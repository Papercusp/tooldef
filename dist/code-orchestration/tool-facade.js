"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.camelVerb = camelVerb;
exports.buildToolFacade = buildToolFacade;
exports.facadeToolNames = facadeToolNames;
exports.roleScopedToolNames = roleScopedToolNames;
/**
 * `wake-queue` / `set_status` → `wakeQueue` / `setStatus` (a valid JS identifier).
 * Exported so the COMPILE-TIME signature generator (facade-types.ts, B-CX-API) names verbs
 * identically to this RUNTIME facade — the two must never disagree.
 */
function camelVerb(verb) {
    return verb.replace(/[-_]+([a-z0-9])/gi, (_m, c) => c.toUpperCase());
}
/**
 * Build the `tools` facade the sandbox injects. One callable per ALLOWED tool, both
 * namespaced (`tools.ns.verb`) and flat (`tools.call('ns:verb', …)`). Tools outside `allowed`
 * are absent. Returns an empty-but-callable facade if `tools` is empty.
 */
function buildToolFacade(tools, dispatch, allowed) {
    const byName = new Map();
    const facade = {
        async call(toolName, args) {
            const tool = byName.get(toolName);
            if (!tool) {
                throw new Error(`code-orchestration: tool not available in this sandbox: ${toolName}`);
            }
            return dispatch(tool, toolName, args ?? {});
        },
    };
    for (const tool of tools) {
        const name = tool.expose?.mcp?.name;
        if (!name)
            continue;
        const ci = name.indexOf(':');
        if (ci <= 0)
            continue; // skip names without a `ns:verb` shape
        if (allowed && !allowed.has(name))
            continue;
        byName.set(name, tool);
        const ns = name.slice(0, ci);
        const verb = camelVerb(name.slice(ci + 1));
        if (ns === 'call')
            continue; // never shadow the escape hatch
        const bucket = (facade[ns] ??= {});
        bucket[verb] = (args) => dispatch(tool, name, args ?? {});
    }
    return facade;
}
/** Names of the tools exposed by a facade (for parse-checks + prompt catalogs). */
function facadeToolNames(tools, allowed) {
    const out = [];
    for (const tool of tools) {
        const name = tool.expose?.mcp?.name;
        if (!name || name.indexOf(':') <= 0)
            continue;
        if (allowed && !allowed.has(name))
            continue;
        out.push(name);
    }
    return out.sort();
}
/**
 * The role-scoped allowed set BOTH code-mode meta-tools (`code:run`, `code:tools`) build before
 * handing the facade/signatures to a script: the MCP names of every tool whose `agentRoles` admit
 * `role`, minus an `exclude` set (the meta-tools exclude THEMSELVES so a script can't recursively
 * nest code-mode). A tool with no `agentRoles` (or an empty list) is role-open — included for any
 * role. This MIRRORS the dispatcher's role-allowlist gate (`dispatch-stack.ts` / `listMcpProjections`)
 * so the facade a script can reference is exactly the set the dispatcher would let it call — the
 * envelope IS the security boundary, so the two must never disagree.
 *
 * Extracted from the identical loop that lived inline in both `code/run.ts` and `code/tools.ts`
 * (code-execution-tool-orchestration) so the scoping has ONE definition + a hermetic unit test.
 */
function roleScopedToolNames(tools, role, exclude) {
    const allowed = new Set();
    for (const tool of tools) {
        const name = tool.expose?.mcp?.name;
        if (!name)
            continue;
        if (exclude?.has(name))
            continue;
        const roles = tool.agentRoles;
        const roleOk = !roles || roles.length === 0 || (role != null && roles.includes(role));
        if (roleOk)
            allowed.add(name);
    }
    return allowed;
}
