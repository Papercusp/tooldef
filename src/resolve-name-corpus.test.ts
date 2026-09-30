import { describe, expect, it } from 'vitest';
import {
  GOLDEN_MANGLES,
  REAL_MANGLES,
  REAL_NON_MANGLES,
  SPINE_TOOLS,
  SYNTHETIC_MANGLES,
  buildSyntheticMangles,
  editDistance,
  mcpNameOf,
} from './resolve-name-corpus.js';

describe('resolve-name golden mangle corpus (P-001)', () => {
  it('spine is the ~19 trimmed-session tools, all canonical group:verb', () => {
    expect(SPINE_TOOLS).toHaveLength(19);
    for (const t of SPINE_TOOLS) expect(t).toMatch(/^[a-z_]+:[a-z_-]+$/);
    expect(new Set(SPINE_TOOLS).size).toBe(SPINE_TOOLS.length);
  });

  it('has real session-9662 cases and a meaningful synthetic population', () => {
    expect(REAL_MANGLES.length).toBeGreaterThanOrEqual(10);
    expect(SYNTHETIC_MANGLES.length).toBeGreaterThanOrEqual(150);
    expect(GOLDEN_MANGLES).toHaveLength(REAL_MANGLES.length + SYNTHETIC_MANGLES.length);
  });

  it('ids and raw inputs are unique across the whole set', () => {
    expect(new Set(GOLDEN_MANGLES.map((c) => c.id)).size).toBe(GOLDEN_MANGLES.length);
    expect(new Set(GOLDEN_MANGLES.map((c) => c.rawInput)).size).toBe(GOLDEN_MANGLES.length);
  });

  it('is deterministic (no RNG): two builds are identical', () => {
    expect(buildSyntheticMangles()).toEqual(buildSyntheticMangles());
  });

  it('a mangle is never already an exact catalog (transport) name', () => {
    const exact = new Set(SPINE_TOOLS.map(mcpNameOf));
    for (const c of GOLDEN_MANGLES) expect(exact.has(c.rawInput), c.rawInput).toBe(false);
  });

  it('every synthetic case targets a spine tool and covers every mangle class', () => {
    for (const c of SYNTHETIC_MANGLES) expect(SPINE_TOOLS as readonly string[]).toContain(c.intendedTool);
    const kinds = new Set(SYNTHETIC_MANGLES.map((c) => c.kind));
    for (const k of ['separator', 'verb-separator', 'prefix', 'case', 'typo'] as const) expect(kinds.has(k), k).toBe(true);
  });

  it('every synthetic label is UNIQUELY recoverable: strictly nearer its intended tool than any other spine tool', () => {
    const norm = (s: string) =>
      s
        .replace(/^(mcp__papercus+p?[-_]su__|mcp__papercus+p?_su_|mcp_papercusp_su_|papercusp-su__)/i, '')
        .toLowerCase()
        .replace(/[:./-]/g, '_');
    for (const c of SYNTHETIC_MANGLES) {
      const d = editDistance(norm(c.rawInput), norm(mcpNameOf(c.intendedTool)));
      for (const other of SPINE_TOOLS) {
        if (other === c.intendedTool) continue;
        expect(editDistance(norm(c.rawInput), norm(mcpNameOf(other))), `${c.rawInput} vs ${other}`).toBeGreaterThan(d);
      }
    }
  });

  it('the uniqueness filter is falsifiable: an equidistant mangle is dropped', () => {
    // `plans_get` vs `plans_set` style collisions: with a 2-tool spine where the mangle sits
    // exactly between them, no case may be emitted for it.
    const cases = buildSyntheticMangles(['autonomy:get', 'autonomy:set']);
    for (const c of cases) expect(c.rawInput).not.toBe('autonomy_zet');
    // control: the filter must keep clearly-unambiguous cases, or the assertion above is vacuous
    expect(cases.length).toBeGreaterThan(0);
  });

  it('real non-mangles are kept apart from the must-resolve set', () => {
    const golden = new Set(GOLDEN_MANGLES.map((c) => c.rawInput));
    expect(REAL_NON_MANGLES.length).toBeGreaterThanOrEqual(4);
    for (const n of REAL_NON_MANGLES) expect(golden.has(n.rawInput), n.rawInput).toBe(false);
  });
});
