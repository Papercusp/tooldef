"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toolArgsType = exports.listFacadeNamespaces = exports.generateToolFacadeTypes = exports.runToolOrchestration = exports.unwrapToolResult = exports.realDispatch = exports.ensureParseCheckReady = exports.checkScript = exports.runOrchestrationScript = exports.roleScopedToolNames = exports.facadeToolNames = exports.buildToolFacade = void 0;
/**
 * code-execution-tool-orchestration runtime (B-CX-1A / B-CX-2A).
 *
 * Public surface of the code-mode runtime: build a capability-scoped tool facade, run a
 * model-submitted orchestration script in a vm sandbox returning only its summary, statically
 * parse-check tool references, bind the facade to the real dispatcher, and compose them with the
 * dry-run/confirm gate (`runToolOrchestration`). The `code:run` agent tool is a thin wrapper.
 */
var tool_facade_1 = require("./tool-facade");
Object.defineProperty(exports, "buildToolFacade", { enumerable: true, get: function () { return tool_facade_1.buildToolFacade; } });
Object.defineProperty(exports, "facadeToolNames", { enumerable: true, get: function () { return tool_facade_1.facadeToolNames; } });
Object.defineProperty(exports, "roleScopedToolNames", { enumerable: true, get: function () { return tool_facade_1.roleScopedToolNames; } });
var run_script_1 = require("./run-script");
Object.defineProperty(exports, "runOrchestrationScript", { enumerable: true, get: function () { return run_script_1.runOrchestrationScript; } });
var parse_check_1 = require("./parse-check");
Object.defineProperty(exports, "checkScript", { enumerable: true, get: function () { return parse_check_1.checkScript; } });
Object.defineProperty(exports, "ensureParseCheckReady", { enumerable: true, get: function () { return parse_check_1.ensureParseCheckReady; } });
var dispatch_binding_1 = require("./dispatch-binding");
Object.defineProperty(exports, "realDispatch", { enumerable: true, get: function () { return dispatch_binding_1.realDispatch; } });
Object.defineProperty(exports, "unwrapToolResult", { enumerable: true, get: function () { return dispatch_binding_1.unwrapToolResult; } });
var orchestrate_1 = require("./orchestrate");
Object.defineProperty(exports, "runToolOrchestration", { enumerable: true, get: function () { return orchestrate_1.runToolOrchestration; } });
// B-CX-API: compile-time typed signatures for the facade + the on-demand namespace index.
var facade_types_1 = require("./facade-types");
Object.defineProperty(exports, "generateToolFacadeTypes", { enumerable: true, get: function () { return facade_types_1.generateToolFacadeTypes; } });
Object.defineProperty(exports, "listFacadeNamespaces", { enumerable: true, get: function () { return facade_types_1.listFacadeNamespaces; } });
Object.defineProperty(exports, "toolArgsType", { enumerable: true, get: function () { return facade_types_1.toolArgsType; } });
