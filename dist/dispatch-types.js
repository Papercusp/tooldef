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
/**
 * The framework's default quota windowing: run-scoped, `perRun` ceiling.
 * A host with richer policy (per-chunk windows, session-keyed quotas, …)
 * supplies `DispatchProjectedDeps.computeQuotaWindow` to override this.
 */
export function defaultComputeQuotaWindow(ctx, roleQuota, _toolName) {
    return {
        key: ctx.runId ? `run:${ctx.runId}` : null,
        limit: roleQuota?.perRun ?? null,
    };
}
/**
 * Throw to signal that the request lacks the authentication the tool
 * requires (no principal, no workspace tx, etc). The dispatcher
 * surfaces this as `unauthorized` so HTTP transports return 401
 * instead of a generic 500.
 */
export class UnauthorizedToolError extends Error {
    name = 'UnauthorizedToolError';
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
    name = 'HarnessRequiredError';
}
/**
 * Throw to signal the CALLER's input failed schema validation. The dispatcher
 * surfaces this as `invalid_input` (HTTP 400) instead of `handler_error`
 * (500) — the distinction matters downstream: error-class telemetry treats
 * `handler_error` as a structural tool bug, so a zod failure coded
 * `handler_error` files false "tool is broken" signals (EI-334's cluster:
 * an oversized cup:spawn `brief` fired the structural watchdog key).
 */
export class InvalidInputError extends Error {
    name = 'InvalidInputError';
}
/* ─── Dispatch deps (DI surface) ─────────────────────────────────────── */
/** Sentinel — return this from overrideTool to let the real handler run. */
export const PASS_THROUGH = Symbol('PASS_THROUGH');
