/**
 * code-execution-tool-orchestration runtime (B-CX-1A / B-CX-2A).
 *
 * Public surface of the code-mode runtime: build a capability-scoped tool facade, run a
 * model-submitted orchestration script in a vm sandbox returning only its summary, statically
 * parse-check tool references, bind the facade to the real dispatcher, and compose them with the
 * dry-run/confirm gate (`runToolOrchestration`). The `code:run` agent tool is a thin wrapper.
 */
export { buildToolFacade, facadeToolNames, roleScopedToolNames, } from './tool-facade';
export { runOrchestrationScript, } from './run-script';
export { checkScript, ensureParseCheckReady } from './parse-check';
export { realDispatch, unwrapToolResult } from './dispatch-binding';
export { runToolOrchestration, } from './orchestrate';
// B-CX-API: compile-time typed signatures for the facade + the on-demand namespace index.
export { generateToolFacadeTypes, listFacadeNamespaces, toolArgsType, } from './facade-types';
