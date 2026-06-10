/**
 * Named, ordered, replaceable dispatch pipeline.
 *
 * The dispatcher's pre-handler gates (role, capability, quota), context
 * decorators (timeout, idle watchdog, replay buffer, ctx.emit/progress/
 * askUser/publishState/metadata wrappers), and handler-invoke step are
 * each one entry in a typed stack.
 *
 * The stack ordering is load-bearing (e.g. timeout must arm before
 * idle-watchdog because idle-watchdog races against the same
 * AbortController). The default order is exported as a constant and is
 * what production uses. Hosts can derive a customized stack by replacing
 * a step by name (`withReplacedStep`); inserting / removing steps is
 * intentionally not supported in v1 — the stack invariants are tighter
 * than that.
 *
 * Telemetry sits outside the stack: it runs in the orchestrator's
 * finally block with the final result, on every termination (gate
 * denial, success, error, timeout). Surfaces as `recordTelemetry()` here
 * so it stays co-located with the steps it observes.
 */

import type { ToolResult } from './wire';
import type { AgentRole } from './host-types';
import { toolDeclaresGate, type ProjectedTool, type UnifiedToolContext } from './tool-projection';
import {
  openBuffer as openReplayBuffer,
  type ReplayBufferWriter,
} from './replay-buffer';
import {
  cancelPendingCardsForRun,
  registerCard,
} from './card-correlator';
import { openRun, closeRun, setToolState } from './state-channel';
import type { CardResponse, CardSpec } from './types';
import { validateSync, formatIssues, type StandardSchemaV1 } from './standard-schema';
import {
  PASS_THROUGH,
  HarnessRequiredError,
  UnauthorizedToolError,
  defaultComputeQuotaWindow,
  type DispatchProjectedDeps,
  type DispatchProjectedErrorCode,
  type DispatchProjectedResult,
} from './dispatch-types';
import { evaluateDataCondition } from '@papercusp/rules';
import type { ToolPreInvokeEvent, ToolRequireSpec } from './requires';

/* ─── Step names ─────────────────────────────────────────────────────── */

export type DispatchStepName =
  | 'default-deny'
  | 'role-allowlist'
  | 'capability-check'
  | 'role-requirement'
  | 'harness-check'
  | 'quota'
  | 'authorize'
  | 'preconditions'
  | 'timeout'
  | 'idle-watchdog'
  | 'replay-buffer'
  | 'ctx-bindings'
  | 'invoke';

/* ─── Per-call mutable state ─────────────────────────────────────────── */

/**
 * Mutable state that flows between steps. Read-only fields are set at
 * init; mutable fields are written by specific steps (named in each
 * field's comment). Keeping this typed lets a future step author see
 * which prior steps they depend on without having to read the code.
 */
export interface DispatchExecution {
  // ─── set at init, never mutated ─────────────────────────────────────
  readonly tool: ProjectedTool;
  readonly toolName: string;
  readonly input: unknown;
  /** Original ctx as received by the dispatcher. */
  readonly ctx: UnifiedToolContext;
  readonly deps: DispatchProjectedDeps;
  readonly startedAt: number;
  /** Quota/telemetry window key, or null when ctx has no run/chunk to scope to. */
  readonly windowKey: string | null;
  /** Quota ceiling within the window, or null when the call is unlimited. */
  readonly quotaLimit: number | null;

  // ─── written by 'timeout' step ──────────────────────────────────────
  abort: AbortController;
  timeoutSec: number;

  // ─── written by 'idle-watchdog' step ────────────────────────────────
  idleSec: number;
  lastEmitMs: number;
  idleTimer: ReturnType<typeof setInterval> | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;

  // ─── written by 'replay-buffer' step ────────────────────────────────
  bufferWriter: ReplayBufferWriter | null;

  // ─── written by 'ctx-bindings' step ─────────────────────────────────
  /** Bumped on every wrappedEmit call. Surfaced in telemetry. */
  eventCount: number;
  /** Per-call metadata accumulator. Most recent ctx.metadata() wins. */
  metadataJson: Record<string, unknown> | null;
  /** ctx with emit/progress/askUser/publishState/metadata wrappers applied. */
  handlerCtx: UnifiedToolContext;

  // ─── written by 'invoke' step ───────────────────────────────────────
  handlerResult: ToolResult | null;
}

