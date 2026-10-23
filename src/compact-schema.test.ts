import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  COMPACT_DROPPED_KEYS,
  compactInputSchema,
  compactWireBytes,
  factorInputSchema,
  isVacuousPropertyNames,
} from './compact-schema';

/**
 * A schema exercising every element compaction must PRESERVE, plus every kind
 * of prose it must drop.
 *
 * ⚠ It deliberately contains a property literally NAMED `description` and one
 * named `default`. Those are argument names, not prose keywords, and a reducer
 * that tests keys without tracking whether it is inside `properties` will
 * silently delete them — turning a compact definition into a PARTIAL contract,
 * which is the single failure this whole projection must not have.
 */
const FULL_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  title: 'ExampleArgs',
  description: 'Prose about the whole object.',
  required: ['id', 'mode'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 200, description: 'the id' },
    mode: { type: 'string', enum: ['fast', 'slow', 'off'], description: 'which mode' },
    count: {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      exclusiveMinimum: -1,
      multipleOf: 2,
      default: 10,
      description: 'how many',
    },
    tags: {
      type: 'array',
      minItems: 1,
      maxItems: 40,
      uniqueItems: true,
      items: { type: 'string', pattern: '^[a-z-]+$', description: 'one tag' },
    },
    nested: {
      type: 'object',
      required: ['inner'],
      properties: {
        inner: { type: 'string', format: 'uuid', description: 'deep prose' },
      },
    },
    choice: {
      oneOf: [
        { type: 'object', required: ['kind'], properties: { kind: { const: 'a' } } },
        { type: 'object', required: ['kind'], properties: { kind: { const: 'b' } } },
      ],
      discriminator: { propertyName: 'kind' },
    },
    reused: { $ref: '#/$defs/Reused' },
    alsoReused: { $ref: '#/$defs/Reused' },
    // An argument NAMED like a prose keyword. Must survive.
    description: { type: 'string', description: 'a field actually called description' },
    default: { type: 'boolean', description: 'a field actually called default' },
  },
  $defs: {
    Reused: {
      type: 'object',
      required: ['x'],
      description: 'prose inside a $def',
      properties: { x: { type: 'number', minimum: 1 } },
    },
  },
  examples: [{ id: 'a', mode: 'fast' }],
} as const;

/** Every (path, value) pair in a JSON value, for containment assertions. */
function paths(node: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (node === null || typeof node !== 'object') {
    out.set(prefix, node);
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((entry, i) => {
      for (const [k, v] of paths(entry, `${prefix}[${i}]`)) out.set(k, v);
    });
    return out;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    for (const [k, v] of paths(value, `${prefix}/${key}`)) out.set(k, v);
  }
  return out;
}

/** Collect the value of every occurrence of `keyword`, at any depth. */
function collect(node: unknown, keyword: string, acc: unknown[] = []): unknown[] {
  if (node === null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const entry of node) collect(entry, keyword, acc);
    return acc;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === keyword) acc.push(value);
    collect(value, keyword, acc);
  }
  return acc;
}

