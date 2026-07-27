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

  // EI-18664105352441219: plans:new's `similar_exists` refusal (and its `busy`/`slug_exists`
  // siblings) signal failure via `isError: true` + a bare `{ error: '<code>', ... }` JSON body
  // with NO `ok: false` field — the odd shape out among refusals that throw invalid_args. A
  // script's idiomatic `res?.ok !== false` guard (and the orchestrator's own isOkFalseResult
  // tally) both read that shape as a SUCCESS. `isError: true` must stamp `ok: false` onto the
  // unwrapped value so both checks see the real failure.
  it('isError:true stamps ok:false onto a JSON body that has no ok field (plans:new similar_exists shape)', () => {
    const text = JSON.stringify({ error: 'similar_exists', slug: 's', similar: [{ slug: 'other' }], hint: 'h' });
    const result = unwrapToolResult(tr({ content: [{ type: 'text', text }] as never, isError: true }));
    expect(result).toMatchObject({ ok: false, error: 'similar_exists', slug: 's', hint: 'h' });
  });

  it('isError:true stamps ok:false onto structuredContent that has no ok field', () => {
    const result = unwrapToolResult(
      tr({ structuredContent: { error: 'busy', busy: [] }, content: [], isError: true }),
    );
    expect(result).toEqual({ error: 'busy', busy: [], ok: false });
  });

  it('isError:true does NOT override an already-explicit ok:false', () => {
    const text = JSON.stringify({ ok: false, error: { code: 'x' } });
    const result = unwrapToolResult(tr({ content: [{ type: 'text', text }] as never, isError: true }));
    expect(result).toEqual({ ok: false, error: { code: 'x' } });
  });

  it('isError:false (or absent) never touches a body missing ok — no false positives on ordinary results', () => {
    const text = JSON.stringify({ error: 'similar_exists', slug: 's' });
    const result = unwrapToolResult(tr({ content: [{ type: 'text', text }] as never }));
    expect(result).toEqual({ error: 'similar_exists', slug: 's' });
  });

  // WI-6458: a PROXIED upstream MCP server (gitnexus) appends a chat affordance after its
  // JSON — `\n\n---\n**Next:** READ gitnexus://repo/{name}/context …`. JSON.parse throws on
  // the trailer, so the script used to receive the whole raw STRING; its first natural line
  // of consumption then failed with "Unexpected non-whitespace character after JSON at
  // position 1040", which reads as a broken tool and sends the agent back to grep.
  it('recovers the JSON value when a proxied tool appends a markdown footer to it', () => {
    const value = [{ name: 'papercusp', nodes: 235033 }];
    const text =
      JSON.stringify(value) +
      '\n\n---\n**Next:** READ gitnexus://repo/{name}/context for any repo above to get its overview and check staleness.';
    expect(unwrapToolResult(tr({ content: [{ type: 'text', text }] as never }))).toEqual(value);
  });

  it('still stamps ok:false on a footer-suffixed payload when isError is set', () => {
    const text = JSON.stringify({ error: 'not_indexed' }) + '\n\nRun `gitnexus analyze` first.';
    const result = unwrapToolResult(tr({ content: [{ type: 'text', text }] as never, isError: true }));
    expect(result).toMatchObject({ ok: false, error: 'not_indexed' });
  });

  it('leaves genuinely non-JSON text alone — the footer recovery never fires on prose', () => {
    const text = 'No repos indexed yet. Run `gitnexus analyze` to build the graph.';
    expect(unwrapToolResult(tr({ content: [{ type: 'text', text }] as never }))).toBe(text);
  });

  it('isError:true on a non-object payload (raw text fallback) is left untouched', () => {
    const result = unwrapToolResult(tr({ content: [{ type: 'text', text: 'plain failure text' }] as never, isError: true }));
    expect(result).toBe('plain failure text');
  });
});
