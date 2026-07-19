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
 * What an entity-reference arg points at. Open-ended `string` on purpose — the
 * engine owns no entity vocabulary; a host names its own kinds and registers
 * matching resolvers.
 */
export type EntityKind = string;

/** Metadata recorded for a schema produced by {@link entityRef}. */
export interface EntityRefMeta {
  kind: EntityKind;
  /** Human label used in error text ("unknown pot"). Defaults to `kind`. */
  label?: string;
  /** When true, an unresolvable value WARNS instead of rejecting (staged rollout). */
  soft?: boolean;
}

/** Options for {@link entityRef}. */
export interface EntityRefOptions extends Omit<EntityRefMeta, 'kind'> {
  /**
   * The arg description. MUST be passed here rather than chained as
   * `.describe(...)` — see the note on {@link entityRef} about clone-orphaning.
   */
  describe?: string;
  /** Max length, for the same reason `describe` lives here. */
  max?: number;
}

/**
 * Schema → meta. A WeakMap (not a schema property) so the marker cannot leak
 * into `z.toJSONSchema` output and change the published wire contract: adding
 * validation must not alter what `tools/list` advertises.
 */
const REGISTRY = new WeakMap<object, EntityRefMeta>();

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
export function entityRef(kind: EntityKind, opts: EntityRefOptions = {}) {
  const { describe, max, ...meta } = opts;
  let schema = z.string().min(1);
  if (typeof max === 'number') schema = schema.max(max);
  if (describe) schema = schema.describe(describe);
  // Register LAST: every clone-producing call is already done, so this key is
  // the object the caller actually hands to `z.object({...})`.
  REGISTRY.set(schema as unknown as object, { kind, ...meta });
  return schema;
}

/** The meta for a schema, or undefined when it is not an entity ref. */
export function entityRefMeta(schema: unknown): EntityRefMeta | undefined {
  return schema && typeof schema === 'object' ? REGISTRY.get(schema as object) : undefined;
}

/**
 * Peel wrapper schemas (`optional` / `nullable` / `default` / array element)
 * to reach the type the marker was attached to. Wrapping produces a NEW schema
 * object that is not itself in the registry, so an unwrap step is what makes
 * `entityRef('pot').optional()` still resolve.
 */
function isSchema(v: unknown): v is object {
  // Zod 4 stores the type NAME on `_def.type` as a string ('object', 'string'),
  // so a naive `_def.type` follow walks into a string and loses the schema.
  // A real schema is an object carrying its own `_def`.
  return Boolean(v) && typeof v === 'object' && '_def' in (v as Record<string, unknown>);
}

function unwrap(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== 'object' || depth > 10) return schema;
  if (REGISTRY.has(schema as object)) return schema;
  const def = (schema as { _def?: Record<string, unknown> })._def;
  for (const key of ['innerType', 'schema'] as const) {
    const inner = def?.[key];
    if (isSchema(inner)) return unwrap(inner, depth + 1);
  }
  return schema;
}

/** One discovered entity-reference arg. */
export interface EntityRefSite {
  /** Dotted path from the args root, e.g. `pot` or `members.0.pot`. */
  path: string;
  meta: EntityRefMeta;
}

/**
 * Walk an args schema and report every entity-reference site, including ones
 * nested in objects and arrays. Structural only — it inspects the SCHEMA, not
 * a value, so a dispatcher can compute this once per tool at registration
 * rather than per call.
 */
export function collectEntityRefs(schema: unknown, path = '', depth = 0): EntityRefSite[] {
  if (!schema || typeof schema !== 'object' || depth > 12) return [];
  const target = unwrap(schema, 0);
  const meta = entityRefMeta(target);
  if (meta) return [{ path, meta }];

  const def = (target as { _def?: Record<string, unknown> })._def;
  const out: EntityRefSite[] = [];

  // Object: recurse over its shape.
  const shape = (target as { shape?: Record<string, unknown> }).shape ?? def?.shape;
  const resolvedShape = typeof shape === 'function' ? (shape as () => Record<string, unknown>)() : shape;
  if (resolvedShape && typeof resolvedShape === 'object') {
    for (const [key, child] of Object.entries(resolvedShape)) {
      out.push(...collectEntityRefs(child, path ? `${path}.${key}` : key, depth + 1));
    }
    return out;
  }

  // Array: recurse into the element type, marking the index position.
  const element = def?.element ?? def?.valueType;
  if (isSchema(element) && element !== target) {
    out.push(...collectEntityRefs(element, path ? `${path}.*` : '*', depth + 1));
  }
  return out;
}

/**
 * A host's existence check for one kind. Receives EVERY value of that kind in
 * the call at once (DataLoader-style batching) and returns only the ones that
 * do NOT exist, optionally with near-miss suggestions for the error message.
 *
 * Returning an empty `unknown` array means "all present". A resolver that
 * throws is treated as UNAVAILABLE and fails OPEN (see {@link resolveEntityRefs}).
 */
