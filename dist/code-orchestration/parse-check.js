"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkScript = checkScript;
/**
 * code-execution-tool-orchestration B-CX-1A / B-CX-PARSE — static PARSE-CHECK.
 *
 * A fast-fail, pre-execution guard: walks the script's TypeScript AST for references to the
 * injected `tools` facade and reports any that aren't in the agent's allowed set. It resolves the
 * normal forms — `tools.<ns>.<verb>(…)` and the `tools.call('<ns>:<verb>', …)` escape hatch — and
 * also the obfuscated-but-static forms a regex misses:
 *
 *   - computed string-literal access:  `tools['sys']['admin']`, `tools['work_items'].list`
 *   - `tools` aliasing:                `const t = tools; t.sys.admin()`
 *   - namespace / verb destructuring:  `const { coord } = tools; coord.wakeQueue()`
 *                                      `const { list } = tools.work_items; list()`
 *
 * This turns the common typo / disallowed-tool case (incl. an obfuscation attempt) into a clean
 * upfront error listing the offenders, before any tool runs.
 *
 * NOT a security boundary. The runtime WHITELIST in the facade (a disallowed tool is simply
 * absent, and `tools.call` throws on an unknown name) is the boundary; this static walk is a UX +
 * telemetry aid layered on top (the plan §8 consensus). It resolves everything STATICALLY
 * determinable; genuinely dynamic access (`tools[runtimeVar]`, `tools.call(runtimeVar)`) is left
 * to the runtime whitelist by design and is NOT flagged here. If parsing ever fails the walk falls
 * back to a regex scan so the aid degrades gracefully rather than failing open.
 */
