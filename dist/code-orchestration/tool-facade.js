"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.camelNamespace = camelNamespace;
exports.camelVerb = camelVerb;
exports.buildToolFacade = buildToolFacade;
exports.facadeToolNames = facadeToolNames;
exports.roleScopedToolNames = roleScopedToolNames;
/**
 * `work_items` / `wake-queue` / `set_status` → `workItems` / `wakeQueue` / `setStatus`
 * (valid JS identifiers).
 * Exported so the COMPILE-TIME signature generator (facade-types.ts, B-CX-API) names verbs
 * identically to this RUNTIME facade — the two must never disagree.
 */
function camelNamespace(ns) {
    return ns.replace(/[-_]+([a-z0-9])/gi, (_m, c) => c.toUpperCase());
}
function camelVerb(verb) {
    return verb.replace(/[-_]+([a-z0-9])/gi, (_m, c) => c.toUpperCase());
}
/**
 * Build the `tools` facade the sandbox injects. One callable per ALLOWED tool, both
 * namespaced (`tools.camelNamespace.camelVerb`) and flat (`tools.call('ns:verb', …)`).
 * Tools outside `allowed` are absent. Returns an empty-but-callable facade if `tools` is empty.
 */
function buildToolFacade(tools, dispatch, allowed, 
/** Parse-check UNKNOWN refs (`ns.verb` dotted or `ns:verb` full). Each is bound to a stub that
 *  REJECTS only when called, so an unknown `tools.ns.verb` fails PER-CALL — isolable via
 *  Promise.allSettled / try-catch — instead of throwing a cryptic "cannot read undefined" that
 *  aborts a whole Promise.all (autonomous-loop-hardening F8/H2). */
unknownRefs) {
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
        const rawNs = name.slice(0, ci);
        const ns = camelNamespace(rawNs);
        const verb = camelVerb(name.slice(ci + 1));
        if (rawNs === 'call' || ns === 'call')
            continue; // never shadow the escape hatch
        const bucket = (facade[ns] ??= {});
        bucket[verb] = (args) => dispatch(tool, name, args ?? {});
    }
    // F8 (autonomous-loop-hardening / H2): bind each parse-check UNKNOWN ref to a stub that REJECTS
    // only when called, so an unknown `tools.ns.verb` fails PER-CALL (isolable) rather than throwing
    // a cryptic "cannot read undefined" that aborts a sibling Promise.all. Never shadows a real verb
    // (unknown refs aren't real by definition). The `tools.call('ns:verb')` hatch already rejects
    // clearly via the `call` handler above, so only the dotted `tools.ns.verb` form needs a stub.
    if (unknownRefs) {
        for (const ref of unknownRefs) {
            const ci = ref.indexOf(':');
            const di = ref.indexOf('.');
            const sep = ci >= 0 ? ci : di; // `ns:verb` (call-hatch full name) or `ns.verb` (dotted access)
            if (sep <= 0)
                continue;
            const ns = camelNamespace(ref.slice(0, sep));
            if (ns === 'call')
                continue; // never shadow the escape hatch
            const rawVerb = ref.slice(sep + 1);
            const verb = camelVerb(rawVerb);
            const bucket = (facade[ns] ??= {});
            if (bucket[verb] === undefined) {
                bucket[verb] = () => Promise.reject(new Error(`code-orchestration: tool not available in this sandbox: ${ns}:${rawVerb} — not in your ` +
                    `allowed facade (fix the tools.${ns}.${verb} name; see unknownRefs/facadeHelp). Wrap it in ` +
                    `Promise.allSettled or try/catch so sibling calls still return.`));
            }
        }
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
