/**
 * P-019 (fleet-leadership-continuity-and-actuation-2026-08-01) — an
 * explicitly-`undefined` value means NOT PROVIDED, at every depth.
 *
 * Filed from a live `code:run` failure: a script passing `{ harness: undefined }`
 * (idiomatic JS for "no value") was rejected by the EI-10883 closed-shape gate as an
 * unrecognized key, aborting the whole script before its already-ordered writes ran.
 *
 * The pairing that matters is asserted here directly: `stripUndefinedArgKeys` must
 * cover exactly the depth `strictArgs` closes. `strictArgs` was itself widened once
 * (EI-18723223344390510) from root-only to the whole tree; a root-only strip would
 * re-open the same asymmetry from the other side.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { stripUndefinedArgKeys, strictArgs } from './define-tool';

describe('stripUndefinedArgKeys (P-019)', () => {
  it('drops a top-level undefined-valued key', () => {
    expect(stripUndefinedArgKeys({ id: 'WI-1', harness: undefined })).toEqual({ id: 'WI-1' });
  });

  it('drops an undefined-valued key nested in an array row — the shape strictness also closes', () => {
    const out = stripUndefinedArgKeys({
      items: [{ id: 'WI-1', checkpoint: 'x', harness: undefined }],
    });
    expect(out).toEqual({ items: [{ id: 'WI-1', checkpoint: 'x' }] });
  });

  it('drops undefined-valued keys in a deeply nested object', () => {
    const out = stripUndefinedArgKeys({ a: { b: { c: { keep: 1, drop: undefined } } } });
    expect(out).toEqual({ a: { b: { c: { keep: 1 } } } });
  });

  it('preserves null, false, 0 and empty string — only `undefined` means "not provided"', () => {
    const input = { a: null, b: false, c: 0, d: '', e: undefined };
    expect(stripUndefinedArgKeys(input)).toEqual({ a: null, b: false, c: 0, d: '' });
  });

  it('does NOT drop an undefined ARRAY ELEMENT (that would silently reindex the array)', () => {
    const out = stripUndefinedArgKeys({ xs: [1, undefined, 3] }) as { xs: unknown[] };
    expect(out.xs).toHaveLength(3);
    expect(out.xs[1]).toBeUndefined();
    expect(out.xs[2]).toBe(3);
  });

  it('returns the SAME reference when there is nothing to strip (no allocation on the common path)', () => {
    const input = { id: 'WI-1', items: [{ id: 'a' }] };
    expect(stripUndefinedArgKeys(input)).toBe(input);
  });

  it('never mutates the caller\'s object', () => {
    const input = { id: 'WI-1', harness: undefined };
    stripUndefinedArgKeys(input);
    expect('harness' in input).toBe(true);
  });

  it('leaves non-plain objects untouched (Date/Map are not ours to rebuild)', () => {
    const d = new Date(0);
    const m = new Map([['k', 'v']]);
    const out = stripUndefinedArgKeys({ d, m, gone: undefined }) as Record<string, unknown>;
    expect(out.d).toBe(d);
    expect(out.m).toBe(m);
    expect('gone' in out).toBe(false);
  });

  it('survives a self-referential args object without infinite recursion', () => {
    const input: Record<string, unknown> = { id: 'WI-1', drop: undefined };
    input.self = input;
    expect(() => stripUndefinedArgKeys(input)).not.toThrow();
  });

  it('passes through primitives, null and undefined unchanged', () => {
    expect(stripUndefinedArgKeys(undefined)).toBeUndefined();
    expect(stripUndefinedArgKeys(null)).toBeNull();
    expect(stripUndefinedArgKeys('x')).toBe('x');
    expect(stripUndefinedArgKeys(7)).toBe(7);
  });
});

describe('P-019 + EI-10883 together: the strip covers the depth strictness closes', () => {
  // The regression this whole item exists to prevent, asserted end-to-end against a
  // REAL strictified schema rather than the helper alone.
  const schema = strictArgs(
    z.object({
      id: z.string(),
      items: z.array(z.object({ id: z.string(), checkpoint: z.string().optional() })).optional(),
    }),
  );

  it('rejects an undefined-valued key WITHOUT the strip (proving the gate is the thing being fixed)', () => {
    expect(schema.safeParse({ id: 'WI-1', harness: undefined }).success).toBe(false);
    expect(
      schema.safeParse({ id: 'WI-1', items: [{ id: 'a', harness: undefined }] }).success,
    ).toBe(false);
  });

  it('accepts the same call once stripped — top level AND nested row', () => {
    expect(schema.safeParse(stripUndefinedArgKeys({ id: 'WI-1', harness: undefined })).success).toBe(
      true,
    );
    expect(
      schema.safeParse(
        stripUndefinedArgKeys({ id: 'WI-1', items: [{ id: 'a', checkpoint: 'x', harness: undefined }] }),
      ).success,
    ).toBe(true);
  });

  it('still rejects a genuinely wrong key that carries a real value (negative control)', () => {
    // The strip must not become a blanket unknown-key amnesty: a typo'd key with an
    // actual value is a real mistake and must still fail loudly.
    expect(
      schema.safeParse(stripUndefinedArgKeys({ id: 'WI-1', harnes: 'papercusp' })).success,
    ).toBe(false);
  });
});
