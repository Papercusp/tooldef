/**
 * Shared types + sentinels for the projected-tool dispatcher pipeline.
 *
 * Extracted from `dispatch-projected.ts` so `dispatch-stack.ts` (the
 * named-step pipeline) and `dispatch-projected.ts` (the entrypoint
 * dispatchProjectedTool / dispatchProjectedToolStream wrappers) can
 * both depend on these without a circular import.
 *
 * Nothing in this file is host- or transport-specific. Everything that
 * does I/O — quota reads, telemetry writes, override registries — is
 * threaded in through `DispatchProjectedDeps` by the host.
 */

import type { RolesQuota, ToolResult } from './wire';
import type { UnifiedToolContext } from './tool-projection';
import type { AuthAuditEvent } from './authz';
import type { PreconditionFireRequest } from './requires';

/* ─── Quota windowing ────────────────────────────────────────────────── */

/**
 * The quota window resolved for one call.
 *   - `key`   groups telemetry rows AND scopes quota counting. `null` means
 *             "no window" — the call is not quota-counted and telemetry
 *             records an empty window key.
 *   - `limit` is the ceiling within that window, or `null` for "unlimited"
 *             (no quota gate). The dispatcher compares the host's count
 *             against this and never reads the `RolesQuota` fields itself.
 *
 * Both the window scoping and the ceiling are host policy — which is why
 * they are resolved together by a single `computeQuotaWindow` function
 * (plan P-010 / P-011, D-006). The role→chunk/run/session mapping and the
 * `perChunk`-vs-`perRun` choice are Papercusp specifics that live in the
 * adapter, not here.
 */
export interface QuotaWindow {
  key: string | null;
  limit: number | null;
}

/**
 * The framework's default quota windowing: run-scoped, `perRun` ceiling.
 * A host with richer policy (per-chunk windows, session-keyed quotas, …)
 * supplies `DispatchProjectedDeps.computeQuotaWindow` to override this.
 */
export function defaultComputeQuotaWindow(
  ctx: UnifiedToolContext,
  roleQuota: RolesQuota | undefined,
  _toolName?: string,
): QuotaWindow {
  return {
    key: ctx.runId ? `run:${ctx.runId}` : null,
    limit: roleQuota?.perRun ?? null,
  };
}

/* ─── Dispatcher result ──────────────────────────────────────────────── */

export type DispatchProjectedErrorCode =
  | 'unknown_tool'
  | 'unauthorized'
  | 'role_not_allowed'
  | 'missing_capability'
  | 'capability_denied'
  | 'missing_role'
  | 'harness_required'
  | 'quota_exceeded'
  | 'invalid_input'
  | 'handler_error'
  | 'authorization_denied'
  | 'precondition_failed'
  | 'ungated'
  | 'timeout';

/**
 * Throw to signal that the request lacks the authentication the tool
 * requires (no principal, no workspace tx, etc). The dispatcher
 * surfaces this as `unauthorized` so HTTP transports return 401
 * instead of a generic 500.
 */
export class UnauthorizedToolError extends Error {
  override readonly name = 'UnauthorizedToolError';
}

/**
 * Throw from a handler (or a shared resolver it calls) to signal that the
 * tool needs a harness in scope and none was resolvable — no explicit
 * `harness` arg, and `ctx.harnessSlug` unset or the `'*'` wildcard. The
 * dispatcher surfaces this as the uniform `harness_required` code instead
 * of a generic `handler_error`, so callers get a self-documenting "pass a
 * slug / `all` / scope the session" message. See
 * `apps/operator/lib/agent-tools/_harness-scope.ts`.
 */
export class HarnessRequiredError extends Error {
  override readonly name = 'HarnessRequiredError';
}

/**
 * Throw to signal the CALLER's input failed schema validation. The dispatcher
 * surfaces this as `invalid_input` (HTTP 400) instead of `handler_error`
 * (500) — the distinction matters downstream: error-class telemetry treats
 * `handler_error` as a structural tool bug, so a zod failure coded
 * `handler_error` files false "tool is broken" signals (EI-334's cluster:
 * an oversized bee:spawn `brief` fired the structural watchdog key).
 */
export class InvalidInputError extends Error {
  override readonly name = 'InvalidInputError';
}

export interface DispatchProjectedResult {
  ok: boolean;
  result?: ToolResult;
  error?: { code: DispatchProjectedErrorCode; message: string; meta?: Record<string, unknown> };
}

/* ─── Dispatch deps (DI surface) ─────────────────────────────────────── */

/** Sentinel — return this from overrideTool to let the real handler run. */
export const PASS_THROUGH = Symbol('PASS_THROUGH');

/**
 * Per-call dispatcher override. When set, the dispatcher consults this
 * BEFORE invoking the tool handler — if it returns a ToolResult, that
 * is used in place of the handler's return value. PASS_THROUGH lets
 * the handler run normally.
 */
