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
  clearEntityResolvers,
  collectEntityRefs,
  entityRef,
  entityRefMeta,
  formatEntityRefViolations,
  hasEntityResolver,
  resolveEntityRefs,
  setEntityResolver,
} from './entity-ref';

afterEach(() => clearEntityResolvers());

describe('entityRef marker', () => {
  it('marks a bare ref and leaves a plain string unmarked', () => {
    expect(entityRefMeta(entityRef('pot'))?.kind).toBe('pot');
    expect(entityRefMeta(z.string())).toBeUndefined();
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
