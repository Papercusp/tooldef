/**
 * negotiateRowsDelta (agent-tool-delta-client-rollout-2026-06-23 P-006) — the server-side
 * delta negotiation for a sync RESOURCE's rows array. The load-bearing properties: a cold
 * call serves full + mints a cursor; an unchanged view serves an empty delta; a changed view
 * serves changes that the client merges back to the EXACT view (checksum matches); a schema
 * bump invalidates the cursor → full.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { negotiateRowsDelta, DELTA_MAX_EMBEDDED_CURSOR_CHARS } from './rows-delta';
import { applySemanticDelta, computeViewChecksum, decodeDeltaCursor } from './delta-protocol';
import { resetRowDigestStore } from './delta-digest-store';
import { DeltaToolClient } from './delta-client';

const id = (r: unknown) => String((r as { id: string }).id);

describe('negotiateRowsDelta', () => {
  it('cold (no cursor) → full + a cursor that encodes the digest + schema', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const r = negotiateRowsDelta({ cursor: undefined, rows, itemKey: id, itemKeyField: 'id', schemaVersion: 'v1' });
    expect(r.mode).toBe('full');
    expect(r.rows).toBe(rows);
    expect(r.itemKeyField).toBe('id');
    const decoded = decodeDeltaCursor(r.cursor)!;
    expect(decoded.dg).toBeTruthy();
    expect(decoded.sv).toBe('v1');
  });

  it('warm + unchanged → an empty delta (client keeps its base)', () => {
    const rows = [{ id: 'a' }];
    const cold = negotiateRowsDelta({ cursor: undefined, rows, itemKey: id, schemaVersion: 'v1' });
    const warm = negotiateRowsDelta({ cursor: cold.cursor, rows, itemKey: id, schemaVersion: 'v1' });
    expect(warm.mode).toBe('delta');
    expect(warm.changes).toEqual([]);
  });

  it('warm + changed → a delta the client merges back to the exact view', () => {
    const prev = [{ id: 'a' }, { id: 'b' }];
    const next = [{ id: 'b' }, { id: 'c' }]; // a removed, c added
    const cold = negotiateRowsDelta({ cursor: undefined, rows: prev, itemKey: id, schemaVersion: 'v1' });
    const warm = negotiateRowsDelta({ cursor: cold.cursor, rows: next, itemKey: id, schemaVersion: 'v1' });
    expect(warm.mode).toBe('delta');
    const merged = applySemanticDelta(prev, warm.changes!, id);
    expect(new Set(merged.map(id))).toEqual(new Set(['b', 'c']));
    expect(computeViewChecksum(merged, id)).toBe(warm.checksum);
  });

  it('a schema bump invalidates the cursor → full', () => {
    const rows = [{ id: 'a' }];
    const cold = negotiateRowsDelta({ cursor: undefined, rows, itemKey: id, schemaVersion: 'v1' });
    const r = negotiateRowsDelta({ cursor: cold.cursor, rows, itemKey: id, schemaVersion: 'v2' });
    expect(r.mode).toBe('full');
  });

  // no-http-anywhere-2026-07-28 P-024 — THE MEASURED CASE. `plans.list` (933 rows) is over
  // DELTA_MAX_DIGEST_ENTRIES, so the cursor shipped without `dg` and every warm poll re-sent
  // the full ~822 KB (~52 MB/hour per open window), while `plans.attention` (165 rows) got
  // 83x (1,043,340 B → 12,589 B) through this same function. The digest now lives
  // server-side keyed by `viewKey`, so only an id rides the cursor.
  describe('large views (over the digest cap) — P-024', () => {
    afterEach(() => resetRowDigestStore());
    const big = (n: number, tag = 'v') =>
      Array.from({ length: n }, (_, i) => ({ id: `r${i}`, tag: `${tag}${i}` }));

    it('THE FIX: a 933-row view still deltas, sending only the changed rows', () => {
      const prev = big(933);
      const cold = negotiateRowsDelta({ cursor: undefined, rows: prev, itemKey: id, viewKey: 'plans.list:{}' });
      expect(cold.mode).toBe('full');
      // The digest is NOT in the cursor — that was the whole problem — but an id is.
      const decoded = decodeDeltaCursor(cold.cursor)!;
      expect(decoded.dg).toBeUndefined();
      expect(typeof decoded.di).toBe('string');

      const next = [{ id: 'r0', tag: 'EDITED' }, ...prev.slice(2), { id: 'brand-new', tag: 'new' }];
      const warm = negotiateRowsDelta({ cursor: cold.cursor, rows: next, itemKey: id, viewKey: 'plans.list:{}' });

      expect(warm.mode).toBe('delta');
      expect(warm.changes).toHaveLength(3); // 1 updated + 1 removed + 1 added, not 933 rows
      const merged = applySemanticDelta(prev, warm.changes!, id);
      expect(computeViewChecksum(merged, id)).toBe(warm.checksum); // merge reconstructs the view
    });

    it('without a viewKey the old safe behaviour is unchanged (full, no id)', () => {
      const rows = big(933);
      const cold = negotiateRowsDelta({ cursor: undefined, rows, itemKey: id });
      expect(decodeDeltaCursor(cold.cursor)?.di).toBeUndefined();
      const warm = negotiateRowsDelta({ cursor: cold.cursor, rows: big(933, 'x'), itemKey: id });
      expect(warm.mode).toBe('full');
    });

    it('a digest id is bound to its viewKey — another view cannot read it back', () => {
      const rows = big(933);
      const cold = negotiateRowsDelta({ cursor: undefined, rows, itemKey: id, viewKey: 'plans.list:{}' });
      // Same cursor, a DIFFERENT view: the id must not resolve, or diffFromDigest would
      // report this view's ids as `removed` to the other caller.
      const cross = negotiateRowsDelta({
        cursor: cold.cursor,
        rows: big(933, 'other'),
        itemKey: id,
        viewKey: 'workItems.byHarness:{}',
      });
      expect(cross.mode).toBe('full');
    });

    it('a store miss degrades to full and re-parks — recoverable, not the old permanent cliff', () => {
      const rows = big(933);
      const cold = negotiateRowsDelta({ cursor: undefined, rows, itemKey: id, viewKey: 'plans.list:{}' });
      resetRowDigestStore(); // eviction / restart
      const afterMiss = negotiateRowsDelta({
        cursor: cold.cursor,
        rows: big(933, 'x'),
        itemKey: id,
        viewKey: 'plans.list:{}',
      });
      expect(afterMiss.mode).toBe('full');
      // …and the next call deltas again, because the miss re-parked a fresh digest.
      const next = negotiateRowsDelta({
        cursor: afterMiss.cursor,
        rows: [...big(933, 'x'), { id: 'extra', tag: 'e' }],
        itemKey: id,
        viewKey: 'plans.list:{}',
      });
      expect(next.mode).toBe('delta');
      expect(next.changes).toHaveLength(1);
    });

    it('a bounded view still embeds its digest inline (unchanged fast path)', () => {
      const cold = negotiateRowsDelta({ cursor: undefined, rows: big(165), itemKey: id, viewKey: 'plans.attention:{}' });
      const decoded = decodeDeltaCursor(cold.cursor)!;
      expect(Object.keys(decoded.dg ?? {})).toHaveLength(165);
      expect(decoded.di).toBeUndefined();
    });
  });

  it('round-trips through the DeltaToolClient end to end (full then delta)', () => {
    const c = new DeltaToolClient();
    const prev = [{ id: 'a' }, { id: 'b' }];
    const next = [{ id: 'b' }, { id: 'c' }, { id: 'd' }];
    const cold = negotiateRowsDelta({ cursor: undefined, rows: prev, itemKey: id, schemaVersion: 'v1' });
    let ing = c.ingest('plans.attention', { mode: 'full', cursor: cold.cursor, rows: cold.rows! }, id);
    expect(ing.rows).toEqual(prev);
    const warm = negotiateRowsDelta({ cursor: c.cursorFor('plans.attention'), rows: next, itemKey: id, schemaVersion: 'v1' });
    ing = c.ingest('plans.attention', { mode: 'delta', cursor: warm.cursor, checksum: warm.checksum, changes: warm.changes! }, id);
    expect(ing.refetchFull).toBe(false);
    expect(new Set(ing.rows.map(id))).toEqual(new Set(['b', 'c', 'd']));
  });

  /**
   * D-091 dead band. The cursor rides back as a `?delta=` QUERY PARAM, so what breaks is
   * CURSOR BYTES, not the `DELTA_MAX_DIGEST_ENTRIES` row count. Measured live on :3170:
   * 300 rows → 14,591 chars → 200 OK, but 450 rows → 22,207 chars → **HTTP 431**. Views in
   * ~320-500 rows were small enough to embed and too big to send, so the warm poll FAILED
   * outright — worse than the full re-send delta replaces, and invisible to every test here
   * because it fails in the transport, not in this function.
   *
   * The guard: given a viewKey, an over-budget view parks (`di`) instead of embedding (`dg`).
   */
  it('D-091: an over-budget digest PARKS instead of embedding a cursor too large to send', () => {
    const rows = Array.from({ length: 450 }, (_, i) => ({ id: `WI-${i}`, title: 'x'.repeat(40) }));
    const r = negotiateRowsDelta({
      cursor: undefined,
      rows,
      itemKey: id,
      itemKeyField: 'id',
      schemaVersion: 'v1',
      viewKey: 'workItems.byHarness:{"harnessSlug":"papercusp"}',
    });
    expect(r.mode).toBe('full');
    expect(r.cursor.length).toBeLessThanOrEqual(DELTA_MAX_EMBEDDED_CURSOR_CHARS);

    const decoded = decodeDeltaCursor(r.cursor);
    expect(decoded?.dg, 'the digest must NOT be embedded at this size').toBeUndefined();
    expect(decoded?.di, 'it must be parked server-side instead').toBeTruthy();

    // …and the parked digest still deltas correctly — the fix moves WHERE the digest lives,
    // never whether it works. Without this the test would pass on a cursor that simply lost
    // its digest and degraded to full-forever (the P-024 bug, reintroduced).
    const warm = negotiateRowsDelta({
      cursor: r.cursor,
      rows: [...rows.slice(1), { id: 'WI-NEW', title: 'y' }],
      itemKey: id,
      itemKeyField: 'id',
      schemaVersion: 'v1',
      viewKey: 'workItems.byHarness:{"harnessSlug":"papercusp"}',
    });
    expect(warm.mode, `expected a delta, got full (${warm.fullReason})`).toBe('delta');
    expect(warm.changes?.length).toBe(2); // one removed, one added
  });

  /** CONTROL: a genuinely small view still embeds — the fix must not park everything. */
  it('D-091 CONTROL: a small view still embeds its digest in the cursor', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const r = negotiateRowsDelta({
      cursor: undefined,
      rows,
      itemKey: id,
      itemKeyField: 'id',
      schemaVersion: 'v1',
      viewKey: 'tiny:{}',
    });
    expect(decodeDeltaCursor(r.cursor)?.dg).toBeTruthy();
    expect(decodeDeltaCursor(r.cursor)?.di).toBeUndefined();
  });
});