export type ToolDispatchOverrideFn = (
  toolName: string,
  args: unknown,
  ctx: UnifiedToolContext,
) =>
  | Promise<{ content: Array<{ text?: string; [k: string]: unknown }>; isError?: boolean } | typeof PASS_THROUGH>
  | { content: Array<{ text?: string; [k: string]: unknown }>; isError?: boolean }
  | typeof PASS_THROUGH;

/**
 * The capability-envelope verdict for one call (agent-capability-confinement-2026-06-13
 * B-06 / P-012). Produced by the host's `checkCapabilityEnvelope` port, consumed by the
 * `capability-envelope` dispatch step (a `deny` short-circuits) AND threaded onto
 * `PostInvokeEvent.envelopeVerdict` so the host's decision-ledger emit can record the
 * row's posture.
 */
export interface CapabilityEnvelopeVerdict {
  /**
   * 'allow'   — within the envelope (or the envelope did not apply): proceed.
   * 'observe' — beyond the envelope but enforcement is OFF (shadow): proceed, but the
   *             ledger records the would-deny ('gated' posture).
   * 'deny'    — beyond the envelope and enforcement is ON: short-circuit (capability_denied).
   */
  decision: 'allow' | 'observe' | 'deny';
  /** Ledger posture: 'auto' (allowed) · 'gated' (observed would-deny) · 'rejected' (denied). */
  posture: 'auto' | 'gated' | 'rejected';
  /** false ⇒ the caller was EXEMPT (SU / power-user / non-fleet / roleless): envelope did not apply. */
  applied: boolean;
  /** Why, when beyond-envelope — feeds the deny message + the ledger `why`. */
  reason?: string;
}

/**
 * The event handed to `DispatchProjectedDeps.postInvoke` after a tool settles.
 * This is the event-reaction system's observation point (event-reaction-system
 * D-001): the host matches `{ toolName, args, result, ctx }` against its rule
 * registry and fires reactions. `args` are the validated (post-zod) arguments;
 * `result` is the dispatcher's settled result (ok + ToolResult, or an error).
 */
export interface PostInvokeEvent {
  toolName: string;
  pluginName: string;
  args: unknown;
  result: DispatchProjectedResult;
  ctx: UnifiedToolContext;
  durationMs: number;
  /**
   * The tool's declared capabilities (agent-capability-confinement B-06). Additive intrinsic
   * call metadata: the decision-ledger emit derives the action's tier (governed = non-low)
   * + coarse category from these without a registry lookup. The event-reaction matcher
   * ignores it. Undefined for hosts that don't populate it.
   */
  capabilities?: readonly string[];
  /**
   * The capability-envelope verdict (agent-capability-confinement B-06 / P-012), threaded
   * from the `capability-envelope` step. Present only when the host wired
   * `checkCapabilityEnvelope` AND it returned a verdict; null/undefined otherwise (the
   * ledger then records posture 'auto').
   */
  envelopeVerdict?: CapabilityEnvelopeVerdict | null;
}

