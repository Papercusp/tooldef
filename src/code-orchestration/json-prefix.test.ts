import { describe, it, expect } from 'vitest';
import { parseJsonWithTrailer } from './json-prefix';

/** The real gitnexus.list_repos footer, measured live 2026-07-27 (WI-6458). */
const GITNEXUS_FOOTER =
  '\n\n---\n**Next:** READ gitnexus://repo/{name}/context for any repo above to get its overview and check staleness.';

describe('parseJsonWithTrailer (WI-6458)', () => {
  it('recovers the JSON array a gitnexus footer is appended to', () => {
    const value = [{ name: 'sheets-clone', nodes: 1 }, { name: 'papercusp', nodes: 235033 }];
    const parsed = parseJsonWithTrailer(JSON.stringify(value, null, 2) + GITNEXUS_FOOTER);
    expect(parsed?.value).toEqual(value);
    expect(parsed?.trailer.startsWith('---')).toBe(true);
  });

  it('recovers an object payload with trailing prose', () => {
    const parsed = parseJsonWithTrailer('{"status":"found","uid":"Function:a.ts:x"}\n\nTo see execution flows, READ gitnexus://repo/papercusp/processes.');
    expect(parsed?.value).toEqual({ status: 'found', uid: 'Function:a.ts:x' });
  });

  // The reason a balanced scan is needed rather than the obvious workaround: gitnexus's own
  // footer contains a `{name}` placeholder, so `s.lastIndexOf(']'|'}')` lands AFTER the JSON
  // and the sliced parse throws too (measured live before this fix).
  it('is not fooled by a brace inside the trailing prose (the lastIndexOf workaround is not)', () => {
    const text = JSON.stringify([{ name: 'papercusp' }]) + GITNEXUS_FOOTER;
    const naive = text.slice(0, Math.max(text.lastIndexOf(']'), text.lastIndexOf('}')) + 1);
    expect(() => JSON.parse(naive)).toThrow();
    expect(parseJsonWithTrailer(text)?.value).toEqual([{ name: 'papercusp' }]);
  });

  it('is string- and escape-aware, so brackets inside string values do not end the value', () => {
    const value = { note: 'a } and a ] and an escaped quote \\" inside', n: 1 };
    const parsed = parseJsonWithTrailer(JSON.stringify(value) + '\n\ntrailing note.');
    expect(parsed?.value).toEqual(value);
  });

  it('returns null for text that is entirely valid JSON (plain JSON.parse already covers it)', () => {
    expect(parseJsonWithTrailer('{"ok":true}')).toBeNull();
    expect(parseJsonWithTrailer('  [1,2,3]\n ')).toBeNull();
  });

  it('returns null for a leading bare scalar — `123 apples` must not read as 123', () => {
    expect(parseJsonWithTrailer('123 apples')).toBeNull();
    expect(parseJsonWithTrailer('"quoted" then prose')).toBeNull();
    expect(parseJsonWithTrailer('true story')).toBeNull();
  });

  it('returns null for ordinary prose, including prose that merely mentions brackets', () => {
    expect(parseJsonWithTrailer('hello')).toBeNull();
    expect(parseJsonWithTrailer('[INFO] something happened')).toBeNull();
    expect(parseJsonWithTrailer('')).toBeNull();
    expect(parseJsonWithTrailer('   ')).toBeNull();
  });

  it('returns null for an NDJSON / concatenated stream — dropping the rest would lose DATA, not an affordance', () => {
    expect(parseJsonWithTrailer('{"a":1}\n{"b":2}')).toBeNull();
    expect(parseJsonWithTrailer('[1,2]\n[3,4]')).toBeNull();
  });

  it('returns null for an unterminated value', () => {
    expect(parseJsonWithTrailer('{"a":1 trailing')).toBeNull();
  });
});
