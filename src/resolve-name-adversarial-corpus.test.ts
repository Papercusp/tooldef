import { describe, expect, it } from 'vitest';
import {
  ADVERSARIAL_CASES,
  ADVERSARIAL_UNIVERSE,
  FAR_SYNONYMS,
  HARD_ADVERSARIAL_CASES,
  MARGIN_ADVERSARIAL_CASES,
  canonicalKey,
  deriveAdversarialCases,
  editDistance,
  looksMutating,
  normalizedEditDistance,
} from './resolve-name-adversarial-corpus';
import { normalizeMcpName } from './tool-projection';

/** Every universe pair at edit distance <= 2 (the measured near-collision population). */
function closePairs(universe: readonly string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const u = [...universe].sort();
  for (let i = 0; i < u.length; i++) {
    for (let j = i + 1; j < u.length; j++) if (editDistance(u[i]!, u[j]!) <= 2) out.push([u[i]!, u[j]!]);
  }
  return out;
}

/**
 * A NAIVE resolver: nearest name within normalized threshold T, first-wins. This is the
 * mistake D-006 exists to prevent — the corpus must catch it (falsifiability control).
 */
function naiveResolve(input: string, universe: readonly string[], t: number): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const u of universe) {
    const d = normalizedEditDistance(input, u);
    if (d < bestD) {
      bestD = d;
      best = u;
    }
  }
  return bestD <= t ? best : undefined;
}

/**
 * A minimal correct gate: nearest must be UNIQUE in RAW edits and within normalized T.
 * Uniqueness is judged on raw edit counts — see the normalized-tie test below for why.
 */
function gatedResolve(input: string, universe: readonly string[], t: number): string | undefined {
  const ds = universe.map((u) => [u, editDistance(input, u), normalizedEditDistance(input, u)] as const).sort((a, b) => a[1] - b[1]);
  const [first, second] = ds;
  if (!first || first[2] > t) return undefined;
  if (second && second[1] === first[1]) return undefined;
  return first[0];
}

/**
 * The tempting-but-wrong variant: uniqueness on the NORMALIZED float. Normalizing by
 * max(len) makes the LONGER of two raw-tied names look strictly nearer
 * (`accounts:npin` is 1 edit from both `accounts:pin` and `accounts:unpin`, but 1/13 vs 1/14),
 * silently turning a genuine tie into a confident resolve.
 */
function normalizedUniquenessResolve(input: string, universe: readonly string[], t: number): string | undefined {
  const ds = universe.map((u) => [u, normalizedEditDistance(input, u)] as const).sort((a, b) => a[1] - b[1]);
  const [first, second] = ds;
  if (!first || first[1] > t) return undefined;
  if (second && second[1] === first[1]) return undefined;
  return first[0];
}

describe('edit distance helpers', () => {
  it('matches known Levenshtein values', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('flags:get', 'flags:set')).toBe(1);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('same', 'same')).toBe(0);
    expect(normalizedEditDistance('flags:get', 'flags:set')).toBeCloseTo(1 / 9);
  });

  it('canonicalKey agrees with the production normalizeMcpName on every universe name and mangle', () => {
    const samples = [
      ...ADVERSARIAL_UNIVERSE,
      'coord_send',
      'mcp__papercusp_su__coord_send',
      'mcp__papercusp-su__curation_state-of-pot',
      'Coord.Send',
      ...ADVERSARIAL_CASES.map((c) => c.rawInput),
    ];
    for (const s of samples) expect(canonicalKey(s)).toBe(normalizeMcpName(s));
  });
});

