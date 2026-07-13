/**
 * Falsifiable proof for P-020 / D-002: the engine validates via the Standard
 * Schema interface, not Zod. These tests use a HAND-ROLLED validator (no Zod,
 * no validator library at all) — just an object exposing `~standard.validate`.
 * If the engine reached for any Zod-specific method, none of this would work.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { StandardSchemaV1 } from './standard-schema';
import { standardValidate, validateSync, formatIssues, issuesAreValueLevel } from './standard-schema';

/** A non-Zod Standard Schema: accepts `{ n: number }`, synchronous. */
const numberBox: StandardSchemaV1<unknown, { n: number }> = {
  '~standard': {
    version: 1,
    vendor: 'handrolled-test',
    validate(input) {
      if (typeof input === 'object' && input !== null && typeof (input as { n: unknown }).n === 'number') {
        return { value: { n: (input as { n: number }).n } };
      }
      return { issues: [{ message: 'expected { n: number }', path: ['n'] }] };
    },
  },
};

/** A non-Zod Standard Schema whose validate() is ASYNC. */
const asyncFlag: StandardSchemaV1<unknown, boolean> = {
  '~standard': {
    version: 1,
    vendor: 'handrolled-test-async',
    async validate(input) {
      await Promise.resolve();
      if (typeof input === 'boolean') return { value: input };
      return { issues: [{ message: 'expected boolean' }] };
    },
  },
};

describe('standardValidate (validator-agnostic)', () => {
  it('accepts valid input from a non-Zod validator', async () => {
    const r = await standardValidate(numberBox, { n: 42 });
    expect(r).toEqual({ ok: true, value: { n: 42 } });
  });

  it('rejects invalid input with issues', async () => {
    const r = await standardValidate(numberBox, { n: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(formatIssues(r.issues)).toBe('n: expected { n: number }');
  });

  it('awaits async (non-Zod) validators', async () => {
    expect(await standardValidate(asyncFlag, true)).toEqual({ ok: true, value: true });
    const bad = await standardValidate(asyncFlag, 'x');
    expect(bad.ok).toBe(false);
  });
});

describe('validateSync', () => {
  it('validates synchronously for sync validators', () => {
    expect(validateSync(numberBox, { n: 1 })).toEqual({ ok: true, value: { n: 1 } });
    expect(validateSync(numberBox, {}).ok).toBe(false);
  });

  it('throws loudly when a validator returns a Promise (async on a sync path)', () => {
    expect(() => validateSync(asyncFlag, true)).toThrow(/Async validators are not supported/);
  });
});
