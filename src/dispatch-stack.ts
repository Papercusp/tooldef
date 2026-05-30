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
import type { ProjectedTool, UnifiedToolContext } from './tool-projection';
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
import type { ZodTypeAny } from 'zod';
import {
  PASS_THROUGH,
  UnauthorizedToolError,
  computeProjectedQuotaWindowKey,
  type DispatchProjectedDeps,
  type DispatchProjectedErrorCode,
  type DispatchProjectedResult,
} from './dispatch-types';

/* ─── Step names ─────────────────────────────────────────────────────── */

export type DispatchStepName =
  | 'role-allowlist'
  | 'capability-check'
  | 'quota'
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
  /** Quota window key, or null when ctx has no run/chunk to scope to. */
  readonly windowKey: string | null;

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
  return {
    tool,
    toolName,
    input,
    ctx,
    deps,
    startedAt: Date.now(),
    windowKey: computeProjectedQuotaWindowKey(ctx),
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

const roleAllowlistStep: DispatchStep = {
  name: 'role-allowlist',
  async run(exec) {
    const { tool, ctx, toolName } = exec;
    if (!tool.roles || !ctx.role || ctx.isSuperuser) return null;
    if (tool.roles.includes(ctx.role as AgentRole)) return null;
    return {
      ok: false,
      error: {
        code: 'role_not_allowed' as DispatchProjectedErrorCode,
        message: `Role "${ctx.role}" cannot call tool "${toolName}" (allowed roles: ${tool.roles.join(', ')})`,
      },
    };
  },
};

const capabilityCheckStep: DispatchStep = {
  name: 'capability-check',
  async run(exec) {
    const { tool, ctx, toolName } = exec;
    if (!ctx.principal || ctx.isSuperuser || tool.capabilities.length === 0) return null;
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

const quotaStep: DispatchStep = {
  name: 'quota',
  async run(exec) {
    const { tool, ctx, toolName, deps, windowKey } = exec;
    const role = ctx.role as AgentRole | undefined;
    const roleQuota = role && tool.rolesQuota?.[role];
    // Superuser bypasses quota; power-user does NOT — workspace quotas
    // apply to end users even though they share the operator-tier
    // catalog. See omp-power-user-bundle-2026-05-20.md §4.1.
    const quotaBypass = ctx.isSuperuser && !ctx.isPowerUser;
    if (!windowKey || !role || !roleQuota || !deps.readQuotaState || quotaBypass) return null;
    const limit = role === 'worker' ? roleQuota.perChunk : roleQuota.perRun;
    if (typeof limit !== 'number' || limit <= 0) return null;
    try {
      const state = await deps.readQuotaState(toolName, ctx, windowKey);
      if (state && state.count >= limit) {
        return {
          ok: false,
          error: {
            code: 'quota_exceeded' as DispatchProjectedErrorCode,
            message: `Tool "${toolName}" exceeded ${role} quota (${state.count}/${limit}) in window "${windowKey}"`,
            meta: { tool: toolName, role, windowKey, used: state.count, limit },
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
      askUser = async <TSchema extends ZodTypeAny>(
        spec: CardSpec<TSchema>,
      ): Promise<CardResponse<TSchema>> => {
        const { result } = registerCard({ workspaceId: wsId, runId, spec });
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
        const parsed = stateSchema.safeParse(snapshot);
        if (!parsed.success) {
          throw new Error(
            `ctx.publishState: snapshot does not match tool.state schema: ${parsed.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; ')}`,
          );
        }
        setToolState(runIdLocal, parsed.data);
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
      if (err instanceof UnauthorizedToolError) {
        return { ok: false, error: { code: 'unauthorized', message: err.message } };
      }
      return {
        ok: false,
        error: { code: 'handler_error', message: err instanceof Error ? err.message : String(err) },
      };
    }
  },
};

/* ─── Default stack ──────────────────────────────────────────────────── */

/**
 * Default ordered stack the dispatcher runs. Steps execute in this order;
 * the first one to return a `DispatchProjectedResult` short-circuits.
 *
 * Ordering invariants:
 *   - All gates (role / capability / quota) come first so denials are
 *     cheap (no timer arming, no buffer allocation, no ctx wrappers).
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
  roleAllowlistStep,
  capabilityCheckStep,
  quotaStep,
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
    await recordTelemetry(exec, result ?? {
      ok: false,
      error: { code: 'handler_error', message: 'no result' },
    });
    if (exec.timeoutTimer) clearTimeout(exec.timeoutTimer);
    if (exec.idleTimer) clearInterval(exec.idleTimer);
    if (ctx.runId) {
      cancelPendingCardsForRun(ctx.runId);
      closeRun(ctx.runId);
    }
  }
}
