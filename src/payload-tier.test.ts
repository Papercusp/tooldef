/**
 * payload-tier.test.ts — the trimmed/standard/full payload-tier axis
 * (context-trimming-tiers-2026-07-01 D-004).
 *
 * The load-bearing semantics:
 *   - `full` IS the normal-size unshaped response; oversized default-tier
 *     output gets a loud generic projection;
 *   - resolution falls back trimmed → standard → full;
 *   - a per-call `payloadTier` arg outranks the session tier and is stripped
 *     before schema validation;
 *   - a throwing shaper never breaks the call;
 *   - a fat unshaped payload served to a non-full session fires the
 *     once-per-tool ratchet warning (the shaper-migration worklist).
 *
 * Run: cd libs/generic/tooldef && npx vitest run src/payload-tier.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPayloadTier,
  extractPayloadTier,
  parsePayloadTier,
  resolvePayloadTier,
  resetPayloadTierRatchet,
  projectBoundedPayload,
  PAYLOAD_TIER_RATCHET_CHARS,
  PAYLOAD_TIER_HARD_CEILING_CHARS,
} from './payload-tier';
import type { ToolResponse } from './types';

beforeEach(() => resetPayloadTierRatchet());

describe('extractPayloadTier', () => {
  it('strips a valid per-call override and leaves other args intact', () => {
    const { input, callTier } = extractPayloadTier({ a: 1, payloadTier: 'full' });
    expect(callTier).toBe('full');
    expect(input).toEqual({ a: 1 });
  });

  it('strips an INVALID value too (framework-reserved key never reaches validation)', () => {
    const { input, callTier } = extractPayloadTier({ a: 1, payloadTier: 'bogus' });
    expect(callTier).toBeUndefined();
    expect(input).toEqual({ a: 1 });
  });

  it('leaves non-object / override-less inputs untouched', () => {
    expect(extractPayloadTier(undefined)).toEqual({ input: undefined });
    expect(extractPayloadTier({ a: 1 })).toEqual({ input: { a: 1 } });
    const arr = [1, 2];
    expect(extractPayloadTier(arr).input).toBe(arr);
  });
});

describe('resolvePayloadTier', () => {
  it('call override > session tier > full', () => {
    expect(resolvePayloadTier('full', 'trimmed')).toBe('full');
    expect(resolvePayloadTier(undefined, 'trimmed')).toBe('trimmed');
    expect(resolvePayloadTier(undefined, undefined)).toBe('full');
  });

  it('parsePayloadTier accepts only the three tiers', () => {
    expect(parsePayloadTier('standard')).toBe('standard');
    expect(parsePayloadTier('huge')).toBeUndefined();
    expect(parsePayloadTier(3)).toBeUndefined();
  });
});

describe('applyPayloadTier', () => {
  const data = { rows: [1, 2, 3], detail: 'x' };
  const response: ToolResponse = { data };
  const shape = {
    standard: (d: unknown) => ({ ...(d as object), detail: undefined, tierMark: 'standard' }),
    trimmed: (d: unknown, sctx: { tier: string }) => ({ rows: (d as { rows: number[] }).rows.slice(0, 1), tierMark: sctx.tier }),
  };

  it('full = unshaped for a normal-size payload (zero-migration contract)', () => {
    expect(applyPayloadTier({ toolName: 't', shape, response, tier: 'full', args: {} })).toBe(response);
    expect(applyPayloadTier({ toolName: 't', shape: undefined, response, tier: 'full', args: {} })).toBe(response);
  });

  it('hard ceiling: a full payload over the ceiling force-applies the trimmed shaper (WI-2859)', () => {
    const log = vi.fn();
    const fat: ToolResponse = { data: { rows: [1, 2, 3], blob: 'x'.repeat(PAYLOAD_TIER_HARD_CEILING_CHARS + 500) } };
    const out = applyPayloadTier({ toolName: 'orient', shape, response: fat, tier: 'full', args: {}, log });
    // The smallest shaper ran even though the tier was `full`…
    expect((out.data as { tierMark: string }).tierMark).toBe('trimmed');
    // …and the forced downgrade is marked so the caller knows.
    expect((out.data as { payloadTierForced?: string }).payloadTierForced).toBe('trimmed');
    // The result now fits under the ceiling (the whole point).
    expect(JSON.stringify(out.data).length).toBeLessThan(PAYLOAD_TIER_HARD_CEILING_CHARS);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('hard ceiling'));
  });

  it('hard ceiling: an over-ceiling payload with NO shaper gets a loud bounded projection', () => {
    const fat: ToolResponse = { data: { blob: 'y'.repeat(PAYLOAD_TIER_HARD_CEILING_CHARS + 500) } };
    const out = applyPayloadTier({ toolName: 't', shape: undefined, response: fat, tier: 'full', args: {} });
    const projected = out.data as ReturnType<typeof projectBoundedPayload>;
    expect(projected._projection).toMatchObject({
      kind: 'bounded-payload',
      truncated: true,
      tier: 'full',
      forced: true,
      cursor: { kind: 'full-detail', payloadTier: 'full' },
    });
    expect(projected._projection.next).toContain('narrower filters/ids');
    expect(JSON.stringify(projected).length).toBeLessThan(PAYLOAD_TIER_HARD_CEILING_CHARS);
  });

  it('hard ceiling falls back to the generic projection when a custom shape does not shrink', () => {
    const identityShape = { trimmed: (d: unknown) => d };
    const fat: ToolResponse = { data: { blob: 'z'.repeat(PAYLOAD_TIER_HARD_CEILING_CHARS + 500) } };
    const out = applyPayloadTier({ toolName: 't', shape: identityShape, response: fat, tier: 'full', args: {} });
    expect((out.data as ReturnType<typeof projectBoundedPayload>)._projection.forced).toBe(true);
    expect(JSON.stringify(out.data).length).toBeLessThan(PAYLOAD_TIER_HARD_CEILING_CHARS);
  });

  it('trimmed picks shape.trimmed; standard picks shape.standard', () => {
    const t = applyPayloadTier({ toolName: 't', shape, response, tier: 'trimmed', args: {} });
    expect(t.data).toEqual({ rows: [1], tierMark: 'trimmed' });
    const s = applyPayloadTier({ toolName: 't', shape, response, tier: 'standard', args: {} });
    expect((s.data as { tierMark: string }).tierMark).toBe('standard');
  });

  it('trimmed falls back to standard when no trimmed shaper; to unshaped when neither', () => {
    const onlyStd = { standard: shape.standard };
    const viaStd = applyPayloadTier({ toolName: 't', shape: onlyStd, response, tier: 'trimmed', args: {} });
    expect((viaStd.data as { tierMark: string }).tierMark).toBe('standard');
    const unshaped = applyPayloadTier({ toolName: 't', shape: {}, response, tier: 'trimmed', args: {} });
    expect(unshaped.data).toBe(data);
  });

  it('a throwing shaper serves the unshaped data and logs, never throws', () => {
    const log = vi.fn();
    const out = applyPayloadTier({
      toolName: 't',
      shape: { trimmed: () => { throw new Error('boom'); } },
      response,
      tier: 'trimmed',
      args: {},
      log,
    });
    expect(out.data).toBe(data);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('shaper threw'));
  });

  it('ratchet: a fat unshaped payload warns once and is auto-projected with exact re-fetch guidance', () => {
    const log = vi.fn();
    const fat: ToolResponse = { data: { blob: 'x'.repeat(PAYLOAD_TIER_RATCHET_CHARS + 100) } };
    const first = applyPayloadTier({ toolName: 'fat:tool', shape: undefined, response: fat, tier: 'trimmed', args: {}, log });
    applyPayloadTier({ toolName: 'fat:tool', shape: undefined, response: fat, tier: 'trimmed', args: {}, log });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('bounded'));
    const projected = first.data as ReturnType<typeof projectBoundedPayload>;
    expect(projected._projection.omittedCount).toBeGreaterThan(0);
    expect(projected._projection.next).toContain('payloadTier:"full"');
    expect(JSON.stringify(projected).length).toBeLessThan(PAYLOAD_TIER_RATCHET_CHARS);
    // envelope fields survive shaping
    const enveloped = applyPayloadTier({
      toolName: 'env:tool',
      shape: { trimmed: () => ({ ok: true }) },
      response: { data, nextCursor: 'c1', degraded: true },
      tier: 'trimmed',
      args: {},
    });
    expect(enveloped.nextCursor).toBe('c1');
    expect(enveloped.degraded).toBe(true);
  });

  it('wraps top-level arrays so bounded output always carries omission metadata', () => {
    const original = Array.from({ length: 200 }, (_, i) => ({ i, blob: 'x'.repeat(100) }));
    const projected = projectBoundedPayload(original, { toolName: 'catalog:list', tier: 'trimmed' });
    expect(projected.items).toBeInstanceOf(Array);
    expect((projected.items as unknown[]).length).toBeLessThan(original.length);
    expect(projected._projection.omittedCount).toBeGreaterThan(0);
    expect(projected._projection.omitted[0]).toHaveProperty('path');
    expect(original).toHaveLength(200);
  });

  it('handles circular data in the generic projector without throwing', () => {
    const circular: { name: string; self?: unknown } = { name: 'loop' };
    circular.self = circular;
    const projected = projectBoundedPayload(circular, { toolName: 'diagnostic:get', tier: 'trimmed' });
    expect(projected.self).toBe('[circular]');
    expect(projected._projection.omitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'circular reference omitted' }),
    ]));
  });
});