const typescript_1 = __importDefault(require("typescript"));
/** `wake-queue` / `set_status` → `wakeQueue` / `setStatus` (the facade's JS-identifier keys). */
const camelVerb = (verb) => verb.replace(/[-_]+([a-z0-9])/gi, (_m, c) => c.toUpperCase());
function checkScript(script, tools, allowed) {
    const memberToName = new Map(); // "ns.camelVerb" → full name
    const fullNames = new Set();
    for (const t of tools) {
        const name = t.expose?.mcp?.name;
        if (!name || name.indexOf(':') <= 0)
            continue;
        if (allowed && !allowed.has(name))
            continue;
        const ci = name.indexOf(':');
        memberToName.set(`${name.slice(0, ci)}.${camelVerb(name.slice(ci + 1))}`, name);
        fullNames.add(name);
    }
    const refs = new Set();
    const unknown = new Set();
    const recordMember = (member) => {
        refs.add(member);
        if (!memberToName.has(member))
            unknown.add(member);
    };
    const recordFull = (name) => {
        refs.add(name);
        if (!fullNames.has(name))
            unknown.add(name);
    };
    let source;
    try {
        source = typescript_1.default.createSourceFile('script.ts', script, typescript_1.default.ScriptTarget.Latest, false, typescript_1.default.ScriptKind.TS);
    }
    catch {
        return regexFallback(script, memberToName, fullNames);
    }
    // Binding maps, populated in source order during the walk. Straight-line scripts declare an
    // alias (`const t = tools`) before they use it, and chained bindings (`const w = tools.x; const
    // f = w.y`) resolve because the walk is depth-first in source order. The runtime whitelist is
    // the real boundary, so an unusual out-of-order binding that this misses is caught there.
    const toolsAliases = new Set(['tools']);
    const nsBindings = new Map(); // ident → ns
    const funcBindings = new Map(); // ident → "ns.camelVerb" member
    const literalKey = (node) => typescript_1.default.isStringLiteralLike(node) ? node.text : null;
    /** One property step within the facade, given the resolved base. */
    const step = (base, prop) => {
        if (base.kind === 'tools') {
            // `tools.call` is the escape hatch, never a namespace (mirrors buildToolFacade).
            return prop === 'call' ? { kind: 'callHatch' } : { kind: 'ns', ns: prop };
        }
        if (base.kind === 'ns')
            return { kind: 'member', member: `${base.ns}.${prop}` };
        return null; // 'member' / 'callHatch' have no further facade step
    };
    /** Resolve an expression to a facade position, or null if it isn't one / is dynamically computed. */
    const resolve = (node) => {
        if (typescript_1.default.isParenthesizedExpression(node) || typescript_1.default.isNonNullExpression(node)) {
            return resolve(node.expression);
        }
        if (typescript_1.default.isIdentifier(node)) {
            const n = node.text;
            if (toolsAliases.has(n))
                return { kind: 'tools' };
            const ns = nsBindings.get(n);
            if (ns !== undefined)
                return { kind: 'ns', ns };
            const member = funcBindings.get(n);
            if (member !== undefined)
                return { kind: 'member', member };
            return null;
        }
        if (typescript_1.default.isPropertyAccessExpression(node)) {
            const base = resolve(node.expression);
            return base ? step(base, node.name.text) : null;
        }
        if (typescript_1.default.isElementAccessExpression(node)) {
            const base = resolve(node.expression);
            if (!base)
                return null;
            const key = literalKey(node.argumentExpression);
            return key == null ? null : step(base, key); // dynamic key → unresolvable → runtime boundary
        }
        return null;
    };
    const bindElements = (pattern, r) => {
        for (const el of pattern.elements) {
            if (!typescript_1.default.isIdentifier(el.name))
                continue; // nested patterns aren't facade bindings
            const local = el.name.text;
            const pn = el.propertyName;
            const key = pn && typescript_1.default.isIdentifier(pn)
                ? pn.text
                : pn && typescript_1.default.isStringLiteralLike(pn)
                    ? pn.text
                    : local;
            if (r.kind === 'tools') {
                if (key === 'call')
                    continue; // destructured escape hatch — not a namespace
                nsBindings.set(local, key);
            }
            else {
                funcBindings.set(local, `${r.ns}.${key}`);
            }
        }
    };
    const visit = (node) => {
        // 1) Binding collection (source order, before this node's own references are recorded).
        if (typescript_1.default.isVariableDeclaration(node) && node.initializer) {
            const r = resolve(node.initializer);
            if (r) {
                if (typescript_1.default.isIdentifier(node.name)) {
                    if (r.kind === 'tools')
                        toolsAliases.add(node.name.text);
                    else if (r.kind === 'ns')
                        nsBindings.set(node.name.text, r.ns);
                    else if (r.kind === 'member')
                        funcBindings.set(node.name.text, r.member);
                }
                else if (typescript_1.default.isObjectBindingPattern(node.name) && (r.kind === 'tools' || r.kind === 'ns')) {
                    bindElements(node.name, r);
                }
            }
        }
        // 2) Reference recording.
        if (typescript_1.default.isCallExpression(node)) {
            const r = resolve(node.expression);
            if (r?.kind === 'callHatch') {
                const name = node.arguments[0] ? literalKey(node.arguments[0]) : null;
                if (name != null)
                    recordFull(name); // dynamic arg → runtime boundary
            }
            else if (r?.kind === 'member') {
                recordMember(r.member);
            }
        }
        else if (typescript_1.default.isPropertyAccessExpression(node) || typescript_1.default.isElementAccessExpression(node)) {
            const r = resolve(node);
            if (r?.kind === 'member')
                recordMember(r.member);
        }
        typescript_1.default.forEachChild(node, visit);
    };
    visit(source);
    return { ok: unknown.size === 0, unknownRefs: [...unknown].sort(), refs: [...refs].sort() };
}
/** Degrade gracefully if AST parsing ever throws: the original regex scan (dotted + call only). */
function regexFallback(script, memberToName, fullNames) {
    const refs = new Set();
    const unknown = new Set();
    for (const m of script.matchAll(/\btools\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
        if (m[1] === 'call')
            continue;
        const member = `${m[1]}.${m[2]}`;
        refs.add(member);
        if (!memberToName.has(member))
            unknown.add(member);
    }
    for (const m of script.matchAll(/\btools\.call\(\s*['"`]([^'"`]+)['"`]/g)) {
        refs.add(m[1]);
        if (!fullNames.has(m[1]))
            unknown.add(m[1]);
    }
    return { ok: unknown.size === 0, unknownRefs: [...unknown].sort(), refs: [...refs].sort() };
}
