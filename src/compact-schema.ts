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
 * structure. A `type` keyword is omitted only when a sibling `enum` or `const`
 * already permits exactly values of that type, and a `pattern` only when it is
 * zod's OWN regex for a sibling `format` that names the same contract (see
 * FORMAT_IMPLIED_PATTERNS). What else is dropped is PROSE ONLY: `description`,
 * `title`, `examples`/`example`, and `default`.
 *
 * ⚠ A FORMAT-IMPLIED `pattern` IS DROPPED, AND THAT IS THE SECOND NARROW BET.
 * zod emits its implementation regex beside every string format it knows, so a
 * single uuid costs ~180 bytes and an offset date-time ~320 — on every floor
 * tool, every launch — to restate what the `format` keyword already names. Only
 * EXACT zod-canonical pairs are dropped, and only for variants whose regex
 * accepts what the format name promises; a variant that NARROWS the format
 * (Z-only or local-only date-time, a fixed precision, a uuid VERSION) keeps its
 * pattern, as does any hand-written pattern. The residue is deliberate: zod's
 * uuid regex also checks the version/variant nibbles of what are, here,
 * server-minted identifiers a caller copies from an earlier result, and its
 * email regex rejects quoted local parts. The server still enforces the full
 * pattern, so the worst case is a typed refusal, never an accepted bad value.
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

import { z } from 'zod';

import { summaryGuidanceDescription } from './partial-guidance';

const UTF8_ENCODER = new TextEncoder();

/**
 * Keys removed by compaction. Every one is PROSE OR ADVISORY — none of them
 * constrains whether an argument object validates.
 *
 * Deliberately NOT here, because each one does constrain validity: `required`,
 * `enum`, `const`, `type` (unless implied by `enum`/`const`), `properties`,
 * `items`, `prefixItems`,
 * `additionalProperties`, `minimum`, `maximum`, `exclusiveMinimum`,
 * `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`
 * (unless implied by `format` — FORMAT_IMPLIED_PATTERNS), `format`, `minItems`, `maxItems`, `uniqueItems`, `minProperties`,
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

/** Whether a JSON value belongs to a JSON Schema primitive type. */
function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    default:
      return false;
  }
}

/**
 * `enum` and `const` already restrict the instance to an exact finite set. A
 * sibling `type` adds no constraint when every allowed value already matches
 * one of its types. Keep it when even one enum value conflicts: removing it
 * would then make an otherwise-invalid value valid.
 */
function typeIsImplied(schema: Record<string, unknown>): boolean {
  if (!Object.hasOwn(schema, 'type')) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (Object.hasOwn(schema, 'const')) {
    return types.some((type) => matchesType(schema.const, type));
  }
  return (
    Array.isArray(schema.enum) &&
    schema.enum.every((value) => types.some((type) => matchesType(value, type)))
  );
}

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
 * Exported so a consumer that compares contracts (compact-schema-catalog.test.ts)
 * applies THIS rule instead of re-deriving the zod regex set and drifting from it.
 */
export function isFormatImpliedPattern(schema: Record<string, unknown>): boolean {
  return (
    typeof schema.format === 'string' &&
    typeof schema.pattern === 'string' &&
    FORMAT_IMPLIED_PATTERNS.has(`${schema.format}\u0000${schema.pattern}`)
  );
}

