/**
 * Unit table for the core resolver (plan `fuzzy-tool-name-resolution-2026-07-02`, P-004):
 * golden resolve, adversarial stay-ambiguous, high-tier no-fuzzy. The (T, M) here are
 * ILLUSTRATIVE contract params — P-003 owns the calibrated constants; these tests pin the
 * resolver's behaviour, not the calibration.
 */
import { describe, expect, it } from 'vitest';
import { resolveToolName, type ResolveNameOptions } from './resolve-name';
import { GOLDEN_MANGLES, REAL_NON_MANGLES } from './resolve-name-corpus';
import { GOLDEN_CANDIDATES } from './resolve-name-sweep';
import { ADVERSARIAL_CASES, HARD_ADVERSARIAL_CASES, looksMutating } from './resolve-name-adversarial-corpus';

const OPTS: ResolveNameOptions = { T: 0.25, M: 2, neverFuzzy: looksMutating };

describe('resolveToolName — stage 1 canonical', () => {
  it.each([
    ['coord_send', 'coord:send'],
    ['COORD:SEND', 'coord:send'],
    ['mcp__papercusp_su__coord_send', 'coord:send'],
    ['work_items_get', 'work_items:get'],
    ['plans:set_now', 'plans:set-now'],
  ])('%s -> %s via canonical, distance 0', (input, tool) => {
    expect(resolveToolName(input, GOLDEN_CANDIDATES, OPTS)).toEqual({
      match: tool,
      alternatives: [tool],
      via: 'canonical',
      distance: 0,
    });
  });

  it('a canonical hit on a high-tier tool still resolves (only FUZZY is gated)', () => {
    const r = resolveToolName('coord_send', ['coord:send'], { ...OPTS, tierOf: () => 'high' });
    expect(r.match).toBe('coord:send');
    expect(r.via).toBe('canonical');
  });
});

describe('resolveToolName — stage 2 fuzzy', () => {
  it('resolves a one-edit typo in a long verb to the unique nearest tool', () => {
    const r = resolveToolName('coord:orientt', ['coord:orient', 'coord:send', 'plans:get'], OPTS);
    // one raw edit in a 6-letter verb (0.17 <= T); nothing else is within M raw edits.
    expect(r.match).toBe('coord:orient');
    expect(r.via).toBe('fuzzy');
    expect(r.blocked).toBeUndefined();
    expect(r.ambiguous).toBeUndefined();
  });

  it('a raw tie is ambiguous and lists both, never guesses', () => {
    const r = resolveToolName('accounts:npin', ['accounts:pin', 'accounts:unpin', 'coord:send'], {
      T: 0.5,
      M: 2,
    });
    expect(r.ambiguous).toBe(true);
    expect(r.match).toBeUndefined();
    expect([...r.alternatives].sort()).toEqual(['accounts:pin', 'accounts:unpin']);
  });

  it('nothing close -> empty result (caller falls through to unknown_tool)', () => {
    expect(resolveToolName('totally_unrelated_thing', GOLDEN_CANDIDATES, OPTS)).toEqual({ alternatives: [] });
    expect(resolveToolName('', GOLDEN_CANDIDATES, OPTS)).toEqual({ alternatives: [] });
    expect(resolveToolName('x', [], OPTS)).toEqual({ alternatives: [] });
  });
});

describe('resolveToolName — D-007 high-tier is never fuzzy-resolved', () => {
  it('tierOf high: a unique fuzzy hit is reported as blocked, not matched', () => {
    const r = resolveToolName('coord:orientt', ['coord:orient', 'plans:get'], {
      T: 0.25,
      M: 2,
      tierOf: (t) => (t === 'coord:orient' ? 'high' : 'low'),
    });
    expect(r.match).toBeUndefined();
    expect(r.blocked).toBe(true);
    expect(r.alternatives).toEqual(['coord:orient']);
  });

  it('neverFuzzy widens the gate beyond tierOf (a medium-tier setter is still protected)', () => {
    const cands = ['flags:set', 'flags:list'];
    const r = resolveToolName('flags:sett', cands, {
      T: 0.25,
      M: 2,
      tierOf: () => 'medium',
      neverFuzzy: looksMutating,
    });
    expect(r.match).toBeUndefined();
    expect(r.blocked).toBe(true);
  });
});

describe('resolveToolName — corpora (P-001 golden, P-002 adversarial)', () => {
  it('golden mangles: never resolves to a WRONG tool, and recovers a strong majority', () => {
    let recovered = 0;
    for (const c of GOLDEN_MANGLES) {
      const r = resolveToolName(c.rawInput, GOLDEN_CANDIDATES, OPTS);
      if (r.match !== undefined) {
        expect(r.match, `${c.id}: ${c.rawInput}`).toBe(c.intendedTool);
        recovered++;
      }
    }
    expect(recovered / GOLDEN_MANGLES.length).toBeGreaterThan(0.75);
  });

  it('hard adversarial cases (ties + far synonyms) never auto-resolve', () => {
    expect(HARD_ADVERSARIAL_CASES.length).toBeGreaterThan(0);
    for (const c of HARD_ADVERSARIAL_CASES) {
      const r = resolveToolName(c.rawInput, c.candidates, OPTS);
      expect(r.match, `${c.id}`).toBeUndefined();
    }
  });

  it('margin probes never resolve onto a mutating-looking tool', () => {
    for (const c of ADVERSARIAL_CASES) {
      const r = resolveToolName(c.rawInput, c.candidates, OPTS);
      if (r.match !== undefined) expect(looksMutating(r.match), `${c.id} -> ${r.match}`).toBe(false);
    }
  });

  it('real non-mangles (foreign/native names, wrong-verb synonyms) never resolve', () => {
    for (const n of REAL_NON_MANGLES) {
      expect(resolveToolName(n.rawInput, GOLDEN_CANDIDATES, OPTS).match, n.id).toBeUndefined();
    }
  });
});
