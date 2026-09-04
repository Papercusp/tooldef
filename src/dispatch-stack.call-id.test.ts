/**
 * The per-call correlation contract (EI-21548894457555139).
 *
 * A host that opens in-flight state in `onDispatchStart` must be able to close
 * exactly THAT entry in `recordInvocation`. Nothing else in the payload can carry
 * that: runId/spawnId/parentSpawnId are all SESSION-scoped, so two concurrent calls
 * from one agent are indistinguishable without `callId`. These tests pin the three
 * properties a correlating host depends on — same id across the pair, distinct ids
 * across calls, and an id present on the error path too.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDispatchStack } from './dispatch-stack';
import type { DispatchProjectedDeps, DispatchStartEvent } from './dispatch-types';
import {
  _resetProjectionRegistryForTests,
  type ProjectedTool,
  type UnifiedToolContext,
} from './tool-projection';

const MAKE_CTX = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'default',
  harnessSlug: 'sheets',
  role: 'worker',
  featureId: 'F-AUTH-003',
  chunkId: 'ck_X',
  runId: 'run_X',
  spawnId: 'spw_X',
  parentSpawnId: null,
  ...over,
});

const makeTool = (over: Partial<ProjectedTool> = {}): ProjectedTool => ({
  pluginName: 'fixture',
  description: 'fixture',
  inputSchema: { type: 'object' },
  capabilities: [],
  expose: { mcp: { name: 'fix.tool' } },
  fn: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  ...over,
});

/** Capture the callId seen at start and at settle, the way a correlating host would. */
function makeRecordingDeps(): {
  deps: DispatchProjectedDeps;
  starts: DispatchStartEvent[];
  settles: Array<{ callId?: string; status: string }>;
} {
  const starts: DispatchStartEvent[] = [];
  const settles: Array<{ callId?: string; status: string }> = [];
  const deps: DispatchProjectedDeps = {
    onDispatchStart: (e) => {
      starts.push(e);
    },
    recordInvocation: async (i) => {
      settles.push({ callId: i.callId, status: i.status });
    },
  };
  return { deps, starts, settles };
}

afterEach(() => _resetProjectionRegistryForTests());

describe('dispatch callId — start/settle correlation', () => {
  it('hands the SAME callId to onDispatchStart and to recordInvocation', async () => {
    const { deps, starts, settles } = makeRecordingDeps();

    await runDispatchStack(makeTool(), 'fix.tool', {}, MAKE_CTX(), deps);

    expect(starts).toHaveLength(1);
    expect(settles).toHaveLength(1);
    expect(starts[0].callId).toBeTruthy();
    // The whole point: a host can pair these two observations.
    expect(settles[0].callId).toBe(starts[0].callId);
  });

  it('gives concurrent calls to the SAME tool distinct ids', async () => {
    // This is the case session-scoped ids cannot express, and the reason a host
    // cannot settle by (ownerId, toolName): one agent, two overlapping calls to one
    // tool. Without distinct ids the first settle would close the second call's entry.
    const { deps, starts, settles } = makeRecordingDeps();
    const ctx = MAKE_CTX();

    await Promise.all([
      runDispatchStack(makeTool(), 'fix.tool', {}, ctx, deps),
      runDispatchStack(makeTool(), 'fix.tool', {}, ctx, deps),
    ]);

    const startIds = starts.map((s) => s.callId);
    expect(startIds).toHaveLength(2);
    expect(new Set(startIds).size).toBe(2);
    expect(new Set(settles.map((s) => s.callId))).toEqual(new Set(startIds));
  });

  it('still correlates when the handler THROWS — the settle carries the same id', async () => {
    // The error path is where an unclosed entry would be most damaging: a failed call
    // that never settles reads forever as "still running".
    const { deps, starts, settles } = makeRecordingDeps();
    const tool = makeTool({
      fn: async () => {
        throw new Error('boom');
      },
    });

    await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), deps);

    expect(starts).toHaveLength(1);
    expect(settles).toHaveLength(1);
    expect(settles[0].callId).toBe(starts[0].callId);
    expect(settles[0].status).toBe('error');
  });

  it('is optional — a host that omits onDispatchStart still dispatches normally', async () => {
    // callId was added as an OPTIONAL field precisely so no existing host is stranded.
    const settles: Array<{ callId?: string }> = [];
    const deps: DispatchProjectedDeps = {
      recordInvocation: async (i) => {
        settles.push({ callId: i.callId });
      },
    };

    const result = await runDispatchStack(makeTool(), 'fix.tool', {}, MAKE_CTX(), deps);

    expect(result.ok).toBe(true);
    expect(settles).toHaveLength(1);
  });
});
