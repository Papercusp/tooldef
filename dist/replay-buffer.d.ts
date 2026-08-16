/**
 * Per-call replay ring buffer for streaming tools. Phase 4 T2.2.
 *
 * When a tool declares `replayBufferSize > 0`, the dispatcher pushes
 * each emitted event into a bounded ring buffer keyed on
 * `(workspaceId, toolName, runId)`. A reconnecting client sending
 * `Last-Event-ID + X-Papercusp-Run-Id` headers retrieves the buffered
 * tail and resumes; the cold sink then stays open if the tool is
 * still streaming, or closes immediately if the original call
 * already terminated.
 *
 * Disconnect semantics: tool ABORTS on disconnect (the dispatcher's
 * existing abort-on-signal behavior). Replay serves only events
 * captured BEFORE the disconnect; the "long-lived disconnected
 * tools" model is deferred to T4.3 of the plan.
 *
 * Lifetime: buffer survives in memory for `BUFFER_TTL_MS` (5 min by
 * default) past stream-end. Cleared on workspace switch via
 * `clearAllBuffers()` (called by the workspace-registry change
 * handler). Cross-process buffers (PG-backed) are out of scope.
 *
 * Plan ref: phase-4-endpoint-system-2026-05-12.md § T2.2.
 */
export interface BufferedEvent {
    /** SSE id allocated by the wire layer. Dispatcher tracks its own
     *  monotonic counter that mirrors the sink's allocator — they're
     *  in lockstep because the dispatcher's wrapped emit is the only
     *  source of `sink.event()` calls during the stream. */
    id: number;
    name: string;
    data: unknown;
}
/**
 * Create (or fetch existing) buffer for a call. Returns a writer
 * the dispatcher uses to push events. Idempotent: calling twice
 * with the same key returns the same entry — useful if a tool
 * call is somehow re-entered (shouldn't happen, but defensive).
 */
export declare function openBuffer(opts: {
    workspaceId: string;
    toolName: string;
    runId: string;
    capacity: number;
    /** Called when an event is evicted (capacity hit). Caller decides
     *  whether to warn-log; the buffer is silent. */
    onEvict?: (event: BufferedEvent) => void;
}): {
    push: (event: BufferedEvent) => void;
    count: () => number;
};
/** The writer handle `openBuffer` returns — the dispatcher pushes events to it. */
export type ReplayBufferWriter = ReturnType<typeof openBuffer>;
/**
 * Fetch buffered events with id > sinceId for replay. Returns null
 * if no buffer exists for the key (or it's expired). Empty array if
 * the buffer exists but has nothing past sinceId.
 *
 * Touches `lastActiveMs` so a reconnect extends the buffer's life
 * past the next GC sweep — buffers stay warm while consumers are
 * actively reconnecting.
 */
export declare function readBuffer(opts: {
    workspaceId: string;
    toolName: string;
    runId: string;
    sinceId: number;
}): BufferedEvent[] | null;
/**
 * Drop the buffer for a specific call. Used by the dispatcher when
 * the call finishes cleanly + the result has been seen (no expected
 * reconnect). Not strictly necessary — GC would clean up — but
 * trims peak memory.
 */
export declare function closeBuffer(opts: {
    workspaceId: string;
    toolName: string;
    runId: string;
}): void;
/**
 * Clear every buffer scoped to a specific workspace. Subscribed via
 * onWorkspaceSwitch so a workspace switch can't see the prior
 * workspace's tail. Buffer keys are `${workspaceId}:${tool}:${runId}`
 * so we match on the prefix.
 */
export declare function clearRingBuffersForWorkspaceSwitch(workspaceId: string): void;
/**
 * Test-only: clear every buffer in every workspace. Use
 * `clearRingBuffersForWorkspaceSwitch(id)` from production code.
 */
export declare function clearAllBuffersForTests(): void;
/** Public — read-only stats for /dev telemetry. */
export declare function replayBufferStats(): {
    bufferCount: number;
    totalEvents: number;
    totalEvicted: number;
};
