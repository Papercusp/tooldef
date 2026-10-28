/**
 * Compact JSON-Schema projection — the middle detail tier between shipping a
 * tool's FULL definition and not advertising it at all.
 *
 * WHY THIS EXISTS. Tool delivery used to be binary: a tool was either advertised
 * with its complete schema and guidance prose, or it was invisible. That forced
 * choice is what made a seed list a zero-sum fight — admitting one heavy tool
 * meant dropping another — and it is why high-demand heavyweights get cut.
 * A COMPACT tier removes the false choice: a compact definition still lets a
 * model form a VALID call, at a fraction of the bytes.
 *
 * THE CONTRACT, and it is the whole point: compact is NEVER A PARTIAL CONTRACT.
 * Everything a caller needs to construct an accepted argument object survives —
 * property names, the required set, enum members, numeric and length bounds,
 * oneOf/anyOf/allOf discriminators, nested object/array shape, and $defs/$ref
 * structure. Exactly five schema keywords are removed: `description`, `title`,
 * `examples`, `example`, and `default`. Explicit `type`, `pattern` and
 * `propertyNames` survive even when a sibling seems to imply them. Literal
 * values under enum/const and unknown keywords are data, not subschemas.
 *
 * ⚠ `$defs`/`$ref` STRUCTURE IS PRESERVED, NOT INLINED. `$defs` is precisely
 * what keeps a duplicated sub-schema from being paid for once per use site, so
 * inlining it would inflate exactly the budget this projection exists to cut.
 * (`schema-ref-inline.ts` in the host inlines in the OPPOSITE direction, for
 * human-facing discovery renderers where a reader cannot follow a $ref — that
 * is a different job with a different cost model. Do not reuse it here.)
 *
 * ⚠ `default` IS DROPPED AND THAT IS A DELIBERATE, NARROW BET. A default is
 * advisory to the CALLER but authoritative in the SERVER, which applies it
 * whether or not the caller ever saw it — so removing it cannot change what an
 * omitted field resolves to. It can only change what a model GUESSES an omitted
 * field will do. Anything load-bearing enough that a caller must see it belongs
 * in the required set or an enum, both of which survive.
 *
 * Domain-free by construction, and therefore here rather than in the host:
 * nothing below knows what a Papercusp tool, workspace or role is.
 */

import { z } from 'zod/v4';

import { summaryGuidanceDescription } from './partial-guidance';

const UTF8_ENCODER = new TextEncoder();

/**
 * Keys removed by compaction. Every one is PROSE OR ADVISORY — none of them
 * constrains whether an argument object validates.
 *
 * Deliberately NOT here, because each one does constrain validity: `required`,
 * `enum`, `const`, `type`, `properties`,
 * `items`, `prefixItems`,
 * `additionalProperties`, `minimum`, `maximum`, `exclusiveMinimum`,
 * `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`,
 * `format`, `minItems`, `maxItems`, `uniqueItems`, `minProperties`,
 * `maxProperties`, `oneOf`, `anyOf`, `allOf`, `not`, `if`/`then`/`else`,
 * `discriminator`, `$ref`, `$defs`, `definitions`, `nullable`.
 */
export const COMPACT_DROPPED_KEYS: readonly string[] = Object.freeze([
  'description',
  'title',
  'examples',
  'example',
  'default',
]);

const DROPPED = new Set<string>(COMPACT_DROPPED_KEYS);

/**
 * Schema keywords whose VALUE is a map of arbitrary, author-chosen names to
 * subschemas. A property literally named `description` or `default` is a
 * PROPERTY NAME, not a prose keyword, and must survive — dropping it would
 * silently remove a real argument from the contract, which is the one failure
 * mode that turns a compact definition into a partial one.
 */