export type EntityResolver = (values: readonly string[]) => Promise<{
  unknown: readonly string[];
  /** Near matches for an unknown value, best first — powers "did you mean". */
  suggestions?: Readonly<Record<string, readonly string[]>>;
  /** The full valid set, when small enough to name in an error. */
  allowed?: readonly string[];
}>;

const RESOLVERS = new Map<EntityKind, EntityResolver>();

/**
 * Register the host's existence check for one kind. Call during startup,
 * before dispatch runs. Last writer wins; a kind with no resolver is SKIPPED
 * (unvalidated) rather than rejected — so adopting `entityRef` on an arg is
 * safe before its resolver exists.
 */
export function setEntityResolver(kind: EntityKind, resolver: EntityResolver): void {
  RESOLVERS.set(kind, resolver);
}

/** Drop a resolver (tests, teardown). */
export function clearEntityResolvers(): void {
  RESOLVERS.clear();
}

/** Whether a kind currently has a resolver — the "will this actually be checked" probe. */
export function hasEntityResolver(kind: EntityKind): boolean {
  return RESOLVERS.has(kind);
}

/** One rejected value, ready to render into an error message. */
export interface EntityRefViolation {
  path: string;
  kind: EntityKind;
  label: string;
  value: string;
  suggestions: readonly string[];
  allowed?: readonly string[];
  soft: boolean;
}

/** Read the value at a dotted path, expanding `*` across array elements. */
function valuesAtPath(args: unknown, path: string): Array<{ path: string; value: string }> {
  if (path === '') return typeof args === 'string' ? [{ path, value: args }] : [];
  const parts = path.split('.');
  let frontier: Array<{ path: string; node: unknown }> = [{ path: '', node: args }];
  for (const part of parts) {
    const next: Array<{ path: string; node: unknown }> = [];
    for (const { path: p, node } of frontier) {
      if (node == null) continue;
      if (part === '*') {
        if (!Array.isArray(node)) continue;
        node.forEach((el, i) => next.push({ path: p ? `${p}.${i}` : String(i), node: el }));
      } else if (typeof node === 'object') {
        const child = (node as Record<string, unknown>)[part];
        if (child !== undefined) next.push({ path: p ? `${p}.${part}` : part, node: child });
      }
    }
    frontier = next;
  }
  return frontier
    .filter((f) => typeof f.node === 'string' && f.node !== '')
    .map((f) => ({ path: f.path, value: f.node as string }));
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
export async function resolveEntityRefs(
  sites: readonly EntityRefSite[],
  args: unknown,
): Promise<EntityRefViolation[]> {
  if (!sites.length || args == null) return [];

  // Group every concrete value by kind so each resolver is consulted ONCE.
  const byKind = new Map<EntityKind, { meta: EntityRefMeta; hits: Array<{ path: string; value: string }> }>();
  for (const site of sites) {
    const resolver = RESOLVERS.get(site.meta.kind);
    if (!resolver) continue; // unregistered kind → skipped, not rejected
    const hits = valuesAtPath(args, site.path);
    if (!hits.length) continue;
    const bucket = byKind.get(site.meta.kind) ?? { meta: site.meta, hits: [] };
    bucket.hits.push(...hits);
    byKind.set(site.meta.kind, bucket);
  }

  const violations: EntityRefViolation[] = [];
  await Promise.all(
    [...byKind.entries()].map(async ([kind, { meta, hits }]) => {
      const resolver = RESOLVERS.get(kind);
      if (!resolver) return;
      const values = [...new Set(hits.map((h) => h.value))];
      let result: Awaited<ReturnType<EntityResolver>>;
      try {
        result = await resolver(values);
      } catch {
        return; // resolver unavailable → fail open
      }
      const unknownSet = new Set(result.unknown ?? []);
      if (!unknownSet.size) return;
      for (const hit of hits) {
        if (!unknownSet.has(hit.value)) continue;
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
    }),
  );
  return violations;
}

/**
 * Render violations as one corrective message — the `--model` UX generalized:
 * name what was wrong, the nearest match, and the allowed set when it is small
 * enough to be useful rather than noise.
 */
export function formatEntityRefViolations(violations: readonly EntityRefViolation[]): string {
  return violations
    .map((v) => {
      const where = v.path ? `\`${v.path}\`` : 'argument';
      let msg = `unknown ${v.label} ${JSON.stringify(v.value)} for ${where}`;
      if (v.suggestions.length) msg += ` — did you mean ${v.suggestions.map((s) => `\`${s}\``).join(' or ')}?`;
      else if (v.allowed && v.allowed.length > 0 && v.allowed.length <= 25) {
        msg += ` — valid values: ${v.allowed.map((a) => `\`${a}\``).join(', ')}`;
      }
      return msg;
    })
    .join('; ');
}
