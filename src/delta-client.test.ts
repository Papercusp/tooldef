/**
 * delta-client — the client-side merge half of the tool-result delta protocol. The
 * load-bearing properties: a delta reconstructs the server's view exactly (round-trip),
 * not_modified replays nothing (returns the cached base), and a merge that diverges from
 * the server checksum NEVER reaches the consumer — it forces a clean full refetch.
 */
import { describe, it, expect } from 'vitest';
import { computeRowDigest, diffFromDigest, computeViewChecksum, type DeltaChange } from './delta-protocol';
import { DeltaToolClient, dispatchWithDelta, dispatchWithConveyedDelta } from './delta-client';

const itemKey = (r: unknown) => (r as { id: string }).id;
const row = (id: string, v = 1) => ({ id, v });

describe('DeltaToolClient', () => {
  it('a cold view has no cursor', () => {
    expect(new DeltaToolClient().cursorFor('v')).toBeUndefined();
  });

  it('full caches the rows + cursor and returns them', () => {
    const c = new DeltaToolClient();
    const rows = [row('a'), row('b')];
    expect(c.ingest('v', { mode: 'full', cursor: 'c1', rows }, itemKey)).toEqual({ rows, refetchFull: false });
    expect(c.cursorFor('v')).toBe('c1');
  });

  it('not_modified returns the cached base (no replay) + bumps the cursor', () => {
    const c = new DeltaToolClient();
    const rows = [row('a')];
    c.ingest('v', { mode: 'full', cursor: 'c1', rows }, itemKey);
    expect(c.ingest('v', { mode: 'not_modified', cursor: 'c2' }, itemKey)).toEqual({ rows, refetchFull: false });
    expect(c.cursorFor('v')).toBe('c2');
  });

  it('delta merges onto the base + checksum-verifies — reconstructs next exactly', () => {
    const c = new DeltaToolClient();
    const prev = [row('a'), row('b', 1), row('c')];
    const next = [row('b', 2), row('c'), row('d')]; // a removed, b updated, d added
    c.ingest('v', { mode: 'full', cursor: 'c1', rows: prev }, itemKey);

    const changes = diffFromDigest(computeRowDigest(prev, itemKey)!, next, itemKey);
    const checksum = computeViewChecksum(next, itemKey);
    const out = c.ingest('v', { mode: 'delta', cursor: 'c2', checksum, changes }, itemKey);

    expect(out.refetchFull).toBe(false);
    expect(new Set(out.rows.map(itemKey))).toEqual(new Set(next.map(itemKey)));
    expect(out.rows.find((r) => itemKey(r) === 'b')).toEqual(row('b', 2));
    expect(c.cursorFor('v')).toBe('c2');
  });

  it('a merge that diverges from the server checksum forces a full refetch (no wrong view reaches the model)', () => {
    const c = new DeltaToolClient();
    c.ingest('v', { mode: 'full', cursor: 'c1', rows: [row('a')] }, itemKey);
    const changes = [{ change: 'added', id: 'b', data: row('b') }] as DeltaChange[];
    const out = c.ingest('v', { mode: 'delta', cursor: 'c2', checksum: 'BOGUS-CHECKSUM', changes }, itemKey);
    expect(out.refetchFull).toBe(true);
    expect(c.size).toBe(0); // base dropped → next call is a cold full
  });

  it('a delta / not_modified with no retained base asks for a full refetch', () => {
    const c = new DeltaToolClient();
    expect(c.ingest('v', { mode: 'delta', changes: [] }, itemKey).refetchFull).toBe(true);
    expect(c.ingest('w', { mode: 'not_modified' }, itemKey).refetchFull).toBe(true);
  });
});

