/**
 * In-process delta CLIENT round-trip through the REAL server dispatch
 * (agent-tool-delta-client-rollout-2026-06-23 P-003/P-005 — the "in-process
 * delta proves mode:delta on re-reads" DoD).
 *
 * `delta-integration.test.ts` proves the SERVER half end-to-end (negotiateDelta
 * through `dispatchProjectedTool` → `_meta.delta`). `delta-client.test.ts` and
 * `base-presence.test.ts` prove the CLIENT units against a SIMULATED dispatch.
 * NOTHING wired the client units to the real server — so a regression that made
 * re-reads silently always-full (the delta never engaging) would pass every
 * existing test. This is that gap-detector: it drives `dispatchWithBasePresence`
 * (BasePresenceTracker + DeltaToolClient) against the real `dispatchProjectedTool`
 * and asserts the full poll loop — cold→full, unchanged→not_modified,
 * mutated→mode:delta with a checksum-verified merge, compaction→forced full, and
 * the out-of-scope (external Claude Code) enabled:false → always full.
 *
 * This is the in-process proof the contract scopes to a turn-wrapper that owns
 * the message array; the operator's converse/oracle loop spawns a CHILD process
 * and owns no message array, so there is no live in-repo LLM loop to wire — the
 * proof is this deterministic drive of the real dispatch + client merge.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { decode, type ResultFormat } from '@papercusp/result-encoding';
import { defineTool } from './define-tool';
import { dispatchProjectedTool, type DispatchProjectedDeps } from './dispatch-projected';
import { lookupByMcpName, _resetProjectionRegistryForTests, type UnifiedToolContext } from './tool-projection';
import {
  computeViewChecksum,
  setSemanticDeltaEnabledResolver,
  resetSemanticDeltaEnabledResolver,
} from './delta-protocol';
import { DeltaToolClient, type DeltaResponse } from './delta-client';
import { BasePresenceTracker, dispatchWithBasePresence } from './base-presence';

interface SemRow {
  id: string;
  name: string;
}
const semItemKey = (r: unknown) => (r as SemRow).id;
const sortById = (rs: SemRow[]) => [...rs].sort((a, b) => a.id.localeCompare(b.id));

function makeSemRows(n = 10): SemRow[] {
  return Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `row-${i}-with-padding-text` }));
}

/**
 * A semantic-capable tool shaped like the REAL adopted reads (work_items:list,
 * plans:list): an `itemKey` and the DEFAULT content-hash row revision — NO
 * custom `rowRevision`. This matters for the round-trip: DeltaToolClient.ingest
 * verifies a merge with `computeViewChecksum(merged, itemKey)` (the default
 * content hash), so a tool that declared a custom rowRevision would mismatch the
 * client checksum and force a full refetch (delta-client.ts §"Assumes the
 * server's default content-hash row revision"). The adopted tools don't, so the
 * client round-trip is sound for them — and this test pins that.
 */
function defineSemanticTool(name: string, state: { rows: SemRow[] }): void {
  defineTool({
    name,
    requirePrincipal: false,
    capability: 'test:read',
    args: z.object({}),
    handler: async () => ({ data: state.rows }),
    delta: {
      revision: () => computeViewChecksum(state.rows, semItemKey),
      itemKey: semItemKey,
    },
  });
}

const DEPS: DispatchProjectedDeps = {};
const baseCtx = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'w',
  runId: 'r',
  transport: 'mcp',
  ...over,
});

function parseBody(text: string): unknown {
  const m = /^format: (\w+)\n/.exec(text);
  if (!m) return JSON.parse(text);
  return decode(text.slice(m[0].length), m[1] as ResultFormat);
}

/** Adapt a real server dispatch result into the {@link DeltaResponse} the client observes. */
function toDeltaResponse(result: { content: Array<{ text?: string }>; _meta?: unknown }): DeltaResponse {
  const meta = (result._meta ?? {}) as { delta?: { mode?: string; cursor?: string; checksum?: string } };
  const d = meta.delta ?? { mode: 'full' };
  const text = result.content[0]?.text ?? '';
  if (d.mode === 'not_modified') return { mode: 'not_modified', cursor: d.cursor };
  if (d.mode === 'delta') {
    return { mode: 'delta', cursor: d.cursor, checksum: d.checksum, changes: parseBody(text) as never };
  }
  return { mode: 'full', cursor: d.cursor, rows: parseBody(text) as unknown[] };
}

/** A real in-process dispatch for `name`, threading the negotiated `_meta.delta` verbatim. */
function realDispatch(name: string) {
  return async (requested: string | undefined): Promise<DeltaResponse> => {
    const tool = lookupByMcpName(name)!;
    const r = await dispatchProjectedTool(
      tool,
      name,
      {},
      baseCtx(requested === undefined ? {} : { requestedDelta: requested }),
      DEPS,
    );
    if (!r.ok || !r.result) throw new Error(`dispatch failed: ${r.error?.code}`);
    return toDeltaResponse(r.result as { content: Array<{ text?: string }>; _meta?: unknown });
  };
}

beforeEach(() => setSemanticDeltaEnabledResolver(() => true));
afterEach(() => {
  resetSemanticDeltaEnabledResolver();
  _resetProjectionRegistryForTests();
});

