/**
 * Entity-reference args — the semantic type the engine was missing
 * (tool-arg-referential-integrity-2026-07-19 P-001 / D-001).
 *
 * THE PROBLEM. A tool arg that NAMES A DURABLE ENTITY (`pot`, `harness`,
 * `plan`, `fleet`, `ownerId`, …) is, structurally, just `z.string()`. Nothing
 * distinguishes "any text" from "must identify a row that exists". So callers —
 * agents especially — invent values, and the write succeeds. In the audit that
 * prompted this file, 55% of one table's rows pointed at entities that had
 * never existed, across 312 arg sites of which at most 12% checked anything.
 *
 * WHY THIS CANNOT LIVE IN THE SCHEMA'S JSON. `tools/list` publishes JSON
 * Schema, which is deliberately I/O-free (cf. Ajv's `addFormat`) — "exists in
 * the database" is not expressible there, by design. Enforcement therefore
 * belongs at DISPATCH, where a host resolver can be consulted. This module
 * supplies the two halves the dispatcher needs:
 *
 *   1. a MARKER on the schema, so a generic walker can find which args are
 *      entity references and of what kind ({@link entityRef} /
 *      {@link collectEntityRefs});
 *   2. a pluggable, BATCHED host resolver per kind ({@link setEntityResolver} /
 *      {@link resolveEntityRefs}) — the engine ships no entity knowledge, the
 *      same load-order contract as the capability-tier resolver.
 *
 * EFFICIENCY. Real entity sets in a host of this shape are small (hundreds of
 * rows), so a host resolver backed by a process-local `Set` with
 * write-invalidation makes validation an O(1) memory lookup with zero per-call
 * queries. The resolver interface is nonetheless BATCHED (it receives every
 * value of a kind at once, DataLoader-style) so a host with a large set can
 * answer with one `= ANY($1)` instead of N round-trips.
 *
 * The brand is compile-time only and intentionally so: `.brand()` gives
 * authoring safety, never enforcement. The runtime guarantee comes from the
 * dispatch step that consumes {@link collectEntityRefs}.
 */
import { z } from 'zod';
/**
 * Schema → meta. A WeakMap (not a schema property) so the marker cannot leak
 * into `z.toJSONSchema` output and change the published wire contract: adding
 * validation must not alter what `tools/list` advertises.
 */
const REGISTRY = new WeakMap();
/**
 * Declare an arg as a reference to an entity of `kind`.
 *
 * ```ts
 * args: z.object({
 *   pot: entityRef('pot', { describe: 'the pot to report on', max: 120 }),
 * })
 * ```
 *
 * ⚠ PASS `describe` / `max` AS OPTIONS — DO NOT CHAIN THEM.
 *
 * Zod 4's `.describe()` and `.max()` return a CLONE of the schema, not the same
 * object. The marker lives in a WeakMap keyed on schema identity (so it cannot
 * leak into published JSON Schema), so anything chained AFTER `entityRef()`
 * produces a new object the registry does not know about — and the arg silently
 * becomes an ordinary string that is never checked. This is not hypothetical: a
 * first conversion pass wrote `entityRef('pot').describe(…)` across seven tools
 * and every one of them was inert, caught only because the conformance ratchet
 * reported `converted=0`. Taking these as options means the marker is always
 * applied LAST, so there is nothing to chain and nothing to get wrong.
 *
 * Wrapping is still fine: `.optional()`, `.nullable()`, `.default()` and array
 * wrapping all produce WRAPPERS with an inner type, which
 * {@link collectEntityRefs} unwraps to find the marker.
 */
export function entityRef(kind, opts = {}) {
    const { describe, max, ...meta } = opts;
    let schema = z.string().min(1);
    if (typeof max === 'number')
        schema = schema.max(max);
    if (describe)
        schema = schema.describe(describe);
    // Register LAST: every clone-producing call is already done, so this key is
    // the object the caller actually hands to `z.object({...})`.
    REGISTRY.set(schema, { kind, ...meta });
    return schema;
}
/** The meta for a schema, or undefined when it is not an entity ref. */
export function entityRefMeta(schema) {
    return schema && typeof schema === 'object' ? REGISTRY.get(schema) : undefined;
}
/**
 * Peel wrapper schemas (`optional` / `nullable` / `default` / array element)
 * to reach the type the marker was attached to. Wrapping produces a NEW schema
 * object that is not itself in the registry, so an unwrap step is what makes
 * `entityRef('pot').optional()` still resolve.
 */
