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
import { type FieldMiss, type OrchestrationInputs, type SleepCap } from './run-script';
import { type StaticToolCall } from './parse-check';
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
    /** Bounded grace for host dispatches to settle after the script wall-clock budget expires. */
    timeoutGraceMs?: number;
    /**
     * Optional per-call context-rebinding hook (WI-1411) — see `WrapDispatch`.
     * Absent ⇒ every call in the batch dispatches under the fixed `ctx`
     * (pre-WI-1411 behavior), which stays correct for any caller whose binding
     * doesn't vary per call.
     */
    wrapDispatch?: WrapDispatch;
    /** Optional JSON-only runtime inputs, exposed inside the VM as deeply frozen `inputs`. */
    inputs?: OrchestrationInputs;
}
export interface PlannedMutation {
    tool: string;
    args: unknown;
}
export type WriteAttemptDisposition = 'in_flight' | 'settled' | 'semantic_rejected' | 'rejected' | 'uncertain';
/**
 * Runtime disposition of one committing write call. Unlike `plannedMutations` (which records
 * only that dispatch started), this remains honest when the vm times out while a host-side tool
 * promise is still pending. `index` is the zero-based dispatch order, so a sequential caller can
 * resume from an exact prefix without echoing sensitive/full call args into the result.
 */
export interface WriteAttempt {
    index: number;
    tool: string;
    disposition: WriteAttemptDisposition;
}
/**
 * A validated durable-output identity observed on an inner result. The preview
 * and owner fields from the model-facing reference envelope are deliberately
 * absent: a trace needs identity/integrity, not another copy of potentially
 * sensitive display text or an invocation-ephemeral owner id.
 */
export interface OrchestrationOutputReference {
    uri: string;
    byteCount: number;
    sha256: string;
    expiresAt?: string;
    audience?: 'owner' | 'workspace' | 'public';
}
export type OrchestrationCallDisposition = 'planned' | 'in_flight' | 'settled' | 'semantic_rejected' | 'rejected' | 'uncertain';
/**
 * Secret-free runtime evidence for one inner call. Arguments and results never
 * enter this record. The operator-side P-013 normalizer combines these records
 * with checkScript's static argument view before anything is persisted.
 */
export interface OrchestrationCallRecord {
    ordinal: number;
    tool: string;
    effect: 'read' | 'write' | 'unknown';
    disposition: OrchestrationCallDisposition;
    outputReferences: OrchestrationOutputReference[];
}
/**
 * Secret-free correlation for a host dispatch that did not settle during the timeout grace
 * window. The dispatch stack's callId is the same value sent to the host's start and telemetry
 * hooks, so a caller can inspect or reconcile exactly this call without guessing from tool name
 * or session identity. This is intentionally separate from callRecords: settled/rejected call
 * records keep their existing shape, while only genuinely detached calls need a callId.
 */
export interface DetachedOrchestrationCall {
    callId: string;
    tool: string;
    effect: OrchestrationCallRecord['effect'];
    ordinal: number;
    disposition: OrchestrationCallDisposition;
}
/**
 * Runtime-owned safety evidence for one orchestration run. This is deliberately
 * outside the script-authored summary: a script cannot prove its own authority
 * invariants by returning `authorityUnchanged: true`.
 *
 * The server runtime cannot observe prompts injected into a native client while
 * this call is in flight. Reporting that boundary explicitly is safer than
 * manufacturing an `unchanged` verdict from the absence of a server signal.
 */
