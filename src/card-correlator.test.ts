import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  _cardCorrelatorStatsForTests,
  _resetCardCorrelatorForTests,
  cancelPendingCardsForRun,
  cancelPendingCardsForWorkspaceSwitch,
  registerCard,
  resolveCardResponse,
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
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
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
