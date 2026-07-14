import { buildToolFacade } from './tool-facade';
import { realDispatch, isPreExecutionFailure } from './dispatch-binding';
import { runOrchestrationScript } from './run-script';
import { checkScript, ensureParseCheckReady } from './parse-check';
/** True when `value` is a plain object carrying a top-level `ok: false` — the tool's own
 *  reported semantic failure, as distinct from a dispatch-level throw (already handled by
 *  realDispatch before the result ever reaches here). */
function isOkFalseResult(value) {
    return (typeof value === 'object' &&
        value !== null &&
        'ok' in value &&
        value.ok === false);
}
export async function runToolOrchestration(script, opts) {
    const { ctx, deps, tools, allowed, dryRun = false, timeoutMs, wrapDispatch } = opts;
    const plannedMutations = [];
    const okFalseMutations = [];
    const childFailures = [];
    // EI-10951: a write that THREW never landed (rejected) or may have (uncertain) — but it
    // certainly was not "already executed", which is what we used to tell the caller.
    const rejectedMutations = [];
    const uncertainMutations = [];
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
    const dispatch = async (tool, name, args) => {
        if (tool.effect === 'write') {
            plannedMutations.push({ tool: name, args });
            if (dryRun) {
                return { dryRun: true, wouldCall: name, args };
            }
        }
        const call = (callCtx) => realDispatch(callCtx, deps)(tool, name, args);
        try {
            const result = await (wrapDispatch ? wrapDispatch(tool, name, args, ctx, call) : call(ctx));
            // EI-7669: realDispatch only throws on a dispatch-level failure — a tool that dispatched fine
            // but reports its OWN semantic rejection (ok: false in its result body, e.g. a completion-
            // integrity check) resolves normally here. Tally those so a batched script that doesn't check
            // every result still gets visibility instead of silently counting the write as executed.
            if (isOkFalseResult(result)) {
                childFailures.push({ tool: name, kind: 'semantic', result });
                if (tool.effect === 'write') {
                    okFalseMutations.push({ tool: name, args, result });
                }
            }
            return result;
        }
        catch (err) {
            // EI-10951: a write-effect call that THREW was still being counted as "already
            // executed", so a typo'd argument produced a scary — and false — "N writes already
            // landed, do NOT re-run" warning. Record WHY it threw: a pre-execution rejection
            // (bad args, a denied gate) provably wrote nothing and is safe to re-run, while any
            // other throw stays UNKNOWN and keeps the loud warning it deserves.
            const preExecution = isPreExecutionFailure(err);
            childFailures.push({
                tool: name,
                kind: preExecution ? 'rejected' : 'uncertain',
                error: err instanceof Error ? err.message : String(err),
            });
            if (tool.effect === 'write') {
                (preExecution ? rejectedMutations : uncertainMutations).push({
                    tool: name,
                    args,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            throw err;
        }
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
        okFalseMutations,
        childFailures,
        ...(rejectedMutations.length ? { rejectedMutations } : {}),
        ...(uncertainMutations.length ? { uncertainMutations } : {}),
        // EI-7784: surfaced independent of `ok` — see the field doc above.
        partial: run.ok && childFailures.length > 0,
    };
}
