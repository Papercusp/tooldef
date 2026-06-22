"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toolArgsType = toolArgsType;
exports.generateToolFacadeTypes = generateToolFacadeTypes;
exports.listFacadeNamespaces = listFacadeNamespaces;
const tool_facade_1 = require("./tool-facade");
/** Default nesting depth before a deep/recursive schema collapses to `Record<string, unknown>`. */
const DEFAULT_MAX_DEPTH = 8;
/** Truncation cap for the per-signature description comment (token economy). */
const DESC_MAX = 120;
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isValidIdent = (k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);
/** Quote an object-literal key only when it is not already a valid JS identifier. */
function renderKey(key) {
    return isValidIdent(key) ? key : JSON.stringify(key);
}
/** A JSON enum/const value → its TS literal form. */
function literal(v) {
    if (typeof v === 'string')
        return JSON.stringify(v);
    if (typeof v === 'number' || typeof v === 'boolean' || v === null)
        return String(v);
    return 'unknown';
}
/** De-duplicate union/intersection members, preserving order. */
function uniq(parts) {
    const seen = new Set();
    const out = [];
    for (const p of parts) {
        if (!seen.has(p)) {
            seen.add(p);
            out.push(p);
        }
    }
    return out;
}
/** Map a single JSON-Schema primitive `type` to its TS type. */
function primitiveType(t) {
    switch (t) {
        case 'string':
            return 'string';
        case 'number':
        case 'integer':
            return 'number';
        case 'boolean':
            return 'boolean';
        case 'null':
            return 'null';
        case 'array':
            return 'unknown[]';
        case 'object':
            return 'Record<string, unknown>';
        default:
            return 'unknown';
    }
}
/** Resolve a `$ref` like `#/$defs/Name` or `#/definitions/Name` against the root `$defs`. */
function resolveRef(ref, defs) {
    const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
    if (!m)
        return undefined;
    return defs[m[1]];
}
/**
 * Render one JSON-Schema node to a TS type string.
 * `defs` is the root schema's `$defs`/`definitions` (for `$ref` resolution).
 */
function schemaToTs(schema, depth, defs, maxDepth) {
    if (!isObj(schema))
        return 'unknown';
    if (depth > maxDepth)
        return 'unknown';
    // $ref → resolve against root defs (cycle-safe via the depth cap).
    if (typeof schema.$ref === 'string') {
        const target = resolveRef(schema.$ref, defs);
        return target ? schemaToTs(target, depth + 1, defs, maxDepth) : 'unknown';
    }
    // const / enum → literal unions.
    if ('const' in schema)
        return literal(schema.const);
    if (Array.isArray(schema.enum)) {
        const members = uniq(schema.enum.map(literal));
        return members.length ? members.join(' | ') : 'never';
    }
    // Combinators.
    if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
        const variants = (schema.anyOf ?? schema.oneOf);
        const parts = uniq(variants.map((v) => schemaToTs(v, depth + 1, defs, maxDepth)));
        return parts.length ? parts.map((p) => (p.includes('|') ? `(${p})` : p)).join(' | ') : 'unknown';
    }
    if (Array.isArray(schema.allOf)) {
        const parts = uniq(schema.allOf.map((v) => schemaToTs(v, depth + 1, defs, maxDepth)));
        return parts.length ? parts.join(' & ') : 'unknown';
    }
    // `nullable: true` (draft-07 / OpenAPI flavor) widens with null.
    const nullableSuffix = schema.nullable === true ? ' | null' : '';
    // `type` may be a string or an array of types (e.g. ["string","null"]).
    const t = schema.type;
    if (Array.isArray(t)) {
        const parts = uniq(t.map((one) => one === 'object' || one === 'array'
            ? schemaToTs({ ...schema, type: one }, depth, defs, maxDepth)
            : primitiveType(String(one))));
        return parts.join(' | ');
    }
    if (t === 'array') {
        const items = schema.items;
        if (Array.isArray(items)) {
            // Tuple form.
            const parts = items.map((it) => schemaToTs(it, depth + 1, defs, maxDepth));
            return `[${parts.join(', ')}]${nullableSuffix}`;
        }
        const inner = items ? schemaToTs(items, depth + 1, defs, maxDepth) : 'unknown';
        return `Array<${inner}>${nullableSuffix}`;
    }
    if (t === 'object' || isObj(schema.properties) || schema.additionalProperties !== undefined) {
        return objectToTs(schema, depth, defs, maxDepth) + nullableSuffix;
    }
    if (typeof t === 'string')
        return primitiveType(t) + nullableSuffix;
    return 'unknown';
}
/** Render a JSON-Schema object node to a TS object/record type. */
function objectToTs(schema, depth, defs, maxDepth) {
    if (depth >= maxDepth)
        return 'Record<string, unknown>';
    const props = isObj(schema.properties) ? schema.properties : undefined;
    const ap = schema.additionalProperties;
    // Record shape: no declared properties, but a value schema on additionalProperties (z.record).
    const hasProps = props && Object.keys(props).length > 0;
    if (!hasProps) {
        if (isObj(ap))
            return `Record<string, ${schemaToTs(ap, depth + 1, defs, maxDepth)}>`;
        if (ap === false)
            return '{}';
        return 'Record<string, unknown>';
    }
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields = [];
    for (const [key, propSchema] of Object.entries(props)) {
        const optional = required.has(key) ? '' : '?';
        fields.push(`${renderKey(key)}${optional}: ${schemaToTs(propSchema, depth + 1, defs, maxDepth)}`);
    }
    // An open record (additionalProperties is a schema) alongside declared props → add an index sig.
    if (isObj(ap))
        fields.push(`[k: string]: ${schemaToTs(ap, depth + 1, defs, maxDepth)} | unknown`);
    return `{ ${fields.join('; ')} }`;
}
/** Root `$defs`/`definitions` of a schema, for `$ref` resolution within it. */
function rootDefs(schema) {
    const d = (schema.$defs ?? schema.definitions);
    if (!isObj(d))
        return {};
    const out = {};
    for (const [k, v] of Object.entries(d))
        if (isObj(v))
            out[k] = v;
    return out;
}
/**
 * Render a tool's `inputSchema` (a JSON Schema object) to its TS args type + whether all
 * fields are optional (so the generated signature can mark `args?`).
 */