function isSchema(v) {
    // Zod 4 stores the type NAME on `_def.type` as a string ('object', 'string'),
    // so a naive `_def.type` follow walks into a string and loses the schema.
    // A real schema is an object carrying its own `_def`.
    return Boolean(v) && typeof v === 'object' && '_def' in v;
}
function unwrap(schema, depth = 0) {
    if (!schema || typeof schema !== 'object' || depth > 10)
        return schema;
    if (REGISTRY.has(schema))
        return schema;
    const def = schema._def;
    for (const key of ['innerType', 'schema']) {
        const inner = def?.[key];
        if (isSchema(inner))
            return unwrap(inner, depth + 1);
    }
    return schema;
}
/**
 * Walk an args schema and report every entity-reference site, including ones
 * nested in objects and arrays. Structural only — it inspects the SCHEMA, not
 * a value, so a dispatcher can compute this once per tool at registration
 * rather than per call.
 */
export function collectEntityRefs(schema, path = '', depth = 0) {
    if (!schema || typeof schema !== 'object' || depth > 12)
        return [];
    const target = unwrap(schema, 0);
    const meta = entityRefMeta(target);
    if (meta)
        return [{ path, meta }];
    const def = target._def;
    const out = [];
    // Object: recurse over its shape.
    const shape = target.shape ?? def?.shape;
    const resolvedShape = typeof shape === 'function' ? shape() : shape;
    if (resolvedShape && typeof resolvedShape === 'object') {
        for (const [key, child] of Object.entries(resolvedShape)) {
            out.push(...collectEntityRefs(child, path ? `${path}.${key}` : key, depth + 1));
        }
        return out;
    }
    // Union / discriminated union: recurse into every branch, marking WHICH one
    // with a `#<i>` segment (mirrors the `anyOf[i]` the converted schema emits).
    //
    // Without this, an args schema built as `z.discriminatedUnion('op', [...])` —
    // the standard shape for a multi-op tool here — reports NO entity refs at all,
    // so both the dispatch check and the published enum silently skip it. That was
    // the state of every `op`-union tool until this branch existed.
    const options = def?.options;
    if (Array.isArray(options)) {
        options.forEach((opt, i) => {
            if (!isSchema(opt))
                return;
            out.push(...collectEntityRefs(opt, path ? `${path}.#${i}` : `#${i}`, depth + 1));
        });
        return out;
    }
    // Array: recurse into the element type, marking the index position.
    const element = def?.element ?? def?.valueType;
    if (isSchema(element) && element !== target) {
        out.push(...collectEntityRefs(element, path ? `${path}.*` : '*', depth + 1));
    }
    return out;
}
/** True for a union-branch path segment produced by {@link collectEntityRefs}. */
function unionBranchIndex(part) {
    if (!part.startsWith('#'))
        return null;
    const n = Number(part.slice(1));
    return Number.isInteger(n) && n >= 0 ? n : null;
}
const RESOLVERS = new Map();
/**
 * Register the host's existence check for one kind. Call during startup,
 * before dispatch runs. Last writer wins; a kind with no resolver is SKIPPED
 * (unvalidated) rather than rejected — so adopting `entityRef` on an arg is
 * safe before its resolver exists.
 */
export function setEntityResolver(kind, resolver) {
    RESOLVERS.set(kind, resolver);
}
/** Drop a resolver (tests, teardown). */
export function clearEntityResolvers() {
    RESOLVERS.clear();
}
/** Whether a kind currently has a resolver — the "will this actually be checked" probe. */
export function hasEntityResolver(kind) {
    return RESOLVERS.has(kind);
}
/** Read the value at a dotted path, expanding `*` across array elements. */
function valuesAtPath(args, path) {
    if (path === '')
        return typeof args === 'string' ? [{ path, value: args }] : [];
    const parts = path.split('.');
    let frontier = [{ path: '', node: args }];
    for (const part of parts) {
        const next = [];
        for (const { path: p, node } of frontier) {
            if (node == null)
                continue;
            if (unionBranchIndex(part) !== null) {
                // A VALUE has no branch: only one union arm matched it, and which one
                // is the validator's business. Pass through so every arm's refs are
                // read against the same object; duplicate hits are deduped below.
                next.push({ path: p, node });
            }
            else if (part === '*') {
                if (!Array.isArray(node))
                    continue;
                node.forEach((el, i) => next.push({ path: p ? `${p}.${i}` : String(i), node: el }));
            }
            else if (typeof node === 'object') {
                const child = node[part];
                if (child !== undefined)
                    next.push({ path: p ? `${p}.${part}` : part, node: child });
            }
        }
        frontier = next;
    }
    return frontier
        .filter((f) => typeof f.node === 'string' && f.node !== '')
        .map((f) => ({ path: f.path, value: f.node }));
}
/**
 * Check a call's args against the registered resolvers and report violations.
 *
 * FAILS OPEN, deliberately. A kind with no resolver, or a resolver that throws,
 * yields NO violations: referential validation is a correctness improvement, and
 * an outage in the lookup path must not take down every tool that names an
 * entity. Hard failure modes belong in the DB's foreign keys, which are the
 * backstop this layer sits in front of (D-001).
 */