const NAME_KEYED_CONTAINERS = new Set<string>([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);

/**
 * `format` + `pattern` pairs whose pattern is zod's OWN implementation of the
 * named format. DERIVED from zod at load, never hand-copied: a zod upgrade that
 * changes a regex simply stops matching, and the pattern is then KEPT (the
 * budget grows and its gate notices — the failure is loud, never a silent loss).
 *
 * Only variants whose regex accepts what the format NAME promises belong here.
 * `z.guid()` is the RFC 4122 shape itself; `z.iso.datetime({ offset: true })`
 * is RFC 3339 date-time. The default `z.iso.datetime()` (Z only), `local`-only,
 * a fixed `precision` and `z.uuidv4()` and friends are ABSENT on purpose: each
 * narrows its format, so there the pattern carries a constraint the format does
 * not, and it must survive.
 */
const FORMAT_IMPLIED_PATTERNS: ReadonlySet<string> = (() => {
  const pairs = new Set<string>();
  const variants: ReadonlyArray<() => z.ZodType> = [
    () => z.uuid(),
    () => z.guid(),
    () => z.email(),
    () => z.iso.datetime({ offset: true }),
    () => z.iso.datetime({ offset: true, local: true }),
    () => z.iso.date(),
  ];
  for (const variant of variants) {
    try {
      const json = z.toJSONSchema(variant()) as { format?: unknown; pattern?: unknown };
      if (typeof json.format === 'string' && typeof json.pattern === 'string') {
        pairs.add(`${json.format}\u0000${json.pattern}`);
      }
    } catch {
      // A zod build that cannot project this variant: keep its pattern (fail-safe).
    }
  }
  return pairs;
})();

/**
 * Whether `pattern` is exactly zod's regex for the sibling `format` (see above).
 * Retained as a diagnostic classifier for existing consumers. Its result does
 * not authorize compactInputSchema to remove a pattern.
 */
export function isFormatImpliedPattern(schema: Record<string, unknown>): boolean {
  return (
    typeof schema.format === 'string' &&
    typeof schema.pattern === 'string' &&
    FORMAT_IMPLIED_PATTERNS.has(`${schema.format}\u0000${schema.pattern}`)
  );
}

/**
 * Whether a `propertyNames` subschema is VACUOUS: one that every JSON object key
 * satisfies. A key is always a string, so `true`, an empty (or prose-only)
 * subschema and `{ type: 'string' }` constrain nothing. zod emits the last one
 * beside every `z.record(z.string(), …)`, so each map-valued argument on a floor
 * tool paid ~33 bytes per launch for it (WI-10006197).
 *
 * This is NOT a denylist entry: `propertyNames` stays out of COMPACT_DROPPED_KEYS
 * because a real one (`pattern`, `enum`, a length bound, a non-string `type`)
 * DOES constrain which keys validate, and every such one is kept verbatim.
 * Retained as a diagnostic classifier; compactInputSchema keeps this keyword
 * regardless of whether the classifier considers its constraint vacuous.
 */
export function isVacuousPropertyNames(value: unknown): boolean {
  if (value === true) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const constraining = Object.keys(value).filter((key) => !DROPPED.has(key));
  if (constraining.length === 0) return true;
  if (constraining.length !== 1 || constraining[0] !== 'type') return false;
  const type = (value as Record<string, unknown>).type;
  return type === 'string' || (Array.isArray(type) && type.includes('string'));
}

function compactNode(node: unknown, inNameKeyedMap: boolean, dropMetadata = true): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((entry) => compactNode(entry, false, dropMetadata));

  const out: Record<string, unknown> = {};
  const schema = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(schema)) {
    // Inside `properties` (etc.) every key is an author-chosen NAME. Keep it
    // verbatim and compact its subschema; never test it against DROPPED.
    if (inNameKeyedMap) {
      out[key] = compactNode(value, false, dropMetadata);
      continue;
    }
    if (dropMetadata && DROPPED.has(key)) continue;
    // Walk schema positions only. An enum/const or future keyword can contain
    // an object with a literal `description` key that must remain unchanged.
    out[key] = NAME_KEYED_CONTAINERS.has(key) ? compactNode(value, true, dropMetadata)
      : SUBSCHEMA_KEYS.has(key) || SUBSCHEMA_LIST_KEYS.has(key) ? compactNode(value, false, dropMetadata)
        : value;
  }
  return out;
}

