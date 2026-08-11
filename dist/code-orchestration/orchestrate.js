import { buildToolFacade } from './tool-facade';
import { realDispatch, isPreExecutionFailure } from './dispatch-binding';
import { runOrchestrationScript } from './run-script';
import { checkScript, ensureParseCheckReady } from './parse-check';
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
export function detectStrandedWrites(staticCalls, tools, dispatchedToolNames) {
    // `expose.mcp.name` is the canonical projected name — the SAME accessor buildToolFacade and
    // facadeToolNames use, and the one `checkScript` resolves its `calls` against. A ProjectedTool
    // has no top-level `.name`; reading one yields `undefined` for every tool, which silently
    // empties this set and makes the whole detector a no-op that still passes any unit test whose
    // fixture invents the field. (It did exactly that until an end-to-end run caught it.)
    const writeEffect = new Set(tools
        .filter((t) => t.effect === 'write')
        .map((t) => t.expose?.mcp?.name)
        .filter((n) => typeof n === 'string'));
    const dispatched = new Set(dispatchedToolNames);
    const stranded = [];
    const seen = new Set();
    for (const call of staticCalls) {
        const name = call.tool;
        if (!writeEffect.has(name))
            continue; // reads are re-runnable; only writes strand
        if (dispatched.has(name))
            continue; // ran at least once — cannot prove anything about the rest
        if (seen.has(name))
            continue;
        seen.add(name);
        stranded.push(name);
    }
    return stranded;
}
/** True when `value` is a plain object carrying a top-level `ok: false` — the tool's own
 *  reported semantic failure, as distinct from a dispatch-level throw (already handled by
 *  realDispatch before the result ever reaches here). */
function isOkFalseResult(value) {
    return (typeof value === 'object' &&
        value !== null &&
        'ok' in value &&
        value.ok === false);
}
/**
 * True when `value` is a house BULK envelope (`{ ok: true, results: [...], counts: { failed } }`
 * — the keyed-array bulk contract, `_bulk.ts`'s `runBulk`/`bulkContent`) reporting at least one
 * per-item failure. By that contract's OWN design the top-level `ok` is ALWAYS `true` ("the batch
 * ran"; `counts.failed` is where per-item truth lives), so `isOkFalseResult` alone never catches a
 * partial bulk failure (EI-18664105352441219: `plans:add-item` against a non-existent plan
 * returned `{ ok:true, results:[{ ok:false, error:'not_found' }], counts:{ ok:0, failed:1 } }`,
 * and a batched script's own mutation tally read it as a landed write — `code:run` reported
 * `mutations:{ count:1 }` for a write that never happened). Detecting this here, once, covers
 * every one of the ~64 existing bulk-contract tools (and any future one) without each having to
 * special-case its own top-level `ok`.
 */
function isBulkPartialFailure(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const v = value;
    if (v.ok !== true || !Array.isArray(v.results))
        return false;
    const counts = v.counts;
    if (typeof counts !== 'object' || counts === null)
        return false;
    const failed = counts.failed;
    return typeof failed === 'number' && failed > 0;
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
            if (isOkFalseResult(result) || isBulkPartialFailure(result)) {
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
    // P-020: only meaningful when the script ABORTED — a run that completed reached every line
    // it was going to, so an undispatched write there was a branch not taken, not a stranding.
    const strandedWrites = run.ok
        ? []
        : detectStrandedWrites(check.calls, tools, plannedMutations.map((m) => m.tool));
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
        ...(strandedWrites.length ? { strandedWrites } : {}),
        ...(run.fieldMisses?.length ? { fieldMisses: run.fieldMisses } : {}),
        ...(run.sleepCaps?.length ? { sleepCaps: run.sleepCaps } : {}),
        // EI-7784: surfaced independent of `ok` — see the field doc above.
        partial: run.ok && childFailures.length > 0,
    };
}
