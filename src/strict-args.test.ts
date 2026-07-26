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
import { strictArgs, suggestArgName } from './define-tool';

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

describe('strictArgs deep nesting (EI-18723223344390510)', () => {
  // The reported bug: loop:checkpoint's `checks: z.array(z.object({ claim,
  // recheck, verified }))` accepted `{ claim, status:'verified', evidence:'Y' }`
  // silently — the row object was never strictified, only the top-level args
  // object was. `.strict()` on the outer schema does not cascade into nested
  // object schemas; the whole tree must be walked and strictified.

  it('rejects an unknown key on an object nested inside an array field', () => {
    const schema = strictArgs(
      z.object({
        checks: z
          .array(
            z.object({
              claim: z.string(),
              recheck: z.string().optional(),
              verified: z.string().optional(),
            }),
          )
          .max(12)
          .optional(),
      }),
    );
    expect(parse(schema, { checks: [{ claim: 'x', verified: 'evidence' }] }).ok).toBe(true);
    const bad = parse(schema, { checks: [{ claim: 'x', status: 'verified', evidence: 'Y' }] });
    expect(bad.ok).toBe(false);
    expect(bad.message.toLowerCase()).toContain('unrecognized');
  });

  it('preserves array constraints (e.g. .max()) while strictifying the element', () => {
    const schema = strictArgs(z.object({ checks: z.array(z.object({ claim: z.string() })).max(2) }));
    expect(parse(schema, { checks: [{ claim: 'a' }, { claim: 'b' }] }).ok).toBe(true);
    expect(parse(schema, { checks: [{ claim: 'a' }, { claim: 'b' }, { claim: 'c' }] }).ok).toBe(false);
  });

  it('rejects an unknown key on the exact loop:checkpoint `checks` shape (z.preprocess wrapping the array)', () => {
    // Mirrors packages/operator-core/lib/agent-tools/loop/checkpoint.ts's real `checks` field.
    const checksField = z
      .preprocess((v) => {
        if (typeof v !== 'string') return v;
        try {
          const parsed = JSON.parse(v);
          return Array.isArray(parsed) ? parsed : v;
        } catch {
          return v;
        }
      }, z.array(z.object({ claim: z.string().min(1), recheck: z.string().optional(), verified: z.string().optional() })).max(12))
      .optional();
    const schema = strictArgs(z.object({ checks: checksField }));
    expect(parse(schema, { checks: [{ claim: 'x', verified: 'ev' }] }).ok).toBe(true);
    expect(parse(schema, { checks: [{ claim: 'x', status: 'verified', evidence: 'ev' }] }).ok).toBe(false);
  });

  it('rejects an unknown key on an object nested inside optional/nullable/default wrappers', () => {
    const row = z.object({ claim: z.string() });
    const schema = strictArgs(
      z.object({
        opt: row.optional(),
        nul: row.nullable(),
        def: row.default({ claim: 'x' }),
      }),
    );
    expect(parse(schema, { opt: { claim: 'a' }, nul: { claim: 'b' } }).ok).toBe(true);
    expect(parse(schema, { opt: { claim: 'a', extra: 1 } }).ok).toBe(false);
    expect(parse(schema, { nul: { claim: 'b', extra: 1 } }).ok).toBe(false);
  });

  it('rejects an unknown key on an object nested inside a union variant, without breaking discriminatedUnion dispatch', () => {
    const union = z.discriminatedUnion('op', [
      z.object({ op: z.literal('a'), a: z.string() }),
      z.object({ op: z.literal('b'), b: z.string() }),
    ]);
    const schema = strictArgs(z.object({ variant: union }));
    expect(parse(schema, { variant: { op: 'a', a: 'x' } }).ok).toBe(true);
    expect(parse(schema, { variant: { op: 'b', b: 'y' } }).ok).toBe(true);
    expect(parse(schema, { variant: { op: 'a', a: 'x', extra: 1 } }).ok).toBe(false);
  });

  it('rejects an unknown key on an object nested inside a record value type', () => {
    const schema = strictArgs(z.object({ byId: z.record(z.string(), z.object({ claim: z.string() })) }));
    expect(parse(schema, { byId: { k1: { claim: 'x' } } }).ok).toBe(true);
    expect(parse(schema, { byId: { k1: { claim: 'x', extra: 1 } } }).ok).toBe(false);
  });

  it('never crashes on a self-referential z.lazy field (left untouched, fail-open)', () => {
    const Node: z.ZodTypeAny = z.lazy(() => z.object({ id: z.string(), children: z.array(Node).optional() }));
    expect(() => strictArgs(z.object({ tree: Node }))).not.toThrow();
  });

  it('still passes a bare top-level union through unchanged (no crash, same referential identity)', () => {
    const union = z.discriminatedUnion('op', [
      z.object({ op: z.literal('a'), a: z.string() }),
      z.object({ op: z.literal('b'), b: z.string() }),
    ]);
    const out = strictArgs(union);
    expect(out).toBe(union);
    expect(parse(out, { op: 'a', a: 'x' }).ok).toBe(true);
  });
});

describe('suggestArgName', () => {
  it('corrects a typo to the nearest declared field', () => {
    expect(suggestArgName('summry', ['id', 'summary', 'harness'])).toBe('summary');
  });

  it('maps common CRUD aliases to the valid name exposed by this tool', () => {
    expect(suggestArgName('assignee', ['id', 'assign_to', 'state'])).toBe('assign_to');
    expect(suggestArgName('summary', ['id', 'body', 'confirmShrink'])).toBe('body');
    expect(suggestArgName('found_during', ['id', 'foundDuring'])).toBe('foundDuring');
  });

  it('teaches the canonical alpha-stage vocabulary without accepting aliases', () => {
    expect(suggestArgName('rubricId', ['rubricRef', 'rubricRefs'])).toBe('rubricRef');
    expect(suggestArgName('rubricIds', ['rubricRef', 'rubricRefs'])).toBe('rubricRefs');
    expect(suggestArgName('itemId', ['slug', 'item', 'itemIds'])).toBe('item');
    expect(suggestArgName('body', ['slug', 'content', 'ownerEmail'])).toBe('content');
    expect(suggestArgName('description', ['slug', 'content'])).toBe('content');
    expect(suggestArgName('owner', ['slug', 'ownerEmail'])).toBe('ownerEmail');
    expect(suggestArgName('code', ['script', 'timeout_ms'])).toBe('script');
  });

  it('maps the EI-13475 semantic near-synonyms distance alone cannot reach', () => {
    // The 2026-07-17 live incidents, verbatim: plans:new { summary } and
    // improvements:capture { harness } both got a bare key list because the
    // alias map lacked these entries (edit distance 7 is over threshold).
    expect(suggestArgName('summary', ['harness', 'slug', 'title', 'status', 'rationale', 'content', 'force'])).toBe('content');
    expect(suggestArgName('harness', ['title', 'kind', 'body', 'severity', 'scope', 'foundDuring'])).toBe('scope');
    expect(suggestArgName('scope', ['slug', 'harness', 'title'])).toBe('harness');
    // Appending `content` to summary's aliases must NOT shift tools where an
    // earlier alias already matches (body outranks content by list order).
    expect(suggestArgName('summary', ['id', 'body', 'content'])).toBe('body');
  });

  it('does not invent a correction for an unrelated field', () => {
    expect(suggestArgName('completelyDifferent', ['id', 'state', 'harness'])).toBeNull();
  });
});