/**
 * Keywords whose value is ONE subschema, or a LIST of subschemas (`items` is
 * both, by draft). Hoisting walks only these and NAME_KEYED_CONTAINERS: `enum`,
 * `const`, `required` and `x-*` hold DATA, and swapping an identical data value
 * for a `$ref` would corrupt it.
 */
const SUBSCHEMA_KEYS = new Set<string>([
  'items', 'additionalItems', 'additionalProperties', 'unevaluatedItems',
  'unevaluatedProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else',
]);
const SUBSCHEMA_LIST_KEYS = new Set<string>(['anyOf', 'oneOf', 'allOf', 'prefixItems', 'items']);
/** Keywords that make a subschema's meaning depend on WHERE it sits. */
const LOCATION_SENSITIVE_KEYS = new Set<string>([
  '$id', '$anchor', '$dynamicAnchor', '$dynamicRef', '$recursiveAnchor', '$recursiveRef',
]);
/** Only a root or root-level-definition ref still resolves after its holder moves. */
const MOVABLE_REF = /^#(?:\/(?:\$defs|definitions)\/[^/]+)?$/;
/** Charge the complete definition and every reference; only positive net savings qualify. */
const HOIST_MIN_SAVED_BYTES = 1;
const HOIST_MAX_ROUNDS = 64;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function utf8Bytes(text: string): number {
  return UTF8_ENCODER.encode(text).byteLength;
}

interface SubschemaSite {
  holder: JsonObject | unknown[];
  slot: string | number;
  node: JsonObject;
  /** Nearest enclosing property (or definition) name. */
  nameHint: string;
}

/** Collect every replaceable subschema below `node`; false when moving one would be unsafe. */
function collectSites(node: JsonObject, nameHint: string, sites: SubschemaSite[]): boolean {
  for (const [key, value] of Object.entries(node)) {
    if (LOCATION_SENSITIVE_KEYS.has(key)) return false;
    if (key === '$ref' && (typeof value !== 'string' || !MOVABLE_REF.test(value))) return false;
    if (NAME_KEYED_CONTAINERS.has(key) && isJsonObject(value)) {
      const isDefinitions = key === '$defs' || key === 'definitions';
      for (const [name, child] of Object.entries(value)) {
        if (!isJsonObject(child)) continue;
        const hint = key === 'properties' || isDefinitions ? name : nameHint;
        // Keep authored definition NAMES, but allow identical bodies to alias
        // one another. Candidate selection excludes the target's own body,
        // otherwise reusing a definition would replace it with a self-ref.
        sites.push({ holder: value, slot: name, node: child, nameHint: hint });
        if (!collectSites(child, hint, sites)) return false;
      }
    } else if (SUBSCHEMA_KEYS.has(key) && isJsonObject(value)) {
      sites.push({ holder: node, slot: key, node: value, nameHint });
      if (!collectSites(value, nameHint, sites)) return false;
    } else if (SUBSCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const child = value[index];
        if (!isJsonObject(child)) continue;
        sites.push({ holder: value, slot: index, node: child, nameHint });
        if (!collectSites(child, nameHint, sites)) return false;
      }
    }
  }
  return true;
}

/** `JSON.stringify` text, memoized per node so one pass costs ~linear in the document. */
function jsonText(value: unknown, memo: Map<object, string>): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const cached = memo.get(value);
  if (cached !== undefined) return cached;
  const text = Array.isArray(value)
    ? `[${value.map((entry) => jsonText(entry, memo)).join(',')}]`
    : `{${Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => `${JSON.stringify(key)}:${jsonText(entry, memo)}`)
        .join(',')}}`;
  memo.set(value, text);
  return text;
}