describe('compactInputSchema', () => {
  const compact = compactInputSchema(FULL_SCHEMA) as Record<string, unknown>;

  it('preserves every required path from the full schema', () => {
    // Every `required` array, wherever it appears, survives identically.
    expect(collect(compact, 'required')).toEqual(collect(FULL_SCHEMA, 'required'));

    // And each named requirement still resolves to a real property.
    const props = compact.properties as Record<string, unknown>;
    for (const name of FULL_SCHEMA.required) {
      expect(props, `required property '${name}' must survive`).toHaveProperty(name);
    }
  });

  it('preserves every enum member and const', () => {
    expect(collect(compact, 'enum')).toEqual(collect(FULL_SCHEMA, 'enum'));
    expect(collect(compact, 'const')).toEqual(collect(FULL_SCHEMA, 'const'));
  });

  it('preserves every validity constraint', () => {
    for (const keyword of [
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'multipleOf',
      'minLength',
      'maxLength',
      'pattern',
      'format',
      'minItems',
      'maxItems',
      'uniqueItems',
      'additionalProperties',
      'oneOf',
      'discriminator',
    ]) {
      expect(
        collect(compact, keyword).length,
        `constraint '${keyword}' must survive compaction`,
      ).toBe(collect(FULL_SCHEMA, keyword).length);
    }
  });

  it('preserves every non-denylisted keyword even when a sibling appears to imply it', () => {
    const schema = {
      type: 'object',
      description: 'prose',
      properties: {
        mode: { type: 'string', enum: ['fixed'], description: 'prose' },
        id: z.toJSONSchema(z.uuid()),
        map: { type: 'object', propertyNames: { type: 'string' } },
        literal: { const: { description: 'literal data', default: 17 } },
        future: { 'x-future': { description: 'opaque future data', type: 'integer' } },
      },
    };
    const result = compactInputSchema(schema) as typeof schema;
    expect(result.properties.mode).toEqual({ type: 'string', enum: ['fixed'] });
    expect(result.properties.id).toEqual(schema.properties.id);
    expect(result.properties.map).toEqual(schema.properties.map);
    expect(result.properties.literal).toEqual(schema.properties.literal);
    expect(result.properties.future).toEqual(schema.properties.future);
    expect(result).not.toHaveProperty('description');
  });

  it('retains type constraints beside enum or const', () => {
    const compacted = compactInputSchema({
      type: 'object',
      properties: {
        text: { type: 'string', enum: ['fast', 'slow'] },
        nullable: { type: ['string', 'null'], enum: ['fast', null] },
        integer: { type: 'integer', enum: [1, 2] },
        literal: { type: 'string', const: 'fixed' },
        mismatchedEnum: { type: 'string', enum: ['kept', 1] },
        mismatchedConst: { type: 'integer', const: 1.5 },
        impossibleConst: { type: 'string', const: 1 },
      },
    }) as { properties: Record<string, Record<string, unknown>> };

    for (const name of ['text', 'nullable', 'integer', 'literal']) {
      expect(compacted.properties[name], `${name} keeps its explicit type`).toHaveProperty('type');
    }
    for (const name of ['mismatchedEnum', 'mismatchedConst', 'impossibleConst']) {
      expect(compacted.properties[name], `${name} still needs its non-redundant type`).toHaveProperty('type');
    }
  });

  it('does not mistake schema-keyword names for keywords inside a properties map', () => {
    const compacted = compactInputSchema({
      type: 'object',
      properties: {
        enum: { type: 'string', enum: ['value'] },
        type: { type: 'string' },
      },
    }) as { properties: Record<string, Record<string, unknown>> };

    expect(compacted.properties).toHaveProperty('enum');
    expect(compacted.properties).toHaveProperty('type');
    expect(compacted.properties.enum).toEqual({ type: 'string', enum: ['value'] });
    expect(compacted.properties.type).toEqual({ type: 'string' });
  });

  it('preserves $defs/$ref STRUCTURE rather than inlining it', () => {
    expect(compact.$defs).toBeDefined();
    // Both use sites still point at the shared definition — inlining would
    // duplicate the subschema and inflate the very budget this exists to cut.
    expect(collect(compact, '$ref')).toEqual(['#/$defs/Reused', '#/$defs/Reused']);
    const defs = compact.$defs as Record<string, Record<string, unknown>>;
    expect(defs.Reused.required).toEqual(['x']);
    expect(defs.Reused.description).toBeUndefined();
  });

  // The test below iterates COMPACT_DROPPED_KEYS itself, so it adapts to any
  // addition and can never object to one. That adaptivity is the hazard: adding
  // a keyword that genuinely constrains validity — `patternProperties` or
  // `propertyNames`, say — would keep every other test in this file green while
  // turning a compact definition into a PARTIAL contract, which is the single
  // failure the compact tier must never allow. So pin the membership itself.
  //
  // Changing this list takes a recorded plan decision, not just a green run:
  // every name here must be one that cannot affect whether a call VALIDATES
  // (the doc comment on COMPACT_DROPPED_KEYS lists the keywords deliberately
  // excluded, and why each one constrains validity).
  it('pins the dropped-keyword denylist so a validity-constraining addition cannot pass silently', () => {
    expect([...COMPACT_DROPPED_KEYS]).toEqual([
      'description',
      'title',
      'examples',
      'example',
      'default',
    ]);
  });

  it('drops every prose keyword at every depth', () => {
    for (const keyword of COMPACT_DROPPED_KEYS) {
      // `properties.description` / `properties.default` are NAMES, not keywords,
      // so look only at keyword positions — which is exactly what `collect`
      // cannot distinguish. Assert on the serialized keyword form instead.
      const serialized = JSON.stringify(compact);
      expect(
        serialized.includes(`"${keyword}":"`) || serialized.includes(`"${keyword}":[`),
        `prose keyword '${keyword}' must not survive`,
      ).toBe(false);
    }
    // No prose STRING from the original survives anywhere.
    for (const prose of [
      'Prose about the whole object.',
      'the id',
      'which mode',
      'how many',
      'one tag',
      'deep prose',
      'prose inside a $def',
      'ExampleArgs',
    ]) {
      expect(JSON.stringify(compact)).not.toContain(prose);
    }
  });

  it('KEEPS a property whose NAME collides with a prose keyword', () => {
    // The partial-contract trap. A reducer that matches keys blindly deletes
    // these and produces a schema that silently rejects a valid call.
    const props = compact.properties as Record<string, unknown>;
    expect(props).toHaveProperty('description');
    expect(props).toHaveProperty('default');
    expect(props.description).toEqual({ type: 'string' });
    expect(props.default).toEqual({ type: 'boolean' });
  });

  it('is a pure projection — the input is not mutated', () => {
    const before = JSON.stringify(FULL_SCHEMA);
    compactInputSchema(FULL_SCHEMA);
    expect(JSON.stringify(FULL_SCHEMA)).toBe(before);
  });

  it('is idempotent', () => {
    expect(compactInputSchema(compact)).toEqual(compact);
  });

  it('never throws on malformed or non-object input', () => {
    for (const input of [undefined, null, 42, 'str', [], {}, { properties: null }]) {
      expect(() => compactInputSchema(input)).not.toThrow();
    }
  });

  it('CONTROL: a reducer that ignores name-keyed containers would fail the trap test', () => {
    // Falsifiability control. This is the naive implementation the real one must
    // beat; it must visibly destroy the contract, or the trap test above proves
    // nothing. Keep this here rather than mutating the real module (the shared
    // tree is swept by git-sync, so an in-tree mutation probe can be committed).
    const naive = (node: unknown): unknown => {
      if (node === null || typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map(naive);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if ((COMPACT_DROPPED_KEYS as readonly string[]).includes(k)) continue;
        out[k] = naive(v);
      }
      return out;
    };
    const wrong = naive(FULL_SCHEMA) as Record<string, unknown>;
    const wrongProps = wrong.properties as Record<string, unknown>;
    expect(wrongProps).not.toHaveProperty('description');
    expect(wrongProps).not.toHaveProperty('default');
  });
});