function compactNode(node: unknown, inNameKeyedMap: boolean): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((entry) => compactNode(entry, false));

  const out: Record<string, unknown> = {};
  const schema = node as Record<string, unknown>;
  const omitType = !inNameKeyedMap && typeIsImplied(schema);
  const omitPattern = !inNameKeyedMap && isFormatImpliedPattern(schema);
  for (const [key, value] of Object.entries(schema)) {
    // Inside `properties` (etc.) every key is an author-chosen NAME. Keep it
    // verbatim and compact its subschema; never test it against DROPPED.
    if (inNameKeyedMap) {
      out[key] = compactNode(value, false);
      continue;
    }
    if (DROPPED.has(key)) continue;
    if (key === 'type' && omitType) continue;
    if (key === 'pattern' && omitPattern) continue;
    out[key] = compactNode(value, NAME_KEYED_CONTAINERS.has(key));
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
/** A smaller subschema stays inline: a field a reader would otherwise chase a ref for. */
const HOIST_MIN_SUBSCHEMA_BYTES = 64;
const HOIST_MIN_SAVED_BYTES = 32;
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
        // A definition body is what refs POINT AT: walked, never replaced.
        if (!isDefinitions) sites.push({ holder: value, slot: name, node: child, nameHint: hint });
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
        .map(([key, entry]) => `${JSON.stringify(key)}:${jsonText(entry, memo)}`)
        .join(',')}}`;
  memo.set(value, text);
  return text;
}

/** Def name when the sites disagree on a property name: say what the shape IS. */
function shapeName(node: JsonObject): string {
  if (typeof node.format === 'string') return node.format;
  if (typeof node.type === 'string') return node.type;
  if (Array.isArray(node.type)) return node.type.join('_');
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (Object.hasOwn(node, key)) return key;
  return 'schema';
}

/**
 * Keep a def name inside [A-Za-z0-9_.-], so the `$ref` fragment compaction writes
 * needs neither pointer- nor percent-escaping: a validator that decodes the
 * fragment (RFC 6901 §6) and one that does not resolve it identically. A
 * property name is author-chosen and may hold a space, `%`, `/` or `#`.
 */
function safeDefinitionName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_.-]+/g, '_');
  return /[A-Za-z0-9]/.test(safe) ? safe : 'schema';
}

function definitionRef(definitionsKey: string, name: string): string {
  return `#/${definitionsKey}/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

/**
 * Move every subschema repeated VERBATIM into one definition plus `$ref`s —
 * greedily, largest saving first, so an enclosing repeat is taken before the
 * repeats inside it. Mutates `root`, which must be compaction's own fresh copy.
 */
function hoistRepeatedSubschemas(root: unknown): unknown {
  if (!isJsonObject(root) || Object.hasOwn(root, '$ref')) return root;
  const definitionsKey =
    !Object.hasOwn(root, '$defs') && isJsonObject(root.definitions) ? 'definitions' : '$defs';
  for (let round = 0; round < HOIST_MAX_ROUNDS; round++) {
    const sites: SubschemaSite[] = [];
    // Only the untouched input can refuse: every ref this pass writes is movable.
    if (!collectSites(root, 'schema', sites)) return root;
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
    let best: { sites: SubschemaSite[]; name: string; saved: number } | undefined;
    for (const [text, group] of groups) {
      const bytes = utf8Bytes(text);
      if (group.length < 2 || bytes < HOIST_MIN_SUBSCHEMA_BYTES) continue;
      const hint = group[0].nameHint;
      const base = safeDefinitionName(
        group.every((site) => site.nameHint === hint) ? hint : shapeName(group[0].node),
      );
      let name = base;
      for (let n = 2; definitions !== undefined && Object.hasOwn(definitions, name); n++) {
        name = `${base}_${n}`;
      }
      const refBytes = utf8Bytes(JSON.stringify({ $ref: definitionRef(definitionsKey, name) }));
      const entryBytes = utf8Bytes(JSON.stringify(name)) + bytes + 2 +
        (definitions === undefined ? utf8Bytes(`"${definitionsKey}":{}`) : 0);
      const saved = group.length * (bytes - refBytes) - entryBytes;
      if (saved >= HOIST_MIN_SAVED_BYTES && (best === undefined || saved > best.saved)) {
        best = { sites: group, name, saved };
      }
    }
    if (best === undefined) break;
    const target: JsonObject = definitions ?? {};
    root[definitionsKey] = target;
    target[best.name] = best.sites[0].node;
    for (const site of best.sites) {
      (site.holder as Record<string | number, unknown>)[site.slot] = {
        $ref: definitionRef(definitionsKey, best.name),
      };
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
