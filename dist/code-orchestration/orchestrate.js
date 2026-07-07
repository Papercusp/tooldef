"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runToolOrchestration = runToolOrchestration;
const tool_facade_1 = require("./tool-facade");
const dispatch_binding_1 = require("./dispatch-binding");
const run_script_1 = require("./run-script");
const parse_check_1 = require("./parse-check");
/** True when `value` is a plain object carrying a top-level `ok: false` — the tool's own
 *  reported semantic failure, as distinct from a dispatch-level throw (already handled by
 *  realDispatch before the result ever reaches here). */
function isOkFalseResult(value) {
    return (typeof value === 'object' &&
        value !== null &&
        'ok' in value &&
        value.ok === false);
}
async function runToolOrchestration(script, opts) {
    const { ctx, deps, tools, allowed, dryRun = false, timeoutMs, wrapDispatch } = opts;
    const plannedMutations = [];
    const okFalseMutations = [];
    await (0, parse_check_1.ensureParseCheckReady)(); // lazy-load the TS compiler before the static parse-check (kept out of the eager client bundle)
    const check = (0, parse_check_1.checkScript)(script, tools, allowed);
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
        const call = (callCtx) => (0, dispatch_binding_1.realDispatch)(callCtx, deps)(tool, name, args);
        const result = await (wrapDispatch ? wrapDispatch(tool, name, args, ctx, call) : call(ctx));
        // EI-7669: realDispatch only throws on a dispatch-level failure — a tool that dispatched fine
        // but reports its OWN semantic rejection (ok: false in its result body, e.g. a completion-
        // integrity check) resolves normally here. Tally those so a batched script that doesn't check
        // every result still gets visibility instead of silently counting the write as executed.
        if (tool.effect === 'write' && isOkFalseResult(result)) {
            okFalseMutations.push({ tool: name, args, result });
        }
        return result;
    };
    const facade = (0, tool_facade_1.buildToolFacade)(tools, dispatch, allowed, unknownRefs);
    const run = await (0, run_script_1.runOrchestrationScript)(script, facade, timeoutMs ? { timeoutMs } : {});
    return {
        ok: run.ok,
        summary: run.result,
        logs: run.logs,
        error: run.error,
        ...(unknownRefs && unknownRefs.length ? { unknownRefs } : {}),
        dryRun,
        plannedMutations,
        okFalseMutations,
        // EI-7784: surfaced independent of `ok` — see the field doc above.
        partial: okFalseMutations.length > 0,
    };
}