function initExecution(
  tool: ProjectedTool,
  toolName: string,
  input: unknown,
  ctx: UnifiedToolContext,
  deps: DispatchProjectedDeps,
): DispatchExecution {
  // Resolve the quota window + ceiling once, up front: the window key feeds
  // both the quota gate and telemetry, so it must be computed for every call
  // (not just quota'd ones). `roleQuota` is the tool's entry for this role.
  const roleQuota = ctx.role ? tool.rolesQuota?.[ctx.role] : undefined;
  const { key: windowKey, limit: quotaLimit } = (
    deps.computeQuotaWindow ?? defaultComputeQuotaWindow
  )(ctx, roleQuota);
  return {
    tool,
    toolName,
    input,
    ctx,
    deps,
    startedAt: Date.now(),
    windowKey,
    quotaLimit,
    abort: new AbortController(),
    timeoutSec: 0,
    idleSec: 0,
    lastEmitMs: 0,
    idleTimer: null,
    timeoutTimer: null,
    bufferWriter: null,
    eventCount: 0,
    metadataJson: null,
    handlerCtx: ctx,
    handlerResult: null,
  };
}

/* ─── Step contract ──────────────────────────────────────────────────── */

/**
 * A dispatch step. Returns:
 *   - `DispatchProjectedResult` to short-circuit the pipeline (gate
 *     denied, handler returned, handler errored, etc). Subsequent
 *     steps are skipped; telemetry runs on the returned result.
 *   - `null` to continue to the next step.
 */
export interface DispatchStep {
  name: DispatchStepName;
  run(exec: DispatchExecution): Promise<DispatchProjectedResult | null>;
}

/* ─── Steps ──────────────────────────────────────────────────────────── */

/**
 * Default-deny gate (RFC tooldef-auth Phase 3, decision D1). Runs first.
 *
 * Opt-in via `deps.defaultDeny` (off = the legacy allow-by-omission posture, no behavior
 * change). When on, a tool that declares NO gate — no capabilities, no agent `roles`, no
 * `requireRoles`, no `authorize` — is denied as `ungated` UNLESS it sets `public: true`
 * (the explicit `[AllowAnonymous]` equivalent). This is the fail-closed "forgot to gate ⇒
 * deny" baseline the §8 audit (D1) committed to. NOT bypassable: an ungated tool is a
 * declaration gap regardless of caller — the fix is to declare a gate or mark it public.
 * `defineTool` requires `capability`, so first-party tools are never ungated; the targets
 * are plugin / direct registrations.
 */
const defaultDenyStep: DispatchStep = {
  name: 'default-deny',
  async run(exec) {
    const { tool, toolName, deps } = exec;
    if (!deps.defaultDeny || tool.public) return null;
    if (toolDeclaresGate(tool)) return null;
    return {
      ok: false,
      error: {
        code: 'ungated' as DispatchProjectedErrorCode,
        message: `Tool "${toolName}" declares no auth gate (capability/roles/requireRoles/authorize) and is not marked public; denied under default-deny`,
        meta: { tool: toolName },
      },
    };
  },
};

const roleAllowlistStep: DispatchStep = {
  name: 'role-allowlist',
  async run(exec) {
    const { tool, ctx, toolName } = exec;
    if (!tool.agentRoles || !ctx.role || ctx.gateBypass?.role) return null;
    if (tool.agentRoles.includes(ctx.role as AgentRole)) return null;
    return {
      ok: false,
      error: {
        code: 'role_not_allowed' as DispatchProjectedErrorCode,
        message: `Role "${ctx.role}" cannot call tool "${toolName}" (allowed roles: ${tool.agentRoles.join(', ')})`,
      },
    };
  },
};

const capabilityCheckStep: DispatchStep = {
  name: 'capability-check',
  async run(exec) {
    const { tool, ctx, toolName } = exec;
    if (!ctx.principal || ctx.gateBypass?.capability || tool.capabilities.length === 0) return null;
    for (const cap of tool.capabilities) {
      if (!ctx.principal.capabilities.has(cap)) {
        return {
          ok: false,
          error: {
            code: 'missing_capability' as DispatchProjectedErrorCode,
            message: `Principal "${ctx.principal.slug}" lacks capability "${cap}" (tool: ${toolName})`,
            meta: { tool: toolName, principal: ctx.principal.slug, missing: cap },
          },
        };
      }
    }
    return null;
  },
};

/**
 * RBAC role-requirement gate (RFC tooldef-auth Phase 2).
 *
 * A tool declaring `requireRoles` is callable only by a principal whose `roles` include
 * at least ONE of them (any-of) — the declarative, typed replacement for ad-hoc
 * `requireAdminKey`/`requireStaff` checks. Additive (a tool with no `requireRoles` is
 * unaffected). Fail-closed: an anonymous call (no principal) is DENIED, since a role
 * requirement can't be satisfied without an identity. Bypassed by `GateBypass.role` (a
 * superuser passes RBAC role gates as it passes the agent-role allowlist). Audited like
 * the other gates (gate:'role').
 */
