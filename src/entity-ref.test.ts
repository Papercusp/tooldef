/**
 * entity-ref — the semantic entity-reference arg type
 * (tool-arg-referential-integrity-2026-07-19 P-001).
 *
 * Pins the three properties the dispatch step depends on: the marker survives
 * Zod wrapping, resolvers are consulted ONCE per kind (batched), and the whole
 * layer FAILS OPEN so a lookup outage can never take down a tool.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  applyEntityRefEnums,
  clearEntityEnums,
  clearEntityResolvers,
  collectEntityRefs,
  ENTITY_ENUM_CACHE_TTL_MS,
  entityEnumRevision,
  entityRef,
  entityRefMeta,
  formatEntityRefViolations,
  hasEntityResolver,
  resolveEntityRefs,
  setEntityEnum,
  setEntityResolver,
} from './entity-ref';
import { toJsonSchema } from './schema-adapter';

afterEach(() => {
  clearEntityResolvers();
  clearEntityEnums();
  vi.restoreAllMocks();
});

describe('entityRef marker', () => {
  it('marks a bare ref and leaves a plain string unmarked', () => {
    expect(entityRefMeta(entityRef('pot'))?.kind).toBe('pot');
    expect(entityRefMeta(z.string())).toBeUndefined();
  });

  // The regression that made an entire conversion pass inert: Zod 4 CLONES on
  // .describe()/.max(), orphaning a marker keyed on schema identity. These pin
  // that the options form works and stay a warning about the chained form.
  it('keeps the marker when describe/max are passed as OPTIONS', () => {
    const s = entityRef('pot', { describe: 'the pot', max: 120 });
    expect(entityRefMeta(s)?.kind).toBe('pot');
    expect(collectEntityRefs(z.object({ pot: s }))).toHaveLength(1);
  });

  it('carries describe/max through to the published schema', () => {
    const js = z.toJSONSchema(z.object({ pot: entityRef('pot', { describe: 'the pot', max: 120 }) })) as any;
    expect(js.properties.pot.description).toBe('the pot');
    expect(js.properties.pot.maxLength).toBe(120);
  });

  it('DOCUMENTS the footgun: chaining .describe() after entityRef orphans the marker', () => {
    // Not desired behaviour — a property of Zod cloning. Pinned so the options
    // form above is never "simplified" back into a chain.
    const chained = entityRef('pot').describe('the pot');
    expect(entityRefMeta(chained)).toBeUndefined();
    expect(collectEntityRefs(z.object({ pot: chained }))).toHaveLength(0);
  });

  it('does NOT leak the marker into the published JSON Schema', () => {
    // Adding validation must not change what tools/list advertises.
    const withRef = z.toJSONSchema(z.object({ pot: entityRef('pot') }));
    const plain = z.toJSONSchema(z.object({ pot: z.string().min(1) }));
    expect(withRef).toEqual(plain);
  });
});

describe('collectEntityRefs', () => {
  it('finds a top-level ref', () => {
    expect(collectEntityRefs(z.object({ pot: entityRef('pot') }))).toEqual([
      { path: 'pot', meta: { kind: 'pot' } },
    ]);
  });

  it('sees through optional/nullable/default wrappers', () => {
    const sites = collectEntityRefs(
      z.object({
        a: entityRef('pot').optional(),
        b: entityRef('harness').nullable(),
        c: entityRef('fleet').default('x'),
      }),
    );
    expect(sites.map((s) => `${s.path}:${s.meta.kind}`).sort()).toEqual([
      'a:pot',
      'b:harness',
      'c:fleet',
    ]);
  });

  it('finds refs nested in objects and arrays', () => {
    const sites = collectEntityRefs(
      z.object({ members: z.array(z.object({ pot: entityRef('pot') })) }),
    );
    expect(sites).toEqual([{ path: 'members.*.pot', meta: { kind: 'pot' } }]);
  });

  // Multi-op tools here are built as `z.discriminatedUnion('op', [...])`. Before
  // the union branch existed, every one of them reported ZERO refs — the check
  // and the published enum both skipped them entirely.
  it('finds refs inside a discriminated union, tagged by branch', () => {
    const sites = collectEntityRefs(
      z.discriminatedUnion('op', [
        z.object({ op: z.literal('set'), role: entityRef('role') }),
        z.object({ op: z.literal('list') }),
        z.object({ op: z.literal('clear'), role: entityRef('role').optional() }),
      ]),
    );
    expect(sites.map((s) => s.path)).toEqual(['#0.role', '#2.role']);
  });

  it('returns nothing for a schema with no refs', () => {
    expect(collectEntityRefs(z.object({ n: z.number(), s: z.string() }))).toEqual([]);
  });
});

describe('resolveEntityRefs', () => {
  const potsResolver = (known: string[]) =>
    vi.fn(async (values: readonly string[]) => ({
      unknown: values.filter((v) => !known.includes(v)),
      allowed: known,
    }));

  it('reports an unknown value with its path', async () => {
    setEntityResolver('pot', potsResolver(['papercusp']));
    const schema = z.object({ pot: entityRef('pot') });
    const v = await resolveEntityRefs(collectEntityRefs(schema), { pot: 'made-up' });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ path: 'pot', kind: 'pot', value: 'made-up' });
  });

  it('passes a value that exists', async () => {
    setEntityResolver('pot', potsResolver(['papercusp']));
    const schema = z.object({ pot: entityRef('pot') });
    expect(await resolveEntityRefs(collectEntityRefs(schema), { pot: 'papercusp' })).toEqual([]);
  });

  it('consults each resolver ONCE with every value (batched, DataLoader-style)', async () => {
    const fn = potsResolver(['a']);
    setEntityResolver('pot', fn);
    const schema = z.object({ pot: entityRef('pot'), members: z.array(z.object({ pot: entityRef('pot') })) });
    await resolveEntityRefs(collectEntityRefs(schema), {
      pot: 'a',
      members: [{ pot: 'b' }, { pot: 'c' }],
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect([...fn.mock.calls[0][0]].sort()).toEqual(['a', 'b', 'c']);
  });

  it('reports EVERY array element that is unknown, with indexed paths', async () => {
    setEntityResolver('pot', potsResolver(['ok']));
    const schema = z.object({ members: z.array(z.object({ pot: entityRef('pot') })) });
    const v = await resolveEntityRefs(collectEntityRefs(schema), {
      members: [{ pot: 'ok' }, { pot: 'bad' }, { pot: 'worse' }],
    });
    expect(v.map((x) => x.path).sort()).toEqual(['members.1.pot', 'members.2.pot']);
  });

  // The fail-open contract: this layer sits IN FRONT OF the DB foreign keys,
  // which are the real backstop. It must never be the reason a tool dies.
  it('FAILS OPEN when a kind has no registered resolver', async () => {
    const schema = z.object({ pot: entityRef('pot') });
    expect(hasEntityResolver('pot')).toBe(false);
    expect(await resolveEntityRefs(collectEntityRefs(schema), { pot: 'anything' })).toEqual([]);
  });

  it('FAILS OPEN when the resolver throws (lookup outage)', async () => {
    setEntityResolver('pot', async () => {
      throw new Error('pg down');
    });
    const schema = z.object({ pot: entityRef('pot') });
    expect(await resolveEntityRefs(collectEntityRefs(schema), { pot: 'x' })).toEqual([]);
  });

  it('ignores absent optional args rather than calling the resolver', async () => {
    const fn = potsResolver(['a']);
    setEntityResolver('pot', fn);
    const schema = z.object({ pot: entityRef('pot').optional() });
    expect(await resolveEntityRefs(collectEntityRefs(schema), {})).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('marks a soft ref so a staged rollout can warn instead of reject', async () => {
    setEntityResolver('pot', potsResolver([]));
    const schema = z.object({ pot: entityRef('pot', { soft: true }) });
    const v = await resolveEntityRefs(collectEntityRefs(schema), { pot: 'nope' });
    expect(v[0].soft).toBe(true);
  });
});

describe('formatEntityRefViolations', () => {
  it('leads with the nearest match when there is one', async () => {
    setEntityResolver('pot', async (values) => ({
      unknown: values,
      suggestions: { papercsp: ['papercusp'] },
    }));
    const schema = z.object({ pot: entityRef('pot') });
    const msg = formatEntityRefViolations(
      await resolveEntityRefs(collectEntityRefs(schema), { pot: 'papercsp' }),
    );
    expect(msg).toContain('unknown pot "papercsp"');
    expect(msg).toContain('did you mean `papercusp`');
  });

  it('names the allowed set when it is small enough to help', async () => {
    setEntityResolver('pot', async (values) => ({ unknown: values, allowed: ['a', 'b'] }));
    const schema = z.object({ pot: entityRef('pot') });
    const msg = formatEntityRefViolations(
      await resolveEntityRefs(collectEntityRefs(schema), { pot: 'zz' }),
    );
    expect(msg).toContain('valid values: `a`, `b`');
  });

  it('omits a large allowed set rather than dumping noise', async () => {
    const many = Array.from({ length: 40 }, (_v, i) => `p${i}`);
    setEntityResolver('pot', async (values) => ({ unknown: values, allowed: many }));
    const schema = z.object({ pot: entityRef('pot') });
    const msg = formatEntityRefViolations(
      await resolveEntityRefs(collectEntityRefs(schema), { pot: 'zz' }),
    );
    expect(msg).not.toContain('valid values');
  });

  it('uses the custom label in the message', async () => {
    setEntityResolver('pot', async (values) => ({ unknown: values }));
    const schema = z.object({ p: entityRef('pot', { label: 'pot slug' }) });
    const msg = formatEntityRefViolations(
      await resolveEntityRefs(collectEntityRefs(schema), { p: 'zz' }),
    );
    expect(msg).toContain('unknown pot slug');
  });
});

/**
 * The tools/list overlay (P-004b). The property that matters most here is the
 * CAP: `tools/list` bytes are prompt-prefix bytes, so an over-cap vocabulary
 * must publish nothing at all rather than "most of it".
 */
