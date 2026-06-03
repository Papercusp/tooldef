"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCard = registerCard;
exports.resolveCardResponse = resolveCardResponse;
exports.cancelPendingCardsForRun = cancelPendingCardsForRun;
exports.cancelPendingCardsForWorkspaceSwitch = cancelPendingCardsForWorkspaceSwitch;
exports._resetCardCorrelatorForTests = _resetCardCorrelatorForTests;
exports._cardCorrelatorStatsForTests = _cardCorrelatorStatsForTests;
const state_channel_1 = require("./state-channel");
const workspace_lifecycle_1 = require("./workspace-lifecycle");
const schema_adapter_1 = require("./schema-adapter");
const standard_schema_1 = require("./standard-schema");
function makeDeferred() {
    let resolve;
    const promise = new Promise((res) => {
        resolve = res;
    });
    return { promise, resolve };
}
const __SYM = Symbol.for('papercusp.cardCorrelatorRegistry');
function registry() {
    const g = globalThis;
    if (!g[__SYM]) {
        g[__SYM] = {
            pending: new Map(),
            byRun: new Map(),
            idempotency: new Map(),
            lifecycleSubscribed: false,
        };
    }
    const r = g[__SYM];
    if (!r.lifecycleSubscribed) {
        (0, workspace_lifecycle_1.onWorkspaceSwitch)((wid) => cancelPendingCardsForWorkspaceSwitch(wid));
        r.lifecycleSubscribed = true;
    }
    return r;
}
function zodToJsonSchema(schema) {
    // Pluggable schema→JSON-Schema (P-021); default adapter is Zod 4's
    // toJSONSchema (zod-to-json-schema@3 produced empty results for Zod 4).
    const raw = (0, schema_adapter_1.toJsonSchema)(schema);
    delete raw.$schema;
    return raw;
}
function pendingToOpenCard(card) {
    return {
        correlationId: card.correlationId,
        prompt: card.spec.prompt,
        dataSchemaJson: zodToJsonSchema(card.spec.dataSchema),
        presentation: card.spec.presentation,
        fallbackText: card.spec.fallbackText,
        allowDecline: card.spec.allowDecline,
        createdAt: card.createdAt,
    };
}
function republishRunSnapshot(runId) {
    const r = registry();
    const ids = r.byRun.get(runId);
    const cards = [];
    if (ids) {
        for (const cid of ids) {
            const card = r.pending.get(cid);
            if (card)
                cards.push(pendingToOpenCard(card));
        }
    }
    (0, state_channel_1.setOpenCards)(runId, cards);
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
function cacheIdempotency(runId, key, 
// eslint-disable-next-line @typescript-eslint/no-explicit-any
response) {
    if (!key)
        return;
    const r = registry();
    let cache = r.idempotency.get(runId);
    if (!cache) {
        cache = new Map();
        r.idempotency.set(runId, cache);
    }
    cache.set(key, response);
}
function drop(correlationId) {
    const r = registry();
    const card = r.pending.get(correlationId);
    if (!card)
        return;
    if (card.timeoutHandle)
        clearTimeout(card.timeoutHandle);
    r.pending.delete(correlationId);
    const set = r.byRun.get(card.runId);
    if (set) {
        set.delete(correlationId);
        if (set.size === 0)
            r.byRun.delete(card.runId);
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
function registerCard(opts) {
    const r = registry();
    if (opts.spec.idempotencyKey) {
        const cache = r.idempotency.get(opts.runId);
        const hit = cache?.get(opts.spec.idempotencyKey);
        if (hit) {
            return {
                correlationId: 'idempotent',
                result: Promise.resolve(hit),
            };
        }
    }
    const correlationId = crypto.randomUUID();
    const deferred = makeDeferred();
    const card = {
        correlationId,
        runId: opts.runId,
        workspaceId: opts.workspaceId,
        spec: opts.spec,
        deferred,
        createdAt: Date.now(),
    };
    r.pending.set(correlationId, card);
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
                const response = { action: 'cancel' };
                cacheIdempotency(opts.runId, opts.spec.idempotencyKey, response);
                deferred.resolve(response);
                drop(correlationId);
            }
        }, opts.spec.timeoutMs);
    }
    republishRunSnapshot(opts.runId);
    return { correlationId, result: deferred.promise };
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
function resolveCardResponse(opts) {
    const r = registry();
    const card = r.pending.get(opts.correlationId);
    if (!card) {
        return { ok: false, status: 404, error: 'card not found' };
    }
    if (opts.expectedWorkspaceId && card.workspaceId !== opts.expectedWorkspaceId) {
        return { ok: false, status: 404, error: 'card not found' };
    }
    // Compute the response shape BEFORE touching any timers / dropping —
    // validation may fail, in which case we leave the card pending.
    let response;
    if (opts.action === 'submit') {
        const parsed = (0, standard_schema_1.validateSync)(card.spec.dataSchema, opts.payload);
        if (!parsed.ok) {
            return {
                ok: false,
                status: 400,
                error: 'payload does not match dataSchema',
                details: parsed.issues,
            };
        }
        response = { action: 'submit', payload: parsed.value };
    }
    else if (opts.action === 'decline') {
        if (card.spec.allowDecline === false) {
            return { ok: false, status: 400, error: 'this card does not allow decline' };
        }
        response = { action: 'decline', reason: opts.reason };
    }
    else {
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
    cacheIdempotency(card.runId, card.spec.idempotencyKey, response);
    card.deferred.resolve(response);
    drop(opts.correlationId);
    return { ok: true };
}
/**
 * Cancel every pending card under a run. Used at run-end / abort.
 */
function cancelPendingCardsForRun(runId) {
    const r = registry();
    const ids = r.byRun.get(runId);
    if (!ids)
        return;
    for (const cid of [...ids]) {
        const card = r.pending.get(cid);
        if (card) {
            card.deferred.resolve({ action: 'cancel' });
            drop(cid);
        }
    }
    r.idempotency.delete(runId);
}
/**
 * Cancel every pending card in a workspace. Subscribed via
 * onWorkspaceSwitch.
 */
function cancelPendingCardsForWorkspaceSwitch(workspaceId) {
    const r = registry();
    const toDrop = [];
    const runsToDrop = new Set();
    for (const [cid, card] of r.pending) {
        if (card.workspaceId === workspaceId) {
            card.deferred.resolve({ action: 'cancel' });
            toDrop.push(cid);
            runsToDrop.add(card.runId);
        }
    }
    for (const cid of toDrop)
        drop(cid);
    for (const rid of runsToDrop)
        r.idempotency.delete(rid);
}
/** Test-only: clear everything. */
function _resetCardCorrelatorForTests() {
    const r = registry();
    for (const card of r.pending.values()) {
        if (card.timeoutHandle)
            clearTimeout(card.timeoutHandle);
    }
    r.pending.clear();
    r.byRun.clear();
    r.idempotency.clear();
}
/** Test-only stats. */
function _cardCorrelatorStatsForTests() {
    const r = registry();
    return { pendingCount: r.pending.size, runCount: r.byRun.size };
}
