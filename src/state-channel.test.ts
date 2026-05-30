import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetStateChannelForTests,
  _stateChannelStatsForTests,
  closeRun,
  dropStateSnapshotsForWorkspaceSwitch,
  getSnapshot,
  openRun,
  setOpenCards,
  setToolState,
  snapshotWorkspace,
  subscribe,
  subscribeWorkspace,
} from './state-channel';
import type { OpenCardSnapshot } from './types';
import { dispatchWorkspaceSwitch } from './workspace-lifecycle';

const ws = 'workspace-X';

function card(id: string): OpenCardSnapshot {
  return {
    correlationId: id,
    prompt: `prompt-${id}`,
    dataSchemaJson: { type: 'object' },
    createdAt: Date.now(),
  };
}

describe('state-channel', () => {
  beforeEach(() => {
    // Note: do NOT reset workspace-lifecycle subscribers. Modules subscribe
    // lazily at first registry() touch; resetting the global subscriber set
    // would unsubscribe sibling modules (replay-buffer, etc.) that imported
    // earlier in the test run. Test isolation is provided by clearing the
    // state-channel's run map only.
    _resetStateChannelForTests();
  });
  afterEach(() => {
    _resetStateChannelForTests();
  });

  it('openRun creates an empty snapshot at version 0', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    const s = getSnapshot('r1');
    expect(s).not.toBeNull();
    expect(s!.version).toBe(0);
    expect(s!.snapshot.openCards).toEqual([]);
  });

  it('setOpenCards bumps version monotonically and re-emits snapshot', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    setOpenCards('r1', [card('a')]);
    setOpenCards('r1', [card('a'), card('b')]);
    setOpenCards('r1', [card('b')]);
    const s = getSnapshot('r1')!;
    expect(s.version).toBe(3);
    expect(s.snapshot.openCards.map((c) => c.correlationId)).toEqual(['b']);
  });

  it('subscribe receives current snapshot immediately, then on every change', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    setOpenCards('r1', [card('a')]);
    const cb = vi.fn();
    const off = subscribe('r1', cb);

    // Initial emit on subscribe.
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].snapshot.openCards.length).toBe(1);

    setOpenCards('r1', [card('a'), card('b')]);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1][0].version).toBe(2);

    off();
    setOpenCards('r1', []);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('subscribe on a non-existent run returns a no-op unsubscribe and never fires', () => {
    const cb = vi.fn();
    const off = subscribe('missing', cb);
    expect(cb).not.toHaveBeenCalled();
    expect(() => off()).not.toThrow();
  });

  it('setToolState merges with openCards (both surfaces share the snapshot)', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    setOpenCards('r1', [card('a')]);
    setToolState('r1', { results: ['hit-1'], phase: 'querying' });
    const s = getSnapshot('r1')!;
    expect(s.snapshot.openCards.map((c) => c.correlationId)).toEqual(['a']);
    expect(s.snapshot.toolState).toEqual({ results: ['hit-1'], phase: 'querying' });
    expect(s.version).toBe(2);
  });

  it('closeRun marks the run; snapshot remains queryable until GC', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    setOpenCards('r1', [card('a')]);
    closeRun('r1');
    // Still queryable — retention window is 5min.
    expect(getSnapshot('r1')).not.toBeNull();
  });

  it('dropStateSnapshotsForWorkspaceSwitch isolates by workspaceId', () => {
    openRun({ workspaceId: 'workspace-A', runId: 'rA' });
    openRun({ workspaceId: 'workspace-B', runId: 'rB' });
    dropStateSnapshotsForWorkspaceSwitch('workspace-A');
    expect(getSnapshot('rA')).toBeNull();
    expect(getSnapshot('rB')).not.toBeNull();
  });

  it('subscribes to onWorkspaceSwitch — dispatch drops scoped snapshots (H4)', async () => {
    openRun({ workspaceId: 'workspace-A', runId: 'rA' });
    openRun({ workspaceId: 'workspace-B', runId: 'rB' });
    await dispatchWorkspaceSwitch('workspace-A');
    expect(getSnapshot('rA')).toBeNull();
    expect(getSnapshot('rB')).not.toBeNull();
  });

  it('subscriber throw is isolated; other subscribers still receive emit', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    subscribe('r1', () => {
      throw new Error('boom');
    });
    const good = vi.fn();
    subscribe('r1', good);

    setOpenCards('r1', [card('a')]);
    // good is called twice: initial subscribe + the setOpenCards mutation.
    expect(good).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('subscribeWorkspace receives every snapshot in the workspace, no initial fire', () => {
    openRun({ workspaceId: 'workspace-A', runId: 'rA1' });
    openRun({ workspaceId: 'workspace-A', runId: 'rA2' });
    openRun({ workspaceId: 'workspace-B', runId: 'rB1' });

    const seen: Array<{ runId: string; ws: string }> = [];
    const off = subscribeWorkspace('workspace-A', (vs, ws) => {
      seen.push({ runId: vs.runId, ws });
    });

    // No initial fire — workspace subs are live-update only.
    expect(seen).toEqual([]);

    setOpenCards('rA1', [card('a1')]);
    setOpenCards('rB1', [card('b1')]); // not in workspace-A; ignored
    setOpenCards('rA2', [card('a2')]);
    setOpenCards('rA1', [card('a1'), card('a1b')]);

    expect(seen.map((s) => s.runId)).toEqual(['rA1', 'rA2', 'rA1']);
    expect(seen.every((s) => s.ws === 'workspace-A')).toBe(true);

    off();
    setOpenCards('rA1', []);
    expect(seen.length).toBe(3); // no more after unsubscribe
  });

  it('snapshotWorkspace returns current state of every run in a workspace', () => {
    openRun({ workspaceId: 'workspace-A', runId: 'rA1' });
    openRun({ workspaceId: 'workspace-A', runId: 'rA2' });
    openRun({ workspaceId: 'workspace-B', runId: 'rB1' });
    setOpenCards('rA1', [card('x')]);
    setOpenCards('rA2', [card('y'), card('z')]);

    const all = snapshotWorkspace('workspace-A');
    expect(all).toHaveLength(2);
    const byRun = Object.fromEntries(all.map((v) => [v.runId, v.snapshot.openCards.length]));
    expect(byRun).toEqual({ rA1: 1, rA2: 2 });

    expect(snapshotWorkspace('workspace-B')).toHaveLength(1);
    expect(snapshotWorkspace('workspace-missing')).toEqual([]);
  });

  it('workspace-switch drops workspace subscribers along with snapshots', () => {
    openRun({ workspaceId: 'workspace-A', runId: 'rA' });
    const fired: number[] = [];
    subscribeWorkspace('workspace-A', () => fired.push(1));
    dropStateSnapshotsForWorkspaceSwitch('workspace-A');
    // After drop, the run is gone — set on a fresh run uses a new
    // snapshot store. The dropped subscriber should NOT fire.
    openRun({ workspaceId: 'workspace-A', runId: 'rA-2' });
    setOpenCards('rA-2', [card('a')]);
    expect(fired).toEqual([]);
  });

  it('audit3: subscriber mutating openCards does NOT corrupt source-of-truth', () => {
    // Pre-fix: subscribers received `vs.snapshot` as a shallow-copied
    // wrapper but the openCards array reference was shared. A buggy
    // subscriber pushing to vs.snapshot.openCards would mutate the
    // registry's entry.snapshot.openCards.
    openRun({ workspaceId: ws, runId: 'r-mut' });
    subscribe('r-mut', (vs) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vs.snapshot.openCards as any).push(card('SHOULDNT-LAND'));
    });
    setOpenCards('r-mut', [card('a')]);
    setOpenCards('r-mut', [card('b')]);
    const final = getSnapshot('r-mut')!;
    // Only the intended setOpenCards call's value is persisted —
    // subscriber's mutation is on the per-emit copy, not the source.
    expect(final.snapshot.openCards.map((c) => c.correlationId)).toEqual(['b']);
  });

  it('throwing workspace subscriber does not block siblings', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    subscribeWorkspace(ws, () => {
      throw new Error('boom');
    });
    const good = vi.fn();
    subscribeWorkspace(ws, good);
    setOpenCards('r1', [card('a')]);
    expect(good).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stats reflect runs and subscribers', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    openRun({ workspaceId: ws, runId: 'r2' });
    subscribe('r1', () => {});
    subscribe('r1', () => {});
    subscribe('r2', () => {});
    const stats = _stateChannelStatsForTests();
    expect(stats.runCount).toBe(2);
    expect(stats.subscriberCount).toBe(3);
  });
});
