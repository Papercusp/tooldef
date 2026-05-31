/**
 * Integration tests for ctx.askUser end-to-end through the dispatcher.
 *
 * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md §4.9
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  dispatchProjectedTool,
  type DispatchProjectedDeps,
} from './dispatch-projected';
import {
  _cardCorrelatorStatsForTests,
  _resetCardCorrelatorForTests,
  resolveCardResponse,
} from './card-correlator';
import { _resetStateChannelForTests, getSnapshot } from './state-channel';
import {
  RESERVED_EVENT_NAMES,
  registerProjectedTool,
  _resetProjectionRegistryForTests,
  type ProjectedTool,
  type UnifiedToolContext,
} from './tool-projection';

const choiceSchema = z.object({ picks: z.array(z.string()).min(1) });

function makeAskTool(): ProjectedTool {
  return {
    pluginName: 'test',
    description: 'ask',
    capabilities: [],
    expose: { mcp: { name: 'test:ask' } },
    inputSchema: { type: 'object' },
    fn: async (_input, ctx) => {
      if (!ctx.askUser) {
        return { content: [{ type: 'text', text: 'no-askUser' }] };
      }
      const r = await ctx.askUser({
        prompt: 'pick one',
        dataSchema: choiceSchema,
        presentation: {
          kind: 'radio',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
        },
      });
      if (r.action === 'submit') {
        return {
          content: [{ type: 'text', text: `picked:${r.payload.picks[0]}` }],
        };
      }
      return { content: [{ type: 'text', text: r.action }] };
    },
  };
}

const MAKE_CTX = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'workspace-Z',
  harnessSlug: 'sheets',
  role: 'worker',
  featureId: null,
  chunkId: 'ck_X',
  runId: 'run_X',
  spawnId: 'spw_X',
  parentSpawnId: null,
  ...over,
});

const MAKE_DEPS = (over: Partial<DispatchProjectedDeps> = {}): DispatchProjectedDeps => ({
  readQuotaState: undefined,
  recordInvocation: undefined,
  ...over,
});

describe('ctx.askUser dispatcher integration', () => {
  beforeEach(() => {
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
    _resetProjectionRegistryForTests();
  });
  afterEach(() => {
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
    _resetProjectionRegistryForTests();
  });

  it('askUser is wired when ctx has workspaceId + runId; resolves on /card-response submit', async () => {
    const tool = makeAskTool();
    const dispatchPromise = dispatchProjectedTool(
      tool,
      'test:ask',
      {},
      MAKE_CTX({ runId: 'r1' }),
      MAKE_DEPS(),
    );

    // Let the handler register the card.
    await new Promise((r) => setTimeout(r, 10));

    const snap = getSnapshot('r1');
    expect(snap).not.toBeNull();
    expect(snap!.snapshot.openCards.length).toBe(1);

    const correlationId = snap!.snapshot.openCards[0].correlationId;
    resolveCardResponse({
      correlationId,
      action: 'submit',
      payload: { picks: ['a'] },
      expectedWorkspaceId: 'workspace-Z',
    });

    const result = await dispatchPromise;
    expect(result.ok).toBe(true);
    if (result.ok && result.result) {
      const c = (result.result.content?.[0] as { text?: string })?.text;
      expect(c).toBe('picked:a');
    }
  });

  it('onCard fires with the freshly-minted correlationId (P-032 — Phase D link hook)', async () => {
    let captured: { correlationId: string; runId: string; workspaceId: string } | null = null;
    const tool: ProjectedTool = {
      pluginName: 'test',
      description: 'ask',
      capabilities: [],
      expose: { mcp: { name: 'test:ask' } },
      inputSchema: { type: 'object' },
      fn: async (_input, ctx) => {
        const r = await ctx.askUser!({
          prompt: 'pick',
          dataSchema: choiceSchema,
          presentation: { kind: 'radio', options: [{ id: 'a', label: 'A' }] },
          onCard: (info) => {
            captured = info;
          },
        });
        return { content: [{ type: 'text', text: r.action }] };
      },
    };
    const dispatchPromise = dispatchProjectedTool(
      tool,
      'test:ask',
      {},
      MAKE_CTX({ runId: 'r-oncard' }),
      MAKE_DEPS(),
    );
    await new Promise((r) => setTimeout(r, 10));
    const snap = getSnapshot('r-oncard');
    const correlationId = snap!.snapshot.openCards[0].correlationId;
    expect(captured).not.toBeNull();
    expect(captured!.correlationId).toBe(correlationId);
    expect(captured!.runId).toBe('r-oncard');
    expect(captured!.workspaceId).toBe('workspace-Z');
    resolveCardResponse({
      correlationId,
      action: 'submit',
      payload: { picks: ['a'] },
      expectedWorkspaceId: 'workspace-Z',
    });
    await dispatchPromise;
  });

  it('askUser is NOT installed when ctx lacks runId — handler sees ctx.askUser undefined', async () => {
    const tool = makeAskTool();
    const result = await dispatchProjectedTool(
      tool,
      'test:ask',
      {},
      MAKE_CTX({ runId: undefined }),
      MAKE_DEPS(),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.result) {
      const c = (result.result.content?.[0] as { text?: string })?.text;
      expect(c).toBe('no-askUser');
    }
  });

  it('askUser resolves cancel when dispatcher aborts the run; pending card cleaned up', async () => {
    // Short timeoutSec drives the dispatcher to abort the run while
    // the handler is awaiting the card — askUser must resolve cancel
    // and the dispatcher's finally block must drop the pending card.
    const tool: ProjectedTool = { ...makeAskTool(), timeoutSec: 0.05 };
    const result = await dispatchProjectedTool(
      tool,
      'test:ask',
      {},
      MAKE_CTX({ runId: 'r-cancel' }),
      MAKE_DEPS(),
    );
    expect(result).toBeDefined();
    expect(_cardCorrelatorStatsForTests().pendingCount).toBe(0);
  });

  it('"card" is a reserved event name (H1)', () => {
    expect(RESERVED_EVENT_NAMES).toContain('card' as never);
  });

  it('a tool declaring events.card throws at register time (H1)', () => {
    const tool: ProjectedTool = {
      pluginName: 'hostile',
      description: 'hostile',
      capabilities: [],
      expose: { mcp: { name: 'hostile:card' } },
      inputSchema: { type: 'object' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      events: { card: z.any() as any },
      fn: async () => ({ content: [] }),
    };
    expect(() => registerProjectedTool(tool)).toThrow(/card/);
  });
});
