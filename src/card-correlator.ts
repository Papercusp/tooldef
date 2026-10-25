/**
 * Card correlator — server-side state machine for ctx.askUser.
 *
 * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md §4.3
 *
 * Each ctx.askUser call:
 *   1. (optional) idempotency-key cache hit → return cached response, no emit
 *   2. generate correlationId = crypto.randomUUID()
 *   3. register in PENDING + BY_RUN; publish state-channel snapshot
 *   4. on timeoutMs (if set) → resolve {action:'cancel'}, drop
 *   5. on /card-response POST → validate payload against dataSchema,
 *      resolve Deferred, drop, re-publish snapshot
 *   6. on run-end → cancel every pending card for the run
 *   7. on workspace-switch → cancel every pending card in the workspace (H4)
 *
 * State source-of-truth: the PENDING map IS what `setOpenCards` mirrors
 * to the state channel. No double-bookkeeping (H2).
 */

import { pinModuleState } from '@papercusp/module-singleton';
import type { CardResponse, CardSpec, OpenCardSnapshot } from './types';
import { setOpenCards } from './state-channel';
import { onWorkspaceSwitch } from './workspace-lifecycle';
import { toJsonSchema } from './schema-adapter';
import { validateSync, type StandardSchemaV1 } from './standard-schema';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (error: unknown) => void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface PendingCard<TSchema extends StandardSchemaV1 = StandardSchemaV1> {
  correlationId: string;
  runId: string;
  workspaceId: string;
  spec: CardSpec<TSchema>;
  deferred: Deferred<CardResponse<TSchema>>;
  createdAt: number;
  cacheable: boolean;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

/**
 * The pin key — also the id this module reports under in
 * `listModuleDuplications()`, so a split here shows up in the REALM-WIDE report
 * rather than only through this module's own accessor. Unchanged from the
 * `Symbol.for(...)` description used before the migration (EI-19479108855357092).
 */
const STATE_KEY = 'papercusp.cardCorrelatorRegistry';

interface CardCorrelatorState {
  pending: Map<string /* correlationId */, PendingCard>;
  byRun: Map<string /* runId */, Set<string /* correlationId */>>;
  idempotency: Map<string /* runId */, Map<string /* key */, CardResponse<any>>>;
  lifecycleSubscribed: boolean;
}

/**
 * Pinned + counted rather than hand-rolled: a hand-rolled
 * `globalThis[Symbol.for(...)]` slot is equally correct and completely invisible
 * to `listModuleDuplications()`. Must stay at module scope. Lifecycle
 * subscription stays lazy in `registry()` — only the data is eager.
 */
const state = pinModuleState<CardCorrelatorState>(STATE_KEY, () => ({
  pending: new Map(),
  byRun: new Map(),
  idempotency: new Map(),
  lifecycleSubscribed: false,
}));

function registry() {
  const r = state;
  if (!r.lifecycleSubscribed) {
    onWorkspaceSwitch((wid) => cancelPendingCardsForWorkspaceSwitch(wid));
    r.lifecycleSubscribed = true;
  }
  return r;
}

function zodToJsonSchema(schema: StandardSchemaV1): Record<string, unknown> {
  // Pluggable schema→JSON-Schema (P-021); default adapter is Zod 4's
  // toJSONSchema (zod-to-json-schema@3 produced empty results for Zod 4).
  const raw = toJsonSchema(schema);
  delete raw.$schema;
  return raw;
}

function pendingToOpenCard(card: PendingCard): OpenCardSnapshot {
  return {
    correlationId: card.correlationId,
    prompt: card.spec.prompt,
    dataSchemaJson: zodToJsonSchema(card.spec.dataSchema),
    presentation: card.spec.presentation,
    fallbackText: card.spec.fallbackText,
    allowDecline: card.spec.allowDecline,
    report: card.spec.report,
    createdAt: card.createdAt,
  };
}

/** Private redirect target. Settlement, expiry and run-end remove access. */
export function readPrivateCardLink(correlationId: string, workspaceId: string): string | null {
  const card = registry().pending.get(correlationId);
  return card?.workspaceId === workspaceId ? card.spec.privateLink ?? null : null;
}

function republishRunSnapshot(runId: string): void {
  const r = registry();
  const ids = r.byRun.get(runId);
  const cards: OpenCardSnapshot[] = [];
  if (ids) {
    for (const cid of ids) {
      const card = r.pending.get(cid);
      if (card) cards.push(pendingToOpenCard(card));
    }
  }
  setOpenCards(runId, cards);
}

/**
 * Write a resolved card response to the idempotency cache synchronously
 * at resolve time. Key may be undefined (no-op).
 *
 * Synchronous write closes the original race: previously we wrote via
 * deferred.promise.then(), which runs as a microtask. A second
 * registerCard with the same key arriving BETWEEN resolve and the
 * microtask saw no cache hit and registered a duplicate card.
 */
function cacheIdempotency(
  runId: string,
  key: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: CardResponse<any>,
): void {
  if (!key) return;
  const r = registry();
  let cache = r.idempotency.get(runId);
  if (!cache) {
    cache = new Map();
    r.idempotency.set(runId, cache);
  }
  cache.set(key, response);
}

function drop(correlationId: string): void {
  const r = registry();
  const card = r.pending.get(correlationId);
  if (!card) return;
  if (card.timeoutHandle) clearTimeout(card.timeoutHandle);
  r.pending.delete(correlationId);
  const set = r.byRun.get(card.runId);
  if (set) {
    set.delete(correlationId);
    if (set.size === 0) r.byRun.delete(card.runId);
  }
  republishRunSnapshot(card.runId);
}

/**
 * Register a new card and return a promise that resolves when the user
 * responds (or the card is cancelled/declined/times-out).
 *
 * Idempotency: if `spec.idempotencyKey` is set and we have a cached
 * response for the same (runId, idempotencyKey), return the cached
 * response immediately without registering or emitting.
 */
export function registerCard<TSchema extends StandardSchemaV1>(opts: {
  workspaceId: string;
  runId: string;
  spec: CardSpec<TSchema>;
  /** Reserved by registerPreparedCard before durable registration. */
  correlationId?: string;
}): { correlationId: string; result: Promise<CardResponse<TSchema>> } {
  const r = registry();

  // A prepared registration already sampled the cache before its durable
  // write. A newly cached answer must not abandon that committed identity.
  if (!opts.correlationId && opts.spec.idempotencyKey) {
    const cache = r.idempotency.get(opts.runId);
    const hit = cache?.get(opts.spec.idempotencyKey);
    if (hit) {
      return {
        correlationId: 'idempotent',
        result: Promise.resolve(hit as CardResponse<TSchema>),
      };
    }
  }

  const correlationId = opts.correlationId ?? crypto.randomUUID();
  if (opts.spec.privateLink) {
    opts = { ...opts, spec: { ...opts.spec, presentation: {
      ...(opts.spec.presentation ?? { kind: 'radio', options: [] }),
      link: `/api/ui/cards/${encodeURIComponent(correlationId)}/link`,
    } } };
  }
  if (r.pending.has(correlationId)) throw new Error('card-identity-conflict');
  const deferred = makeDeferred<CardResponse<TSchema>>();

  const card: PendingCard<TSchema> = {
    correlationId,
    runId: opts.runId,
    workspaceId: opts.workspaceId,
    spec: opts.spec,
    deferred,
    createdAt: Date.now(),
    cacheable: true,
  };

  r.pending.set(correlationId, card as unknown as PendingCard);
  let set = r.byRun.get(opts.runId);
  if (!set) {
    set = new Set();
    r.byRun.set(opts.runId, set);
  }
  set.add(correlationId);

  if (opts.spec.timeoutMs && opts.spec.timeoutMs > 0) {
    card.timeoutHandle = setTimeout(() => {
      // Re-fetch by id — if a competing resolve already dropped the
      // card, the timeout is a no-op. Setting timeoutHandle=undefined
      // here matters only if we lose the race to another path that
      // also calls clearTimeout; either way pending.has() is the gate.
      if (r.pending.has(correlationId)) {
        cancelCard(card as unknown as PendingCard, 'timeout');
      }
    }, opts.spec.timeoutMs);
  }

  republishRunSnapshot(opts.runId);

  return { correlationId, result: deferred.promise };
}

/** The durable host hook finishes before registerCard publishes anything.
 * Keep the original synchronous API for callers without persistence. */
export async function registerPreparedCard<TSchema extends StandardSchemaV1>(opts: {
  workspaceId: string; runId: string; spec: CardSpec<TSchema>; signal: AbortSignal;
}): Promise<{ correlationId: string; result: Promise<CardResponse<TSchema>> }> {
  const cancelled = () => ({ correlationId: 'cancelled',
    result: Promise.resolve({ action: 'cancel' } as CardResponse<TSchema>) });
  if (opts.signal.aborted) return cancelled();
  const hit = opts.spec.idempotencyKey
    ? registry().idempotency.get(opts.runId)?.get(opts.spec.idempotencyKey) : undefined;
  if (hit) return { correlationId: 'idempotent', result: Promise.resolve(hit as CardResponse<TSchema>) };
  const correlationId = crypto.randomUUID();
  await opts.spec.beforeCard?.(Object.freeze({ correlationId, runId: opts.runId, workspaceId: opts.workspaceId }), opts.signal);
  // An abort during a storage write cannot publish a card when its write later
  // completes. The host also receives the signal for its persisted cancellation.
  if (opts.signal.aborted) {
    if (!opts.spec.commitResponse) return cancelled();
    const committed = await opts.spec.commitResponse({ action: 'cancel' } as CardResponse<TSchema>,
      Object.freeze({ correlationId, runId: opts.runId, workspaceId: opts.workspaceId }), 'abort');
    const response = committedResponse(committed?.response);
    if (!response || typeof committed.accepted !== 'boolean') throw new Error('invalid-card-commit');
    return { correlationId: 'cancelled', result: Promise.resolve(response as CardResponse<TSchema>) };
  }
  return registerCard({ ...opts, correlationId });
}

type ResponseOptions = {
  correlationId: string; action: 'submit' | 'decline' | 'cancel'; payload?: unknown;
  reason?: string; expectedWorkspaceId?: string;
  /** A host that missed scoped durable lookup may use only legacy cards. */
  legacyOnly?: boolean;
};
type ResponseResult = { ok: true } | { ok: false; status: number; error: string; details?: unknown };
type Origin = Parameters<NonNullable<CardSpec['commitResponse']>>[2];

function validateResponse(card: PendingCard, opts: ResponseOptions):
  { ok: true; response: CardResponse } | Extract<ResponseResult, { ok: false }> {
  if (opts.action === 'submit') {
    const parsed = validateSync(card.spec.dataSchema, opts.payload);
    if (!parsed.ok) return { ok: false, status: 400, error: 'payload does not match dataSchema', details: parsed.issues };
    return { ok: true, response: { action: 'submit', payload: parsed.value } };
  }
  if (opts.action === 'decline') {
    if (card.spec.allowDecline === false) return { ok: false, status: 400, error: 'this card does not allow decline' };
    return { ok: true, response: { action: 'decline', ...(opts.reason === undefined ? {} : { reason: opts.reason }) } };
  }
  if (opts.action !== 'cancel') return { ok: false, status: 400, error: 'invalid card action' };
  return { ok: true, response: { action: 'cancel' } };
}

function deliver(card: PendingCard, response: CardResponse): void {
  if (registry().pending.get(card.correlationId) !== card) return;
  if (card.cacheable) cacheIdempotency(card.runId, card.spec.idempotencyKey, response);
  card.deferred.resolve(response);
  drop(card.correlationId);
}

/** A host receipt already contains the validated schema OUTPUT. Running an
 * input parser again can transform it twice or reject a valid transformed
 * result. The persistence adapter owns schema validation; this delivery port
 * only checks the response envelope and snapshots the committed value. */
function committedResponse(value: unknown): CardResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.action === 'submit' && Object.hasOwn(record, 'payload')) return structuredClone(value) as CardResponse;
  if (record.action === 'decline' && (record.reason === undefined || typeof record.reason === 'string')) {
    return structuredClone(value) as CardResponse;
  }
  return record.action === 'cancel' ? { action: 'cancel' } : null;
}

