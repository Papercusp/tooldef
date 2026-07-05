import { describe, it, expect } from 'vitest';
import { encode } from '@papercusp/result-encoding';
import { unwrapToolResult } from './dispatch-binding';
import type { ToolResult } from '../wire';

const tr = (r: Partial<ToolResult>) => r as ToolResult;

describe('unwrapToolResult (B-CX-1A dispatch binding)', () => {
  it('prefers structuredContent when present', () => {
    expect(unwrapToolResult(tr({ structuredContent: { items: [1, 2] }, content: [] }))).toEqual({
      items: [1, 2],
    });
  });

  it('parses the JSON text payload when there is no structuredContent', () => {
    expect(
      unwrapToolResult(tr({ content: [{ type: 'text', text: '{"ok":true,"n":3}' }] as never })),
    ).toEqual({ ok: true, n: 3 });
  });

  it('falls back to raw text when the payload is not JSON', () => {
    expect(unwrapToolResult(tr({ content: [{ type: 'text', text: 'hello' }] as never }))).toBe('hello');
  });

  it('returns undefined for a missing result', () => {
    expect(unwrapToolResult(undefined)).toBeUndefined();
  });

  // EI-7689: a compact (non-JSON) tool response self-identifies with a leading
  // `format: <fmt>\n` marker (serialize-result.ts) instead of carrying
  // structuredContent. Before the fix, JSON.parse always threw on this (TOON/CSV/TSV
  // aren't JSON) and the raw marker+encoded STRING was handed to the script as
  // `result` — a script's `if (result.ok)` truthiness check then silently lied,
  // because a non-empty string is truthy regardless of the ok value encoded inside.
  it('decodes a format:toon-marked payload back into the real structured object (not a raw string)', () => {
    const value = { ok: false, error: { code: 'similar_exists', message: 'a similar plan already exists' } };
    const text = `format: toon\n${encode(value, 'toon')}`;
    const result = unwrapToolResult(tr({ content: [{ type: 'text', text }] as never }));
    expect(result).toEqual(value);
    // The exact regression this guards: an in-script truthiness/property check must
    // see the REAL ok:false, not a truthy opaque string.
    expect((result as { ok: boolean }).ok).toBe(false);
  });

  it('decodes a format:toon-marked ARRAY payload (the bulk-envelope shape most list/many-item tools return)', () => {
    const value = { ok: true, results: [{ ok: true, id: 'WI-1' }, { ok: false, id: 'WI-2', error: 'nope' }], counts: { ok: 1, failed: 1 } };
    const text = `format: toon\n${encode(value, 'toon')}`;
    const result = unwrapToolResult(tr({ content: [{ type: 'text', text }] as never }));
    expect(result).toEqual(value);
  });

  it('decodes a format:csv-marked payload via the matching delimited decoder', () => {
    const value = [{ a: '1', b: 'x' }, { a: '2', b: 'y' }];
    const text = `format: csv\n${encode(value, 'csv')}`;
    const result = unwrapToolResult(tr({ content: [{ type: 'text', text }] as never }));
    expect(result).toEqual(value);
  });

  it('falls back to raw text for a format:md-marked payload (display-only, not decodable)', () => {
    const text = 'format: md\n| a |\n|---|\n| 1 |\n';
    expect(unwrapToolResult(tr({ content: [{ type: 'text', text }] as never }))).toBe(text);
  });

  it('falls back to raw text when a format marker names something bogus (never throws)', () => {
    const text = 'format: not-a-real-format\nwhatever';
    expect(unwrapToolResult(tr({ content: [{ type: 'text', text }] as never }))).toBe(text);
  });
});