describe('dispatchWithDelta', () => {
  it('cold call dispatches a full (no cursor), caches it, returns mode full', async () => {
    const c = new DeltaToolClient();
    const seen: (string | undefined)[] = [];
    const out = await dispatchWithDelta(c, 'v', itemKey, async (cur) => {
      seen.push(cur);
      return { mode: 'full', cursor: 'c1', rows: [row('a')] };
    });
    expect(out).toEqual({ rows: [row('a')], mode: 'full' });
    expect(seen).toEqual([undefined]);
    expect(c.cursorFor('v')).toBe('c1');
  });

  it('repeat call sends the cursor and applies a delta', async () => {
    const c = new DeltaToolClient();
    c.ingest('v', { mode: 'full', cursor: 'c1', rows: [row('a'), row('b')] }, itemKey);
    const checksum = computeViewChecksum([row('b'), row('c')], itemKey);
    const out = await dispatchWithDelta(c, 'v', itemKey, async (cur) => {
      expect(cur).toBe('c1');
      return {
        mode: 'delta',
        cursor: 'c2',
        checksum,
        changes: [
          { change: 'added', id: 'c', data: row('c') },
          { change: 'removed', id: 'a' },
        ] as DeltaChange[],
      };
    });
    expect(out.mode).toBe('delta');
    expect(new Set(out.rows.map(itemKey))).toEqual(new Set(['b', 'c']));
  });

  it('a mismatched delta re-dispatches WITHOUT a cursor (full refetch) → correct view, never a wrong merge', async () => {
    const c = new DeltaToolClient();
    c.ingest('v', { mode: 'full', cursor: 'c1', rows: [row('a')] }, itemKey);
    const cursors: (string | undefined)[] = [];
    const out = await dispatchWithDelta(c, 'v', itemKey, async (cur) => {
      cursors.push(cur);
      if (cur === 'c1') {
        return { mode: 'delta', cursor: 'c2', checksum: 'BOGUS', changes: [{ change: 'added', id: 'b', data: row('b') }] as DeltaChange[] };
      }
      return { mode: 'full', cursor: 'c3', rows: [row('a'), row('b'), row('c')] };
    });
    expect(cursors).toEqual(['c1', undefined]);
    expect(out.mode).toBe('full');
    expect(new Set(out.rows.map(itemKey))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('not_modified returns the cached base', async () => {
    const c = new DeltaToolClient();
    c.ingest('v', { mode: 'full', cursor: 'c1', rows: [row('a')] }, itemKey);
    const out = await dispatchWithDelta(c, 'v', itemKey, async () => ({ mode: 'not_modified', cursor: 'c2' }));
    expect(out).toEqual({ rows: [row('a')], mode: 'not_modified' });
  });
});

describe('dispatchWithConveyedDelta (out-of-process / proxy)', () => {
  const slug = (r: unknown) => (r as { slug: string }).slug;
  const id = (r: unknown) => (r as { id: string }).id;

  it('learns itemKeyField from the full response, then merges a delta with it', async () => {
    const c = new DeltaToolClient();
    const fields = new Map<string, string>();
    let out = await dispatchWithConveyedDelta(c, fields, 'v', async (cur) => {
      expect(cur).toBeUndefined();
      return { mode: 'full', cursor: 'c1', rows: [{ slug: 'a' }, { slug: 'b' }], itemKeyField: 'slug' };
    });
    expect(out.mode).toBe('full');
    expect(fields.get('v')).toBe('slug');

    const checksum = computeViewChecksum([{ slug: 'b' }, { slug: 'c' }], slug);
    out = await dispatchWithConveyedDelta(c, fields, 'v', async (cur) => {
      expect(cur).toBe('c1');
      return {
        mode: 'delta',
        cursor: 'c2',
        checksum,
        changes: [
          { change: 'added', id: 'c', data: { slug: 'c' } },
          { change: 'removed', id: 'a' },
        ] as DeltaChange[],
      };
    });
    expect(out.mode).toBe('delta');
    expect(new Set(out.rows.map(slug))).toEqual(new Set(['b', 'c']));
  });

  it('refetches full on a checksum mismatch (no wrong merge reaches the proxy consumer)', async () => {
    const c = new DeltaToolClient();
    c.ingest('v', { mode: 'full', cursor: 'c1', rows: [{ id: 'a' }] }, id);
    const fields = new Map<string, string>([['v', 'id']]);
    const cursors: (string | undefined)[] = [];
    const out = await dispatchWithConveyedDelta(c, fields, 'v', async (cur) => {
      cursors.push(cur);
      if (cur === 'c1') {
        return { mode: 'delta', cursor: 'c2', checksum: 'BOGUS', changes: [{ change: 'added', id: 'b', data: { id: 'b' } }] as DeltaChange[] };
      }
      return { mode: 'full', cursor: 'c3', rows: [{ id: 'a' }, { id: 'b' }], itemKeyField: 'id' };
    });
    expect(cursors).toEqual(['c1', undefined]);
    expect(out.mode).toBe('full');
    expect(new Set(out.rows.map(id))).toEqual(new Set(['a', 'b']));
  });
});
