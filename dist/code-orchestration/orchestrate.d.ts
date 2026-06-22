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
}
export interface PlannedMutation {
    tool: string;
    args: unknown;
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
}
export declare function runToolOrchestration(script: string, opts: OrchestrateOptions): Promise<OrchestrateResult>;
