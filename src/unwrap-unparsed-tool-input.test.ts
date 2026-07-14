/**
 * EI-11621 — a client `__unparsedToolInput` envelope must be transparently
 * unwrapped before the EI-10883 closed-shape gate, so direct MCP calls from
 * Claude Code (which wraps model-emitted args it could not parse into structured
 * JSON) succeed instead of being rejected with "unrecognized key
 * __unparsedToolInput". Before the fix, work_items:complete /
 * session:request-compaction / etc. were unusable from that client without the
 * code_run workaround.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { strictArgs, unwrapUnparsedToolInput } from './define-tool';

function parse(schema: unknown, value: unknown): { ok: boolean; message: string } {
  const r = (schema as { safeParse: (v: unknown) => { success: boolean; error?: { message: string } } }).safeParse(value);
  return { ok: r.success, message: r.error?.message ?? '' };
}

describe('unwrapUnparsedToolInput (EI-11621)', () => {
  it('recovers args from a stringified JSON envelope', () => {
    const out = unwrapUnparsedToolInput({
      __unparsedToolInput: JSON.stringify({ id: 'WI-1', state: 'done' }),
    });
    expect(out).toEqual({ id: 'WI-1', state: 'done' });
  });

  it('recovers args from an already-parsed object envelope', () => {
    const out = unwrapUnparsedToolInput({
      __unparsedToolInput: { id: 'WI-1', state: 'done' },
    });
    expect(out).toEqual({ id: 'WI-1', state: 'done' });
  });

  it('lets sibling keys the client DID parse win over the envelope', () => {
    const out = unwrapUnparsedToolInput({
      __unparsedToolInput: JSON.stringify({ id: 'WI-1', state: 'done' }),
      state: 'wip', // an explicitly-parsed sibling key overrides the envelope
    });
    expect(out).toEqual({ id: 'WI-1', state: 'wip' });
  });

  it('is a no-op on a normal, un-enveloped object', () => {
    const normal = { id: 'WI-1', state: 'done' };
    expect(unwrapUnparsedToolInput(normal)).toBe(normal);
  });

  it('strips the reserved key when the value is not JSON (real error surfaces on the actual args)', () => {
    const out = unwrapUnparsedToolInput({ __unparsedToolInput: 'not json {{' });
    expect(out).toEqual({});
    expect('__unparsedToolInput' in (out as Record<string, unknown>)).toBe(false);
  });

  it('strips the reserved key when the recovered payload is a scalar/array', () => {
    expect(unwrapUnparsedToolInput({ __unparsedToolInput: '42' })).toEqual({});
    expect(unwrapUnparsedToolInput({ __unparsedToolInput: '["a","b"]' })).toEqual({});
  });

  it('never throws on non-object inputs', () => {
    expect(unwrapUnparsedToolInput(undefined)).toBeUndefined();
    expect(unwrapUnparsedToolInput(null)).toBeNull();
    expect(unwrapUnparsedToolInput('x')).toBe('x');
    expect(unwrapUnparsedToolInput([1, 2])).toEqual([1, 2]);
  });
});

describe('unwrap + strict gate end-to-end (EI-11621 × EI-10883)', () => {
  // A tool schema with a nested-object arg — exactly the anyOf/nested shape the
  // Claude client mangles into __unparsedToolInput.
  const schema = strictArgs(
    z.object({
      id: z.string(),
      completion: z.object({ summary: z.string(), status: z.string() }),
    }),
  );

  it('BASELINE: the raw envelope is REJECTED by the closed-shape gate (the bug)', () => {
    const r = parse(schema, {
      __unparsedToolInput: JSON.stringify({ id: 'WI-1', completion: { summary: 's', status: 'done' } }),
    });
    expect(r.ok).toBe(false);
    expect(r.message.toLowerCase()).toContain('unrecognized');
  });

  it('after unwrap the SAME call validates cleanly', () => {
    const recovered = unwrapUnparsedToolInput({
      __unparsedToolInput: JSON.stringify({ id: 'WI-1', completion: { summary: 's', status: 'done' } }),
    });
    const r = parse(schema, recovered);
    expect(r.ok).toBe(true);
  });

  it('a genuinely undeclared arg inside the envelope still fails loudly (no false accept)', () => {
    const recovered = unwrapUnparsedToolInput({
      __unparsedToolInput: JSON.stringify({ id: 'WI-1', completion: { summary: 's', status: 'done' }, bogus: 1 }),
    });
    const r = parse(schema, recovered);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('bogus');
  });
});
