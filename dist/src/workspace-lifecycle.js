/**
 * Workspace-lifecycle hook (H4 in bespoke-card-improvements-2026-05-13.md).
 *
 * Single registration point for "workspace switched" cleanup. Subscribers
 * fan out from one event so future cleanup paths don't get forgotten
 * (round 12 lesson — clearAllBuffersForTests was misnamed because it
 * had no central dispatcher).
 *
 * Subscribers wired in this arc:
 *   - replay-buffer.ts          → clearRingBuffersForWorkspaceSwitch
 *   - card-correlator.ts        → cancelPendingCardsForWorkspaceSwitch
 *   - state-publisher.ts (PR 2) → dropStateSnapshotsForWorkspaceSwitch
 *
 * Caller (operator on session/workspace change) invokes
 * `dispatchWorkspaceSwitch(newWorkspaceId)`.
 */
const SUBSCRIBERS = new Set();
/**
 * Subscribe a callback. Returns an unsubscribe function.
 * Callbacks run in registration order on `dispatchWorkspaceSwitch`.
 */
export function onWorkspaceSwitch(cb) {
    SUBSCRIBERS.add(cb);
    return () => {
        SUBSCRIBERS.delete(cb);
    };
}
/**
 * Notify every subscriber. One subscriber throwing does NOT block others;
 * errors are aggregated and logged.
 */
export async function dispatchWorkspaceSwitch(workspaceId) {
    const errors = [];
    for (const cb of SUBSCRIBERS) {
        try {
            await cb(workspaceId);
        }
        catch (e) {
            errors.push(e);
        }
    }
    if (errors.length > 0) {
        console.warn('[workspace-lifecycle] subscriber errors during workspace switch', { workspaceId, count: errors.length, errors });
    }
}
/** Test-only: clear all subscribers. */
export function _resetWorkspaceLifecycleForTests() {
    SUBSCRIBERS.clear();
}
/** Test-only: read current subscriber count. */
export function _subscriberCountForTests() {
    return SUBSCRIBERS.size;
}