/** Await the host's commit before delivery or acknowledgement. An external
 * notification may already have delivered the same committed identity. */
async function commit(card: PendingCard, response: CardResponse, origin: Origin): Promise<ResponseResult> {
  const receipt = card.spec.commitResponse
    ? await card.spec.commitResponse(structuredClone(response), Object.freeze({ correlationId: card.correlationId,
      runId: card.runId, workspaceId: card.workspaceId }), origin)
    : { accepted: true, response };
  if (!receipt || typeof receipt.accepted !== 'boolean' || !receipt.response) throw new Error('invalid-card-commit');
  const committed = committedResponse(receipt.response);
  if (!committed) throw new Error('invalid-card-commit');
  deliver(card, committed);
  return receipt.accepted ? { ok: true } : { ok: false, status: 409, error: 'card already decided' };
}

function cancelCard(card: PendingCard, origin: Origin): void {
  if (!card.spec.commitResponse) { deliver(card, { action: 'cancel' }); return; }
  // Cleanup must never resolve an uncommitted cancellation as success. A
  // failed host cancellation rejects the waiter and leaves recovery to PG.
  void commit(card, { action: 'cancel' }, origin).catch(error => {
    if (registry().pending.get(card.correlationId) !== card) return;
    card.deferred.reject(error);
    drop(card.correlationId);
  });
}

