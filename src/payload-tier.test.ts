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
import { encode as encodeResult } from '@papercusp/result-encoding';
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

  // WI-37843. The measured defect: an MCP agent session carries
  // ctx_tier='trimmed', so coord:orient resolved to 'trimmed' and served ~24k
  // chars of a ~66k payload on the one call that bootstraps the whole session.
  describe('ignoreSessionTier (WI-37843)', () => {
    it('discards the SESSION tier — a trimmed-session call resolves to full', () => {
      // The whole point: same inputs as the passing case above, opposite answer.
      expect(resolvePayloadTier(undefined, 'trimmed')).toBe('trimmed');
      expect(resolvePayloadTier(undefined, 'trimmed', { ignoreSessionTier: true })).toBe('full');
      expect(resolvePayloadTier(undefined, 'standard', { ignoreSessionTier: true })).toBe('full');
    });

    it('does NOT override an explicit per-call tier — the caller still wins', () => {
      // A caller that deliberately asks for a small payload must still get one;
      // only the ambient session tier (which the caller never chose) is ignored.
      expect(resolvePayloadTier('trimmed', 'full', { ignoreSessionTier: true })).toBe('trimmed');
      expect(resolvePayloadTier('standard', undefined, { ignoreSessionTier: true })).toBe('standard');
      expect(resolvePayloadTier('full', 'trimmed', { ignoreSessionTier: true })).toBe('full');
    });

    it('is inert when absent or false — every other tool is byte-identical', () => {
      expect(resolvePayloadTier(undefined, 'trimmed', {})).toBe('trimmed');
      expect(resolvePayloadTier(undefined, 'trimmed', { ignoreSessionTier: false })).toBe('trimmed');
      expect(resolvePayloadTier(undefined, undefined, { ignoreSessionTier: true })).toBe('full');
    });
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

  // WI-37843: a tool may raise its OWN ceiling. coord:orient was pinned at the
  // shared 30,000-char default (p99 29,908 — a clamp signature), which meant
  // exempting it from the result door alone would have left the bootstrap read
  // trimmed anyway, and trimmed WORSE than doored: what this ceiling drops is
  // never serialized, so no spill can recover it.
  it('ceilingChars: a per-tool ceiling lets an over-DEFAULT payload through unshaped', () => {
    const log = vi.fn();
    const fat: ToolResponse = { data: { rows: [1, 2, 3], blob: 'x'.repeat(PAYLOAD_TIER_HARD_CEILING_CHARS + 500) } };
    const out = applyPayloadTier({
      toolName: 'coord:orient',
      shape,
      response: fat,
      tier: 'full',
      args: {},
      log,
      ceilingChars: PAYLOAD_TIER_HARD_CEILING_CHARS * 4,
    });
    // Unshaped: the payload is over the SHARED ceiling but under this tool's own.
    expect(out).toBe(fat);
    expect((out.data as { payloadTierForced?: string }).payloadTierForced).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it('ceilingChars: a raised ceiling is a valve, not a bypass — past IT the trimmed shaper still fires', () => {
    // The guard that keeps this from becoming "orient is uncapped forever": a
    // payload over the RAISED ceiling must still degrade, or a runaway orient
    // would sail past the MCP client's own cap and hit the WI-2859 file-dump.
    const log = vi.fn();
    const raised = PAYLOAD_TIER_HARD_CEILING_CHARS * 4;
    const fat: ToolResponse = { data: { rows: [1, 2, 3], blob: 'x'.repeat(raised + 500) } };
    const out = applyPayloadTier({
      toolName: 'coord:orient',
      shape,
      response: fat,
      tier: 'full',
      args: {},
      log,
      ceilingChars: raised,
    });
    expect((out.data as { payloadTierForced?: string }).payloadTierForced).toBe('trimmed');
    expect(JSON.stringify(out.data).length).toBeLessThan(raised);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(String(raised)));
  });

  // A malformed override must fall back to the shared ceiling, never disable the
  // guard. 0 would force-shape everything; NaN compares false against every size
  // and would silently uncap the tool — the failure that looks like success.
  it.each([
    ['NaN', Number.NaN],
    ['zero', 0],
    ['negative', -1],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('ceilingChars: a %s override falls back to the shared ceiling', (_label, bad) => {
    const fat: ToolResponse = { data: { rows: [1, 2, 3], blob: 'x'.repeat(PAYLOAD_TIER_HARD_CEILING_CHARS + 500) } };
    const out = applyPayloadTier({
      toolName: 't',
      shape,
      response: fat,
      tier: 'full',
      args: {},
      ceilingChars: bad as number,
    });
    expect((out.data as { payloadTierForced?: string }).payloadTierForced).toBe('trimmed');
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
    const rows = projected.results as Array<Record<string, unknown> | string>;

    expect(rows.length).toBeGreaterThan(0);
    // The real regression: BEFORE the fix, a row whose budget ran out mid-object
    // could come back as a bare `{ok:true}` (or even `{}`) — no `id` at all, so a
    // bulk caller cannot tell which requested id that row even corresponds to.
    // Every row actually present in the projection must still carry its `id`,
    // however aggressively its OTHER fields got trimmed/omitted. (A trailing
    // string is the in-band array-truncation marker, EI-19965559011729712 — not
    // a row, so it's excluded from this per-row check.)
    for (const row of rows) {
      if (typeof row === 'string') continue;
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

/**
 * EI-19447969329510166 — a clipped string must announce its own clipping IN BAND.
 *
 * The reported harm was not that a value was truncated (that is the tier's job)
 * but that the truncation was INVISIBLE: the marker was a bare `…`, a character
 * that occurs constantly inside real content, and the only other evidence was a
 * sibling `_projection.omitted` entry. A ~13,000-char work_items:get checkpoint
 * came back as its first 800 chars, ending mid-sentence, reading as complete.
 */
describe('projectBoundedPayload — truncation is announced in band', () => {
  const markerRe = /…\[TRUNCATED \+(\d+) chars — see _projection\.cursor\]$/;

  it('marks a maxString-clipped string with a LOUD marker naming the omitted count', () => {
    const original = 'A'.repeat(5_000);
    const out = projectBoundedPayload({ note: original }, { toolName: 't', tier: 'trimmed' });
    const got = out.note as string;

    expect(got).toMatch(markerRe);
    // The count is not decorative: head + omitted must reconstruct the original.
    const omitted = Number(markerRe.exec(got)![1]);
    const head = got.replace(markerRe, '');
    expect(head.length + omitted).toBe(original.length);
    // And the sibling evidence still exists for a reader who does correlate.
    expect(out._projection.omitted.some((o) => o.path === '$.note')).toBe(true);
  });

  it('leaves a string that FITS byte-identical — the marker must not become noise', () => {
    const short = 'a complete, untruncated value';
    const out = projectBoundedPayload({ note: short }, { toolName: 't', tier: 'trimmed' });
    expect(out.note as string).toBe(short);
    expect(out.note as string).not.toMatch(/TRUNCATED/);
  });

  it('marks AND records the BUDGET-pressure clip, which was previously silent in both channels', () => {
    // Sized to pass the per-string maxString gate (800 at trimmed) on every row
    // while collectively exhausting the running budget, so the halving loop —
    // not the maxString branch — is what does the clipping. That loop used to
    // append a bare `…` and never call recordOmission at all.
    const rows = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`f${i}`, 'B'.repeat(700)]),
    );
    const out = projectBoundedPayload(rows, { toolName: 't', tier: 'trimmed' });

    const clipped = Object.entries(out as Record<string, unknown>).filter(
      ([k, v]) => k !== '_projection' && typeof v === 'string' && /TRUNCATED/.test(v),
    );
    expect(clipped.length).toBeGreaterThan(0);
    // Every in-band marker has a matching `_projection.omitted` entry: the two
    // channels must agree, so neither alone can silently under-report.
    for (const [key] of clipped.slice(0, 5)) {
      expect(out._projection.omitted.some((o) => o.path === `$.${key}`)).toBe(true);
    }
    expect(out._projection.omittedCount).toBeGreaterThan(0);
  });

  it('REGRESSION: a checkpoint-sized string never comes back looking complete', () => {
    // The exact reported shape: work_items:get { detail:true } on an item whose
    // checkpoint is ~13k chars, served to a trimmed session with no shaper.
    const checkpoint = `SUPERSEDED root cause: the loop disarmed itself.\n${'x'.repeat(12_000)}\nRETRACTION: it did not — stalled-loops-guard disarmed it.`;
    const out = projectBoundedPayload(
      { ok: true, results: [{ ok: true, id: 'WI-6638', checkpoint }] },
      { toolName: 'work_items:get', tier: 'trimmed', args: { id: 'WI-6638', detail: true } },
    );

    const got = (out.results as Array<{ checkpoint: string }>)[0].checkpoint;
    expect(got.length).toBeLessThan(checkpoint.length);
    // The whole point: a reader can tell, from the value ALONE, that the
    // retraction they cannot see might exist.
    expect(got).toMatch(/TRUNCATED/);
  });

  it("cursor advice states that payloadTier is framework-reserved, not schema-passable", () => {
    const out = projectBoundedPayload(
      { blob: 'z'.repeat(20_000) },
      { toolName: 'work_items:get', tier: 'trimmed', args: { id: 'WI-1' } },
    );
    // The args remain correct for a raw-args dispatch path…
    expect(out._projection.cursor.args).toMatchObject({ id: 'WI-1', payloadTier: 'full' });
    // …but the prose no longer tells the caller to pass them somewhere that
    // rejects them. Following the OLD text ("call with the exact args") failed
    // schema validation at the exact moment the caller was recovering a dropped
    // field.
    expect(out._projection.next).toMatch(/FRAMEWORK-RESERVED/);
    expect(out._projection.next).toMatch(/additionalProperties:false/);
  });

  it('bounds large request args instead of re-expanding them in the recovery cursor', () => {
    const args = {
      messages: Array.from({ length: 67 }, (_, i) => ({
        to: [`agent-${i}`],
        body: [{ text: 'x'.repeat(500) }],
        expects: 'none',
      })),
    };
    const out = projectBoundedPayload(
      { ok: true, count: args.messages.length, error: null },
      { toolName: 'coord:send', tier: 'trimmed', args },
    );
    const cursor = out._projection.cursor;

    expect(cursor.argsTruncated).toBe(true);
    expect(cursor.args).toEqual({ payloadTier: 'full' });
    expect(JSON.stringify(cursor.args).length).toBeLessThan(2_000);
    expect(JSON.stringify(out).length).toBeLessThan(PAYLOAD_TIER_HARD_CEILING_CHARS);
    expect(out._projection.next).toContain('ORIGINAL request args');
    expect(out._projection.next).not.toContain('with _projection.cursor.args for full detail');
  });
});

// WI-36048 — borrow item 1 of the opencode/OMP token-reduction research.
// The sibling of the block above, for values dropped WHOLE rather than clipped.
// Both channels answer "what was here, and can I get it back?"; until this
// landed, only the clip path did — a dropped value produced a bare
// `[omitted: projection budget]` carrying neither size nor recovery path, which
// is opencode's `[Old tool result content cleared]` shape and strictly dominated
// by OMP's `[shaken ~N tokens — recover: artifact://<id>]`.
describe('projectBoundedPayload — a value dropped WHOLE says how much and how to recover it', () => {
  it('EVERY omission marker it emits names the recovery knob', () => {
    // Deliberately shape-agnostic: it asserts the CONTRACT over whatever markers
    // the projector actually produces, rather than pinning one fixture to one
    // branch. A new omission site that forgets the pointer fails here.
    const payload = {
      deep: { a: { b: { c: { d: { e: { noIdentityHere: 'x', more: 'y' } } } } } },
      rows: Array.from({ length: 30 }, (_, i) => ({
        id: `WI-${i}`,
        nested: { plan_item: { slug: 's', item: 'P-1' } },
        summary: 'S'.repeat(400),
      })),
    };
    const text = JSON.stringify(projectBoundedPayload(payload, { toolName: 't', tier: 'trimmed' }));
    const markers = [...new Set(text.match(/\[omitted:[^\]"]*\]/g) ?? [])];

    expect(markers.length).toBeGreaterThan(0);
    for (const m of markers) {
      // The pointer that actually resolves — an EXPLICIT payloadTier:'full' sets
      // explicitFullRequest, the one documented exit from the hard-ceiling
      // force-shape. Deliberately NOT the result-door spill: these values were
      // never serialized, so they are not in the spill either, and advertising
      // it would be a lie the model trusts.
      expect(m).toContain("payloadTier:'full'");
      expect(m).not.toContain('scratch');
    }
  });

  it('CONTROL: a payload that FITS carries no omission marker — it must not become noise', () => {
    // Without this, the assertions above would also pass against a projector
    // that stamped the marker unconditionally.
    const out = projectBoundedPayload({ note: 'small' }, { toolName: 't', tier: 'trimmed' });
    expect(out.note as string).toBe('small');
    expect(JSON.stringify(out)).not.toContain('[omitted:');
  });

  it('REGRESSION (EI-19965559011729712): an array truncated at the maxArray cap announces the drop IN BAND and in omitted[], never starved by field-level entries', () => {
    // Mirrors the reported rubrics:get shape: a 17-element array of small
    // objects, each with several nested fields — deep/wide enough that EVERY
    // kept element also trips depth/field omissions of its own. Before the fix,
    // those per-element omissions (2 per kept element) filled the 20-slot
    // `omitted[]` sample before the ONE array-truncation entry (recorded last)
    // ever got a chance — so a reader scanning `omitted[]` saw only field noise
    // and no signal that 5 whole elements were gone.
    const criteria = Array.from({ length: 17 }, (_, i) => ({
      key: `c${i}`,
      title: `criterion ${i}`,
      model: { rubric: 'x'.repeat(50), drillSteps: ['a', 'b', 'c'] },
      method: 'y'.repeat(50),
      driftMarkers: ['m1', 'm2'],
    }));
    const out = projectBoundedPayload(
      { rubric: { rubricId: 'goal-mode-e2e', criteria } },
      { toolName: 'rubrics:get', tier: 'trimmed' },
    );

    const projectedCriteria = (out.rubric as { criteria: unknown[] }).criteria;
    // The header a downstream TOON/array-length read would derive is no longer
    // silently short — the drop is visible IN the array's own last element.
    const marker = projectedCriteria[projectedCriteria.length - 1];
    expect(typeof marker).toBe('string');
    expect(marker as string).toMatch(/TRUNCATED \+\d+ more item\(s\)/);
    expect(marker as string).toContain('header count includes this marker');
    expect(marker as string).toContain('showing 12 of 17');

    // The actual agent-facing TOON shape still has a projected-length header,
    // so the adjacent marker must carry the shown/true total distinction.
    const toon = encodeResult(out, 'toon');
    expect(toon).toContain('criteria[13]:');
    expect(toon).toContain('header count includes this marker; showing 12 of 17');

    // And the sample list actually names it — never starved out by the
    // per-element field/depth omissions recorded for the elements that DID
    // survive.
    expect(out._projection.omitted.some((o) => /array item\(s\) omitted; showing 12 of 17/.test(o.reason))).toBe(true);
  });

  it('the depth-boundary markers carry the recovery knob too, and pay no stringify for a size', () => {
    // A deeply nested object with no identity fields hits the depth limit.
    const deep = { a: { b: { c: { d: { e: { noIdentityHere: 'x', more: 'y' } } } } } };
    const text = JSON.stringify(projectBoundedPayload(deep, { toolName: 't', tier: 'trimmed' }));

    // If a depth/preview marker fired at all, it must name the recovery path.
    const markers = text.match(/\[omitted: (?:depth limit|compact preview depth)[^\]]*\]/g) ?? [];
    expect(markers.length).toBeGreaterThan(0);
    for (const m of markers) {
      expect(m).toContain("payloadTier:'full'");
      // Deliberately size-free: computing one would cost a JSON.stringify per
      // dropped node, and this marker is charged to the same budget it is
      // trying to save.
      expect(m).not.toMatch(/~\d+ chars/);
    }
  });
});
