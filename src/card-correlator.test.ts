import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CardResponse } from './types';

import {
  _cardCorrelatorStatsForTests,
  _resetCardCorrelatorForTests,
  cancelPendingCardsForRun,
  cancelPendingCardsForWorkspaceSwitch,
  registerCard,
  resolveCardResponse,
  resolveCardResponseAsync,
  deliverCommittedCardResponse,
} from './card-correlator';
import {
  _resetStateChannelForTests,
  getSnapshot,
  openRun,
} from './state-channel';
import { dispatchWorkspaceSwitch } from './workspace-lifecycle';

const ws = 'workspace-A';

const choiceSchema = z.object({
  picks: z.array(z.string()).min(1),
});

describe('card-correlator', () => {
  beforeEach(() => {
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
  });

  it('awaits the durable response commit before acknowledging or settling the waiter', async () => {
    openRun({ workspaceId: ws, runId: 'durable' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const commitResponse = vi.fn(async (response: CardResponse) => { await gate; return { accepted: true, response }; });
    const { correlationId, result } = registerCard({ workspaceId: ws, runId: 'durable',
      spec: { prompt: 'choose', dataSchema: choiceSchema, commitResponse } });
    let delivered = false;
    void result.then(() => { delivered = true; });
    const opts = { correlationId, action: 'submit' as const, payload: { picks: ['a'] }, expectedWorkspaceId: ws };
    expect(resolveCardResponse(opts)).toMatchObject({ ok: false, status: 409 });
    expect(commitResponse).not.toHaveBeenCalled();
    let acknowledged = false;
    const answer = resolveCardResponseAsync(opts).then(value => { acknowledged = true; return value; });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(delivered).toBe(false);
    expect(getSnapshot('durable')!.snapshot.openCards).toHaveLength(1);
    expect(commitResponse).toHaveBeenCalledWith({ action: 'submit', payload: { picks: ['a'] } },
      { correlationId, workspaceId: ws, runId: 'durable' }, 'response');
    release();
    expect(await answer).toEqual({ ok: true });
    expect(await result).toEqual({ action: 'submit', payload: { picks: ['a'] } });
    expect(getSnapshot('durable')!.snapshot.openCards).toEqual([]);
  });

  it('validates scope and schema before invoking the durable response writer', async () => {
    const commitResponse = vi.fn(async (response: CardResponse) => ({ accepted: true, response }));
    const { correlationId } = registerCard({ workspaceId: ws, runId: 'validation',
      spec: { prompt: 'choose', dataSchema: choiceSchema, allowDecline: false, commitResponse } });
    expect(await resolveCardResponseAsync({ correlationId, action: 'submit', payload: { picks: [] } }))
      .toMatchObject({ ok: false, status: 400 });
    expect(await resolveCardResponseAsync({ correlationId, action: 'decline' })).toMatchObject({ ok: false, status: 400 });
    expect(await resolveCardResponseAsync({ correlationId, action: 'cancel', expectedWorkspaceId: 'foreign' }))
      .toMatchObject({ ok: false, status: 404 });
    expect(commitResponse).not.toHaveBeenCalled();
  });

  it('leaves an unknown response commit pending and accepts only a scoped committed delivery', async () => {
    const commitResponse = vi.fn(async () => { throw new Error('ack-lost'); });
    const { correlationId, result } = registerCard({ workspaceId: ws, runId: 'recovery',
      spec: { prompt: 'choose', dataSchema: choiceSchema, commitResponse } });
    expect(await resolveCardResponseAsync({ correlationId, action: 'submit', payload: { picks: ['a'] } }))
      .toMatchObject({ ok: false, status: 503 });
    expect(_cardCorrelatorStatsForTests().pendingCount).toBe(1);
    const delivery = { correlationId, runId: 'recovery', workspaceId: ws,
      response: { action: 'submit' as const, payload: { picks: ['a'] } } };
    for (const wrong of [{ ...delivery, runId: 'foreign' }, { ...delivery, workspaceId: 'foreign' }]) {
      expect(deliverCommittedCardResponse(wrong)).toMatchObject({ ok: false, status: 404 });
    }
    expect(deliverCommittedCardResponse({ ...delivery, response: { action: 'submit' } as CardResponse }))
      .toMatchObject({ ok: false, status: 400 });
    expect(deliverCommittedCardResponse(delivery)).toEqual({ ok: true });
    expect(await result).toEqual(delivery.response);
    expect(commitResponse).toHaveBeenCalledOnce();
  });

  it('delivers the exact committed schema output without applying input transforms again', async () => {
    let transforms = 0;
    const schema = z.preprocess(value => {
      transforms++;
      return { picks: choiceSchema.parse(value).picks.map(pick => `${pick}-normalized`) };
    }, choiceSchema);
    const commitResponse = async (response: CardResponse) => ({ accepted: true, response });
    const first = registerCard({ workspaceId: ws, runId: 'transform',
      spec: { prompt: 'choose', dataSchema: schema, commitResponse } });
    expect(await resolveCardResponseAsync({ correlationId: first.correlationId, action: 'submit', payload: { picks: ['a'] } }))
      .toEqual({ ok: true });
    const committed = { action: 'submit' as const, payload: { picks: ['a-normalized'] } };
    expect(await first.result).toEqual(committed);
    expect(transforms).toBe(1);
    const recovered = registerCard({ workspaceId: ws, runId: 'transform',
      spec: { prompt: 'choose', dataSchema: schema, commitResponse } });
    expect(deliverCommittedCardResponse({ correlationId: recovered.correlationId,
      workspaceId: ws, runId: 'transform', response: committed })).toEqual({ ok: true });
    expect(await recovered.result).toEqual(committed);
    expect(transforms).toBe(1);
  });

  it('refuses a losing response while delivering the actual committed winner', async () => {
    const winner = { action: 'submit' as const, payload: { picks: ['b'] } };
    const { correlationId, result } = registerCard({ workspaceId: ws, runId: 'loser',
      spec: { prompt: 'choose', dataSchema: choiceSchema,
        commitResponse: async () => ({ accepted: false, response: winner }) } });
    expect(await resolveCardResponseAsync({ correlationId, action: 'submit', payload: { picks: ['a'] } }))
      .toMatchObject({ ok: false, status: 409 });
    expect(await result).toEqual(winner);
  });

  it('does not settle timeout cancellation before its commit and preserves a winning answer', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const winner = { action: 'submit' as const, payload: { picks: ['b'] } };
    const commitResponse = vi.fn(async () => { await gate; return { accepted: false, response: winner }; });
    const { correlationId, result } = registerCard({ workspaceId: ws, runId: 'timeout',
      spec: { prompt: 'choose', dataSchema: choiceSchema, timeoutMs: 100, commitResponse } });
    let delivered = false;
    void result.then(() => { delivered = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(delivered).toBe(false);
    expect(_cardCorrelatorStatsForTests().pendingCount).toBe(1);
    expect(commitResponse).toHaveBeenCalledWith({ action: 'cancel' },
      { correlationId, runId: 'timeout', workspaceId: ws }, 'timeout');
    release();
    expect(await result).toEqual(winner);
  });

  it.each(['abort', 'run-end', 'workspace-switch'] as const)('rejects %s cleanup when cancellation storage fails', async origin => {
    const commitResponse = vi.fn(async (_response: CardResponse, _info: unknown, _origin: string) => {
      throw new Error('cancel-write-failed');
    });
    const { result } = registerCard({ workspaceId: ws, runId: 'failure',
      spec: { prompt: 'choose', dataSchema: choiceSchema, commitResponse } });
    const rejected = expect(result).rejects.toThrow('cancel-write-failed');
    if (origin === 'workspace-switch') cancelPendingCardsForWorkspaceSwitch(ws);
    else cancelPendingCardsForRun('failure', origin);
    await rejected;
    expect(commitResponse).toHaveBeenCalledOnce();
    expect(commitResponse.mock.calls[0][2]).toBe(origin);
    expect(_cardCorrelatorStatsForTests().pendingCount).toBe(0);
  });

  it('registerCard publishes the card into the state-channel snapshot', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    const { correlationId } = registerCard({
      workspaceId: ws,
      runId: 'r1',
      spec: { prompt: 'choose', dataSchema: choiceSchema },
    });
    const snap = getSnapshot('r1')!;
    expect(snap.snapshot.openCards.length).toBe(1);
    expect(snap.snapshot.openCards[0].correlationId).toBe(correlationId);
    expect(snap.snapshot.openCards[0].prompt).toBe('choose');
    expect(snap.snapshot.openCards[0].dataSchemaJson).toBeDefined();
  });

  it('resolveCardResponse submit validates against dataSchema and resolves the deferred', async () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    const { correlationId, result } = registerCard({
      workspaceId: ws,
      runId: 'r1',
      spec: { prompt: 'choose', dataSchema: choiceSchema },
    });
    const ok = resolveCardResponse({
      correlationId,
      action: 'submit',
      payload: { picks: ['option-1'] },
      expectedWorkspaceId: ws,
    });
    expect(ok).toEqual({ ok: true });
    const r = await result;
    expect(r).toEqual({ action: 'submit', payload: { picks: ['option-1'] } });
    expect(getSnapshot('r1')!.snapshot.openCards).toEqual([]);
  });

  it('resolveCardResponse rejects payload that fails Zod validation with 400', async () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    const { correlationId, result } = registerCard({
      workspaceId: ws,
      runId: 'r1',
      spec: { prompt: 'choose', dataSchema: choiceSchema },
    });
    const ok = resolveCardResponse({
      correlationId,
      action: 'submit',
      payload: { picks: [] }, // violates min(1)
      expectedWorkspaceId: ws,
    });
    expect(ok.ok).toBe(false);
    if (!ok.ok) {
      expect(ok.status).toBe(400);
      expect(ok.details).toBeDefined();
    }
    // Card remains pending; deferred unresolved.
    expect(_cardCorrelatorStatsForTests().pendingCount).toBe(1);
  });

  it('resolveCardResponse decline path resolves with action:decline', async () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    const { correlationId, result } = registerCard({
      workspaceId: ws,
      runId: 'r1',
      spec: { prompt: 'choose', dataSchema: choiceSchema },
    });
    resolveCardResponse({
      correlationId,
      action: 'decline',
      reason: 'not relevant',
      expectedWorkspaceId: ws,
    });
    expect(await result).toEqual({ action: 'decline', reason: 'not relevant' });
  });

  it('resolveCardResponse decline is rejected when allowDecline:false', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    const { correlationId } = registerCard({
      workspaceId: ws,
      runId: 'r1',
      spec: { prompt: 'choose', dataSchema: choiceSchema, allowDecline: false },
    });
    const ok = resolveCardResponse({
      correlationId,
      action: 'decline',
      expectedWorkspaceId: ws,
    });
    expect(ok.ok).toBe(false);
    if (!ok.ok) expect(ok.status).toBe(400);
  });

  it('resolveCardResponse 404 when correlationId is unknown', () => {
    const ok = resolveCardResponse({
      correlationId: 'nope',
      action: 'submit',
      payload: { picks: ['x'] },
    });
    expect(ok.ok).toBe(false);
    if (!ok.ok) expect(ok.status).toBe(404);
  });

  it('resolveCardResponse returns 404 (not 403) on workspace mismatch — defense in depth', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    const { correlationId } = registerCard({
      workspaceId: ws,
      runId: 'r1',
      spec: { prompt: 'choose', dataSchema: choiceSchema },
    });
    const ok = resolveCardResponse({
      correlationId,
      action: 'submit',
      payload: { picks: ['x'] },
      expectedWorkspaceId: 'other-ws',
    });
    expect(ok.ok).toBe(false);
    if (!ok.ok) expect(ok.status).toBe(404);
  });

  it('timeoutMs resolves with action:cancel and drops from PENDING', async () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    const { result } = registerCard({
      workspaceId: ws,
      runId: 'r1',
      spec: { prompt: 'choose', dataSchema: choiceSchema, timeoutMs: 50 },
    });
    expect(_cardCorrelatorStatsForTests().pendingCount).toBe(1);
    const r = await result;
    expect(r).toEqual({ action: 'cancel' });
    expect(_cardCorrelatorStatsForTests().pendingCount).toBe(0);
  });

  it('cancelPendingCardsForRun resolves every open card under the run', async () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    const a = registerCard({
      workspaceId: ws,
      runId: 'r1',
      spec: { prompt: 'a', dataSchema: choiceSchema },
    });
    const b = registerCard({
      workspaceId: ws,
      runId: 'r1',
      spec: { prompt: 'b', dataSchema: choiceSchema },
    });
    cancelPendingCardsForRun('r1');
    expect(await a.result).toEqual({ action: 'cancel' });
    expect(await b.result).toEqual({ action: 'cancel' });
    expect(_cardCorrelatorStatsForTests().pendingCount).toBe(0);
    expect(getSnapshot('r1')!.snapshot.openCards).toEqual([]);
  });

  it('workspace-switch cancels pending cards for the workspace (H4)', async () => {
    openRun({ workspaceId: 'workspace-A', runId: 'rA' });
    openRun({ workspaceId: 'workspace-B', runId: 'rB' });
    const a = registerCard({
      workspaceId: 'workspace-A',
      runId: 'rA',
      spec: { prompt: 'a', dataSchema: choiceSchema },
    });
    const b = registerCard({
      workspaceId: 'workspace-B',
      runId: 'rB',
      spec: { prompt: 'b', dataSchema: choiceSchema },
    });
    await dispatchWorkspaceSwitch('workspace-A');
    expect(await a.result).toEqual({ action: 'cancel' });
    // B still pending; only workspace-A cards cancelled.
    expect(_cardCorrelatorStatsForTests().pendingCount).toBe(1);
    cancelPendingCardsForWorkspaceSwitch('workspace-B'); // cleanup
    await b.result;
  });

  it('idempotencyKey: second registerCard with same key returns cached response, no new card', async () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    const first = registerCard({
      workspaceId: ws,
      runId: 'r1',
      spec: {
        prompt: 'choose',
        dataSchema: choiceSchema,
        idempotencyKey: 'k1',
      },
    });
    resolveCardResponse({
      correlationId: first.correlationId,
      action: 'submit',
      payload: { picks: ['x'] },
      expectedWorkspaceId: ws,
    });
    await first.result; // ensure the cache write side-effect lands

    expect(_cardCorrelatorStatsForTests().pendingCount).toBe(0);

    const second = registerCard({
      workspaceId: ws,
      runId: 'r1',
      spec: {
        prompt: 'choose',
        dataSchema: choiceSchema,
        idempotencyKey: 'k1',
      },
    });
    // No new PENDING entry; resolved immediately.
    expect(_cardCorrelatorStatsForTests().pendingCount).toBe(0);
    expect(await second.result).toEqual({ action: 'submit', payload: { picks: ['x'] } });
  });

  it('correlationIds are UUIDs (review §4.10 / round-12 lesson)', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    const { correlationId } = registerCard({
      workspaceId: ws,
      runId: 'r1',
      spec: { prompt: 'a', dataSchema: choiceSchema },
    });
    // RFC 4122 v4 shape.
    expect(correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('audit: race between timeout and submit — submit wins; deferred carries submit, not cancel', async () => {
    // Pre-fix bug: timeout's setTimeout body ran AFTER resolveCardResponse
    // had already called deferred.resolve, both calling resolve. Promise
    // ignored the second, but resolveCardResponse already returned ok:true
    // — so the caller saw 200 OK while the tool's await saw cancel.
    //
    // Post-fix: clearTimeout fires synchronously before deferred.resolve
    // in resolveCardResponse, eliminating the window.
    openRun({ workspaceId: ws, runId: 'r-race' });
    const { correlationId, result } = registerCard({
      workspaceId: ws,
      runId: 'r-race',
      spec: { prompt: 'q', dataSchema: choiceSchema, timeoutMs: 10 },
    });
    // Submit immediately — before timeout would have fired.
    resolveCardResponse({
      correlationId,
      action: 'submit',
      payload: { picks: ['x'] },
      expectedWorkspaceId: ws,
    });
    // Wait long enough for the timeout to have fired had it not been
    // cancelled (the bug condition).
    await new Promise((r) => setTimeout(r, 30));
    expect(await result).toEqual({ action: 'submit', payload: { picks: ['x'] } });
  });

  it('audit: idempotency cache populated SYNCHRONOUSLY at resolve, not via .then()', () => {
    // Pre-fix bug: writing the cache inside deferred.promise.then() ran
    // as a microtask. A second registerCard with the same key arriving
    // BEFORE that microtask saw no cache hit and registered a duplicate.
    //
    // Post-fix: cacheIdempotency runs synchronously inside resolveCardResponse,
    // so the cache is observable on the very next call.
    openRun({ workspaceId: ws, runId: 'r-idem' });
    const first = registerCard({
      workspaceId: ws,
      runId: 'r-idem',
      spec: {
        prompt: 'q',
        dataSchema: choiceSchema,
        idempotencyKey: 'k1',
      },
    });
    resolveCardResponse({
      correlationId: first.correlationId,
      action: 'submit',
      payload: { picks: ['x'] },
      expectedWorkspaceId: ws,
    });
    // SAME tick — no awaits — second register MUST hit the cache.
    const second = registerCard({
      workspaceId: ws,
      runId: 'r-idem',
      spec: {
        prompt: 'q',
        dataSchema: choiceSchema,
        idempotencyKey: 'k1',
      },
    });
    expect(second.correlationId).toBe('idempotent');
    // Pending count remains 0 — no duplicate card registered.
    expect(_cardCorrelatorStatsForTests().pendingCount).toBe(0);
  });

  it('audit: idempotency cache populated on timeout-resolved cancel too', async () => {
    openRun({ workspaceId: ws, runId: 'r-idem-t' });
    const { result } = registerCard({
      workspaceId: ws,
      runId: 'r-idem-t',
      spec: {
        prompt: 'q',
        dataSchema: choiceSchema,
        timeoutMs: 10,
        idempotencyKey: 'kt',
      },
    });
    expect(await result).toEqual({ action: 'cancel' });
    // Same tick: re-register with the same key should hit cached cancel.
    const replay = registerCard({
      workspaceId: ws,
      runId: 'r-idem-t',
      spec: {
        prompt: 'q',
        dataSchema: choiceSchema,
        idempotencyKey: 'kt',
      },
    });
    expect(await replay.result).toEqual({ action: 'cancel' });
  });

  it('republishes snapshot on every PENDING change (drop + add)', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    const a = registerCard({
      workspaceId: ws,
      runId: 'r1',
      spec: { prompt: 'a', dataSchema: choiceSchema },
    });
    expect(getSnapshot('r1')!.version).toBe(1);
    registerCard({
      workspaceId: ws,
      runId: 'r1',
      spec: { prompt: 'b', dataSchema: choiceSchema },
    });
    expect(getSnapshot('r1')!.version).toBe(2);
    resolveCardResponse({
      correlationId: a.correlationId,
      action: 'submit',
      payload: { picks: ['x'] },
      expectedWorkspaceId: ws,
    });
    expect(getSnapshot('r1')!.version).toBe(3);
    expect(getSnapshot('r1')!.snapshot.openCards.length).toBe(1);
  });
});
