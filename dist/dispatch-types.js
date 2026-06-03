"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PASS_THROUGH = exports.HarnessRequiredError = exports.UnauthorizedToolError = void 0;
exports.defaultComputeQuotaWindow = defaultComputeQuotaWindow;
/**
 * The framework's default quota windowing: run-scoped, `perRun` ceiling.
 * A host with richer policy (per-chunk windows, session-keyed quotas, …)
 * supplies `DispatchProjectedDeps.computeQuotaWindow` to override this.
 */
function defaultComputeQuotaWindow(ctx, roleQuota) {
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
class UnauthorizedToolError extends Error {
    name = 'UnauthorizedToolError';
}
exports.UnauthorizedToolError = UnauthorizedToolError;
/**
 * Throw from a handler (or a shared resolver it calls) to signal that the
 * tool needs a harness in scope and none was resolvable — no explicit
 * `harness` arg, and `ctx.harnessSlug` unset or the `'*'` wildcard. The
 * dispatcher surfaces this as the uniform `harness_required` code instead
 * of a generic `handler_error`, so callers get a self-documenting "pass a
 * slug / `all` / scope the session" message. See
 * `apps/operator/lib/agent-tools/_harness-scope.ts`.
 */
class HarnessRequiredError extends Error {
    name = 'HarnessRequiredError';
}
exports.HarnessRequiredError = HarnessRequiredError;
/* ─── Dispatch deps (DI surface) ─────────────────────────────────────── */
/** Sentinel — return this from overrideTool to let the real handler run. */
exports.PASS_THROUGH = Symbol('PASS_THROUGH');