export interface OrchestrationRuntimeObservations {
    authorizationObservationCount: number;
    authorityWideningDetected: boolean;
    midTurnPromptInjectionObservability: 'not-observable';
}
/** A statically ordered write that the script never reached after an earlier throw. */
export interface NotDispatchedWrite {
    tool: string;
    /** Explicitly false: this write never crossed the dispatcher boundary. */
    executed: false;
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
/** EI-10951: a write-effect call that THREW — recorded with why, so the caller can tell a
 *  provably-never-landed rejection from an honestly-uncertain one. */
export interface ThrownMutation {
    tool: string;
    args: unknown;
    error: string;
}
/** A child call that failed semantically or threw, regardless of read/write effect. */
export interface ChildFailure {
    tool: string;
    kind: 'semantic' | 'rejected' | 'uncertain';
    result?: unknown;
    error?: string;
}
/**
 * P-027: media a script explicitly elects to return to the model. This is deliberately
 * narrower than an arbitrary inner ToolResult: only image/audio data blocks are eligible,
 * and they cross the outer transport only when the FINAL script result uses the
 * `{ summary, media }` contract. Intermediate tool results never populate this array.
 */
export type CodeRunMediaContent = {
    type: 'image';
    data: string;
    mimeType: string;
    _meta?: Record<string, unknown>;
} | {
    type: 'audio';
    data: string;
    mimeType: string;
};
export interface OrchestrateResult {
    ok: boolean;
    /** The script's returned summary (what re-enters the model's context). */
    summary?: unknown;
    /** Validated image/audio blocks from an explicit final `{ summary, media }` result. */
    media?: CodeRunMediaContent[];
    /** Explicit store/load state, suitable for replay as the next invocation's bindings.values. */
    state?: OrchestrationInputs;
    logs: string[];
    error?: string;
    /** Set when the parse-check failed. */
    unknownRefs?: string[];
    dryRun: boolean;
    /** P-012 (census double-count): how many times the script actually ENTERED the host
     *  dispatcher — reads and writes alike, throwing calls included, dryRun-skipped writes
     *  and unknown-ref stub rejections excluded. Equals the number of inner
     *  tool_invocations rows this run produced, which is what a wrapper tool needs to
     *  mark its own row as a dispatch wrapper only when inner rows actually exist.
     *  Optional so pre-existing hand-built fixture results are unaffected;
     *  runToolOrchestration's own return always populates it. */
    dispatchCount?: number;
    /** Exact UTF-8 bytes of every child result that settled and entered the script
     *  runtime. Thrown dispatches have no result body and therefore add zero. */
    intermediateBytes?: number;
    /** Independent runtime evidence; never derived from the script's return value. */
    runtimeObservations: OrchestrationRuntimeObservations;
    /** Write-effect calls the script made (recorded in dryRun, observed otherwise).
     *  NOTE: recorded at DISPATCH time, so this includes calls that then threw — subtract
     *  `rejectedMutations` + `uncertainMutations` for the set that actually landed. */
    plannedMutations: PlannedMutation[];
    /** Runtime disposition for every non-dry-run write dispatch, in dispatch order. A timeout may
     * return entries as `in_flight`; those are UNKNOWN, not landed, until the caller verifies them. */
    writeAttempts?: WriteAttempt[];
    /** EI-10951: write-effect calls the dispatcher REJECTED before the handler ran (bad args,
     *  a denied gate). These provably wrote NOTHING — safe to fix and re-run. */
    rejectedMutations?: ThrownMutation[];
    /** EI-10951: write-effect calls that threw for some OTHER reason (a handler error, a
     *  timeout mid-flight). These MAY have partially landed — the honestly-uncertain set, and
     *  the only one that still warrants a "verify before you re-run" warning. */
    uncertainMutations?: ThrownMutation[];
    /** Write-effect calls that resolved with a top-level `ok: false` result (EI-7669). Always
     *  empty (or absent, on a hand-built fixture result predating this field) under dryRun
     *  (nothing executed yet) — runToolOrchestration's own return always populates it. Optional
     *  so pre-existing test fixtures constructing an OrchestrateResult literal don't all need
     *  updating; shapeMutationEcho defaults a missing value to `[]`. */
    okFalseMutations?: FailedMutation[];
    /** Every failed child call, including reads. This is the aggregate truth surface used by
     * wrappers/telemetry; mutation-specific arrays above remain the recovery/safety surface. */
    childFailures?: ChildFailure[];
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
    /**
     * P-020: write-effect tools the script ORDERED but that never dispatched at all, because
     * an earlier throw unwound the vm before reaching them. Present only on a failed run, and
     * only when non-empty. Distinct from every other mutation array here: those are recorded
     * at dispatch, so a call that never dispatched appears in NONE of them — this is the only
     * surface that can tell an author their trailing `work_items:checkpoint` never happened.
     * Provable set only (see `detectStrandedWrites`): a tool that ran at least once is omitted.
     */
    strandedWrites?: string[];
    /**
     * P-020 compatibility companion to `strandedWrites`. The legacy string list is useful for
     * concise human output but does not carry a disposition in its shape. This field makes the
     * recovery fact machine-readable: every listed write has `executed:false` because it never
     * dispatched at all. It is present only when `strandedWrites` is present.
     */
    notDispatchedWrites?: NotDispatchedWrite[];
    /**
     * EI-19301148486657755: reads of fields that do not exist on a tool result — the author asked
     * for `count` on a result whose key is `claimableCount`. Present only when non-empty.
     *
     * This is the FIELD-name counterpart of `unknownRefs` (wrong TOOL name). Both exist for the same
     * reason: the protection has to fire without the agent having predicted the mistake, because the
     * failure is silent — `undefined` reads as a legitimate absence, and the `?? null` fallbacks that
     * keep summaries bounded then launder it into a confident value.
     */
    fieldMisses?: FieldMiss[];
    /**
     * EI-19324793244855883: `sleep(ms)` calls the script made that asked for longer than the
     * sandbox's cap and were silently clamped. Present only when non-empty — see {@link SleepCap}.
     */
    sleepCaps?: SleepCap[];
    /**
     * Internal P-013 capture evidence. code:run and recipes:run remove this field
     * from their model-facing payloads after persisting the normalized trace.
     */
    callRecords?: OrchestrationCallRecord[];
    /** Host dispatches still unresolved after the bounded timeout settlement grace. */
    detachedCalls?: DetachedOrchestrationCall[];
}
/**
 * P-020 (fleet-leadership-continuity-and-actuation-2026-08-01) — name the writes that
 * NEVER RAN, not just the ones that failed.
 *
 * A thrown call aborts the vm script, so every `tools.ns.verb(...)` written AFTER it in
 * source order never dispatches at all. Those calls are invisible to every existing
 * recovery surface — `plannedMutations`/`rejected`/`uncertain` are all recorded AT
 * DISPATCH, and an unreached line never dispatched. So the result could say "1 call was
 * rejected, nothing was written" while silently omitting that the script had also ordered
 * a `work_items:checkpoint` that never happened. The agent reads "nothing written, safe to
 * re-run", fixes the typo'd read... and the continuity write it thought it had made is gone.
 *
 * EI-18717906460509995 already recognised this shape and added ORDERING_HINT — but that is a
 * MITIGATION ("write your durable calls first"), not a report: it tells the author how to
 * avoid the trap next time and still never says which write was stranded THIS time. This is
 * the missing read-side half.
 *
 * Sound by construction — it reports only the provable set. `checkScript` already resolves
 * every statically-visible facade reference to its canonical `ns:verb` (it runs anyway, for
 * `unknownRefs`), so this reuses that parse rather than adding a second, drifting one. A
 * write-effect tool named in the script with ZERO dispatches provably never ran. A tool that
 * dispatched at least once is deliberately NOT reported: inside a loop or a branch it may
 * have run some iterations and not others, and no static count can tell which — claiming
 * otherwise would be the same cry-wolf failure EI-10951 fixed in the warning next door.
 * Dynamic dispatch (`tools.call(someVar)`) is likewise invisible to the static parse and
 * simply not claimed.
 *
 * Source order is preserved so the report reads as the script does.
 *
 * PURE — unit-tested without a vm, PG, or a live dispatcher.
 */
export type ResolvedToolEffect = 'read' | 'write' | 'unknown';
/**
 * Resolve a projected tool's effect for one facade call. A classifier is
 * advisory metadata: malformed output or a thrown classifier must not turn a
 * safe static write into an executable dry-run call.
 */
export declare function resolveToolEffect(tool: Pick<ProjectedTool, 'effect' | 'effectForCall'>, args: unknown): ResolvedToolEffect;
export declare function detectStrandedWrites(staticCalls: readonly StaticToolCall[], tools: readonly ProjectedTool[], dispatchedToolNames: readonly string[]): string[];
export declare function runToolOrchestration(script: string, opts: OrchestrateOptions): Promise<OrchestrateResult>;
