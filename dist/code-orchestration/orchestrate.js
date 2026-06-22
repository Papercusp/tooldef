"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runToolOrchestration = runToolOrchestration;
const tool_facade_1 = require("./tool-facade");
const dispatch_binding_1 = require("./dispatch-binding");
const run_script_1 = require("./run-script");
const parse_check_1 = require("./parse-check");
async function runToolOrchestration(script, opts) {
    const { ctx, deps, tools, allowed, dryRun = false, timeoutMs } = opts;
    const plannedMutations = [];
    const check = (0, parse_check_1.checkScript)(script, tools, allowed);
    if (!check.ok) {
        return {
            ok: false,
            logs: [],
            error: `unknown_tools: ${check.unknownRefs.join(', ')}`,
            unknownRefs: check.unknownRefs,
            dryRun,
            plannedMutations,
        };
    }
    const inner = (0, dispatch_binding_1.realDispatch)(ctx, deps);
    const dispatch = async (tool, name, args) => {
        if (tool.effect === 'write') {
            plannedMutations.push({ tool: name, args });
            if (dryRun) {
                return { dryRun: true, wouldCall: name, args };
            }
        }
        return inner(tool, name, args);
    };
    const facade = (0, tool_facade_1.buildToolFacade)(tools, dispatch, allowed);
    const run = await (0, run_script_1.runOrchestrationScript)(script, facade, timeoutMs ? { timeoutMs } : {});
    return {
        ok: run.ok,
        summary: run.result,
        logs: run.logs,
        error: run.error,
        dryRun,
        plannedMutations,
    };
}
