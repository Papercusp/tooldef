/**
 * code-execution-tool-orchestration B-CX-2A — the orchestration COMPOSITION.
 *
 * Ties the B-CX-1A pieces together into the one call the `code:run` agent tool makes:
 *   1. PARSE-CHECK the script against the allowed tool set (fast-fail on disallowed refs).
 *   2. Build the facade over `realDispatch(ctx, deps)` — the REAL dispatcher pipeline —
 *      wrapped by the DRY-RUN/CONFIRM gate: in dryRun, `effect:'write'` calls (the B-CX-PRE
 *      marker) are RECORDED, not executed, so an agent/operator can preview every mutation
 *      before committing; reads run normally. Non-dryRun runs everything.
 *   3. Run the script (node:vm), returning ONLY its summary.
 *
 * Lives in tooldef (not operator-core) so it's e2e-testable against the real dispatcher with
 * fixture tools + a fixture ctx; the `code:run` defineTool is a thin wrapper over this.
 *
 * Known MVP gap (documented): inner calls enforce the dispatcher's role + capability gates (from
 * ctx) but not the host capability-ENVELOPE port unless the caller threads it via `deps`. The
 * facade whitelist (`allowed`) + the dryRun gate are the layers present; threading the host
 * envelope port into `deps` is a hardening follow-up.
 */
import type { ProjectedTool, UnifiedToolContext } from '../tool-projection';
import type { DispatchProjectedDeps } from '../dispatch-types';
/**
 * Per-inner-call context-rebinding hook (WI-1411). By default every call the
 * script makes reuses the SAME fixed `ctx` passed to `runToolOrchestration` —
 * fine for an ordinary concrete-workspace caller (its ctx is already bound
 * correctly for the whole batch) but WRONG for a caller whose effective
 * per-call binding can differ from call to call (e.g. an unscoped superuser
 * passing a per-call `{ workspace: 'X' }` arg — the EI-30 "hop without
 * re-auth" convention a direct MCP dispatch honors via
 * `effectiveDispatchWorkspace`/`withWorkspace`/ALS, but which a single fixed
 * `ctx` can never express). `next(callCtx)` performs the actual dispatch with
 * whatever context the wrapper decides is correct for THIS call.
 */
export type DispatchNext = (callCtx: UnifiedToolContext) => Promise<unknown>;
export type WrapDispatch = (tool: ProjectedTool, toolName: string, args: unknown, ctx: UnifiedToolContext, next: DispatchNext) => Promise<unknown>;
export interface OrchestrateOptions {
    ctx: UnifiedToolContext;
    deps: DispatchProjectedDeps;
    /** Candidate tools (typically the full projected registry). */
    tools: readonly ProjectedTool[];
    /** Optional whitelist (full MCP names) — the agent's envelope. Absent ⇒ all `tools`. */
    allowed?: ReadonlySet<string>;
    /** When true, `effect:'write'` calls are recorded, not executed. Default false. */
    dryRun?: boolean;
    /** Wall-clock budget. Default = run-script's 30s. */
    timeoutMs?: number;
    /**
     * Optional per-call context-rebinding hook (WI-1411) — see `WrapDispatch`.
     * Absent ⇒ every call in the batch dispatches under the fixed `ctx`
     * (pre-WI-1411 behavior), which stays correct for any caller whose binding
     * doesn't vary per call.
     */
    wrapDispatch?: WrapDispatch;
}
export interface PlannedMutation {
    tool: string;
    args: unknown;
}
/**
 * A write-effect call whose result reported `ok: false` WITHOUT throwing (EI-7669) — the
 * dispatch itself succeeded (realDispatch only throws on a dispatch-level failure), but the
 * tool's own business-logic result carries a semantic rejection (e.g. work_items:set_state's
 * completion-integrity check). A script that doesn't inspect every result (the common case —
 * `Promise.allSettled` counts a resolved-but-ok:false call the same as a real success) would
 * otherwise silently treat this as an executed mutation. Empty in dryRun (nothing executed).
 */
export interface FailedMutation {
    tool: string;
    args: unknown;
    result: unknown;
}
export interface OrchestrateResult {
    ok: boolean;
    /** The script's returned summary (what re-enters the model's context). */
    summary?: unknown;
    logs: string[];
    error?: string;
    /** Set when the parse-check failed. */
    unknownRefs?: string[];
    dryRun: boolean;
    /** Write-effect calls the script made (recorded in dryRun, observed otherwise). */
    plannedMutations: PlannedMutation[];
    /** Write-effect calls that resolved with a top-level `ok: false` result (EI-7669). Always
     *  empty (or absent, on a hand-built fixture result predating this field) under dryRun
     *  (nothing executed yet) — runToolOrchestration's own return always populates it. Optional
     *  so pre-existing test fixtures constructing an OrchestrateResult literal don't all need
     *  updating; shapeMutationEcho defaults a missing value to `[]`. */
    okFalseMutations?: FailedMutation[];
    /**
     * EI-7784: true when `okFalseMutations` is non-empty — the script itself ran to completion
     * (`ok` stays whatever `run.ok` says: did the SCRIPT throw/timeout), but at least one
     * write-effect call silently rejected without throwing. `ok` alone cannot carry this (it is
     * ALREADY a meaningful, independent signal — "did the script itself complete" — that several
     * existing callers branch on, e.g. `code:run`'s own recipe-capture gate and `recipes:run`'s
     * per-item `ok`), so this is a SEPARATE flag rather than overloading `ok`'s existing meaning.
     * A caller that checks only `ok` (not this flag) is exactly the gap that let three real
     * incidents (EI-7763, EI-7778, WI-3042's assignee:null drop) look like clean successes. Optional
     * (defaults absent/false-ish) so pre-existing hand-built fixture results are unaffected;
     * runToolOrchestration's own return always populates it. */
    partial?: boolean;
}
export declare function runToolOrchestration(script: string, opts: OrchestrateOptions): Promise<OrchestrateResult>;