describe('applyEntityRefEnums', () => {
  const json = (schema: unknown) => toJsonSchema(schema as never) as Record<string, unknown>;

  it('publishes a small vocabulary as an enum at the arg it marks', async () => {
    setEntityEnum('pot', async () => ['b', 'a']);
    const schema = z.object({ pot: entityRef('pot'), note: z.string() });
    const out = await applyEntityRefEnums(schema, json(schema));
    const props = out.properties as Record<string, Record<string, unknown>>;
    // Sorted, so the published bytes do not churn on load order alone.
    expect(props.pot.enum).toEqual(['a', 'b']);
    expect(props.note.enum).toBeUndefined();
  });

  it('publishes NOTHING when the vocabulary exceeds the cap', async () => {
    setEntityEnum('pot', async () => ['a', 'b', 'c'], { maxValues: 2 });
    const schema = z.object({ pot: entityRef('pot') });
    const out = await applyEntityRefEnums(schema, json(schema));
    expect((out.properties as Record<string, Record<string, unknown>>).pot.enum).toBeUndefined();
  });

  it('pairs the enum with a pattern for an open vocabulary, dropping the scalar type', async () => {
    setEntityEnum('role', async () => ['worker'], { openPattern: '^[a-z]+:[a-z]+$' });
    const schema = z.object({ role: entityRef('role') });
    const out = await applyEntityRefEnums(schema, json(schema));
    const node = (out.properties as Record<string, Record<string, unknown>>).role;
    expect(node.anyOf).toEqual([
      { enum: ['worker'] },
      { type: 'string', pattern: '^[a-z]+:[a-z]+$' },
    ]);
    expect(node.type).toBeUndefined();
  });

  it('reaches a ref nested in an array of objects', async () => {
    setEntityEnum('pot', async () => ['a']);
    const schema = z.object({ members: z.array(z.object({ pot: entityRef('pot') })) });
    const out = await applyEntityRefEnums(schema, json(schema));
    const members = (out.properties as Record<string, Record<string, unknown>>).members;
    const item = members.items as Record<string, Record<string, Record<string, unknown>>>;
    expect(item.properties.pot.enum).toEqual(['a']);
  });

  it('fails open when an enumerator throws — discovery must never break', async () => {
    setEntityEnum('pot', async () => {
      throw new Error('db down');
    });
    const schema = z.object({ pot: entityRef('pot') });
    const out = await applyEntityRefEnums(schema, json(schema));
    expect((out.properties as Record<string, Record<string, unknown>>).pot.enum).toBeUndefined();
  });

  it('single-flights one kind across a concurrent tools/list catalog walk', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = vi.fn(async () => {
      await gate;
      return ['a'];
    });
    setEntityEnum('pot', load);

    // Papercusp currently calls applyEntityRefEnums once per visible tool. A
    // reconnect herd used to turn N pot-ref tools into N simultaneous DB loads
    // per session; every caller for the same kind must join one load instead.
    const schemas = Array.from({ length: 40 }, () => z.object({ pot: entityRef('pot') }));
    const pending = Promise.all(schemas.map((schema) => applyEntityRefEnums(schema, json(schema))));
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);

    release();
    const results = await pending;
    for (const out of results) {
      expect((out.properties as Record<string, Record<string, unknown>>).pot.enum).toEqual(['a']);
    }
  });

  it('reuses a successful fragment within the TTL and refreshes after it expires', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let values = ['a'];
    const load = vi.fn(async () => [...values]);
    setEntityEnum('pot', load);
    const schema = z.object({ pot: entityRef('pot') });

    const first = await applyEntityRefEnums(schema, json(schema));
    values = ['b'];
    const cached = await applyEntityRefEnums(schema, json(schema));
    expect(load).toHaveBeenCalledTimes(1);
    expect((first.properties as Record<string, Record<string, unknown>>).pot.enum).toEqual(['a']);
    expect((cached.properties as Record<string, Record<string, unknown>>).pot.enum).toEqual(['a']);

    now += ENTITY_ENUM_CACHE_TTL_MS + 1;
    const refreshed = await applyEntityRefEnums(schema, json(schema));
    expect(load).toHaveBeenCalledTimes(2);
    expect((refreshed.properties as Record<string, Record<string, unknown>>).pot.enum).toEqual(['b']);
  });

  it('does not cache a failed load and invalidates when a kind is re-registered', async () => {
    const firstLoad = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue(['a']);
    setEntityEnum('pot', firstLoad);
    const schema = z.object({ pot: entityRef('pot') });

    const failed = await applyEntityRefEnums(schema, json(schema));
    const recovered = await applyEntityRefEnums(schema, json(schema));
    expect((failed.properties as Record<string, Record<string, unknown>>).pot.enum).toBeUndefined();
    expect((recovered.properties as Record<string, Record<string, unknown>>).pot.enum).toEqual(['a']);
    expect(firstLoad).toHaveBeenCalledTimes(2);

    const replacement = vi.fn(async () => ['b']);
    setEntityEnum('pot', replacement);
    const replaced = await applyEntityRefEnums(schema, json(schema));
    expect(replacement).toHaveBeenCalledTimes(1);
    expect((replaced.properties as Record<string, Record<string, unknown>>).pot.enum).toEqual(['b']);
  });

  it('leaves the schema untouched when the marked arg is not in the advertised surface', async () => {
    setEntityEnum('pot', async () => ['a']);
    const schema = z.object({ pot: entityRef('pot') });
    // A tool whose advertised surface was rewritten (registry positional `row`).
    const rewritten = { type: 'object', properties: { row: { type: 'string' } } };
    const out = await applyEntityRefEnums(schema, rewritten);
    expect(out).toEqual(rewritten);
  });

  it('registering a resolver alone publishes nothing — the two are separate acts', async () => {
    setEntityResolver('pot', async () => ({ unknown: [] }));
    const schema = z.object({ pot: entityRef('pot') });
    const out = await applyEntityRefEnums(schema, json(schema));
    expect((out.properties as Record<string, Record<string, unknown>>).pot.enum).toBeUndefined();
  });
});

