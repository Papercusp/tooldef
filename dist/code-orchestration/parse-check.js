"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureParseCheckReady = ensureParseCheckReady;
exports.checkScript = checkScript;
const tool_facade_1 = require("./tool-facade");
let _ts = null;
/** Lazily load the TS compiler (kept out of the eager client bundle). Await once before checkScript(). Idempotent. */
async function ensureParseCheckReady() {
    if (!_ts) {
        const m = (await Promise.resolve().then(() => __importStar(require('typescript'))));
        _ts = (m.default ?? m);
    }
}
function tsc() {
    if (!_ts) {
        throw new Error('parse-check: ensureParseCheckReady() must be awaited before checkScript() (the TS compiler is lazy-loaded to keep it out of the eager client bundle)');
    }
    return _ts;
}
function checkScript(script, tools, allowed) {
    const ts = tsc(); // lazy-loaded TS compiler (see ensureParseCheckReady)
    const memberToName = new Map(); // "ns.camelVerb" → full name
    const fullNames = new Set();
    for (const t of tools) {
        const name = t.expose?.mcp?.name;
        if (!name || name.indexOf(':') <= 0)
            continue;
        if (allowed && !allowed.has(name))
            continue;
        const ci = name.indexOf(':');
        memberToName.set(`${(0, tool_facade_1.camelNamespace)(name.slice(0, ci))}.${(0, tool_facade_1.camelVerb)(name.slice(ci + 1))}`, name);
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
        source = ts.createSourceFile('script.ts', script, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
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
    const literalKey = (node) => ts.isStringLiteralLike(node) ? node.text : null;
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
        if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
            return resolve(node.expression);
        }
        if (ts.isIdentifier(node)) {
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
        if (ts.isPropertyAccessExpression(node)) {
            const base = resolve(node.expression);
            return base ? step(base, node.name.text) : null;
        }
        if (ts.isElementAccessExpression(node)) {
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
            if (!ts.isIdentifier(el.name))
                continue; // nested patterns aren't facade bindings
            const local = el.name.text;
            const pn = el.propertyName;
            const key = pn && ts.isIdentifier(pn)
                ? pn.text
                : pn && ts.isStringLiteralLike(pn)
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
        if (ts.isVariableDeclaration(node) && node.initializer) {
            const r = resolve(node.initializer);
            if (r) {
                if (ts.isIdentifier(node.name)) {
                    if (r.kind === 'tools')
                        toolsAliases.add(node.name.text);
                    else if (r.kind === 'ns')
                        nsBindings.set(node.name.text, r.ns);
                    else if (r.kind === 'member')
                        funcBindings.set(node.name.text, r.member);
                }
                else if (ts.isObjectBindingPattern(node.name) && (r.kind === 'tools' || r.kind === 'ns')) {
                    bindElements(node.name, r);
                }
            }
        }
        // 2) Reference recording.
        if (ts.isCallExpression(node)) {
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
        else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
            const r = resolve(node);
            if (r?.kind === 'member')
                recordMember(r.member);
        }
        ts.forEachChild(node, visit);
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