const roleRequirementStep: DispatchStep = {
  name: 'role-requirement',
  async run(exec) {
    const { tool, ctx, toolName, deps } = exec;
    const required = tool.requireRoles;
    if (!required || required.length === 0 || ctx.gateBypass?.role) return null;
    const have = ctx.principal?.roles;
    if (have && required.some((r) => have.has(r))) return null;
    deps.auditAuth?.({
      ts: Date.now(),
      principal: ctx.principal ? { slug: ctx.principal.slug, workspaceId: ctx.principal.workspaceId } : null,
      tool: toolName,
      action: toolName,
      decision: 'deny',
      gate: 'role',
      reason: `requires one of role(s): ${required.join(', ')}`,
    });
    return {
      ok: false,
      error: {
        code: 'missing_role' as DispatchProjectedErrorCode,
        message: `Principal ${ctx.principal ? `"${ctx.principal.slug}"` : '(anonymous)'} lacks a required role for tool "${toolName}" (needs one of: ${required.join(', ')})`,
        meta: { tool: toolName, required, principal: ctx.principal?.slug ?? null },
      },
    };
  },
};

/**
 * Harness-required gate (su-prompt-audit-fixes P-020 / D-007).
 *
 * A tool declaring `harness: 'required'` (a CTX-ONLY harness-scoped tool —
 * one with no slug arg, so `ctx.harnessSlug` is its only harness source)
 * gets a UNIFORM `harness_required` error when no harness is resolvable —
 * i.e. `ctx.harnessSlug` is unset or the `'*'` wildcard (the superuser
 * "no harness picked" sentinel). This replaces the old per-handler grab-bag
 * (harness_not_registered / require-slug / primary-fallback / stub) with one
 * self-documenting message. Tools that accept an explicit slug self-resolve
 * and stay `'optional'`; the gate is a no-op for them.
 *
 * Fails closed even for privileged callers: a missing harness is a FUNCTIONAL
 * gap (the tool can't run), not a permission one, so superuser/power don't
 * bypass it. `gateBypass.papercusp` is an explicit per-call escape hatch only.
 */
const harnessCheckStep: DispatchStep = {
  name: 'harness-check',
  async run(exec) {
    const { tool, ctx, toolName } = exec;
    if (tool.harness !== 'required' || ctx.gateBypass?.harness) return null;
    const slug = ctx.harnessSlug?.trim();
    if (slug && slug !== '*') return null;
    return {
      ok: false,
      error: {
        code: 'harness_required' as DispatchProjectedErrorCode,
        message:
          `Tool "${toolName}" requires a harness. Pass a harness slug (e.g. via ` +
          `the spawn's ?harness= / X-Papercusp-Harness), or run \`harness:list\` ` +
          `and relaunch scoped to one. For a different harness use \`cross_harness:*\`.`,
        meta: { tool: toolName },
      },
    };
  },
};

const quotaStep: DispatchStep = {
  name: 'quota',
  async run(exec) {
    const { ctx, toolName, deps, windowKey, quotaLimit } = exec;
    // The host decides quota bypass (Papercusp: superuser yes, power-user no —
    // workspace quotas apply to end users; see omp-power-user-bundle-2026-05-20
    // §4.1, encoded in papercuspGateBypass). The engine just reads the signal.
    const quotaBypass = ctx.gateBypass?.quota ?? false;
    // The window key + ceiling were resolved at init by the host's
    // `computeQuotaWindow` policy (worker→chunk, power-user→session, …);
    // this step only enforces the count against the resolved limit.
    if (!windowKey || quotaLimit == null || quotaLimit <= 0 || !deps.readQuotaState || quotaBypass) {
      return null;
    }
    try {
      const state = await deps.readQuotaState(toolName, ctx, windowKey);
      if (state && state.count >= quotaLimit) {
        return {
          ok: false,
          error: {
            code: 'quota_exceeded' as DispatchProjectedErrorCode,
            message: `Tool "${toolName}" exceeded quota (${state.count}/${quotaLimit}) in window "${windowKey}"`,
            meta: { tool: toolName, role: ctx.role, windowKey, used: state.count, limit: quotaLimit },
          },
        };
      }
    } catch {
      // fail-open on PG error — matches pre-refactor behavior
    }
    return null;
  },
};

const timeoutStep: DispatchStep = {
  name: 'timeout',
  async run(exec) {
    exec.timeoutSec = exec.tool.timeoutSec ?? 60;
    const timer = setTimeout(() => exec.abort.abort(), exec.timeoutSec * 1000);
    if (typeof timer.unref === 'function') timer.unref();
    exec.timeoutTimer = timer;
    // Compose any caller-supplied signal — caller-side aborts must still
    // propagate to the dispatcher's controller.
    if (exec.ctx.signal && !exec.ctx.signal.aborted) {
      exec.ctx.signal.addEventListener('abort', () => exec.abort.abort(), { once: true });
    }
    return null;
  },
};