export async function resolveEntityRefs(sites, args) {
    if (!sites.length || args == null)
        return [];
    // Group every concrete value by kind so each resolver is consulted ONCE.
    const byKind = new Map();
    for (const site of sites) {
        const resolver = RESOLVERS.get(site.meta.kind);
        if (!resolver)
            continue; // unregistered kind → skipped, not rejected
        const hits = valuesAtPath(args, site.path);
        if (!hits.length)
            continue;
        const bucket = byKind.get(site.meta.kind) ?? { meta: site.meta, hits: [] };
        // Sibling union arms declaring the same arg collapse to the same
        // (path, value) — report it once, not once per arm.
        for (const hit of hits) {
            if (bucket.hits.some((h) => h.path === hit.path && h.value === hit.value))
                continue;
            bucket.hits.push(hit);
        }
        byKind.set(site.meta.kind, bucket);
    }
    const violations = [];
    await Promise.all([...byKind.entries()].map(async ([kind, { meta, hits }]) => {
        const resolver = RESOLVERS.get(kind);
        if (!resolver)
            return;
        const values = [...new Set(hits.map((h) => h.value))];
        let result;
        try {
            result = await resolver(values);
        }
        catch {
            return; // resolver unavailable → fail open
        }
        const unknownSet = new Set(result.unknown ?? []);
        if (!unknownSet.size)
            return;
        for (const hit of hits) {
            if (!unknownSet.has(hit.value))
                continue;
            violations.push({
                path: hit.path,
                kind,
                label: meta.label ?? kind,
                value: hit.value,
                suggestions: result.suggestions?.[hit.value] ?? [],
                allowed: result.allowed,
                soft: meta.soft === true,
            });
        }
    }));
    return violations;
}
/** Default cap — see the token-budget note on {@link EntityEnumOptions.maxValues}. */
export const DEFAULT_MAX_ENUM_VALUES = 60;
const ENUMS = new Map();
/**
 * Register the publishable vocabulary for a kind. Independent of
 * {@link setEntityResolver} on purpose: a kind can be ENFORCED without being
 * publishable (too large — the common case here) and, in principle,
 * publishable without being enforced.
 */
export function setEntityEnum(kind, load, opts = {}) {
    ENUMS.set(kind, {
        load,
        maxValues: opts.maxValues ?? DEFAULT_MAX_ENUM_VALUES,
        ...(opts.openPattern ? { openPattern: opts.openPattern } : {}),
    });
}
/** Drop registered enums (tests, teardown). */
export function clearEntityEnums() {
    ENUMS.clear();
}
/**
 * Ask every registered kind for its fragment. Failures and over-cap sets both
 * yield nothing, so this never throws into a `tools/list` handler: a broken
 * enumerator must not take down tool discovery (the same fail-open contract as
 * {@link resolveEntityRefs}).
 */