/**
 * New definitions use short URI-safe labels. Authored names remain unchanged.
 * A long property name must not be charged at every reference to its shape.
 */
function nextDefinitionName(definitions: JsonObject | undefined): string {
  for (let n = 0; ; n++) {
    const name = n.toString(36);
    if (definitions === undefined || !Object.hasOwn(definitions, name)) return name;
  }
}

function definitionRef(definitionsKey: string, name: string): string {
  return `#/${definitionsKey}/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

/** Follow only pure root-definition aliases; cycles retain their original ref. */
function canonicalAliasRef(root: JsonObject, original: string): string {
  const seen = new Set<string>();
  let ref = original;
  while (!seen.has(ref)) {
    seen.add(ref);
    const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref);
    if (!match) return ref;
    const definitions = root[match[1]!];
    const name = match[2]!.replace(/~1/g, '/').replace(/~0/g, '~');
    const body = isJsonObject(definitions) ? definitions[name] : undefined;
    if (!isJsonObject(body) || Object.keys(body).length !== 1 || typeof body.$ref !== 'string') return ref;
    ref = body.$ref;
  }
  return original;
}

/**
 * Move every subschema repeated VERBATIM into one definition plus `$ref`s —
 * greedily, largest saving first, so an enclosing repeat is taken before the
 * repeats inside it. Mutates `root`, which must be compaction's own fresh copy.
 */
function hoistRepeatedSubschemas(root: unknown, preserveCompactBudget = false): unknown {
  if (!isJsonObject(root) || Object.hasOwn(root, '$ref')) return root;
  const definitionsKey =
    !Object.hasOwn(root, '$defs') && isJsonObject(root.definitions) ? 'definitions' : '$defs';
  let compactCeiling = preserveCompactBudget ? jsonBytes(compactInputSchema(root)) : 0;
  const rejected = new Set<string>();
  for (let round = 0; round < HOIST_MAX_ROUNDS; round++) {
    const sites: SubschemaSite[] = [];
    // Only the untouched input can refuse: every ref this pass writes is movable.
    if (!collectSites(root, 'schema', sites)) return root;
    // Full-schema factoring can leave different refs whose bodies become equal
    // after metadata removal. Normalize aliases before comparing their parents,
    // charging each rewritten ref and preserving every authored definition key.
    for (const { node } of sites) {
      if (typeof node.$ref !== 'string') continue;
      const ref = canonicalAliasRef(root, node.$ref);
      if (utf8Bytes(ref) <= utf8Bytes(node.$ref)) node.$ref = ref;
    }
    const memo = new Map<object, string>();
    const groups = new Map<string, SubschemaSite[]>();
    for (const site of sites) {
      const text = jsonText(site.node, memo);
      const group = groups.get(text);
      if (group) group.push(site);
      else groups.set(text, [site]);
    }
    const existing = root[definitionsKey];
    const definitions = isJsonObject(existing) ? existing : undefined;
    let best: { sites: SubschemaSite[]; name: string; saved: number; reuse: boolean; key: string } | undefined;
    for (const [text, group] of groups) {
      const bytes = utf8Bytes(text);
      const candidates = [
        { name: nextDefinitionName(definitions), reuse: false },
        ...Object.entries(definitions ?? {})
          .filter(([, body]) => jsonText(body, memo) === text)
          .map(([name]) => ({ name, reuse: true })),
      ];
      for (const { name, reuse } of candidates) {
        const key = `${text}\u0000${name}\u0000${reuse}`;
        if (rejected.has(key)) continue;
        const replaceable = reuse
          ? group.filter((site) => site.holder !== definitions || site.slot !== name)
          : group;
        const refBytes = utf8Bytes(JSON.stringify({ $ref: definitionRef(definitionsKey, name) }));
        const entryBytes = reuse ? 0 : utf8Bytes(JSON.stringify(name)) + bytes + 2 +
          (definitions === undefined ? utf8Bytes(`"${definitionsKey}":{}`) : 0);
        const saved = replaceable.length * (bytes - refBytes) - entryBytes;
        if (saved >= HOIST_MIN_SAVED_BYTES && (best === undefined || saved > best.saved)) {
          best = { sites: replaceable, name, saved, reuse, key };
        }
      }
    }
    if (best === undefined) break;
    const target: JsonObject = definitions ?? {};
    root[definitionsKey] = target;
    if (!best.reuse) target[best.name] = best.sites[0].node;
    for (const site of best.sites) {
      (site.holder as Record<string | number, unknown>)[site.slot] = {
        $ref: definitionRef(definitionsKey, best.name),
      };
    }
    if (preserveCompactBudget) {
      const compactBytes = jsonBytes(compactInputSchema(root));
      if (compactBytes > compactCeiling) {
        // Metadata can make two FULL repeats profitable while the extra
        // definition survives as overhead after compaction. Try another
        // choice; this root is our private copy, never the caller's input.
        for (const site of best.sites) {
          (site.holder as Record<string | number, unknown>)[site.slot] = site.node;
        }
        if (!best.reuse) delete target[best.name];
        if (definitions === undefined) delete root[definitionsKey];
        rejected.add(best.key);
      } else compactCeiling = compactBytes;
    }
  }
  return root;
}

/**
 * Project a JSON Schema onto its compact form: same contract, prose removed,
 * verbatim repeats hoisted into `$defs`.
 *
 * Pure and total — it never throws on a malformed schema, because it is used on
 * a measurement path where a single bad tool must not take down the whole
 * catalog reading. A non-object input is returned unchanged; the input itself
 * is never mutated (hoisting rewrites compaction's own copy).
 */
export function compactInputSchema(schema: unknown): unknown {
  return hoistRepeatedSubschemas(compactNode(schema, false));
}

/** Factor identical full subschemas without removing metadata or constraints.
 * References are introduced only when their complete UTF-8 cost is smaller.
 * Like compaction, this owns a fresh copy of every schema position it rewrites.
 */
export function factorInputSchema(schema: unknown): unknown {
  return hoistRepeatedSubschemas(compactNode(schema, false, false), true);
}

/** Exact UTF-8 byte length of a value's JSON serialization (0 when undefined). */
function jsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : UTF8_ENCODER.encode(serialized).byteLength;
}

/** What one tool costs on the wire at each detail tier. */
export interface CompactWireBytes {
  /** Bytes for the full advertised definition (name + description + schema). */
  full: number;
  /** Bytes for the compact definition: schema compacted, description dropped. */
  compact: number;
  /** `full - compact` — the bytes compaction actually returns. */
  saved: number;
}

/**
 * Measure one tool at both tiers, using the SAME serialization shape the full
 * instrument uses so the two numbers are directly comparable.
 *
 * ⚠ This is a REGRESSION signal, not a byte-exact replica of the live endpoint:
 * it measures the in-repo projection, which skips the server's late
 * entity-enum/sanitize passes. Compare in-repo readings to in-repo readings.
 */
export function compactWireBytes(
  name: string,
  tool: { description?: string; inputSchema?: unknown },
): CompactWireBytes {
  const full = jsonBytes({
    name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? {},
  });
  const compact = jsonBytes({
    name,
    // P-010: COMPACT ships a SUMMARY, not silence. This measurement and
    // `applyCompactTier` MUST stay in lockstep — if delivery ships prose that
    // measurement priced at zero, `spentBytes` becomes a fiction and the whole
    // budget is unenforceable.
    description: summaryGuidanceDescription(tool.description),
    inputSchema: compactInputSchema(tool.inputSchema ?? {}),
  });
  return { full, compact, saved: full - compact };
}