const idleWatchdogStep: DispatchStep = {
  name: 'idle-watchdog',
  async run(exec) {
    exec.idleSec = exec.tool.idleTimeoutSec ?? 0;
    exec.lastEmitMs = Date.now();
    if (exec.idleSec > 0) {
      const checkMs = Math.max(1_000, Math.floor((exec.idleSec * 1000) / 4));
      const timer = setInterval(() => {
        if (exec.abort.signal.aborted) return;
        if (Date.now() - exec.lastEmitMs > exec.idleSec * 1000) exec.abort.abort();
      }, checkMs);
      if (typeof timer.unref === 'function') timer.unref();
      exec.idleTimer = timer;
    }
    return null;
  },
};

const replayBufferStep: DispatchStep = {
  name: 'replay-buffer',
  async run(exec) {
    const { tool, ctx, toolName } = exec;
    // State-shaped tools skip the ring buffer — their reconnect strategy
    // is "latest snapshot," not "event history."
    const replayCap = tool.state ? 0 : (tool.replayBufferSize ?? 0);
    if (replayCap > 0 && ctx.workspaceId && ctx.runId) {
      exec.bufferWriter = openReplayBuffer({
        workspaceId: ctx.workspaceId,
        toolName,
        runId: ctx.runId,
        capacity: replayCap,
        onEvict: (ev) => {
          // eslint-disable-next-line no-console
          console.warn(
            `[replay-buffer] ${toolName}/${ctx.runId}: evicted event id=${ev.id} name=${ev.name} (capacity ${replayCap})`,
          );
        },
      });
    }
    return null;
  },
};

const ctxBindingsStep: DispatchStep = {
  name: 'ctx-bindings',
  async run(exec) {
    const { ctx, tool } = exec;

    // wrappedEmit — refreshes idle deadline + pushes into replay buffer
    // + bumps eventCount. Always installed; both features are conditional
    // inside.
    const wrappedEmit = (name: string, data: unknown): void => {
      if (exec.idleSec > 0) exec.lastEmitMs = Date.now();
      exec.eventCount += 1;
      if (exec.bufferWriter) exec.bufferWriter.push({ id: exec.eventCount, name, data });
      ctx.emit(name, data);
    };
    const wrappedProgress = (pct: number | undefined, msg?: string): void => {
      wrappedEmit('progress', {
        progress: typeof pct === 'number' ? pct : 0,
        total: 100,
        ...(msg ? { message: msg } : {}),
      });
    };

    // askUser — installed only when ctx has a workspaceId + runId for
    // card-correlator to scope cleanup against.
    let askUser: UnifiedToolContext['askUser'] | undefined;
    if (ctx.workspaceId && ctx.runId) {
      const wsId = ctx.workspaceId;
      const runId = ctx.runId;
      openRun({ workspaceId: wsId, runId });
      askUser = async <TSchema extends StandardSchemaV1>(
        spec: CardSpec<TSchema>,
      ): Promise<CardResponse<TSchema>> => {
        const { correlationId, result } = registerCard({ workspaceId: wsId, runId, spec });
        // Surface the freshly-minted id so a caller can link an external
        // durable record (Phase D). Skip an idempotency-cache hit (no card was
        // registered — correlationId is the 'idempotent' sentinel).
        if (spec.onCard && correlationId !== 'idempotent') {
          try {
            spec.onCard({ correlationId, runId, workspaceId: wsId });
          } catch {
            /* onCard must never break the card flow */
          }
        }
        return await new Promise<CardResponse<TSchema>>((resolve) => {
          const onAbort = () => {
            exec.abort.signal.removeEventListener('abort', onAbort);
            resolve({ action: 'cancel' } as CardResponse<TSchema>);
          };
          if (exec.abort.signal.aborted) return onAbort();
          exec.abort.signal.addEventListener('abort', onAbort);
          void result.then((r) => {
            exec.abort.signal.removeEventListener('abort', onAbort);
            resolve(r);
          });
        });
      };
    }

    // publishState — installed only when (a) tool declared `state` and
    // (b) ctx has a workspaceId + runId.
    let publishState: UnifiedToolContext['publishState'] | undefined;
    if (tool.state && ctx.workspaceId && ctx.runId) {
      const stateSchema = tool.state;
      const runIdLocal = ctx.runId;
      publishState = (snapshot: unknown) => {
        if (Array.isArray(snapshot)) {
          throw new Error(
            'ctx.publishState v1 is snapshot-only; pass a full state object, not a JSON-Patch array',
          );
        }
        // Validate synchronously — publishState is fire-and-forget (tools call
        // it without await), so an async validator can't be supported here.
        const parsed = validateSync(stateSchema, snapshot);
        if (!parsed.ok) {
          throw new Error(
            `ctx.publishState: snapshot does not match tool.state schema: ${formatIssues(parsed.issues)}`,
          );
        }
        setToolState(runIdLocal, parsed.value);
      };
    }

    // metadata — overwrite-not-merge semantics, last write wins.
    const metadataCallback = (data: Record<string, unknown>): void => {
      exec.metadataJson = { ...data };
    };

    exec.handlerCtx = {
      ...ctx,
      signal: exec.abort.signal,
      emit: wrappedEmit,
      progress: wrappedProgress,
      metadata: metadataCallback,
      ...(askUser ? { askUser } : {}),
      ...(publishState ? { publishState } : {}),
    };

    return null;
  },
};

