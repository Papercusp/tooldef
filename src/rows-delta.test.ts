/**
 * negotiateRowsDelta (agent-tool-delta-client-rollout-2026-06-23 P-006) — the server-side
 * delta negotiation for a sync RESOURCE's rows array. The load-bearing properties: a cold
 * call serves full + mints a cursor; an unchanged view serves an empty delta; a changed view
 * serves changes that the client merges back to the EXACT view (checksum matches); a schema
 * bump invalidates the cursor → full.
 */
import { describe, it, expect } from 'vitest';
import { negotiateRowsDelta } from './rows-delta';
import { applySemanticDelta, computeViewChecksum, decodeDeltaCursor } from './delta-protocol';
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
});