/** Async ingress for persisted cards. Legacy cards keep their existing
 * synchronous path. Failed/unknown commits leave the card pending for a
 * later authoritative read; callers receive no success acknowledgement. */
export async function resolveCardResponseAsync(opts: ResponseOptions,
  origin: Origin = 'response'): Promise<ResponseResult> {
  const card = registry().pending.get(opts.correlationId);
  if (!card || (opts.expectedWorkspaceId && card.workspaceId !== opts.expectedWorkspaceId)) {
    return { ok: false, status: 404, error: 'card not found' };
  }
  if (opts.legacyOnly && card.spec.commitResponse) {
    return { ok: false, status: 409, error: 'card requires scoped durable decision' };
  }
  const parsed = validateResponse(card, opts);
  if (!parsed.ok) return parsed;
  try { return await commit(card, parsed.response, origin); }
  catch { return { ok: false, status: 503, error: 'card decision needs reconciliation' }; }
}

/** Delivery only, after the host has read and reauthorized a committed row
 * on LISTEN/reconnect. Scoped run + workspace prevent local identity drift. */
export function deliverCommittedCardResponse(input: {
  correlationId: string; runId: string; workspaceId: string; response: CardResponse;
}): ResponseResult {
  const card = registry().pending.get(input.correlationId);
  if (!card || !card.spec.commitResponse || card.runId !== input.runId || card.workspaceId !== input.workspaceId) {
    return { ok: false, status: 404, error: 'card not found' };
  }
  const committed = committedResponse(input.response);
  if (!committed) return { ok: false, status: 400, error: 'invalid committed card response' };
  deliver(card, committed);
  return { ok: true };
}