const invokeStep: DispatchStep = {
  name: 'invoke',
  async run(exec) {
    const { tool, toolName, input, handlerCtx, deps } = exec;
    try {
      let result: ToolResult;
      if (deps.overrideTool) {
        const ov = await deps.overrideTool(toolName, input, handlerCtx);
        if (ov !== PASS_THROUGH) {
          result = ov as ToolResult;
        } else {
          result = await tool.fn(input, handlerCtx);
        }
      } else {
        result = await tool.fn(input, handlerCtx);
      }
      // ok-on-abort race: if the watchdog fired mid-handler but the
      // handler returned normally without observing ctx.signal.aborted,
      // treat the abort as authoritative.
      if (exec.abort.signal.aborted) {
        return {
          ok: false,
          error: {
            code: 'timeout',
            message: `tool "${toolName}" exceeded timeout of ${exec.timeoutSec}s (handler returned but signal had aborted)`,
          },
        };
      }
      // outputRef auto-emit — the framework injects a `chunk` event
      // when the handler declared outputRef on its result.
      if (result.outputRef) {
        handlerCtx.emit('chunk', {
          ref: result.outputRef,
          ...(typeof result.outputSize === 'number' ? { byteSize: result.outputSize } : {}),
        });
      }
      exec.handlerResult = result;
      return { ok: true, result };
    } catch (err) {
      const isTimeout = exec.abort.signal.aborted;
      if (isTimeout) {
        return {
          ok: false,
          error: { code: 'timeout', message: `tool "${toolName}" exceeded timeout of ${exec.timeoutSec}s` },
        };
      }
      // eslint-disable-next-line no-console
      console.error('[DBG dispatch-stack catch]', import.meta.url, 'errName=', (err as Error)?.name, 'iof=', err instanceof UnauthorizedToolError);
      if (err instanceof UnauthorizedToolError) {
        return { ok: false, error: { code: 'unauthorized', message: err.message } };
      }
      if (err instanceof HarnessRequiredError) {
        return { ok: false, error: { code: 'harness_required', message: err.message } };
      }
      return {
        ok: false,
        error: { code: 'handler_error', message: err instanceof Error ? err.message : String(err) },
      };
    }
  },
};

/**
 * Resource-`authorize` gate (RFC tooldef-auth Phase 1b, decision D-F).
 *
 * Runs a tool's `authorize` hook — the fine-grained "can THIS principal act on THIS
 * resource" layer the coarse gates can't express. Additive: a tool with no `authorize`
 * is unaffected. Fail-closed (a throw denies). Sits with the other gates (before timer
 * arming) so denials stay cheap and so it composes with `GateBypass` like its siblings.
 *
 * `GateBypass.policy` (default off, and NOT implied by the role/capability/quota
 * bypasses) skips the hook — but the skip is AUDITED, never silent: break-glass best
 * practice is "policy-governed + mandatorily logged" (RFC §8 D2). Every allow, deny, and
 * bypass emits an `AuthAuditEvent` via `deps.auditAuth`.
 */
