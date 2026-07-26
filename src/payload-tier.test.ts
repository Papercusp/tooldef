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

  it('hard ceiling: an EXPLICIT payloadTier:full call skips the ceiling (the documented escape hatch, WI-5078)', () => {
    const log = vi.fn();
    const fat: ToolResponse = { data: { rows: [1, 2, 3], blob: 'x'.repeat(PAYLOAD_TIER_HARD_CEILING_CHARS + 500) } };
    // Same over-ceiling payload as the WI-2859 case above, but the caller
    // EXPLICITLY asked for full (payloadTier:'full' arg → explicitFullRequest).
    // This is the escape hatch every shaper hint and the bounded projection's
    // own `cursor.args.payloadTier:'full'` retry pointer document — and the
    // contract the UI's in-process dispatch (callPlansReadRaw) relies on:
    // without it, plans:attention force-trimmed to item-less summaries and the
    // Queue/Overview/Inbox surfaces rendered empty.
    const out = applyPayloadTier({
      toolName: 'orient',
      shape,
      response: fat,
      tier: 'full',
      explicitFullRequest: true,
      args: {},
      log,
    });
    expect(out).toBe(fat); // unshaped, byte-identical
    expect(log).not.toHaveBeenCalled();
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
      cursor: { kind: 'full-detail', tool: 't', args: { payloadTier: 'full' } },
    });
    expect(projected._projection.next).toContain('_projection.cursor.args');
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
    expect(projected._projection.cursor).toEqual({
      kind: 'full-detail',
      tool: 'fat:tool',
      args: { payloadTier: 'full' },
    });
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

  it('retains identity for every deeply nested recipe-result row and returns a callable continuation (EI-11404)', () => {
    const summary = Array.from({ length: 10 }, (_, i) => ({
      ok: true,
      results: [{
        ok: true,
        id: `WI-${4600 + i}`,
        workItem: {
          id: `WI-${4600 + i}`,
          title: `Operability item ${i}`,
          state: i % 2 === 0 ? 'todo' : 'passed',
          summary: 'x'.repeat(2_000),
        },
      }],
      counts: { ok: 1, failed: 0 },
    }));
    const nested = {
      ok: true,
      results: [{
        ok: true,
        id: 'read-existing-agent-operability-work-items',
        result: { ok: true, summary, logs: [], dryRun: false, plannedMutations: [] },
      }],
      counts: { ok: 1, failed: 0 },
    };

    const projected = projectBoundedPayload(nested, {
      toolName: 'recipes:run',
      tier: 'trimmed',
      args: { id: 'read-existing-agent-operability-work-items' },
    });
    const rows = (((projected.results as any[])[0].result.summary) as Array<any>);
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => typeof row !== 'string')).toBe(true);
    expect(rows.map((row) => row.results[0].id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `WI-${4600 + i}`),
    );
    expect(projected._projection.cursor).toEqual({
      kind: 'full-detail',
      tool: 'recipes:run',
      args: { id: 'read-existing-agent-operability-work-items', payloadTier: 'full' },
    });
    expect(projected._projection.next).not.toContain('narrower filters/ids');
  });

  it('retains `id`/`ok` for every bulk results[] row even when per-key BUDGET (not depth) runs out mid-object (EI-18683546971375407)', () => {
    // Each row's bulky fields (workItem.summary, checkpoint) come AFTER id/ok in
    // insertion order — exactly the shape work_items:get returns — so a naive
    // insertion-order key loop starves `id` out once the budget trips partway
    // through a row, well before the generic depth limit (maxDepth) is ever hit.
    const bigBlob = 'x'.repeat(1_500);
    const results = Array.from({ length: 8 }, (_, i) => ({
      ok: true,
      id: `EI-${1000 + i}`,
      workItem: { id: `EI-${1000 + i}`, title: `row ${i}`, summary: bigBlob },
      checkpoint: bigBlob,
    }));
    const envelope = { ok: true, results, counts: { ok: results.length, failed: 0 } };

    const projected = projectBoundedPayload(envelope, { toolName: 'work_items:get', tier: 'trimmed' });
    const rows = projected.results as Array<Record<string, unknown>>;

    expect(rows.length).toBeGreaterThan(0);
    // The real regression: BEFORE the fix, a row whose budget ran out mid-object
    // could come back as a bare `{ok:true}` (or even `{}`) — no `id` at all, so a
    // bulk caller cannot tell which requested id that row even corresponds to.
    // Every row actually present in the projection must still carry its `id`,
    // however aggressively its OTHER fields got trimmed/omitted.
    for (const row of rows) {
      expect(row.id).toBeDefined();
      expect(typeof row.id).toBe('string');
    }
    // The budget genuinely was exhausted (this is what made the old code drop
    // ids in the first place) — confirm we actually exercised that path, not a
    // no-op fast path where nothing needed trimming.
    expect(projected._projection.omittedCount).toBeGreaterThan(0);
  });
});

