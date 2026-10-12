import { describe, expect, it } from 'vitest';
import { createPhaseTracker, trackPhase, unionCoveredMs } from './phase-tracker';

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('createPhaseTracker', () => {
  it('records each completed phase with its start offset and duration', async () => {
    const c = clock();
    const tracker = createPhaseTracker({ now: c.now });
    c.advance(5);
    await tracker.track('read', async () => { c.advance(40); });
    await tracker.track('shape', () => { c.advance(10); });
    c.advance(5);

    expect(tracker.intervals()).toEqual([
      { phase: 'read', startMs: 5, durationMs: 40 },
      { phase: 'shape', startMs: 45, durationMs: 10 },
    ]);
    const meta = tracker.toMetadata();
    expect(meta).toMatchObject({
      schemaVersion: 'handler-phases-v1',
      unit: 'ms',
      timing: 'wall-time-possibly-concurrent',
      elapsedMs: 60,
      attributedMs: 50,
      pending: [],
      omittedCompletedCount: 0,
    });
  });

  it('records a phase that throws, and rethrows', async () => {
    const c = clock();
    const tracker = createPhaseTracker({ now: c.now });
    await expect(tracker.track('boom', () => { c.advance(7); throw new Error('nope'); })).rejects.toThrow('nope');
    expect(tracker.intervals()).toEqual([{ phase: 'boom', startMs: 0, durationMs: 7 }]);
  });

  it('attributes overlapping phases by their union, not their sum', async () => {
    const c = clock();
    const tracker = createPhaseTracker({ now: c.now });
    let releaseA!: () => void;
    let releaseB!: () => void;
    const a = tracker.track('a', () => new Promise<void>((r) => { releaseA = r; }));
    const b = tracker.track('b', () => new Promise<void>((r) => { releaseB = r; }));
    c.advance(30);
    releaseA();
    await a;
    c.advance(20);
    releaseB();
    await b;

    const meta = tracker.toMetadata()!;
    expect(meta.phases.map((p) => [p.phase, p.durationMs])).toEqual([['a', 30], ['b', 50]]);
    expect(meta.elapsedMs).toBe(50);
    expect(meta.attributedMs).toBe(50); // union, while the durations sum to 80
  });

  it('reports phases still running when the call ends as pending', async () => {
    const c = clock();
    const tracker = createPhaseTracker({ now: c.now });
    void tracker.track('slow-fold', () => new Promise<void>(() => undefined));
    c.advance(1_200);
    const meta = tracker.toMetadata()!;
    expect(meta.phases).toEqual([]);
    expect(meta.pending).toEqual([{ phase: 'slow-fold', startMs: 0, elapsedMs: 1_200 }]);
    expect(meta.attributedMs).toBe(0);
    expect(tracker.snapshot()).toMatchObject({ activePhase: 'slow-fold', activePhaseElapsedMs: 1_200 });
  });

  it('caps history and counts what it dropped', async () => {
    const c = clock();
    const tracker = createPhaseTracker({ now: c.now, historyCap: 2 });
    for (const name of ['one', 'two', 'three']) await tracker.track(name, () => { c.advance(1); });
    expect(tracker.intervals().map((p) => p.phase)).toEqual(['two', 'three']);
    expect(tracker.toMetadata()!.omittedCompletedCount).toBe(1);
    expect(tracker.snapshot().omittedCompletedCount).toBe(1);
  });

  it('returns null metadata when nothing was tracked', () => {
    expect(createPhaseTracker().toMetadata()).toBeNull();
  });

  it('keeps the snapshot shape callers already depend on (no start offsets)', async () => {
    const c = clock();
    const tracker = createPhaseTracker({ now: c.now });
    await tracker.track('x', () => { c.advance(3); });
    expect(tracker.snapshot().completedDurationsMs).toEqual([{ phase: 'x', durationMs: 3 }]);
  });
});

describe('unionCoveredMs', () => {
  it('merges overlaps, skips contained spans, and clips to the limit', () => {
    expect(unionCoveredMs([
      { startMs: 0, durationMs: 10 },
      { startMs: 5, durationMs: 10 },
      { startMs: 6, durationMs: 2 },
      { startMs: 30, durationMs: 100 },
    ], 50)).toBe(15 + 20);
  });

  it('is zero for an empty set', () => {
    expect(unionCoveredMs([], 10)).toBe(0);
  });
});

describe('trackPhase', () => {
  it('records the work as the named phase when a tracker is present', async () => {
    const c = clock();
    const tracker = createPhaseTracker({ now: c.now });
    const value = await trackPhase(tracker, 'list:read', async () => { c.advance(25); return 7; });
    expect(value).toBe(7);
    expect(tracker.intervals()).toEqual([{ phase: 'list:read', startMs: 0, durationMs: 25 }]);
  });

  it('runs the work untracked, with the same result, when no tracker is present', async () => {
    let calls = 0;
    const value = await trackPhase(undefined, 'list:read', () => { calls += 1; return 'rows'; });
    expect(value).toBe('rows');
    expect(calls).toBe(1);
  });

  it('propagates a rejection from the work whether or not a tracker is present', async () => {
    const tracker = createPhaseTracker();
    await expect(trackPhase(tracker, 'boom', () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(trackPhase(undefined, 'boom', () => { throw new Error('y'); })).rejects.toThrow('y');
    expect(tracker.intervals().map((i) => i.phase)).toEqual(['boom']);
  });
});