const authorizeStep: DispatchStep = {
  name: 'authorize',
  async run(exec) {
    const { tool, toolName, input, ctx, deps } = exec;
    const authorize = tool.authorize;
    if (!authorize) return null; // no resource gate on this tool

    const audit = (decision: 'allow' | 'deny', reason?: string) => {
      deps.auditAuth?.({
        ts: Date.now(),
        principal: ctx.principal
          ? { slug: ctx.principal.slug, workspaceId: ctx.principal.workspaceId }
          : null,
        tool: toolName,
        action: toolName,
        decision,
        gate: 'authorize',
        reason,
      });
    };

    const deny = (reason: string | undefined): DispatchProjectedResult => ({
      ok: false,
      error: {
        code: 'authorization_denied' as DispatchProjectedErrorCode,
        message: reason ?? `Not authorized to call tool "${toolName}"`,
        meta: { tool: toolName, principal: ctx.principal?.slug ?? null },
      },
    });

    // Audited break-glass: skip the hook, but record the bypass.
    if (ctx.gateBypass?.policy) {
      audit('allow', 'gateBypass.policy');
      return null;
    }

    let decision;
    try {
      decision = await authorize({ principal: ctx.principal, input, ctx });
    } catch (err) {
      const reason = `authorize threw: ${err instanceof Error ? err.message : String(err)}`;
      audit('deny', reason);
      return deny(reason);
    }
    if (!decision.allow) {
      audit('deny', decision.reason);
      return deny(decision.reason);
    }
    audit('allow', decision.reason);
    return null;
  },
};

/**
 * Declarative-preconditions gate (autoloop-pot-operator-rebuild D-006) — the
 * preInvoke mirror of `emits:`. Evaluates each `requires:` spec's declarative
 * condition (a `@papercusp/rules` DataCondition over `{ tool, args, ctx,
 * state }`) and, on failure, either REJECTS (`precondition_failed`) or
 * AUTO-CORRECTS: fires the spec's corrective tool through the host's
 * injectable `deps.firePrecondition` port, re-resolves state, re-evaluates
 * ONCE, and rejects if it still fails. Auto-corrections + denials are audited
 * (gate:'precondition') — visible, never silent. Fail-closed throughout: a
 * throwing state resolver / evaluator / fire port denies the call.
 *
 * Runs AFTER `authorize` (cheap declarative checks shouldn't preempt the
 * audited auth chain, and a corrective fire must only happen for an
 * authorized caller) and BEFORE `timeout` (it's a gate — no timers/buffers
 * exist yet on the deny path).
 *
 * Safety invariants stay imperative code (D-007) — `requires:` is for
 * functional preconditions only. See `ToolRequireSpec`.
 */
const preconditionsStep: DispatchStep = {
  name: 'preconditions',
  async run(exec) {
    const { tool, toolName, input, ctx, deps } = exec;
    const requires = tool.requires;
    if (!requires || requires.length === 0) return null;

    const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const eventCtx = ctx as unknown as ToolPreInvokeEvent['ctx'];

    const audit = (decision: 'allow' | 'deny', requireId: string, reason: string) => {
      deps.auditAuth?.({
        ts: Date.now(),
        principal: ctx.principal
          ? { slug: ctx.principal.slug, workspaceId: ctx.principal.workspaceId }
          : null,
        tool: toolName,
        action: toolName,
        decision,
        gate: 'precondition',
        reason: `[require:${requireId}] ${reason}`,
      });
    };

    const deny = (requireId: string, message: string, meta?: Record<string, unknown>): DispatchProjectedResult => ({
      ok: false,
      error: {
        code: 'precondition_failed' as DispatchProjectedErrorCode,
        message,
        meta: { tool: toolName, require: requireId, ...meta },
      },
    });

    for (let i = 0; i < requires.length; i++) {
      const spec: ToolRequireSpec = requires[i];
      const requireId = spec.id ?? String(i);
      const failMessage =
        spec.error ?? `Tool "${toolName}" precondition "${requireId}" not met`;

      // Evaluate once: resolve state (fail-closed on a throw), then run the
      // declarative condition over the pre-invoke event.
      const evaluate = async (): Promise<{ holds: boolean; event: ToolPreInvokeEvent }> => {
        let state: Record<string, unknown> = {};
        if (spec.state) state = await spec.state(args, eventCtx);
        const event: ToolPreInvokeEvent = { tool: toolName, args, ctx: eventCtx, state };
        return { holds: evaluateDataCondition(spec.when, event), event };
      };

      let first;
      try {
        first = await evaluate();
      } catch (err) {
        const reason = `precondition evaluation threw: ${err instanceof Error ? err.message : String(err)}`;
        audit('deny', requireId, reason);
        return deny(requireId, `${failMessage} (${reason})`);
      }
      if (first.holds) continue;

      // Failed. Auto-correct path: fire the corrective tool, retry once.
      if (spec.fire) {
        if (!deps.firePrecondition) {
          const reason = `auto-correct fire "${spec.fire}" declared but host wired no firePrecondition port`;
          audit('deny', requireId, reason);
          return deny(requireId, `${failMessage} (${reason})`, { fire: spec.fire });
        }
        try {
          const fireArgs = spec.render ? spec.render(first.event) : {};
          await deps.firePrecondition({
            fire: spec.fire,
            args: fireArgs,
            trigger: toolName,
            requireId,
            ctx: eventCtx,
          });
        } catch (err) {
          const reason = `auto-correct fire "${spec.fire}" failed: ${err instanceof Error ? err.message : String(err)}`;
          audit('deny', requireId, reason);
          return deny(requireId, `${failMessage} (${reason})`, { fire: spec.fire });
        }
        // then: 'retry' — re-resolve state, re-evaluate once.
        let retry;
        try {
          retry = await evaluate();
        } catch (err) {
          const reason = `retry evaluation threw after auto-correct "${spec.fire}": ${err instanceof Error ? err.message : String(err)}`;
          audit('deny', requireId, reason);
          return deny(requireId, `${failMessage} (${reason})`, { fire: spec.fire });
        }
        if (retry.holds) {
          // Visible success: the call proceeds, but the correction is audited.
          audit('allow', requireId, `auto-corrected via "${spec.fire}" + retry`);
          continue;
        }
        const reason = `still failing after auto-correct "${spec.fire}"`;
        audit('deny', requireId, reason);
        return deny(requireId, `${failMessage} (${reason})`, { fire: spec.fire });
      }

      // Plain reject.
      audit('deny', requireId, 'condition not met');
      return deny(requireId, failMessage);
    }
    return null;
  },
};

