/**
 * Integration tests for ctx.publishState end-to-end through the
 * dispatcher.
 *
 * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md §5
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  dispatchProjectedTool,
  type DispatchProjectedDeps,
} from './dispatch-projected';
import {
  _resetStateChannelForTests,
  closeRun,
  getSnapshot,
  openRun,
} from './state-channel';
import {
  _resetProjectionRegistryForTests,
  type ProjectedTool,
  type UnifiedToolContext,
} from './tool-projection';
import { replayBufferStats, clearAllBuffersForTests } from './replay-buffer';

const MAKE_CTX = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'workspace-S',
  harnessSlug: 'sheets',
  role: 'worker',
  featureId: null,
  chunkId: 'ck_S',
  runId: 'run_S',
  spawnId: 'spw_S',
  parentSpawnId: null,
  ...over,
});

const MAKE_DEPS = (over: Partial<DispatchProjectedDeps> = {}): DispatchProjectedDeps => ({
  readQuotaState: undefined,
  recordInvocation: undefined,
  ...over,
});

const stateSchema = z.object({
  results: z.array(z.string()),
  phase: z.enum(['embedding', 'querying', 'ranking', 'done']),
  progress: z.number().min(0).max(1),
});

function makeStatefulTool(over?: Partial<ProjectedTool>): ProjectedTool {
  return {
    pluginName: 'test',
    description: 'stateful',
    capabilities: [],
    expose: { mcp: { name: 'test:search' } },
    inputSchema: { type: 'object' },
    state: stateSchema,
    fn: async (_input, ctx) => {
      if (!ctx.publishState) {
        return { content: [{ type: 'text', text: 'no-publishState' }] };
      }
      ctx.publishState({ results: [], phase: 'embedding', progress: 0 });
      ctx.publishState({ results: ['hit-1'], phase: 'querying', progress: 0.5 });
      ctx.publishState({ results: ['hit-1', 'hit-2'], phase: 'done', progress: 1 });
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    ...over,
  };
}

describe('ctx.publishState dispatcher integration', () => {
  beforeEach(() => {
    _resetStateChannelForTests();
    _resetProjectionRegistryForTests();
    clearAllBuffersForTests();
  });
  afterEach(() => {
    _resetStateChannelForTests();
    _resetProjectionRegistryForTests();
    clearAllBuffersForTests();
  });

  it('happy-path: snapshots flow through state-channel; final snapshot persists', async () => {
    const tool = makeStatefulTool();
    openRun({ workspaceId: 'workspace-S', runId: 'r-ps' });
    const r = await dispatchProjectedTool(
      tool,
      'test:search',
      {},
      MAKE_CTX({ runId: 'r-ps' }),
      MAKE_DEPS(),
    );
    expect(r.ok).toBe(true);
    const snap = getSnapshot('r-ps')!;
    expect(snap.snapshot.toolState).toEqual({
      results: ['hit-1', 'hit-2'],
      phase: 'done',
      progress: 1,
    });
  });

  it('publishState is NOT installed when ctx lacks runId', async () => {
    const tool = makeStatefulTool();
    const r = await dispatchProjectedTool(
      tool,
      'test:search',
      {},
      MAKE_CTX({ runId: undefined }),
      MAKE_DEPS(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.result.content?.[0] as { text?: string })?.text).toBe('no-publishState');
    }
  });

  it('publishState is NOT installed when tool has no state schema', async () => {
    const tool = makeStatefulTool({ state: undefined });
    const r = await dispatchProjectedTool(
      tool,
      'test:search',
      {},
      MAKE_CTX({ runId: 'r-ps2' }),
      MAKE_DEPS(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.result.content?.[0] as { text?: string })?.text).toBe('no-publishState');
    }
  });

  it('snapshot validation: bad shape rejected at handler call site', async () => {
    const tool: ProjectedTool = {
      pluginName: 'test',
      description: 'bad-state',
      capabilities: [],
      expose: { mcp: { name: 'test:bad' } },
      inputSchema: { type: 'object' },
      state: stateSchema,
      fn: async (_input, ctx) => {
        try {
          // Bad: missing `phase`.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ctx.publishState!({ results: [], progress: 0 } as any);
          return { content: [{ type: 'text', text: 'no-throw' }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `threw:${(e as Error).message.slice(0, 30)}` }] };
        }
      },
    };
    openRun({ workspaceId: 'workspace-S', runId: 'r-bad' });
    const r = await dispatchProjectedTool(
      tool,
      'test:bad',
      {},
      MAKE_CTX({ runId: 'r-bad' }),
      MAKE_DEPS(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.result.content?.[0] as { text?: string })?.text).toMatch(/^threw:/);
    }
  });

  it('M1: JSON-Patch array input rejected in v1 (snapshot-only)', async () => {
    const tool: ProjectedTool = {
      pluginName: 'test',
      description: 'patch',
      capabilities: [],
      expose: { mcp: { name: 'test:patch' } },
      inputSchema: { type: 'object' },
      state: stateSchema,
      fn: async (_input, ctx) => {
        try {
          // Bad: arrays are JSON-Patch shape; v1 rejects.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ctx.publishState!([{ op: 'replace', path: '/phase', value: 'done' }] as any);
          return { content: [{ type: 'text', text: 'no-throw' }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `${(e as Error).message}` }] };
        }
      },
    };
    openRun({ workspaceId: 'workspace-S', runId: 'r-patch' });
    const r = await dispatchProjectedTool(
      tool,
      'test:patch',
      {},
      MAKE_CTX({ runId: 'r-patch' }),
      MAKE_DEPS(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.result.content?.[0] as { text?: string })?.text).toMatch(/snapshot-only/);
    }
  });

  it('M5: state-shaped tools opt OUT of the replay ring buffer at register-time', async () => {
    const tool = makeStatefulTool({
      // Even with replayBufferSize set, the ring buffer is skipped
      // because tool.state is present.
      replayBufferSize: 100,
    });
    // Also emit a 'progress' event so we'd populate a buffer if one existed.
    tool.fn = async (_input, ctx) => {
      ctx.publishState!({ results: [], phase: 'embedding', progress: 0 });
      ctx.emit('progress', { progress: 50, total: 100 });
      return { content: [{ type: 'text', text: 'ok' }] };
    };
    openRun({ workspaceId: 'workspace-S', runId: 'r-m5' });
    await dispatchProjectedTool(
      tool,
      'test:search',
      {},
      MAKE_CTX({ runId: 'r-m5' }),
      MAKE_DEPS(),
    );
    // No ring buffer was created — bufferCount is 0.
    const stats = replayBufferStats();
    expect(stats.bufferCount).toBe(0);
  });

  it('state outlives disconnect: snapshot persists after run-end (5min retention)', async () => {
    const tool = makeStatefulTool();
    openRun({ workspaceId: 'workspace-S', runId: 'r-outlive' });
    const r = await dispatchProjectedTool(
      tool,
      'test:search',
      {},
      MAKE_CTX({ runId: 'r-outlive' }),
      MAKE_DEPS(),
    );
    expect(r.ok).toBe(true);
    // Run is closed by the dispatcher's finally; snapshot remains queryable.
    const snap = getSnapshot('r-outlive');
    expect(snap).not.toBeNull();
    expect(snap!.snapshot.toolState).toBeDefined();
  });
});
