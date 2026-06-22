/**
 * state-delta — pure per-run snapshot diff/apply (agent-tool-delta-protocol P-009).
 * Adapts the generic delta-protocol engine (Lane B) to the per-run snapshot shape.
 * The load-bearing property is the round-trip: applying the diff of (prev → next)
 * to prev reproduces next exactly, so shipping deltas is behaviour-identical to
 * re-shipping whole snapshots — while a baseVersion/run mismatch fails closed to
 * null (→ the caller refetches the full snapshot).
 */
import { describe, it, expect } from 'vitest';
import { diffSnapshot, applySnapshotDelta } from './state-delta';
import type { OpenCardSnapshot } from './types';
import type { VersionedSnapshot } from './state-channel';

const card = (correlationId: string, extra: Record<string, unknown> = {}): OpenCardSnapshot =>
  ({ correlationId, id: `card:${correlationId}`, ...extra }) as unknown as OpenCardSnapshot;

const snap = (version: number, openCards: OpenCardSnapshot[], toolState?: unknown): VersionedSnapshot => ({
  runId: 'r1',
  version,
  snapshot: { openCards, toolState },
});

describe('diffSnapshot / applySnapshotDelta', () => {
  it('round-trips: apply(prev, diff(prev, next)) deep-equals next', () => {
    const prev = snap(1, [card('a'), card('b', { v: 1 })], { t: 1 });
    const next = snap(2, [card('a'), card('b', { v: 2 }), card('c')], { t: 2 });
    expect(applySnapshotDelta(prev, diffSnapshot(prev, next)!)).toEqual(next);
  });

  it('emits only the cards that changed (add / update), not the unchanged ones', () => {
    const prev = snap(1, [card('a'), card('b', { v: 1 })]);
    const next = snap(2, [card('a'), card('b', { v: 2 }), card('c')]);
    const d = diffSnapshot(prev, next)!;
    const upserted = d.cards.filter((c) => c.change !== 'removed').map((c) => c.id).sort();
    expect(upserted).toEqual(['b', 'c']); // 'a' unchanged → omitted
    expect(d.cards.some((c) => c.change === 'removed')).toBe(false);
    expect(d.order).toEqual(['a', 'b', 'c']);
  });

  it('records removed cards', () => {
    const prev = snap(1, [card('a'), card('b')]);
    const next = snap(2, [card('a')]);
    const d = diffSnapshot(prev, next)!;
    expect(d.cards).toEqual([{ change: 'removed', id: 'b' }]);
    expect(applySnapshotDelta(prev, d)).toEqual(next);
  });

  it('carries toolState only when it changed', () => {
    expect(diffSnapshot(snap(1, [], { x: 1 }), snap(2, [], { x: 1 }))!.toolState).toBeUndefined();
    expect(diffSnapshot(snap(1, [], { x: 1 }), snap(2, [], { x: 2 }))!.toolState).toEqual({ value: { x: 2 } });
  });

  it('handles a pure reorder via `order` without re-shipping cards', () => {
    const prev = snap(1, [card('a'), card('b')]);
    const next = snap(2, [card('b'), card('a')]);
    const d = diffSnapshot(prev, next)!;
    expect(d.cards).toEqual([]); // nothing changed content-wise
    expect(d.order).toEqual(['b', 'a']);
    expect(applySnapshotDelta(prev, d)).toEqual(next);
  });

  it('fails closed to null (→ refetch full) on a baseVersion or runId mismatch', () => {
    const prev = snap(1, [card('a')]);
    const d = diffSnapshot(prev, snap(2, [card('a'), card('b')]))!;
    expect(applySnapshotDelta(snap(5, [card('a')]), d)).toBeNull(); // consumer not at baseVersion
    expect(applySnapshotDelta({ ...prev, runId: 'r2' }, d)).toBeNull(); // wrong run
  });

  it('is insensitive to object-key ordering (no false "updated")', () => {
    const prev = snap(1, [card('a', { x: 1, y: 2 })]);
    const next = snap(2, [card('a', { y: 2, x: 1 })]);
    expect(diffSnapshot(prev, next)!.cards).toEqual([]);
  });
});