/* ─── Default stack ──────────────────────────────────────────────────── */

/**
 * Default ordered stack the dispatcher runs. Steps execute in this order;
 * the first one to return a `DispatchProjectedResult` short-circuits.
 *
 * Ordering invariants:
 *   - All gates (role / capability / harness / quota / authorize /
 *     preconditions) come first so denials are cheap (no timer arming, no
 *     buffer allocation, no ctx wrappers). `authorize` runs last among the
 *     AUTH gates — it is the finest-grained and may touch the resource.
 *   - `preconditions` (declarative `requires:` — D-006) runs after
 *     `authorize` and before `timeout`: a corrective auto-fire must only
 *     happen for an authorized caller, and a functional precondition should
 *     not mask an auth denial.
 *   - `timeout` arms the AbortController; every subsequent step that
 *     races against it depends on this having run.
 *   - `idle-watchdog` runs after `timeout` so it composes with the same
 *     controller. It also runs before `ctx-bindings` because the wrapped
 *     emit refreshes `lastEmitMs`.
 *   - `replay-buffer` runs before `ctx-bindings` because the wrapped
 *     emit pushes into the buffer.
 *   - `ctx-bindings` is the last decorator before `invoke`.
 *   - `invoke` is always terminal.
 */
export const DEFAULT_DISPATCH_STACK: ReadonlyArray<DispatchStep> = Object.freeze([
  defaultDenyStep,
  roleAllowlistStep,
  capabilityCheckStep,
  roleRequirementStep,
  harnessCheckStep,
  quotaStep,
  authorizeStep,
  preconditionsStep,
  timeoutStep,
  idleWatchdogStep,
  replayBufferStep,
  ctxBindingsStep,
  invokeStep,
]);

/* ─── Customization ──────────────────────────────────────────────────── */

/**
 * Derive a stack from the default with one step replaced by name. The
 * returned array is the same length and in the same order — only the
 * named step's `run` is swapped. Hosts override e.g. quota for an
 * embedded test environment, or invoke to slip in a profiler.
 *
 * Insertion / removal is intentionally not supported in v1: the
 * ordering invariants documented on `DEFAULT_DISPATCH_STACK` are tight,
 * and a single replaceable position is the smallest knob that proves
 * the surface is real.
 */
export function withReplacedStep(
  stack: ReadonlyArray<DispatchStep>,
  name: DispatchStepName,
  replacement: DispatchStep['run'],
): ReadonlyArray<DispatchStep> {
  let found = false;
  const out = stack.map((s) => {
    if (s.name === name) {
      found = true;
      return { name, run: replacement };
    }
    return s;
  });
  if (!found) {
    throw new Error(`withReplacedStep: no step named "${name}" in stack`);
  }
  return Object.freeze(out);
}

/* ─── Telemetry (always runs in finally) ─────────────────────────────── */

/**
 * Record a tool-invocation row from a completed execution + its final
 * result. Called by the orchestrator after the stack settles (success,
 * gate denial, error, timeout — all paths). Best-effort; thrown
 * recordInvocation errors are swallowed.
 */