/**
 * Resolve a pending card with a user response. Returns:
 *   { ok: true }       — accepted, deferred resolved
 *   { ok: false, error } — not found OR validation failed
 *
 * Workspace gating: if `expectedWorkspaceId` is supplied and does not
 * match the card's workspaceId, returns not-found (defense in depth
 * against cross-workspace replay; the route's auth check is the
 * primary defense).
 */
export function resolveCardResponse(opts: {
  correlationId: string;
  action: 'submit' | 'decline' | 'cancel';
  payload?: unknown;
  reason?: string;
  expectedWorkspaceId?: string;
}): { ok: true } | { ok: false; status: number; error: string; details?: unknown } {
  const r = registry();
  const card = r.pending.get(opts.correlationId);
  if (!card) {
    return { ok: false, status: 404, error: 'card not found' };
  }
  if (opts.expectedWorkspaceId && card.workspaceId !== opts.expectedWorkspaceId) {
    return { ok: false, status: 404, error: 'card not found' };
  }

  if (card.spec.commitResponse) return { ok: false, status: 409, error: 'card requires an awaited decision' };

  // Compute the response shape BEFORE touching any timers / dropping —
  // validation may fail, in which case we leave the card pending.
  let response: CardResponse;
  if (opts.action === 'submit') {
    const parsed = validateSync(card.spec.dataSchema, opts.payload);
    if (!parsed.ok) {
      return {
        ok: false,
        status: 400,
        error: 'payload does not match dataSchema',
        details: parsed.issues,
      };
    }
    response = { action: 'submit', payload: parsed.value };
  } else if (opts.action === 'decline') {
    if (card.spec.allowDecline === false) {
      return { ok: false, status: 400, error: 'this card does not allow decline' };
    }
    response = { action: 'decline', reason: opts.reason };
  } else {
    response = { action: 'cancel' };
  }

  // Close the timeout/resolve race: clear the timeout BEFORE deferred.resolve
  // so a concurrent timeout firing finds pending.has() false (drop runs below)
  // AND its setTimeout is already cancelled. Without this, the timeout could
  // call deferred.resolve with cancel after we resolved with submit — caller
  // gets 200 OK but the tool's await sees the cancel.
  if (card.timeoutHandle) {
    clearTimeout(card.timeoutHandle);
    card.timeoutHandle = undefined;
  }
  deliver(card, response);
  return { ok: true };
}