function toolArgsType(tool, maxDepth = DEFAULT_MAX_DEPTH) {
    const schema = tool.inputSchema;
    if (!isObj(schema))
        return { type: 'Record<string, unknown>', optional: true };
    const defs = rootDefs(schema);
    const type = schemaToTs(schema, 0, defs, maxDepth);
    const required = Array.isArray(schema.required) ? schema.required : [];
    return { type, optional: required.length === 0 };
}
/** One line of description, whitespace-collapsed and truncated for the signature comment. */
function shortDesc(desc) {
    if (!desc)
        return '';
    const one = desc.replace(/\s+/g, ' ').trim();
    return one.length > DESC_MAX ? `${one.slice(0, DESC_MAX - 1)}…` : one;
}
/** Project the tools into well-formed, allowed facade entries (sorted ns then verb). */
function facadeEntries(tools, opts) {
    const nsFilter = opts.namespaces && opts.namespaces.length ? new Set(opts.namespaces) : undefined;
    const nameFilter = opts.names && opts.names.length ? new Set(opts.names) : undefined;
    const entries = [];
    for (const tool of tools) {
        const name = tool.expose?.mcp?.name;
        if (!name)
            continue;
        const ci = name.indexOf(':');
        if (ci <= 0)
            continue;
        if (opts.allowed && !opts.allowed.has(name))
            continue;
        const ns = name.slice(0, ci);
        if (ns === 'call')
            continue; // never shadow the escape hatch
        // When a subset is requested, include a tool if its ns OR its full name matches.
        if (nsFilter || nameFilter) {
            const hit = (nsFilter && nsFilter.has(ns)) || (nameFilter && nameFilter.has(name));
            if (!hit)
                continue;
        }
        entries.push({
            ns,
            verb: (0, tool_facade_1.camelVerb)(name.slice(ci + 1)),
            name,
            desc: shortDesc(tool.description),
            args: toolArgsType(tool, opts.maxDepth),
        });
    }
    entries.sort((a, b) => (a.ns === b.ns ? a.verb.localeCompare(b.verb) : a.ns.localeCompare(b.ns)));
    return entries;
}
/**
 * Generate the `declare const tools: { … }` TypeScript surface for the code-mode facade,
 * scoped to `allowed` (and optionally to a `namespaces`/`names` subset for on-demand loading).
 * The universal `call(toolName, args?)` escape hatch is always included.
 */
function generateToolFacadeTypes(tools, opts = {}) {
    const entries = facadeEntries(tools, opts);
    const byNs = new Map();
    for (const e of entries) {
        const bucket = byNs.get(e.ns) ?? [];
        bucket.push(e);
        byNs.set(e.ns, bucket);
    }
    const lines = [];
    lines.push(opts.header ?? 'declare const tools: {');
    for (const ns of [...byNs.keys()].sort()) {
        lines.push(`  ${renderKey(ns)}: {`);
        for (const e of byNs.get(ns)) {
            if (e.desc)
                lines.push(`    /** ${e.desc} */`);
            const argPart = e.args.type === '{}'
                ? 'args?: {}'
                : `args${e.args.optional ? '?' : ''}: ${e.args.type}`;
            lines.push(`    ${e.verb}(${argPart}): Promise<unknown>;`);
        }
        lines.push('  };');
    }
    lines.push('  /** Universal escape hatch — call any allowed tool by full "ns:verb" name. */');
    lines.push('  call(toolName: string, args?: unknown): Promise<unknown>;');
    lines.push('};');
    return lines.join('\n');
}
/**
 * The cheap index for on-demand discovery: every allowed namespace with its verb list, WITHOUT
 * full arg types. The model reads this first, then requests `generateToolFacadeTypes` for the
 * one or two namespaces it actually needs — the token win.
 */
function listFacadeNamespaces(tools, allowed) {
    const entries = facadeEntries(tools, { allowed });
    const byNs = new Map();
    for (const e of entries) {
        const idx = byNs.get(e.ns) ?? { ns: e.ns, verbs: [], toolNames: [] };
        idx.verbs.push(e.verb);
        idx.toolNames.push(e.name);
        byNs.set(e.ns, idx);
    }
    return [...byNs.values()].sort((a, b) => a.ns.localeCompare(b.ns));
}
