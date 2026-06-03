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
import type { CardResponse, CardSpec } from './types';
import { type StandardSchemaV1 } from './standard-schema';
/**
 * Register a new card and return a promise that resolves when the user
 * responds (or the card is cancelled/declined/times-out).
 *
 * Idempotency: if `spec.idempotencyKey` is set and we have a cached
 * response for the same (runId, idempotencyKey), return the cached
 * response immediately without registering or emitting.
 */
export declare function registerCard<TSchema extends StandardSchemaV1>(opts: {
    workspaceId: string;
    runId: string;
    spec: CardSpec<TSchema>;
}): {
    correlationId: string;
    result: Promise<CardResponse<TSchema>>;
};
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
export declare function resolveCardResponse(opts: {
    correlationId: string;
    action: 'submit' | 'decline' | 'cancel';
    payload?: unknown;
    reason?: string;
    expectedWorkspaceId?: string;
}): {
    ok: true;
} | {
    ok: false;
    status: number;
    error: string;
    details?: unknown;
};
/**
 * Cancel every pending card under a run. Used at run-end / abort.
 */
export declare function cancelPendingCardsForRun(runId: string): void;
/**
 * Cancel every pending card in a workspace. Subscribed via
 * onWorkspaceSwitch.
 */
export declare function cancelPendingCardsForWorkspaceSwitch(workspaceId: string): void;
/** Test-only: clear everything. */
export declare function _resetCardCorrelatorForTests(): void;
/** Test-only stats. */
export declare function _cardCorrelatorStatsForTests(): {
    pendingCount: number;
    runCount: number;
};
