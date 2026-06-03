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
export type WorkspaceSwitchCallback = (workspaceId: string) => void | Promise<void>;
/**
 * Subscribe a callback. Returns an unsubscribe function.
 * Callbacks run in registration order on `dispatchWorkspaceSwitch`.
 */
export declare function onWorkspaceSwitch(cb: WorkspaceSwitchCallback): () => void;
/**
 * Notify every subscriber. One subscriber throwing does NOT block others;
 * errors are aggregated and logged.
 */
export declare function dispatchWorkspaceSwitch(workspaceId: string): Promise<void>;
/** Test-only: clear all subscribers. */
export declare function _resetWorkspaceLifecycleForTests(): void;
/** Test-only: read current subscriber count. */
export declare function _subscriberCountForTests(): number;