describe('compactWireBytes', () => {
  it('reports full, compact and saved bytes that reconcile exactly', () => {
    const m = compactWireBytes('example:verb', {
      description: 'A fairly wordy description that costs real bytes on the wire.',
      inputSchema: FULL_SCHEMA,
    });
    expect(m.saved).toBe(m.full - m.compact);
    expect(m.compact).toBeLessThan(m.full);
    expect(m.compact).toBeGreaterThan(0);
  });

  it('MEASURES the reduction for this schema rather than asserting a magic number', () => {
    const m = compactWireBytes('example:verb', {
      description: 'A fairly wordy description that costs real bytes on the wire.',
      inputSchema: FULL_SCHEMA,
    });
    const pct = ((m.saved / m.full) * 100).toFixed(1);
    // Reported, not gated: the value is the measurement, and pinning it to a
    // threshold would make an honest change to the fixture look like a failure.
    // eslint-disable-next-line no-console
    console.log(
      `[compact-schema] fixture: full=${m.full}B compact=${m.compact}B saved=${m.saved}B (${pct}%)`,
    );
    expect(m.saved).toBeGreaterThan(0);
  });

  it('handles a tool with no schema and no description', () => {
    const m = compactWireBytes('bare:verb', {});
    expect(m.full).toBeGreaterThan(0);
    expect(m.saved).toBe(0);
  });
});

