import { describe, expect, it } from 'vitest';
import { evaluate, pickBest, sweep } from './resolve-name-sweep';
import { FUZZY_RESOLVE_M, FUZZY_RESOLVE_T } from './resolve-name-thresholds';
import { canonicalKey, levenshtein, matchName } from './resolve-name-match';
import { normalizeMcpName } from './tool-projection';
import { looksMutating } from './resolve-name-adversarial-corpus';

describe('P-003 (T,M) sweep', () => {
  const points = sweep();
  const best = pickBest(points);

  it('has a zero-false-resolve optimum', () => {
    expect(best).not.toBeNull();
  });

  it('frozen constants equal the sweep optimum (cannot drift from the evidence)', () => {
    expect({ T: FUZZY_RESOLVE_T, M: FUZZY_RESOLVE_M }).toEqual({ T: best!.T, M: best!.M });
  });

  it('frozen point has zero false-resolves in every population and recovers most goldens', () => {
    const p = evaluate(FUZZY_RESOLVE_T, FUZZY_RESOLVE_M);
    expect(p.goldenWrong).toBe(0);
    expect(p.hardFalseResolves).toBe(0);
    expect(p.marginFalseResolves).toBe(0);
    expect(p.nonMangleFalseResolves).toBe(0);
    // every golden either recovers or is withheld by D-007 (high-tier), never silently missed
    expect(p.goldenAbstained).toBe(p.goldenBlocked);
    expect(p.recovered).toBe(p.goldenTotal - p.goldenAbstained);
  });

  it('M=1 is unsafe: raw ties between real neighbours resolve', () => {
    expect(evaluate(FUZZY_RESOLVE_T, 1).hardFalseResolves).toBeGreaterThan(0);
  });
});

describe('matcher invariants', () => {
  const cands = ['accounts:pin', 'accounts:unpin', 'plans:get', 'plans:set-now', 'work_items:create', 'work_items:complete'];
  const p = { T: FUZZY_RESOLVE_T, M: FUZZY_RESOLVE_M };

  it('canonicalKey agrees with normalizeMcpName', () => {
    for (const s of ['coord_send', 'mcp__papercusp-su__plans_set-now', 'Work_Items:Get', 'a.b-c']) {
      expect(canonicalKey(s)).toBe(normalizeMcpName(s));
    }
  });
  it('adjacent transposition is one edit', () => {
    expect(levenshtein('palns', 'plans')).toBe(1);
  });
  it('a raw tie between two real names abstains (accounts:npin)', () => {
    expect(matchName('accounts:npin', cands, p).kind).toBe('ambiguous');
  });
  it('a far synonym sharing a long group prefix does not resolve', () => {
    expect(matchName('work_items:update', cands, p).kind).toBe('none');
  });
  it('a stray edge separator is an edit, not free noise', () => {
    expect(matchName('plans:get-', cands, p).kind).toBe('fuzzy');
    expect(matchName('plans:get-', ['plans:get', 'plans:gets'], p).kind).toBe('ambiguous');
  });
  it('a mangled server prefix + separators resolve exactly (raw 0)', () => {
    expect(matchName('mcp__papercuss_u_plans:get', cands, p)).toEqual({ kind: 'exact', tool: 'plans:get' });
  });
  it('D-007: a unique fuzzy hit on a high-tier tool is withheld', () => {
    expect(matchName('work_items_coplete', cands, p, (t) => looksMutating(t)).kind).toBe('blocked-high-tier');
  });
});
