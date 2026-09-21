import { describe, expect, it } from 'vitest';

import {
  COMPACT_DROPPED_KEYS,
  compactInputSchema,
  compactWireBytes,
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
      'type',
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

  it('preserves $defs/$ref STRUCTURE rather than inlining it', () => {
    expect(compact.$defs).toBeDefined();
    // Both use sites still point at the shared definition — inlining would
    // duplicate the subschema and inflate the very budget this exists to cut.
    expect(collect(compact, '$ref')).toEqual(['#/$defs/Reused', '#/$defs/Reused']);
    const defs = compact.$defs as Record<string, Record<string, unknown>>;
    expect(defs.Reused.required).toEqual(['x']);
    expect(defs.Reused.description).toBeUndefined();
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