describe('ADVERSARIAL_CASES — corpus invariants', () => {
  const universe = new Set(ADVERSARIAL_UNIVERSE);
  const canon = new Set(ADVERSARIAL_UNIVERSE.map(canonicalKey));

  it('is non-trivially populated and every id is unique', () => {
    expect(ADVERSARIAL_CASES.length).toBeGreaterThanOrEqual(60);
    expect(new Set(ADVERSARIAL_CASES.map((c) => c.id)).size).toBe(ADVERSARIAL_CASES.length);
    expect(HARD_ADVERSARIAL_CASES.length + MARGIN_ADVERSARIAL_CASES.length).toBe(ADVERSARIAL_CASES.length);
  });

  it('no input is an exact or canonicalize hit (those are stage-1 resolutions, not fuzzy guards)', () => {
    for (const c of ADVERSARIAL_CASES) {
      expect(universe.has(c.rawInput), c.id).toBe(false);
      expect(canon.has(canonicalKey(c.rawInput)), c.id).toBe(false);
    }
  });

  it('stored measurements equal a fresh recomputation against the universe', () => {
    for (const c of ADVERSARIAL_CASES) {
      const ds = ADVERSARIAL_UNIVERSE.map((u) => [u, editDistance(c.rawInput, u)] as const);
      const dNearest = Math.min(...ds.map((d) => d[1]));
      expect(c.dNearest, c.id).toBe(dNearest);
      expect([...c.nearest].sort(), c.id).toEqual(ds.filter((d) => d[1] === dNearest).map((d) => d[0]).sort());
      const others = ds.filter((d) => d[1] !== dNearest).map((d) => d[1]);
      expect(c.dSecond, c.id).toBe(others.length ? Math.min(...others) : Infinity);
      for (const f of c.mustNotResolveTo) expect(universe.has(f), `${c.id} forbids unknown ${f}`).toBe(true);
    }
  });

  it('ties are genuine: >= 2 nearest names, and >= 1 edit away from all of them', () => {
    const ties = ADVERSARIAL_CASES.filter((c) => c.cls === 'tie');
    expect(ties.length).toBeGreaterThanOrEqual(45);
    for (const t of ties) {
      expect(t.nearest.length, t.id).toBeGreaterThanOrEqual(2);
      expect(t.dNearest, t.id).toBeGreaterThanOrEqual(1);
      expect(t.hard, t.id).toBe(true);
      expect(t.mustNotResolveTo, t.id).toEqual(t.nearest);
    }
  });

  it('margin probes have a unique nearest with runner-up exactly 1 farther, and are policy-dependent', () => {
    expect(MARGIN_ADVERSARIAL_CASES.length).toBeGreaterThan(0);
    for (const m of MARGIN_ADVERSARIAL_CASES) {
      expect(m.cls, m.id).toBe('margin-probe');
      expect(m.nearest.length, m.id).toBe(1);
      expect(m.dSecond, m.id).toBe(m.dNearest + 1);
      expect(m.hard, m.id).toBe(false);
    }
  });

  it('far synonyms stay far at the VERB level: >= 0.4 normalized distance to every forbidden target verb', () => {
    // Whole-name distance is NOT the right yardstick: `work_items:update` is only 0.18 from
    // `work_items:create` because the 11-char group prefix is shared — exactly the get/set
    // collision D-005's group-then-verb matching exists to remove. The verb is what differs.
    const verbOf = (n: string) => n.slice(n.lastIndexOf(':') + 1);
    const far = ADVERSARIAL_CASES.filter((c) => c.cls === 'far-synonym');
    expect(far.length).toBe(FAR_SYNONYMS.length);
    for (const f of far) {
      for (const target of f.mustNotResolveTo) {
        expect(normalizedEditDistance(verbOf(f.rawInput), verbOf(target)), `${f.rawInput} -> ${target}`).toBeGreaterThanOrEqual(0.4);
      }
    }
  });

  it('covers every plan-named ambiguous pair (P-002) with at least one tie', () => {
    const named: Array<[string, string]> = [
      ['autonomy:policy_get', 'autonomy:policy_set'],
      ['backup:settings_get', 'backup:settings_set'],
      ['config:tiers-get', 'config:tiers-set'],
      ['pot:get-steering', 'pot:set-steering'],
      ['capability:edit', 'capability:git'],
    ];
    for (const [a, b] of named) {
      const hit = ADVERSARIAL_CASES.some((c) => c.cls === 'tie' && c.nearest.includes(a) && c.nearest.includes(b));
      expect(hit, `${a} / ${b}`).toBe(true);
    }
  });

  it('covers EVERY distance<=2 pair in the universe (no measured collision left unguarded)', () => {
    for (const [a, b] of closePairs(ADVERSARIAL_UNIVERSE)) {
      const hit = ADVERSARIAL_CASES.some((c) => c.cls === 'tie' && c.nearest.includes(a) && c.nearest.includes(b));
      expect(hit, `${a} / ${b}`).toBe(true);
    }
  });

  it('flags the read/write confusables so D-007 has its protected population', () => {
    const withMutating = HARD_ADVERSARIAL_CASES.filter((c) => c.mutatingTargets.length > 0);
    expect(withMutating.length).toBeGreaterThan(10);
    expect(looksMutating('flags:set')).toBe(true);
    expect(looksMutating('flags:get')).toBe(false);
    expect(looksMutating('capability:edit')).toBe(true);
    expect(looksMutating('plans:get-specs')).toBe(false);
  });
});

