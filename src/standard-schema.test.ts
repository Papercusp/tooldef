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

/**
 * EI-10943 — the value-level classifier that decides whether an invalid_args error
 * should carry the full args-schema dump. A pure over-length (or bad-enum) value means
 * the caller knows the shape and does not need 1,800 chars of schema; a shape problem
 * (unknown key, missing required field) means they do.
 *
 * Zod issues are the real input. Validate a schema, feed the resulting issues in.
 */
describe('issuesAreValueLevel (EI-10943)', () => {
  const schema = z.object({ id: z.string(), label: z.string().max(10) });
  const issuesFor = (input: unknown) => {
    const r = schema.safeParse(input);
    return r.success ? [] : r.error.issues;
  };

  it('is TRUE for a pure over-length value on a named field', () => {
    const issues = issuesFor({ id: 'x', label: 'x'.repeat(20) });
    expect(issuesAreValueLevel(issues)).toBe(true);
  });

  it('is TRUE for a bad enum / invalid_value', () => {
    const s = z.object({ mode: z.enum(['a', 'b']) });
    const r = s.safeParse({ mode: 'c' });
    expect(r.success).toBe(false);
    if (!r.success) expect(issuesAreValueLevel(r.error.issues)).toBe(true);
  });

  it('is FALSE for a missing required field (a shape problem — caller needs the schema)', () => {
    const issues = issuesFor({ label: 'ok' }); // id missing
    expect(issuesAreValueLevel(issues)).toBe(false);
  });

  it('is FALSE for an unknown key on a strict object', () => {
    const s = z.object({ id: z.string() }).strict();
    const r = s.safeParse({ id: 'x', bogus: 1 });
    expect(r.success).toBe(false);
    if (!r.success) expect(issuesAreValueLevel(r.error.issues)).toBe(false);
  });

  it('is FALSE for a MIX (over-length value + unknown key) — any shape problem forces the schema', () => {
    const s = z.object({ id: z.string(), label: z.string().max(5) }).strict();
    const r = s.safeParse({ id: 'x', label: 'toolong', bogus: 1 });
    expect(r.success).toBe(false);
    if (!r.success) expect(issuesAreValueLevel(r.error.issues)).toBe(false);
  });

  it('is FALSE for a whole-object (unnamed-path) refinement failure', () => {
    const s = z
      .object({ a: z.number(), b: z.number() })
      .refine((v) => v.a < v.b, { message: 'a must be < b' });
    const r = s.safeParse({ a: 5, b: 1 });
    expect(r.success).toBe(false);
    if (!r.success) expect(issuesAreValueLevel(r.error.issues)).toBe(false);
  });

  it('is FALSE for empty issues (nothing to classify)', () => {
    expect(issuesAreValueLevel([])).toBe(false);
  });
});

describe('formatIssues — actionable too_big (EI-10943 / P-003)', () => {
  const schema = z.object({ label: z.string().max(10) });
  it('reports the actual length, the overage, and the target when given the input', () => {
    const r = schema.safeParse({ label: 'x'.repeat(15) });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(formatIssues(r.error.issues, { label: 'x'.repeat(15) })).toBe(
        'label: too long — 15 chars, 5 over the 10-char limit; trim to 10.',
      );
    }
  });

  it('degrades to the target-only form without the input', () => {
    const r = schema.safeParse({ label: 'x'.repeat(15) });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(formatIssues(r.error.issues)).toBe('label: too long — over the 10-char limit; trim to 10.');
    }
  });
});

describe('formatIssues — a SIZE verdict on a wrong-typed value (EI-20018883577474576)', () => {
  // Reproduces coord:send's `youMayNotKnow` / `couldNotDetermine`: an ARRAY field
  // carrying a `.max(20)` ITEM bound, handed a prose string. Zod's size check reads
  // `.length` off the string, so it reports `maximum: 20` with a string origin
  // ALONGSIDE the invalid_type — and the renderer then tells the caller to "trim to
  // 20 chars". That remedy is (a) wrong units, the 20 bounds ITEMS not characters,
  // and (b) the opposite of the real fix, which is to pass an array. It is also the
  // more specific-sounding of the two messages, so it out-competes the correct one.
  //
  // Six independent agents have filed this against coord:send, and every report ends
  // the same way: they shipped by DELETING the structured field. A length verdict on
  // a value of the wrong type is never meaningful — suppress it.
  const schema = z.object({
    couldNotDetermine: z
      .array(z.object({ what: z.string().min(1) }))
      .max(20)
      .optional(),
  });
  const bad = { couldNotDetermine: 'x'.repeat(312) };

  it('never renders a CHARACTER remedy when the same path failed its type check', () => {
    const r = schema.safeParse(bad);
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = formatIssues(r.error.issues, bad);
      expect(msg).toContain('expected array');
      expect(msg).not.toMatch(/char limit/);
      expect(msg).not.toMatch(/trim to/);
    }
  });

  // CALIBRATION — the suppression must be narrow. A genuine string over-length on a
  // string field keeps its actionable remedy; without this, "delete the char message"
  // would pass by breaking the feature the char message exists for.
  it('still renders the character remedy for a real string over-length', () => {
    const strSchema = z.object({ label: z.string().max(10) });
    const input = { label: 'x'.repeat(15) };
    const r = strSchema.safeParse(input);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(formatIssues(r.error.issues, input)).toBe(
        'label: too long — 15 chars, 5 over the 10-char limit; trim to 10.',
      );
    }
  });
});

describe('formatIssues — union branch descent (EI-19968462161677390)', () => {
  // Mirrors coord:send's `body: z.union([z.string(), z.array(section)])` shape: a
  // union where one branch is a bare scalar and the other is an array of objects.
  // A well-shaped array with a deep field violation should surface via the
  // ARRAY branch's own issue, not the union's generic top-level message.
  const section = z.object({ id: z.string(), note: z.string() });
  const schema = z.object({ body: z.union([z.string(), z.array(section)]) });

  it('surfaces the deepest branch field-level issue instead of the union generic message', () => {
    const r = schema.safeParse({ body: [{ id: 'x' }] }); // array branch is close; note missing
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = formatIssues(r.error.issues);
      // Must NOT collapse to the union's own shallow message.
      expect(msg).not.toBe('body: Invalid input');
      // Must name the deep, qualified path into the array branch.
      expect(msg).toContain('body.0.note');
    }
  });

  it('still renders a plain (non-union) issue unchanged', () => {
    const plain = z.object({ id: z.string() });
    const r = plain.safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(formatIssues(r.error.issues)).toContain('id:');
    }
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