async function recordTelemetry(
  exec: DispatchExecution,
  result: DispatchProjectedResult,
): Promise<void> {
  const { deps, tool, toolName, ctx, windowKey, input, startedAt, eventCount } = exec;
  if (!deps.recordInvocation) return;
  // Gate denials (no windowKey required); successes + handler errors
  // require windowKey to match pre-refactor behavior (was guarded by
  // `if (deps.recordInvocation && windowKey)`).
  const code = result.ok ? null : result.error?.code;
  const status =
    result.ok
      ? 'ok'
      : code === 'role_not_allowed' || code === 'missing_capability'
        ? 'role-not-allowed'
        : code === 'quota_exceeded'
          ? 'quota-exceeded'
          : code === 'timeout'
            ? 'timeout'
            : code === 'invalid_input'
              ? 'invalid-input'
              : 'error';
  const isGateDenial =
    !result.ok &&
    (code === 'role_not_allowed' ||
      code === 'missing_capability' ||
      code === 'quota_exceeded');
  if (!isGateDenial && !windowKey) return;

  const metadataJson = finalizeMetadata(exec);

  try {
    if (result.ok && result.result) {
      const r = result.result;
      await deps.recordInvocation({
        toolName,
        pluginName: tool.pluginName,
        ctx,
        windowKey: windowKey ?? '',
        durationMs: Date.now() - startedAt,
        status: 'ok',
        outputSize: r.outputSize ?? JSON.stringify(r.content).length,
        ...(r.outputRef ? { outputRef: r.outputRef } : {}),
        args: input,
        eventCount,
        metadataJson,
      });
    } else {
      await deps.recordInvocation({
        toolName,
        pluginName: tool.pluginName,
        ctx,
        windowKey: windowKey ?? '',
        durationMs: Date.now() - startedAt,
        status,
        // Persist the dispatcher error CLASS (computed above, then historically
        // discarded) so the watchdog can tell a deterministic config bug from a
        // transient crash without LIKE-matching errorMessage (P-007 / D-009).
        errorCode: code ?? null,
        errorMessage: result.error?.message ?? '',
        args: input,
        eventCount,
        metadataJson,
      });
    }
  } catch {
    // best-effort
  }
}

function finalizeMetadata(exec: DispatchExecution): Record<string, unknown> | null {
  if (exec.ctx.uiClientId) {
    const base = exec.metadataJson ?? {};
    if (base.uiClientId === undefined) {
      return { ...base, uiClientId: exec.ctx.uiClientId };
    }
  }
  return exec.metadataJson;
}

/* ─── Orchestrator ───────────────────────────────────────────────────── */

/**
 * Drive a stack to completion. Initializes execution state, iterates
 * the stack, records telemetry, and runs cleanup. Returns the result
 * the first short-circuiting step produced — or the result `invoke`
 * returned, if no gate fired.
 */
export async function runDispatchStack(
  tool: ProjectedTool,
  toolName: string,
  input: unknown,
  ctx: UnifiedToolContext,
  deps: DispatchProjectedDeps,
  stack: ReadonlyArray<DispatchStep> = DEFAULT_DISPATCH_STACK,
): Promise<DispatchProjectedResult> {
  const exec = initExecution(tool, toolName, input, ctx, deps);
  let result: DispatchProjectedResult | null = null;
  try {
    for (const step of stack) {
      result = await step.run(exec);
      if (result) break;
    }
    if (!result) {
      // Stack ended without producing a result — this would be a bug
      // (e.g. a custom stack missing the `invoke` step). Surface clearly.
      result = {
        ok: false,
        error: {
          code: 'handler_error',
          message: `dispatch stack completed without a result (missing 'invoke' step?)`,
        },
      };
    }
    return result;
  } finally {
    const settled = result ?? {
      ok: false,
      error: { code: 'handler_error' as const, message: 'no result' },
    };
    await recordTelemetry(exec, settled);
    // Event-reaction observation point (D-001). Fired AFTER telemetry, on every
    // path. Best-effort + non-blocking: the host's postInvoke matches rules and
    // SCHEDULES reactions (durable queue / fire-and-forget), it must not run a
    // reaction inline here. We deliberately do NOT await it, and swallow throws,
    // so a reaction can never delay or break its trigger.
    if (deps.postInvoke) {
      try {
        deps.postInvoke({
          toolName,
          pluginName: tool.pluginName,
          args: input,
          result: settled,
          ctx,
          durationMs: Date.now() - exec.startedAt,
        });
      } catch {
        // a reaction must never break its trigger
      }
    }
    if (exec.timeoutTimer) clearTimeout(exec.timeoutTimer);
    if (exec.idleTimer) clearInterval(exec.idleTimer);
    if (ctx.runId) {
      cancelPendingCardsForRun(ctx.runId);
      closeRun(ctx.runId);
    }
  }
}