describe('ADVERSARIAL_CASES — falsifiability (the corpus can fail a bad resolver and pass a sound one)', () => {
  it('a NAIVE nearest-within-T resolver false-resolves hard cases (control: the corpus has teeth)', () => {
    const falseResolves = HARD_ADVERSARIAL_CASES.filter((c) => {
      const out = naiveResolve(c.rawInput, ADVERSARIAL_UNIVERSE, 0.34);
      return out !== undefined && c.mustNotResolveTo.includes(out);
    });
    expect(falseResolves.length).toBeGreaterThan(20);
  });

  it('a unique-nearest gate at a tight T resolves ZERO hard cases (the bar is satisfiable)', () => {
    for (const c of HARD_ADVERSARIAL_CASES) {
      const out = gatedResolve(c.rawInput, ADVERSARIAL_UNIVERSE, 0.2);
      expect(out === undefined || !c.mustNotResolveTo.includes(out), `${c.id} -> ${out}`).toBe(true);
    }
  });

  it('normalized-float uniqueness false-resolves raw ties — resolvers must judge ties on RAW edits (P-004 contract)', () => {
    const leaked = HARD_ADVERSARIAL_CASES.filter((c) => {
      const out = normalizedUniquenessResolve(c.rawInput, ADVERSARIAL_UNIVERSE, 0.2);
      return out !== undefined && c.mustNotResolveTo.includes(out);
    });
    expect(leaked.map((c) => c.id)).toContain('tie:accounts:npin');
  });

  it('a margin probe DOES resolve under a bare unique-nearest gate — that is what M must arbitrate', () => {
    const resolved = MARGIN_ADVERSARIAL_CASES.filter((c) => gatedResolve(c.rawInput, ADVERSARIAL_UNIVERSE, 0.2) === c.nearest[0]);
    expect(resolved.length).toBeGreaterThan(0);
  });
});

describe('deriveAdversarialCases — positive control on a tiny universe', () => {
  it('yields a tie for a get/set pair and none for a lone name', () => {
    const pair = deriveAdversarialCases(['flags:get', 'flags:set']);
    expect(pair.some((c) => c.cls === 'tie' && c.nearest.length === 2)).toBe(true);
    expect(deriveAdversarialCases(['flags:get']).filter((c) => c.cls === 'tie')).toEqual([]);
  });

  it('never derives a case out of a canonicalize hit', () => {
    const cases = deriveAdversarialCases(['flags:get', 'flags:set']);
    for (const c of cases) expect(['flags:get', 'flags:set'].map(canonicalKey)).not.toContain(canonicalKey(c.rawInput));
  });
});