describe('delta client round-trip (BasePresenceTracker + DeltaToolClient ↔ real dispatchProjectedTool)', () => {
  const VIEW = 'sem:roundtrip';

  it('cold read → mode:full, full snapshot reconstructed, base now tracked', async () => {
    const state = { rows: makeSemRows() };
    defineSemanticTool(VIEW, state);
    const tracker = new BasePresenceTracker({ enabled: true });
    const client = new DeltaToolClient();

    const out = await dispatchWithBasePresence(tracker, client, VIEW, semItemKey, realDispatch(VIEW), { wantSemantic: true });
    expect(out.mode).toBe('full');
    expect(sortById(out.rows as SemRow[])).toEqual(sortById(state.rows));
    expect(tracker.haveBase(VIEW)).toBe(true);
  });

  it('unchanged re-read → mode:not_modified, base re-presented from cache (no body replay)', async () => {
    const state = { rows: makeSemRows() };
    defineSemanticTool(VIEW, state);
    const tracker = new BasePresenceTracker({ enabled: true });
    const client = new DeltaToolClient();
    const dispatch = realDispatch(VIEW);

    await dispatchWithBasePresence(tracker, client, VIEW, semItemKey, dispatch, { wantSemantic: true }); // cold full
    const out = await dispatchWithBasePresence(tracker, client, VIEW, semItemKey, dispatch, { wantSemantic: true });
    expect(out.mode).toBe('not_modified');
    // The consumer still gets the full correct view — reconstructed from the cached base, not the wire.
    expect(sortById(out.rows as SemRow[])).toEqual(sortById(state.rows));
  });

  it('mutated re-read → mode:delta, checksum-verified merge reconstructs the new full view', async () => {
    const state = { rows: makeSemRows() };
    defineSemanticTool(VIEW, state);
    const tracker = new BasePresenceTracker({ enabled: true });
    const client = new DeltaToolClient();
    const dispatch = realDispatch(VIEW);

    await dispatchWithBasePresence(tracker, client, VIEW, semItemKey, dispatch, { wantSemantic: true }); // cold full
    // Mutate: update r0 (content change), remove r1, add zz.
    state.rows = [
      { id: 'r0', name: 'row-0-UPDATED-padding-text' },
      ...state.rows.slice(2),
      { id: 'zz', name: 'brand-new-row-padding' },
    ];
    const out = await dispatchWithBasePresence(tracker, client, VIEW, semItemKey, dispatch, { wantSemantic: true });
    expect(out.mode).toBe('delta');
    // The client merged the changes onto its base and the checksum verified — full new view, no refetch.
    expect(sortById(out.rows as SemRow[])).toEqual(sortById(state.rows));
  });

  it('compaction clears the base ⇒ the next read is forced back to full (re-establishes the base)', async () => {
    const state = { rows: makeSemRows() };
    defineSemanticTool(VIEW, state);
    const tracker = new BasePresenceTracker({ enabled: true });
    const client = new DeltaToolClient();
    const dispatch = realDispatch(VIEW);

    await dispatchWithBasePresence(tracker, client, VIEW, semItemKey, dispatch, { wantSemantic: true }); // cold full
    const nm = await dispatchWithBasePresence(tracker, client, VIEW, semItemKey, dispatch, { wantSemantic: true });
    expect(nm.mode).toBe('not_modified'); // base present → no replay

    tracker.onCompaction(); // the turn wrapper compacted history — the model lost the base
    const forced = await dispatchWithBasePresence(tracker, client, VIEW, semItemKey, dispatch, { wantSemantic: true });
    expect(forced.mode).toBe('full'); // forced full re-establishes the base in the model's context
    expect(tracker.haveBase(VIEW)).toBe(true);
  });

  it('out-of-scope harness (enabled:false — external Claude Code/Codex) ⇒ EVERY read is full, never not_modified/delta', async () => {
    const state = { rows: makeSemRows() };
    defineSemanticTool(VIEW, state);
    const tracker = new BasePresenceTracker({ enabled: false });
    const client = new DeltaToolClient();
    const dispatch = realDispatch(VIEW);

    const a = await dispatchWithBasePresence(tracker, client, VIEW, semItemKey, dispatch, { wantSemantic: true });
    const b = await dispatchWithBasePresence(tracker, client, VIEW, semItemKey, dispatch, { wantSemantic: true });
    expect(a.mode).toBe('full');
    expect(b.mode).toBe('full'); // unchanged, but still full — base-presence not asserted out of scope
    expect(tracker.haveBase(VIEW)).toBe(false);
    expect(sortById(b.rows as SemRow[])).toEqual(sortById(state.rows));
  });

  it('GAP-DETECTOR: across a realistic poll loop, re-reads actually engage the no-replay path (not silently always-full)', async () => {
    const state = { rows: makeSemRows() };
    defineSemanticTool(VIEW, state);
    const tracker = new BasePresenceTracker({ enabled: true });
    const client = new DeltaToolClient();
    const dispatch = realDispatch(VIEW);

    const modes: string[] = [];
    // 1 cold + 5 re-reads, mutating on the 4th iteration so a delta must appear.
    for (let i = 0; i < 6; i += 1) {
      if (i === 3) state.rows = [...state.rows, { id: `extra-${i}`, name: 'fresh-row-padding-text' }];
      const out = await dispatchWithBasePresence(tracker, client, VIEW, semItemKey, dispatch, { wantSemantic: true });
      modes.push(out.mode);
      // Every read hands the consumer the correct current view regardless of mode.
      expect(sortById(out.rows as SemRow[])).toEqual(sortById(state.rows));
    }
    expect(modes[0]).toBe('full');
    // The whole point: re-reads must NOT all be full. A regression that disabled the delta
    // path (always-full) would make this fail — the detector the existing tests miss.
    expect(modes.some((m) => m === 'not_modified')).toBe(true);
    expect(modes).toContain('delta');
  });
});