describe('payloadProjection meta (EI-13918)', () => {
  // A downstream consumer that only reads `_meta` (the per-result door,
  // result-door.ts) must be able to tell `data` was already replaced by a
  // lossy projection WITHOUT parsing the serialized body — see
  // serialize-result.ts which copies `response.payloadProjection` into
  // `_meta.payloadProjection`.

  it('is stamped on the ratchet path, mirroring the inline `_projection` metadata', () => {
    const fat: ToolResponse = { data: { blob: 'x'.repeat(PAYLOAD_TIER_RATCHET_CHARS + 100) } };
    const out = applyPayloadTier({ toolName: 'fat:tool', shape: undefined, response: fat, tier: 'trimmed', args: {} });
    const projected = out.data as ReturnType<typeof projectBoundedPayload>;
    expect(out.payloadProjection).toEqual({
      truncated: true,
      tier: projected._projection.tier,
      forced: projected._projection.forced,
      originalChars: projected._projection.originalChars,
      returnedChars: projected._projection.returnedChars,
      omittedCount: projected._projection.omittedCount,
    });
  });

  it('is stamped on the hard-ceiling generic-projection path', () => {
    const fat: ToolResponse = { data: { blob: 'y'.repeat(PAYLOAD_TIER_HARD_CEILING_CHARS + 500) } };
    const out = applyPayloadTier({ toolName: 't', shape: undefined, response: fat, tier: 'full', args: {} });
    expect(out.payloadProjection).toMatchObject({ truncated: true, forced: true });
    expect(out.payloadProjection?.omittedCount).toBeGreaterThan(0);
  });

  it('is stamped on the hard-ceiling forced-custom-shaper path (WI-2859), even though no inline `_projection` rides the shaped data', () => {
    const shape = { trimmed: (d: unknown) => ({ tierMark: 'trimmed', rows: (d as { rows: number[] }).rows }) };
    const fat: ToolResponse = { data: { rows: [1, 2, 3], blob: 'x'.repeat(PAYLOAD_TIER_HARD_CEILING_CHARS + 500) } };
    const out = applyPayloadTier({ toolName: 'orient', shape, response: fat, tier: 'full', args: {}, log: vi.fn() });
    // No `_projection` key rides the custom-shaped data…
    expect(out.data).not.toHaveProperty('_projection');
    // …but the door-facing meta marker is present anyway, so a caller can't
    // mistake this forced-small result for the tool's true full output.
    expect(out.payloadProjection).toEqual({
      truncated: true,
      tier: 'trimmed',
      forced: true,
      originalChars: expect.any(Number),
      returnedChars: expect.any(Number),
      omittedCount: 0,
    });
  });

  it('is ABSENT for a normal-size / unshaped / explicit-full response (no false positives)', () => {
    const data = { rows: [1, 2, 3] };
    const response: ToolResponse = { data };
    expect(applyPayloadTier({ toolName: 't', shape: undefined, response, tier: 'full', args: {} }).payloadProjection).toBeUndefined();
    expect(applyPayloadTier({ toolName: 't', shape: undefined, response, tier: 'trimmed', args: {} }).payloadProjection).toBeUndefined();
    const fat: ToolResponse = { data: { blob: 'x'.repeat(PAYLOAD_TIER_HARD_CEILING_CHARS + 500) } };
    expect(
      applyPayloadTier({ toolName: 't', shape: undefined, response: fat, tier: 'full', explicitFullRequest: true, args: {} })
        .payloadProjection,
    ).toBeUndefined();
  });
});