describe('format-implied patterns', () => {
  /** What zod itself emits for a field, so these tests track the real pairs. */
  const emitted = (schema: z.ZodType) => z.toJSONSchema(schema) as Record<string, unknown>;

  it('retains zod\'s regex beside its format as an explicit contract element', () => {
    for (const schema of [
      z.uuid(),
      z.guid(),
      z.email(),
      z.iso.datetime({ offset: true }),
      z.iso.datetime({ offset: true, local: true }),
      z.iso.date(),
    ]) {
      const full = emitted(schema);
      // Non-vacuity: without an emitted pattern there is nothing to drop.
      expect(typeof full.pattern, `${String(full.format)} must emit a pattern`).toBe('string');
      const compact = compactInputSchema(full) as Record<string, unknown>;
      expect(compact.pattern, `${String(full.format)} pattern must survive`).toBe(full.pattern);
      expect(compact.format).toBe(full.format);
    }
  });

  it('KEEPS the pattern of a variant that NARROWS its format', () => {
    // Z-only and local-only date-times, a fixed precision and a uuid VERSION each
    // reject values the bare format name allows, so the regex is real contract.
    for (const schema of [
      z.iso.datetime(),
      z.iso.datetime({ local: true }),
      z.iso.datetime({ offset: true, precision: 3 }),
      z.uuidv4(),
    ]) {
      const full = emitted(schema);
      expect(typeof full.pattern).toBe('string');
      expect((compactInputSchema(full) as Record<string, unknown>).pattern).toBe(full.pattern);
    }
  });

  it('KEEPS a hand-written pattern beside a format, and a canonical pattern without its format', () => {
    const custom = { type: 'string', format: 'uuid', pattern: '^[0-9a-f-]{36}$' };
    expect(compactInputSchema(custom)).toEqual(custom);

    const uuidPattern = emitted(z.uuid()).pattern;
    const bare = { type: 'string', pattern: uuidPattern };
    expect(compactInputSchema(bare)).toEqual(bare);
    // The pair must match, not just the regex: a uuid regex under `email` is real contract.
    const crossed = { type: 'string', format: 'email', pattern: uuidPattern };
    expect(compactInputSchema(crossed)).toEqual(crossed);
  });

  it('applies at depth, keeps a property NAMED pattern, and is idempotent', () => {
    const full = emitted(
      z.object({
        id: z.uuid(),
        at: z.iso.datetime({ offset: true }),
        list: z.array(z.uuid()),
        pattern: z.string().regex(/^[a-z]+$/),
      }),
    );
    const once = compactInputSchema(full) as {
      properties: Record<string, Record<string, unknown>>;
    };
    const defs = (once as unknown as { $defs?: Record<string, Record<string, unknown>> }).$defs ?? {};
    const pattern = (node: Record<string, unknown>) => typeof node.$ref === 'string'
      ? defs[node.$ref.split('/').at(-1)!]?.pattern : node.pattern;
    const original = full.properties as Record<string, Record<string, unknown>>;
    expect(pattern(once.properties.id)).toBe(original.id.pattern);
    expect(pattern(once.properties.at)).toBe(original.at.pattern);
    expect(pattern(once.properties.list.items as Record<string, unknown>)).toBe(
      (original.list.items as Record<string, unknown>).pattern,
    );
    // A property literally named `pattern` is an argument, and its own regex is not
    // format-implied, so both survive.
    expect(once.properties.pattern.pattern).toBe('^[a-z]+$');
    expect(compactInputSchema(once)).toEqual(once);
  });

  it('does not count a retained uuid pattern as compact savings', () => {
    const tool = { inputSchema: emitted(z.object({ id: z.uuid() })) };
    const withPattern = compactWireBytes('x:y', tool);
    const compact = compactInputSchema(tool.inputSchema) as typeof tool.inputSchema;
    expect(compact.properties).toEqual(tool.inputSchema.properties);
    expect(withPattern.saved).toBe(withPattern.full - withPattern.compact);
  });
});