async function loadFragments(kinds) {
    const out = new Map();
    await Promise.all([...new Set(kinds)].map(async (kind) => {
        const entry = ENUMS.get(kind);
        if (!entry)
            return;
        let raw;
        try {
            raw = await entry.load();
        }
        catch {
            return; // enumerator unavailable → publish nothing
        }
        if (!raw)
            return;
        const values = [...new Set(raw.filter((v) => typeof v === 'string' && v !== ''))].sort();
        if (!values.length || values.length > entry.maxValues)
            return;
        const fragment = entry.openPattern
            ? { anyOf: [{ enum: values }, { type: 'string', pattern: entry.openPattern }] }
            : { enum: values };
        out.set(kind, { kind, fragment, values });
    }));
    return out;
}
function asObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}
/**
 * Walk a JSON Schema to the node an {@link EntityRefSite} path names — the
 * mirror of {@link collectEntityRefs}'s walk, in the converted document:
 * a key step follows `properties.<key>`, and `*` follows `items`.
 *
 * Returns null when the path does not exist in the converted schema (the tool
 * advertises a rewritten surface — see `advertisedArgsSchema` — or the arg was
 * stripped), which the caller treats as "publish nothing here" rather than an
 * error: a mismatch must never break tool discovery.
 */
function jsonSchemaNodeAt(root, path) {
    let node = asObject(root);
    if (!node)
        return null;
    if (path === '')
        return node;
    for (const part of path.split('.')) {
        const branch = unionBranchIndex(part);
        if (branch !== null) {
            const arms = node.anyOf ?? node.oneOf;
            node = Array.isArray(arms) ? asObject(arms[branch]) : null;
        }
        else if (part === '*') {
            node = asObject(node.items);
        }
        else {
            const props = asObject(node.properties);
            node = props ? asObject(props[part]) : null;
        }
        if (!node)
            return null;
    }
    return node;
}
/**
 * Overlay published vocabularies onto a tool's already-converted JSON Schema.
 *
 * MUTATES AND RETURNS `jsonSchema` — it is called on the freshly-built schema
 * inside a `tools/list` handler, which owns that object.
 *
 * Deliberately a SEPARATE step from `toArgsJsonSchema` rather than something
 * `entityRef` bakes into the schema: the marker is a WeakMap entry precisely so
 * that declaring an arg as an entity ref cannot silently change the published
 * wire contract. Publishing is an explicit, host-controlled, capped act.
 */
export async function applyEntityRefEnums(argsSchema, jsonSchema) {
    const sites = collectEntityRefs(argsSchema);
    if (!sites.length || !ENUMS.size)
        return jsonSchema;
    const fragments = await loadFragments(sites.map((s) => s.meta.kind));
    if (!fragments.size)
        return jsonSchema;
    for (const site of sites) {
        const frag = fragments.get(site.meta.kind);
        if (!frag)
            continue;
        const node = jsonSchemaNodeAt(jsonSchema, site.path);
        if (!node)
            continue;
        // An `anyOf` fragment replaces the scalar `type`; a bare enum rides beside
        // it (an enum of strings is redundant with `type: 'string'`, but harmless
        // and clearer to strict consumers).
        if ('anyOf' in frag.fragment)
            delete node.type;
        Object.assign(node, frag.fragment);
    }
    return jsonSchema;
}
/**
 * A stable fingerprint of everything currently publishable. A host polls this
 * and fires `notifications/tools/list_changed` when it moves, so a live client
 * re-fetches a catalog whose enums actually changed — and, just as importantly,
 * does NOT re-fetch (busting its prompt cache) when they did not.
 */
export async function entityEnumRevision() {
    const fragments = await loadFragments(ENUMS.keys());
    const parts = [...fragments.values()]
        .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
        .map((f) => `${f.kind}:${f.values.join(',')}`);
    if (!parts.length)
        return 'empty';
    // FNV-1a — no crypto import in a hot list path, and collision risk here only
    // costs a missed re-fetch of an advisory enum.
    let h = 0x811c9dc5;
    const text = parts.join('|');
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}
/**
 * Render violations as one corrective message — the `--model` UX generalized:
 * name what was wrong, the nearest match, and the allowed set when it is small
 * enough to be useful rather than noise.
 */
export function formatEntityRefViolations(violations) {
    return violations
        .map((v) => {
        const where = v.path ? `\`${v.path}\`` : 'argument';
        let msg = `unknown ${v.label} ${JSON.stringify(v.value)} for ${where}`;
        if (v.suggestions.length)
            msg += ` — did you mean ${v.suggestions.map((s) => `\`${s}\``).join(' or ')}?`;
        else if (v.allowed && v.allowed.length > 0 && v.allowed.length <= 25) {
            msg += ` — valid values: ${v.allowed.map((a) => `\`${a}\``).join(', ')}`;
        }
        return msg;
    })
        .join('; ');
}
