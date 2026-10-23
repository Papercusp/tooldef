/**
 * Integration tests for ctx.askUser end-to-end through the dispatcher.
 *
 * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md §4.9
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CardResponse } from './types';

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
  interactiveCardCapability: true,
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

  it('askUser is wired when ctx proves an interactive responder; resolves on /card-response submit', async () => {
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

  it('awaits durable preparation before publishing a card, using the same identity', async () => {
    let prepared!: { correlationId: string; runId: string; workspaceId: string };
    let finish!: () => void;
    const committed = new Promise<void>(resolve => { finish = resolve; });
    const onCard = vi.fn();
    const tool: ProjectedTool = { ...makeAskTool(), timeoutSec: 2, fn: async (_input, ctx) => {
      const response = await ctx.askUser!({ prompt: 'persist first', dataSchema: choiceSchema,
        beforeCard: async info => { prepared = info; await committed; }, onCard });
      return { content: [{ type: 'text', text: response.action }] };
    } };
    const running = dispatchProjectedTool(tool, 'test:ask', {}, MAKE_CTX({ runId: 'durable' }), MAKE_DEPS());
    await vi.waitFor(() => expect(prepared).toBeDefined());
    expect(getSnapshot('durable')?.snapshot.openCards ?? []).toEqual([]);
    expect(onCard).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(onCard).toHaveBeenCalledWith(prepared));
    expect(getSnapshot('durable')!.snapshot.openCards[0].correlationId).toBe(prepared.correlationId);
    resolveCardResponse({ correlationId: prepared.correlationId, action: 'submit', payload: { picks: ['a'] },
      expectedWorkspaceId: 'workspace-Z' });
    expect((await running).ok).toBe(true);
  });

  it('failed durable preparation publishes no card and does not run the best-effort link hook', async () => {
    const onCard = vi.fn();
    const tool: ProjectedTool = { ...makeAskTool(), timeoutSec: 0.1, fn: async (_input, ctx) => {
      await ctx.askUser!({ prompt: 'persist first', dataSchema: choiceSchema,
        beforeCard: async () => { throw new Error('storage-unavailable'); }, onCard });
      return { content: [] };
    } };
    const result = await dispatchProjectedTool(tool, 'test:ask', {}, MAKE_CTX({ runId: 'failed-prepare' }), MAKE_DEPS());
    expect(result.ok).toBe(false);
    expect(getSnapshot('failed-prepare')?.snapshot.openCards ?? []).toEqual([]);
    expect(onCard).not.toHaveBeenCalled();
    expect(_cardCorrelatorStatsForTests().pendingCount).toBe(0);
  });

  it('abort during durable preparation never publishes the late committed identity', async () => {
    let finish!: () => void;
    const committed = new Promise<void>(resolve => { finish = resolve; });
    const beforeCard = vi.fn(async () => { await committed; });
    const onCard = vi.fn();
    const abort = new AbortController();
    const tool: ProjectedTool = { ...makeAskTool(), fn: async (_input, ctx) => {
      await ctx.askUser!({ prompt: 'persist first', dataSchema: choiceSchema, beforeCard, onCard });
      return { content: [] };
    } };
    const running = dispatchProjectedTool(tool, 'test:ask', {},
      MAKE_CTX({ runId: 'abort-prepare', signal: abort.signal }), MAKE_DEPS());
    await vi.waitFor(() => expect(beforeCard).toHaveBeenCalledOnce());
    abort.abort();
    finish();
    await running;
    expect(onCard).not.toHaveBeenCalled();
    expect(getSnapshot('abort-prepare')?.snapshot.openCards ?? []).toEqual([]);
    expect(_cardCorrelatorStatsForTests().pendingCount).toBe(0);
  });

  it('awaits committed cancellation when the dispatcher aborts a published durable card', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const commitResponse = vi.fn(async (response: CardResponse) => { await gate; return { accepted: true, response }; });
    const abort = new AbortController();
    const onCard = vi.fn();
    let handlerSettled = false;
    const tool: ProjectedTool = { ...makeAskTool(), fn: async (_input, ctx) => {
      await ctx.askUser!({ prompt: 'persist cancellation', dataSchema: choiceSchema,
        beforeCard: async () => {}, commitResponse, onCard });
      handlerSettled = true;
      return { content: [] };
    } };
    const running = dispatchProjectedTool(tool, 'test:ask', {},
      MAKE_CTX({ runId: 'durable-abort', signal: abort.signal }), MAKE_DEPS());
    await vi.waitFor(() => expect(onCard).toHaveBeenCalledOnce());
    abort.abort();
    await vi.waitFor(() => expect(commitResponse).toHaveBeenCalledOnce());
    expect(handlerSettled).toBe(false);
    expect(getSnapshot('durable-abort')?.snapshot.openCards).toHaveLength(1);
    finish();
    await running;
    expect(handlerSettled).toBe(true);
    expect(commitResponse).toHaveBeenCalledWith({ action: 'cancel' },
      expect.objectContaining({ runId: 'durable-abort', workspaceId: 'workspace-Z' }), 'abort');
    expect(_cardCorrelatorStatsForTests().pendingCount).toBe(0);
  });

  it('commits cancellation after an abort during preparation before returning without publication', async () => {
    let finishPrepare!: () => void;
    const prepared = new Promise<void>(resolve => { finishPrepare = resolve; });
    const beforeCard = vi.fn(async () => { await prepared; });
    let finishCancel!: () => void;
    const cancelled = new Promise<void>(resolve => { finishCancel = resolve; });
    const commitResponse = vi.fn(async (response: CardResponse) => { await cancelled; return { accepted: true, response }; });
    const onCard = vi.fn();
    const abort = new AbortController();
    let handlerSettled = false;
    const tool: ProjectedTool = { ...makeAskTool(), fn: async (_input, ctx) => {
      await ctx.askUser!({ prompt: 'persist first', dataSchema: choiceSchema, beforeCard, commitResponse, onCard });
      handlerSettled = true;
      return { content: [] };
    } };
    const running = dispatchProjectedTool(tool, 'test:ask', {},
      MAKE_CTX({ runId: 'durable-prepare-abort', signal: abort.signal }), MAKE_DEPS());
    await vi.waitFor(() => expect(beforeCard).toHaveBeenCalledOnce());
    abort.abort();
    finishPrepare();
    await vi.waitFor(() => expect(commitResponse).toHaveBeenCalledOnce());
    expect(handlerSettled).toBe(false);
    expect(onCard).not.toHaveBeenCalled();
    expect(getSnapshot('durable-prepare-abort')?.snapshot.openCards ?? []).toEqual([]);
    finishCancel();
    await running;
    expect(handlerSettled).toBe(true);
    expect(onCard).not.toHaveBeenCalled();
    expect(_cardCorrelatorStatsForTests().pendingCount).toBe(0);
  });

  it('completed idempotency hit skips durable preparation and republishes no card', async () => {
    const beforeCard = vi.fn(async () => {});
    const onCard = vi.fn();
    const tool: ProjectedTool = { ...makeAskTool(), fn: async (_input, ctx) => {
      const spec = { prompt: 'persist once', dataSchema: choiceSchema, beforeCard, onCard, idempotencyKey: 'same' };
      const a = await ctx.askUser!(spec);
      const b = await ctx.askUser!(spec);
      expect(b).toEqual(a);
      return { content: [] };
    } };
    const running = dispatchProjectedTool(tool, 'test:ask', {}, MAKE_CTX({ runId: 'cached-prepare' }), MAKE_DEPS());
    await vi.waitFor(() => expect(onCard).toHaveBeenCalledOnce());
    const correlationId = getSnapshot('cached-prepare')!.snapshot.openCards[0].correlationId;
    resolveCardResponse({ correlationId, action: 'submit', payload: { picks: ['a'] }, expectedWorkspaceId: 'workspace-Z' });
    expect((await running).ok).toBe(true);
    expect(beforeCard).toHaveBeenCalledOnce();
    expect(onCard).toHaveBeenCalledOnce();
    expect(_cardCorrelatorStatsForTests().pendingCount).toBe(0);
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

  it('askUser is NOT installed when ctx lacks the interactive-card capability', async () => {
    const tool = makeAskTool();
    const result = await dispatchProjectedTool(
      tool,
      'test:ask',
      {},
      MAKE_CTX({ interactiveCardCapability: undefined }),
      MAKE_DEPS(),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.result) {
      const c = (result.result.content?.[0] as { text?: string })?.text;
      expect(c).toBe('no-askUser');
    }
    expect(getSnapshot('run_X')).toBeNull();
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
