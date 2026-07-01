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
import { buildToolFacade, type FacadeDispatch } from './tool-facade';
import { realDispatch } from './dispatch-binding';
import { runOrchestrationScript } from './run-script';
import { checkScript, ensureParseCheckReady } from './parse-check';

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
export type WrapDispatch = (
  tool: ProjectedTool,
  toolName: string,
  args: unknown,
  ctx: UnifiedToolContext,
  next: DispatchNext,
) => Promise<unknown>;

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

export async function runToolOrchestration(
  script: string,
  opts: OrchestrateOptions,
): Promise<OrchestrateResult> {
  const { ctx, deps, tools, allowed, dryRun = false, timeoutMs, wrapDispatch } = opts;
  const plannedMutations: PlannedMutation[] = [];

  await ensureParseCheckReady(); // lazy-load the TS compiler before the static parse-check (kept out of the eager client bundle)
  const check = checkScript(script, tools, allowed);
  // F8 (autonomous-loop-hardening / H2): an unknown tool ref no longer NUKES the whole run before
  // it starts (which forced a full re-run of the good calls too). We still surface `unknownRefs`
  // (→ advisory facadeHelp so the agent fixes the name), but we RUN the script — binding each
  // unknown ref to a stub that REJECTS only when CALLED. So the good calls execute and the author
  // can isolate the bad one (Promise.allSettled / try-catch) instead of re-running the whole batch,
  // and a bad ref in an unreached branch is a no-op. The `allowed` whitelist is still the security
  // boundary — a stub grants NO reach; it only turns a cryptic "cannot read undefined" into a clear
  // per-call error.
  const unknownRefs = check.ok ? undefined : check.unknownRefs;

  const dispatch: FacadeDispatch = async (tool, name, args) => {
    if (tool.effect === 'write') {
      plannedMutations.push({ tool: name, args });
      if (dryRun) {
        return { dryRun: true, wouldCall: name, args };
      }
    }
    const call: DispatchNext = (callCtx) => realDispatch(callCtx, deps)(tool, name, args);
    return wrapDispatch ? wrapDispatch(tool, name, args, ctx, call) : call(ctx);
  };

  const facade = buildToolFacade(tools, dispatch, allowed, unknownRefs);
  const run = await runOrchestrationScript(script, facade, timeoutMs ? { timeoutMs } : {});
  return {
    ok: run.ok,
    summary: run.result,
    logs: run.logs,
    error: run.error,
    ...(unknownRefs && unknownRefs.length ? { unknownRefs } : {}),
    dryRun,
    plannedMutations,
  };
}