/**
 * Cancel every pending card under a run. Used at run-end / abort.
 */
export function cancelPendingCardsForRun(runId: string, origin: 'run-end' | 'abort' = 'run-end'): void {
  const r = registry();
  const ids = r.byRun.get(runId);
  if (!ids) return;
  for (const cid of [...ids]) {
    const card = r.pending.get(cid);
    if (card) {
      card.cacheable = false;
      cancelCard(card, origin);
    }
  }
  r.idempotency.delete(runId);
}

/** Explicit human run cancellation must finish its commits before HTTP can
 * acknowledge it. Cleanup's void API above is retained for existing callers;
 * its durable waiters still settle only after the same commit hook. */
export async function cancelPendingCardsForRunAsync(runId: string, expectedWorkspaceId: string,
  legacyOnly = false): Promise<ResponseResult> {
  const r = registry();
  const cards = [...(r.byRun.get(runId) ?? [])].map(cid => r.pending.get(cid)).filter((card): card is PendingCard => !!card);
  if (cards.some(card => card.workspaceId !== expectedWorkspaceId)) {
    return { ok: false, status: 404, error: 'run not found in workspace' };
  }
  if (legacyOnly && cards.some(card => card.spec.commitResponse)) {
    return { ok: false, status: 409, error: 'run requires scoped durable cancellation' };
  }
  for (const card of cards) card.cacheable = false;
  const results = await Promise.all(cards.map(async card => {
    try { return await commit(card, { action: 'cancel' }, 'run-end'); }
    catch { return { ok: false as const, status: 503, error: 'card decision needs reconciliation' }; }
  }));
  r.idempotency.delete(runId);
  return results.find(result => !result.ok && result.status === 503)
    ?? results.find(result => !result.ok) ?? { ok: true };
}

/**
 * Cancel every pending card in a workspace. Subscribed via
 * onWorkspaceSwitch.
 */
export function cancelPendingCardsForWorkspaceSwitch(workspaceId: string): void {
  const r = registry();
  const runsToDrop = new Set<string>();
  for (const card of r.pending.values()) {
    if (card.workspaceId === workspaceId) {
      card.cacheable = false;
      cancelCard(card, 'workspace-switch');
      runsToDrop.add(card.runId);
    }
  }
  for (const rid of runsToDrop) r.idempotency.delete(rid);
}

/** Test-only: clear everything. */
export function _resetCardCorrelatorForTests(): void {
  const r = registry();
  for (const card of r.pending.values()) {
    if (card.timeoutHandle) clearTimeout(card.timeoutHandle);
  }
  r.pending.clear();
  r.byRun.clear();
  r.idempotency.clear();
}

/** Test-only stats. */
export function _cardCorrelatorStatsForTests(): {
  pendingCount: number;
  runCount: number;
} {
  const r = registry();
  return { pendingCount: r.pending.size, runCount: r.byRun.size };
}
