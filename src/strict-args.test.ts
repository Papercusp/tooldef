/**
 * EI-10883 — an undeclared arg must be a HARD ERROR, never a silent drop.
 *
 * Zod's default object behaviour STRIPS unknown keys, so before this a caller who
 * passed an arg a tool did not declare got back ok:true and the tool's DEFAULT
 * behaviour. That is the worst failure mode available: byte-identical to success
 * while doing something other than what was asked, invisible to the caller AND to
 * the tool-efficiency telemetry (which only counts hard failures).
 *
 * The concrete incident these tests encode: `sessions:read { order:'asc' }` was
 * accepted and ignored — the tool had no `order` arg — so the caller concluded the
 * tool had no head read, burned further calls, and drew a wrong conclusion about
 * the data. Under a closed shape that same call fails loudly and self-corrects.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { strictArgs } from './define-tool';

/** Zod 4 exposes safeParse on the schema; keep the test honest about the shape. */
function parse(schema: unknown, value: unknown): { ok: boolean; message: string } {
  const r = (schema as { safeParse: (v: unknown) => { success: boolean; error?: { message: string } } }).safeParse(value);
  return { ok: r.success, message: r.error?.message ?? '' };
}

describe('strictArgs (EI-10883)', () => {
  const base = z.object({
    session: z.string(),
    limit: z.number().int().optional(),
  });

  it('BASELINE: a plain zod object silently DROPS an undeclared arg (the bug)', () => {
    const r = base.safeParse({ session: 'x', order: 'asc' });
    expect(r.success).toBe(true);
    // The smoking gun: `order` is gone, and the caller was never told.
    expect(r.success && 'order' in (r.data as Record<string, unknown>)).toBe(false);
  });

  it('rejects an undeclared arg', () => {
    const strict = strictArgs(base);
    const r = parse(strict, { session: 'x', order: 'asc' });
    expect(r.ok).toBe(false);
    expect(r.message.toLowerCase()).toContain('unrecognized');
  });

  it('names the offending key so the failure is self-correcting', () => {
    const strict = strictArgs(base);
    const r = parse(strict, { session: 'x', order: 'asc' });
    expect(r.message).toContain('order');
  });

  it('still accepts a fully-declared call (no false positives)', () => {
    const strict = strictArgs(base);
    expect(parse(strict, { session: 'x' }).ok).toBe(true);
    expect(parse(strict, { session: 'x', limit: 5 }).ok).toBe(true);
  });

  it('still enforces the declared constraints', () => {
    const strict = strictArgs(base);
    expect(parse(strict, { session: 'x', limit: 1.5 }).ok).toBe(false);
    expect(parse(strict, {}).ok).toBe(false);
  });

  it('passes through a schema with no .strict() (unions) instead of throwing', () => {
    // A discriminatedUnion has no .strict(); the catalog contains several, and the
    // registration path must never blow up on them — it just leaves them as-is.
    const union = z.discriminatedUnion('op', [
      z.object({ op: z.literal('a'), a: z.string() }),
      z.object({ op: z.literal('b'), b: z.string() }),
    ]);
    const out = strictArgs(union);
    expect(out).toBe(union);
    expect(parse(out, { op: 'a', a: 'x' }).ok).toBe(true);
  });

  it('is a no-op on a non-schema value (never throws at registration)', () => {
    const weird = { not: 'a schema' } as unknown;
    expect(() => strictArgs(weird)).not.toThrow();
    expect(strictArgs(weird)).toBe(weird);
  });
});
