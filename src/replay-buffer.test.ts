/**
 * Phase 4 T2.2 replay-buffer unit tests.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  openBuffer,
  readBuffer,
  closeBuffer,
  clearAllBuffersForTests,
  clearRingBuffersForWorkspaceSwitch,
  replayBufferStats,
} from './replay-buffer';
import { dispatchWorkspaceSwitch } from './workspace-lifecycle';

beforeEach(() => {
  clearAllBuffersForTests();
});

const ws = 'workspace-A';
const tool = 'demo:stream';

describe('replay-buffer', () => {
  it('opens, pushes, reads back since 0', () => {
    const runId = 'run-A1';
    const w = openBuffer({ workspaceId: ws, toolName: tool, runId, capacity: 100 });
    w.push({ id: 1, name: 'delta', data: 'a' });
    w.push({ id: 2, name: 'delta', data: 'b' });
    w.push({ id: 3, name: 'progress', data: { progress: 50, total: 100 } });
    const out = readBuffer({ workspaceId: ws, toolName: tool, runId, sinceId: 0 });
    expect(out).not.toBeNull();
    expect(out!.length).toBe(3);
    expect(out![0]).toEqual({ id: 1, name: 'delta', data: 'a' });
  });

  it('reads only events with id > sinceId', () => {
    const runId = 'run-A2';
    const w = openBuffer({ workspaceId: ws, toolName: tool, runId, capacity: 100 });
    for (let i = 1; i <= 5; i++) {
      w.push({ id: i, name: 'delta', data: `${i}` });
    }
    const out = readBuffer({ workspaceId: ws, toolName: tool, runId, sinceId: 3 });
    expect(out!.map((e) => e.id)).toEqual([4, 5]);
  });

  it('returns null for an unknown key', () => {
    const out = readBuffer({ workspaceId: ws, toolName: tool, runId: 'never-opened', sinceId: 0 });
    expect(out).toBeNull();
  });

  it('FIFO-evicts when capacity exceeded; calls onEvict for each drop', () => {
    const runId = 'run-A3';
    const evicted: Array<{ id: number; name: string }> = [];
    const w = openBuffer({
      workspaceId: ws,
      toolName: tool,
      runId,
      capacity: 3,
      onEvict: (e) => evicted.push({ id: e.id, name: e.name }),
    });
    for (let i = 1; i <= 5; i++) {
      w.push({ id: i, name: 'delta', data: `${i}` });
    }
    expect(w.count()).toBe(3);
    expect(evicted.map((e) => e.id)).toEqual([1, 2]);
    const out = readBuffer({ workspaceId: ws, toolName: tool, runId, sinceId: 0 });
    expect(out!.map((e) => e.id)).toEqual([3, 4, 5]);
  });

  it('isolates buffers per (workspace, tool, runId) tuple — concurrent calls do not cross-contaminate', () => {
    // Regression test for the reviewer's concurrent-call concern (#4):
    // two simultaneous architect:chat invocations with different runIds
    // must reach distinct buffers.
    const w1 = openBuffer({ workspaceId: ws, toolName: tool, runId: 'run-X', capacity: 10 });
    const w2 = openBuffer({ workspaceId: ws, toolName: tool, runId: 'run-Y', capacity: 10 });
    w1.push({ id: 1, name: 'delta', data: 'from-X' });
    w2.push({ id: 1, name: 'delta', data: 'from-Y' });
    w1.push({ id: 2, name: 'delta', data: 'X-again' });

    const outX = readBuffer({ workspaceId: ws, toolName: tool, runId: 'run-X', sinceId: 0 })!;
    const outY = readBuffer({ workspaceId: ws, toolName: tool, runId: 'run-Y', sinceId: 0 })!;

    expect(outX.map((e) => e.data)).toEqual(['from-X', 'X-again']);
    expect(outY.map((e) => e.data)).toEqual(['from-Y']);
  });

  it('isolates buffers per workspace — cross-workspace read returns null', () => {
    const wA = openBuffer({ workspaceId: 'workspace-A', toolName: tool, runId: 'shared-run', capacity: 10 });
    wA.push({ id: 1, name: 'delta', data: 'in-A' });

    // workspace-B asks for the SAME tool+runId — different key, no buffer.
    const out = readBuffer({ workspaceId: 'workspace-B', toolName: tool, runId: 'shared-run', sinceId: 0 });
    expect(out).toBeNull();
  });

  it('closeBuffer drops the entry — subsequent reads return null', () => {
    const runId = 'run-close';
    const w = openBuffer({ workspaceId: ws, toolName: tool, runId, capacity: 10 });
    w.push({ id: 1, name: 'delta', data: 'a' });
    closeBuffer({ workspaceId: ws, toolName: tool, runId });
    const out = readBuffer({ workspaceId: ws, toolName: tool, runId, sinceId: 0 });
    expect(out).toBeNull();
  });

  it('replayBufferStats reports active buffers and total events', () => {
    const w1 = openBuffer({ workspaceId: ws, toolName: tool, runId: 'r1', capacity: 10 });
    const w2 = openBuffer({ workspaceId: ws, toolName: tool, runId: 'r2', capacity: 10 });
    w1.push({ id: 1, name: 'd', data: '' });
    w1.push({ id: 2, name: 'd', data: '' });
    w2.push({ id: 1, name: 'd', data: '' });
    const stats = replayBufferStats();
    expect(stats.bufferCount).toBe(2);
    expect(stats.totalEvents).toBe(3);
    expect(stats.totalEvicted).toBe(0);
  });

  it('replayBufferStats counts evictions across all buffers', () => {
    const w = openBuffer({ workspaceId: ws, toolName: tool, runId: 'r-evict', capacity: 2 });
    for (let i = 1; i <= 7; i++) {
      w.push({ id: i, name: 'd', data: '' });
    }
    const stats = replayBufferStats();
    expect(stats.totalEvicted).toBe(5);
  });

  it('clearRingBuffersForWorkspaceSwitch drops only the named workspace (H4)', () => {
    const wA = openBuffer({ workspaceId: 'workspace-A', toolName: tool, runId: 'rA', capacity: 10 });
    const wB = openBuffer({ workspaceId: 'workspace-B', toolName: tool, runId: 'rB', capacity: 10 });
    wA.push({ id: 1, name: 'd', data: '' });
    wB.push({ id: 1, name: 'd', data: '' });
    clearRingBuffersForWorkspaceSwitch('workspace-A');
    expect(readBuffer({ workspaceId: 'workspace-A', toolName: tool, runId: 'rA', sinceId: 0 })).toBeNull();
    expect(readBuffer({ workspaceId: 'workspace-B', toolName: tool, runId: 'rB', sinceId: 0 })).not.toBeNull();
  });

  it('subscribes to onWorkspaceSwitch — dispatchWorkspaceSwitch clears workspace buffers (H4)', async () => {
    const w = openBuffer({ workspaceId: 'workspace-A', toolName: tool, runId: 'r-evt', capacity: 10 });
    w.push({ id: 1, name: 'd', data: '' });
    expect(readBuffer({ workspaceId: 'workspace-A', toolName: tool, runId: 'r-evt', sinceId: 0 })).not.toBeNull();
    await dispatchWorkspaceSwitch('workspace-A');
    expect(readBuffer({ workspaceId: 'workspace-A', toolName: tool, runId: 'r-evt', sinceId: 0 })).toBeNull();
  });

  it('re-opens the same buffer when called twice with the same key (defensive idempotency)', () => {
    const runId = 'r-reopen';
    const a = openBuffer({ workspaceId: ws, toolName: tool, runId, capacity: 10 });
    a.push({ id: 1, name: 'd', data: 'first' });

    // Second openBuffer with the same key returns a fresh writer
    // but pushes into the SAME entry.
    const b = openBuffer({ workspaceId: ws, toolName: tool, runId, capacity: 10 });
    b.push({ id: 2, name: 'd', data: 'second' });

    const out = readBuffer({ workspaceId: ws, toolName: tool, runId, sinceId: 0 })!;
    expect(out.map((e) => e.data)).toEqual(['first', 'second']);
  });
});