describe('verbatim-repeated subschemas are hoisted into $defs', () => {
  // The batch envelope shape: the SAME sub-object at the root and in every items[] entry.
  const big = () => ({
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['alpha', 'beta', 'gamma'] },
      refs: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 },
    },
    required: ['kind'],
    additionalProperties: false,
  });
  const batch = (extra: Record<string, unknown> = {}) => ({
    type: 'object',
    properties: {
      report: big(),
      items: { type: 'array', items: { type: 'object', properties: { report: big(), ...extra } } },
    },
  });
  /** Inline every root-definition ref: the contract a validator actually applies. */
  const resolve = (schema: any, node: any = schema): any => {
    if (Array.isArray(node)) return node.map((entry) => resolve(schema, entry));
    if (node === null || typeof node !== 'object') return node;
    if (typeof node.$ref === 'string') return resolve(schema, schema.$defs[node.$ref.slice('#/$defs/'.length)]);
    return Object.fromEntries(
      Object.entries(node).filter(([key]) => key !== '$defs').map(([key, value]) => [key, resolve(schema, value)]),
    );
  };

  it('pays for a repeated sub-object ONCE with the contract intact', () => {
    const out = compactInputSchema(batch()) as any;
    const report = compactInputSchema(big());
    const inline = {
      type: 'object',
      properties: { report, items: { type: 'array', items: { type: 'object', properties: { report } } } },
    };
    expect(out.properties.report).toEqual({ $ref: '#/$defs/0' });
    expect(out.properties.items.items.properties.report).toEqual({ $ref: '#/$defs/0' });
    expect(out.$defs).toEqual({ 0: report });
    expect(resolve(out)).toEqual(inline);
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(inline).length);
  });

  it('factors full schemas with metadata, validation and literal data intact', () => {
    const leaf = {
      ...big(), title: 'Report', description: 'An authored report with bounded references.',
      examples: [{ description: 'literal example' }], default: { kind: 'alpha' },
    };
    const input = {
      type: 'object', title: 'Full envelope',
      properties: { left: leaf, right: structuredClone(leaf) },
      const: { description: 'literal data', title: 'literal title' },
      'x-future': { description: 'opaque metadata' },
    };
    const before = structuredClone(input);
    const out = factorInputSchema(input) as any;
    expect(resolve(out)).toEqual(input);
    expect(input).toEqual(before);
    expect(out.$defs['0']).toEqual(leaf);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(Buffer.byteLength(JSON.stringify(input)));
    expect(factorInputSchema(out)).toEqual(out);
  });

  it('retains small full schemas and refuses location-sensitive factoring', () => {
    const leaf = { type: 'string', description: 'short' };
    const small = { type: 'object', properties: { left: leaf, right: leaf } };
    expect(factorInputSchema(small)).toEqual(small);
    const scoped = { ...big(), $id: 'relative', description: 'Keep the original resolution scope.' };
    const input = { type: 'object', properties: { left: scoped, right: scoped } };
    expect(factorInputSchema(input)).toEqual(input);
  });

  it('aliases repeated definition bodies after metadata removal without losing names or creating self refs', () => {
    const input = {
      type: 'object',
      properties: { left: { $ref: '#/$defs/Alpha' }, right: { $ref: '#/$defs/Beta' } },
      $defs: {
        Alpha: { ...big(), description: 'First authored explanation.' },
        Beta: { ...big(), description: 'Different explanation, same constraints.' },
      },
    };
    const before = structuredClone(input);
    const out = compactInputSchema(factorInputSchema(input)) as any;
    expect(Object.keys(out.$defs)).toEqual(expect.arrayContaining(['Alpha', 'Beta']));
    expect([out.$defs.Alpha.$ref, out.$defs.Beta.$ref].filter(Boolean)).toHaveLength(1);
    expect(out.$defs.Alpha.$ref).not.toBe('#/$defs/Alpha');
    expect(out.$defs.Beta.$ref).not.toBe('#/$defs/Beta');
    expect(resolve(out)).toEqual({
      type: 'object', properties: { left: big(), right: big() },
    });
    expect(input).toEqual(before);
    expect(compactInputSchema(out)).toEqual(out);
  });

  it('normalizes cheaper alias references before comparing parents and leaves cyclic aliases intact', () => {
    const input = {
      type: 'object',
      properties: { left: { $ref: '#/$defs/AliasLong' }, right: { $ref: '#/$defs/k' } },
      $defs: { AliasLong: { $ref: '#/$defs/MiddleLong' }, MiddleLong: { $ref: '#/$defs/k' }, k: big() },
      const: { $ref: '#/$defs/AliasLong' },
    };
    const out = factorInputSchema(input) as any;
    expect(out.properties.left).toEqual(out.properties.right);
    expect(Object.keys(out.$defs)).toEqual(expect.arrayContaining(Object.keys(input.$defs)));
    expect(resolve(out)).toEqual(resolve(input));
    expect(out.const).toEqual(input.const);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(Buffer.byteLength(JSON.stringify(input)));
    const cycle = { type: 'object', properties: { x: { $ref: '#/$defs/a' } },
      $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } } };
    expect(factorInputSchema(cycle)).toEqual(cycle);
  });

  it('never spends the compact wire budget to factor repeated full annotations', () => {
    const left = { ...big(), description: 'Left full explanation, intentionally distinct.' };
    const right = { ...big(), description: 'Right full explanation, intentionally distinct.' };
    const input = { type: 'object', properties: { left, leftAgain: structuredClone(left),
      right, rightAgain: structuredClone(right) } };
    const full = factorInputSchema(input);
    expect(resolve(full)).toEqual(input);
    expect(Buffer.byteLength(JSON.stringify(full))).toBeLessThan(Buffer.byteLength(JSON.stringify(input)));
    expect(Buffer.byteLength(JSON.stringify(compactInputSchema(full))))
      .toBeLessThanOrEqual(Buffer.byteLength(JSON.stringify(compactInputSchema(input))));
    expect(factorInputSchema(full)).toEqual(full);
  });

  it('leaves a small repeated leaf inline, so a short field never costs a reader a ref', () => {
    const leaf = { type: 'string', minLength: 1 };
    const out = compactInputSchema({ type: 'object', properties: { a: leaf, b: { ...leaf }, c: { ...leaf } } }) as any;
    expect(out.$defs).toBeUndefined();
    expect(out.properties).toEqual({ a: leaf, b: leaf, c: leaf });
  });

  it('hoists a frequently repeated bounded scalar when its complete wire representation is smaller', () => {
    const leaf = { type: 'string', minLength: 1, maxLength: 200 };
    const input = {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`field${index}`, { ...leaf }])),
    };
    const out = compactInputSchema(input) as any;
    expect(out.$defs).toEqual({ 0: leaf });
    expect(Object.values(out.properties)).toEqual(Array.from({ length: 8 }, () => ({ $ref: '#/$defs/0' })));
    expect(resolve(out)).toEqual(input);
    expect(JSON.stringify(input).length - JSON.stringify(out).length).toBeGreaterThanOrEqual(16);
  });

  it('keeps a bounded scalar inline when the definition and refs would cost more', () => {
    const leaf = { type: 'string', minLength: 1, maxLength: 200 };
    const input = { type: 'object', properties: { left: { ...leaf }, right: { ...leaf } } };
    expect(compactInputSchema(input)).toEqual(input);
  });

  it('hoists frequent bounded scalar fields when their net savings pay for the references', () => {
    const leaf = { type: 'string', minLength: 1, maxLength: 100 };
    const input = {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field${i}`, { ...leaf }])),
    };
    const out = compactInputSchema(input) as any;
    expect(out.$defs).toEqual({ 0: leaf });
    expect(resolve(out)).toEqual(input);
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(input).length - 32);
    expect(compactInputSchema(out)).toEqual(out);
    expect(input.properties.field0).toEqual(leaf);
  });

  it('does not clobber an authored definition or its references', () => {
    const list = () => ({ type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, minItems: 1, maxItems: 50 });
    const out = compactInputSchema({
      type: 'object',
      properties: { left: list(), middle: list(), right: list(), other: { $ref: '#/$defs/0' } },
      $defs: { 0: { type: 'number' } },
    }) as any;
    for (const key of ['left', 'middle', 'right']) expect(out.properties[key]).toEqual({ $ref: '#/$defs/1' });
    expect(out.$defs).toEqual({ 0: { type: 'number' }, 1: list() });
    expect(out.properties.other).toEqual({ $ref: '#/$defs/0' });
  });

  it('names a def in URI-safe characters, so its $ref fragment needs no escaping', () => {
    // The parents differ (x vs y), so the shared repeat is the sub-object under
    // an author-chosen property NAME that would need pointer + percent escaping.
    const odd = 'my key/%#';
    const out = compactInputSchema({
      type: 'object',
      properties: {
        a: { type: 'object', properties: { [odd]: big(), x: { type: 'string' } } },
        b: { type: 'object', properties: { [odd]: big(), y: { type: 'integer' } } },
      },
    }) as any;
    const report = compactInputSchema(big());
    expect(Object.keys(out.$defs)).toEqual(['0']);
    expect(out.properties.a.properties[odd]).toEqual({ $ref: '#/$defs/0' });
    expect(out.properties.b.properties[odd]).toEqual({ $ref: '#/$defs/0' });
    expect(resolve(out)).toEqual({
      type: 'object',
      properties: {
        a: { type: 'object', properties: { [odd]: report, x: { type: 'string' } } },
        b: { type: 'object', properties: { [odd]: report, y: { type: 'integer' } } },
      },
    });
  });

  it('never rewrites a DATA keyword, even one that repeats verbatim', () => {
    const members = ['first-long-member-name', 'second-long-member-name', 'third-long-member-name'];
    const out = compactInputSchema({
      type: 'object',
      properties: { a: { enum: [...members] }, b: { enum: [...members] } },
      'x-meta': { a: [...members], b: [...members] },
    }) as any;
    expect(out['x-meta']).toEqual({ a: members, b: members });
    expect(resolve(out).properties).toEqual({ a: { enum: members }, b: { enum: members } });
  });

  it('moves nothing when a ref or anchor depends on WHERE a subschema sits', () => {
    const pinned = [
      { pointer: { $ref: '#/properties/report/properties/kind' } },
      { anchored: { $anchor: 'here', type: 'string' } },
    ];
    for (const extra of pinned) {
      const out = compactInputSchema(batch(extra)) as any;
      expect(out.$defs).toBeUndefined();
      expect(out.properties.report).toEqual(compactInputSchema(big()));
    }
  });

  it('is idempotent and never mutates its input', () => {
    const input = batch();
    const snapshot = JSON.stringify(input);
    const once = compactInputSchema(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(compactInputSchema(once)).toEqual(once);
  });

  it('reuses an authored definition for even one matching inline schema', () => {
    const leaf = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[a-z]+$' };
    const input = { type: 'object', properties: { value: leaf }, $defs: { known: { ...leaf } } };
    const out = compactInputSchema(input) as any;
    expect(out.$defs).toEqual(input.$defs);
    expect(out.properties.value).toEqual({ $ref: '#/$defs/known' });
    expect(resolve(out)).toEqual(resolve(input));
    expect(compactInputSchema(out)).toEqual(out);
  });

  it('factors object-key order differences while preserving array and literal data order', () => {
    const left = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[a-z]+$' };
    const right = { pattern: '^[a-z]+$', maxLength: 200, minLength: 1, type: 'string' };
    const input = { type: 'object', properties: { left, right }, 'x-data': { right, left } };
    const out = compactInputSchema(input) as any;
    expect(out.properties.left).toEqual(out.properties.right);
    expect(out.properties.left).toHaveProperty('$ref');
    expect(resolve(out)).toEqual(input);
    expect(out['x-data']).toEqual(input['x-data']);
  });
});

// WI-10006197: a JSON object key is always a string, so a `propertyNames` that
// every string satisfies restates nothing. zod emits `{ type: 'string' }` beside
// every z.record, which each map-valued floor-tool argument paid for per launch.
describe('vacuous propertyNames', () => {
  const recordArgs = () =>
    z.toJSONSchema(
      z.object({ env: z.record(z.string(), z.string()), tags: z.record(z.string(), z.number()) }),
    ) as Record<string, any>;

  it('retains the propertyNames zod emits beside a z.record and its value schema', () => {
    const full = recordArgs();
    // The precondition this rule exists for: zod really does emit it.
    expect(full.properties.env.propertyNames).toEqual({ type: 'string' });
    const out = compactInputSchema(full) as Record<string, any>;
    expect(out.properties.env.propertyNames).toEqual({ type: 'string' });
    expect(out.properties.env.additionalProperties).toEqual({ type: 'string' });
    expect(out.properties.tags.propertyNames).toEqual({ type: 'string' });
    expect(out.properties.tags.additionalProperties).toEqual({ type: 'number' });
    expect(JSON.stringify(out)).toContain('propertyNames');
  });

  it.each([
    ['true', true],
    ['an empty subschema', {}],
    ['a prose-only subschema', { description: 'any key' }],
    ['type string', { type: 'string' }],
    ['type string plus prose', { type: 'string', title: 'Key' }],
    ['a type union containing string', { type: ['string', 'null'] }],
  ])('treats %s as vacuous', (_label, names) => {
    expect(isVacuousPropertyNames(names)).toBe(true);
    const out = compactInputSchema({ type: 'object', propertyNames: names }) as Record<string, unknown>;
    expect(out).toHaveProperty('propertyNames');
  });

  it.each([
    ['a key pattern', { type: 'string', pattern: '^[A-Z_]+$' }],
    ['a key enum', { enum: ['a', 'b'] }],
    ['a key length bound', { type: 'string', minLength: 2 }],
    ['a non-string type, which no key satisfies', { type: 'number' }],
    ['false', false],
    ['a $ref', { $ref: '#/$defs/Key' }],
  ])('KEEPS a propertyNames that constrains keys: %s', (_label, names) => {
    expect(isVacuousPropertyNames(names)).toBe(false);
    const out = compactInputSchema({ type: 'object', propertyNames: names }) as Record<string, unknown>;
    expect(out).toHaveProperty('propertyNames');
  });

  it('never touches a PROPERTY that is merely named propertyNames', () => {
    const schema = {
      type: 'object',
      required: ['propertyNames'],
      properties: { propertyNames: { type: 'string' } },
    };
    expect(compactInputSchema(schema)).toEqual(schema);
  });
});