export interface DispatchProjectedDeps {
  /**
   * Resolve the quota window (telemetry grouping + quota scope) and ceiling
   * for a call. Defaults to `defaultComputeQuotaWindow` (run-scoped, `perRun`
   * ceiling) when unset. The host supplies this to encode its own policy —
   * e.g. Papercusp keys workers on `chunk:<id>`/`perChunk`, power-user
   * sessions on the stable auth session, everyone else on `run:<id>`/`perRun`.
   * `roleQuota` is the tool's `rolesQuota[ctx.role]` entry (or undefined).
   * `toolName` is the dispatched tool's name — passed so a host can resolve a
   * per-(tool,role) runtime override (Papercusp's quota:set_tool dial) in front
   * of the baked `roleQuota`. Optional + ignored by the default; back-compat.
   */
  computeQuotaWindow?(
    ctx: UnifiedToolContext,
    roleQuota: RolesQuota | undefined,
    toolName?: string,
  ): QuotaWindow;
  /** Read current quota usage. Return null to disable quota enforcement. */
  readQuotaState?(
    toolName: string,
    ctx: UnifiedToolContext,
    windowKey: string,
  ): Promise<{ count: number } | null>;
  /**
   * Per-call override. Consulted before tool.fn runs. Used by the
   * llm-testing framework's ToolDispatchOverride registry to inject
   * failures / slow responses / canned results for deterministic
   * scenario testing. Optional; pass-through is the default.
   */
  overrideTool?: ToolDispatchOverrideFn;
  /** Persist a tool-invocation record. Best-effort. */
  recordInvocation?(input: {
    toolName: string;
    pluginName: string;
    ctx: UnifiedToolContext;
    windowKey: string;
    durationMs: number;
    status: 'ok' | 'error' | 'quota-exceeded' | 'role-not-allowed' | 'timeout' | 'invalid-input';
    outputRef?: string | null;
    outputSize?: number | null;
    errorMessage?: string | null;
    /**
     * The dispatcher's error CLASS code (e.g. 'unauthorized', 'handler_error',
     * 'timeout', 'role_not_allowed', 'harness_required', 'invalid_args') —
     * persisted so consumers (the improvement-watchdog) can classify
     * structural-vs-transient failures on a first-class column instead of
     * parsing errorMessage. NULL on success. (watchdog-robustness P-007 / D-009.)
     */
    errorCode?: string | null;
    /**
     * The validated arguments the tool was called with (post-zod parse).
     * Used by the /dev Sessions drilldown to enable exact-replay reruns.
     */
    args?: unknown;
    /**
     * Number of events the tool emitted via ctx.emit / ctx.progress
     * before completion. Used to size replay buffers from empirical
     * p99 (Phase 4 T2.2).
     */
    eventCount?: number;
    /**
     * Per-call structured metadata set by the handler via
     * ctx.metadata({...}). The dispatcher captures the last payload
     * before completion and passes it here.
     */
    metadataJson?: Record<string, unknown> | null;
  }): Promise<void>;
  /**
   * Sink for resource-authorization decisions (RFC tooldef-auth Phase 1b). The
   * dispatcher calls this for every `authorize` allow AND deny — and for every
   * `GateBypass.policy` skip — so privileged bypasses are never silent. Best-effort;
   * unset = decisions are not persisted (the host opted out of the audit trail).
   */
  auditAuth?(event: AuthAuditEvent): void;
  /**
   * Post-invocation hook — fires AFTER every tool settles (success, error, gate
   * denial), once telemetry is recorded, on the same `finally` path. The single
   * observation point of the event-reaction system (event-reaction-system
   * D-001): the host matches the event against its rule registry and fires
   * reactions. **Best-effort and MUST NOT block or fail the trigger** — the
   * dispatcher calls it WITHOUT awaiting and swallows throws; the host schedules
   * reaction *execution* itself (a durable queue / fire-and-forget), never
   * inline on the hot path. Unset ⇒ no reactions.
   */
  postInvoke?(event: PostInvokeEvent): void;
  /**
   * The CAPABILITY-ENVELOPE port (agent-capability-confinement-2026-06-13 B-06 / P-012).
   * The `capability-envelope` dispatch step calls this to evaluate the cheap, static,
   * per-role "may this caller do X at all" envelope. The host owns ALL policy here — the
   * per-role allowlist, the protected set, the SU/non-fleet EXEMPTIONS (D-002), and the
   * enforce-vs-observe flag — and returns a `CapabilityEnvelopeVerdict`; the engine merely
   * acts on `decision` (a `deny` short-circuits as `capability_denied`; `allow`/`observe`
   * proceed) and threads the verdict onto `PostInvokeEvent.envelopeVerdict`.
   *
   * Return `null` ⇒ not applicable (treated as allow, no verdict stashed). AWAITED, but the
   * host impl must be cheap (static matching + a cached flag read; no PG). Unset ⇒ the step
   * is a NO-OP (behavior-neutral — every existing host/test is unaffected). FAIL-OPEN: the
   * step swallows a thrown evaluator error (the OS sandbox is the containment backstop,
   * D-006 — an evaluator bug must never wedge the whole fleet).
   */
  checkCapabilityEnvelope?(input: {
    toolName: string;
    capabilities: readonly string[];
    ctx: UnifiedToolContext;
    args: unknown;
  }): Promise<CapabilityEnvelopeVerdict | null> | (CapabilityEnvelopeVerdict | null);
  /**
   * The PRECONDITION FIRE PORT (autoloop-pot-operator-rebuild D-006). When a
   * `requires:` spec with `{ fire, then: 'retry' }` fails, the dispatcher's
   * `preconditions` step calls this to run the corrective tool, then
   * re-evaluates once. The host wires it to its own dispatcher (the same
   * place reactions fire) so the corrective call is auth-gated + audited
   * like any other invocation. AWAITED (unlike `postInvoke`) — the trigger
   * blocks on its own correction. Unset ⇒ auto-correct specs FAIL CLOSED
   * (the precondition rejects with a message naming the missing port).
   */
  firePrecondition?(req: PreconditionFireRequest): Promise<void>;
  /**
   * Default-deny posture (RFC tooldef-auth Phase 3). When true, the dispatcher denies any
   * tool that declares NO gate (no capabilities/roles/requireRoles/authorize) and is not
   * marked `public` — the fail-closed "forgot to gate ⇒ deny" baseline. Default off
   * (opt-in) during the migration: a host flips it once every tool (incl. plugins)
   * declares a gate or is explicitly public. defineTool requires `capability`, so
   * first-party tools are never ungated; the targets are plugin / direct registrations.
   */
  defaultDeny?: boolean;
}