describe('entityEnumRevision', () => {
  it('moves only when the PUBLISHED values change', async () => {
    let values = ['a', 'b'];
    setEntityEnum('pot', async () => [...values]);
    const first = await entityEnumRevision();
    values = ['b', 'a']; // reordering is not a change
    expect(await entityEnumRevision()).toBe(first);
    values = ['a', 'b', 'c'];
    expect(await entityEnumRevision()).not.toBe(first);
  });

  it('stays put when an over-cap set changes — no cache-busting re-fetch for bytes nobody sees', async () => {
    let values = ['a', 'b', 'c'];
    setEntityEnum('pot', async () => [...values], { maxValues: 2 });
    const first = await entityEnumRevision();
    expect(first).toBe('empty');
    values = ['x', 'y', 'z'];
    expect(await entityEnumRevision()).toBe(first);
  });
});

/**
 * Discriminated-union args — the standard shape for a multi-op tool in this
 * host, and the shape the walker used to skip entirely.
 */
describe('discriminated-union args', () => {
  const opUnion = z.discriminatedUnion('op', [
    z.object({ op: z.literal('set'), role: entityRef('role') }),
    z.object({ op: z.literal('list') }),
    z.object({ op: z.literal('clear'), role: entityRef('role').optional() }),
  ]);

  it('checks the value once, not once per arm that declares the arg', async () => {
    const fn = vi.fn(async (values: readonly string[]) => ({ unknown: values }));
    setEntityResolver('role', fn);
    const v = await resolveEntityRefs(collectEntityRefs(opUnion), { op: 'set', role: 'made-up' });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ path: 'role', value: 'made-up' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('publishes the enum into every arm that declares the arg', async () => {
    setEntityEnum('role', async () => ['worker']);
    const out = await applyEntityRefEnums(opUnion, toJsonSchema(opUnion as never) as Record<string, unknown>);
    const arms = (out.anyOf ?? out.oneOf) as Array<Record<string, Record<string, Record<string, unknown>>>>;
    expect(arms[0].properties.role.enum).toEqual(['worker']);
    expect(arms[2].properties.role.enum).toEqual(['worker']);
    expect(arms[1].properties.role).toBeUndefined();
  });
});
