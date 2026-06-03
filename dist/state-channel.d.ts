/**
 * State channel — per-run snapshot store for stateful surfaces.
 *
 * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md §5
 *
 * Two channels in the tool runtime:
 *
 *   EVENTS channel    — ctx.emit(name, payload)
 *                       ring buffer (T2.2), replay = history
 *
 *   STATE channel     — ctx.askUser, ctx.publishState (PR 2)
 *                       per-run snapshot map, replay = snapshot only
 *
 * This module is the state-channel store. Snapshot shape:
 *
 *   {
 *     openCards: OpenCardSnapshot[]   — populated by card-correlator (PR 1)
 *     toolState: unknown              — populated by publishState     (PR 2)
 *   }
 *
 * Each mutation bumps a monotonic per-run `version`. Subscribers receive
 * the new snapshot; transport adapters serialize it as a `state-snapshot`
 * typed event on the wire.
 *
 * Lifecycle:
 *   - openRun({ workspaceId, runId })       → creates empty snapshot
 *   - setOpenCards(runId, cards[])          → re-emit snapshot
 *   - setToolState(runId, snapshot)         → re-emit snapshot   (PR 2)
 *   - getSnapshot(runId)                    → current snapshot   (for reconnect)
 *   - subscribe(runId, cb) → unsubscribe()  → emit current immediately + on change
 *   - closeRun(runId)                       → drop after retention window (5min)
 *   - dispatchWorkspaceSwitch → drops all snapshots for that workspace
 */
import type { OpenCardSnapshot } from './types';
export interface StateSnapshot {
    /** Open cards (managed by card-correlator). */
    openCards: OpenCardSnapshot[];
    /** Tool-published state (managed by publishState — PR 2). */
    toolState?: unknown;
}
export interface VersionedSnapshot {
    runId: string;
    version: number;
    snapshot: StateSnapshot;
}
type Subscriber = (vs: VersionedSnapshot) => void;
type WorkspaceSubscriber = (vs: VersionedSnapshot, workspaceId: string) => void;
/**
 * Initialize an empty snapshot for a run. Idempotent — safe to call
 * multiple times; returns the existing entry if present.
 */
export declare function openRun(opts: {
    workspaceId: string;
    runId: string;
}): void;
/**
 * Replace the openCards field. Bumps version + re-emits to subscribers.
 * No-op if no run entry exists for the runId.
 */
export declare function setOpenCards(runId: string, openCards: OpenCardSnapshot[]): void;
/**
 * Replace the toolState field. Bumps version + re-emits.
 * Used by ctx.publishState in PR 2.
 */
export declare function setToolState(runId: string, toolState: unknown): void;
/**
 * Snapshot the current state for a run. Returns null if no run entry
 * exists (or it has been GC'd past retention).
 */
export declare function getSnapshot(runId: string): VersionedSnapshot | null;
/**
 * Subscribe to snapshot changes. The subscriber is invoked synchronously
 * with the current snapshot, then again on every mutation.
 * Returns an unsubscribe function.
 */
export declare function subscribe(runId: string, cb: Subscriber): () => void;
/**
 * Mark a run as closed. The entry sticks around for STATE_TTL_MS for
 * late reconnects, then is GC'd. Subscribers are NOT auto-removed —
 * transport adapters should call their own unsubscribe.
 */
export declare function closeRun(runId: string): void;
/**
 * Subscribe to ALL snapshot changes within a workspace, irrespective
 * of runId. Used by chat-surface SSE consumers — they don't know
 * which runIds will exist in advance, but they always know their
 * active workspace.
 *
 * The subscriber fires on every mutation in any run scoped to the
 * workspace. It does NOT receive an "initial" snapshot for currently-
 * open runs; the caller should walk getSnapshot(runId) for known
 * runIds if they need that. This API is for live updates only.
 */
export declare function subscribeWorkspace(workspaceId: string, cb: WorkspaceSubscriber): () => void;
/**
 * Snapshot every open run scoped to a workspace. Used by chat-surface
 * SSE consumers right after subscribeWorkspace, so the client sees
 * every currently-open card on stream open.
 */
export declare function snapshotWorkspace(workspaceId: string): VersionedSnapshot[];
/**
 * Workspace-switch subscriber. Drops every run scoped to the workspace.
 */
export declare function dropStateSnapshotsForWorkspaceSwitch(workspaceId: string): void;
/** Test-only: clear everything. */
export declare function _resetStateChannelForTests(): void;
/** Test-only stats. */
export declare function _stateChannelStatsForTests(): {
    runCount: number;
    subscriberCount: number;
};
export {};
