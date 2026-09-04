/**
 * delta-client — the CLIENT side of the agent tool-result delta protocol (the inverse
 * of `negotiateDelta`). agent-tool-delta-protocol-2026-06-22 follow-up: the server has
 * always known how to SERVE a delta (parse `_meta.delta`, return changes), but nothing
 * SENDS one — no agent client tracks a cursor + reconstructs. This is that missing half.
 *
 * A consumer that re-reads the same tool VIEW (same tool + args + scope) keeps a base
 * row-set + a cursor per view. On a repeat it attaches the cursor as `_meta.delta`, and
 * folds the server's response back in:
 *   - `full`         → cache the rows + cursor, return the rows.
 *   - `not_modified` → return the cached base (the whole point: no replay), bump the cursor.
 *   - `delta`        → merge the changes onto the base (`applySemanticDelta`), VERIFY the
 *                      result against the server's `checksum`, and ONLY use it on a match;
 *                      on a mismatch (or no base) discard + signal a full refetch.
 *
 * This is the "harness-owns-base" half the protocol mandates — the MODEL never merges, so
 * a silently-wrong merge can't reach it (the checksum guard forces a full refetch instead).
 *
 * `itemKey` is supplied per call by the wiring layer (the response envelope does not convey
 * it). Assumes the server's default content-hash row revision (the checksum machinery the
 * adopted tools use); a tool declaring a custom `rowRevision` must convey it to the client.
 */
import { type DeltaChange } from './delta-protocol';
export type { DeltaChange } from './delta-protocol';
/** A server delta response as the client observes it (parsed from `_meta.delta` + the body). */
export type DeltaResponse = {
    mode: 'full';
    cursor?: string;
    rows: unknown[];
    itemKeyField?: string;
} | {
    mode: 'not_modified';
    cursor?: string;
} | {
    mode: 'delta';
    cursor?: string;
    checksum?: string;
    changes: DeltaChange[];
    itemKeyField?: string;
};
export interface DeltaIngestResult {
    /** The full row-set to hand the consumer (reconstructed for a delta; the cached base for not_modified). */
    rows: unknown[];
    /** True when the response could NOT be safely used (checksum mismatch, or a delta/not_modified
     *  with no retained base) — the caller MUST re-request WITHOUT the cursor (a full refetch). */
    refetchFull: boolean;
}
/**
 * Per-consumer cache of tool VIEWS for the delta protocol. One instance per agent
 * session / conversation; `viewKey` is a stable id for a logical view (e.g.
 * `"plans:list:" + canonicalArgs`). Not thread-safe; drive it from one tool-call loop.
 */
export declare class DeltaToolClient {
    private readonly views;
    /** The cursor to attach as `_meta.delta` for `viewKey`, or undefined for a cold first read. */
    cursorFor(viewKey: string): string | undefined;
    /** Fold a server response into the cache. Returns the full rows + whether a full refetch is needed. */
    ingest(viewKey: string, res: DeltaResponse, itemKey: (row: unknown) => string): DeltaIngestResult;
    /** Drop a cached view (e.g. on a scope change or an explicit reset). */
    forget(viewKey: string): void;
    /** Number of cached views (introspection / tests). */
    get size(): number;
}
/** Runs ONE tool read with a given delta cursor and returns the client's view of the response.
 *  The wiring layer supplies this — in-process it sets `ctx.requestedDelta = cursor`, dispatches,
 *  and adapts the structured result into a {@link DeltaResponse}. */
export type DeltaDispatch = (requestedDelta: string | undefined) => Promise<DeltaResponse>;
export interface DeltaDispatchResult {
    /** The full reconstructed view (the harness-owned base) — the consumer's authoritative rows. */
    rows: unknown[];
    /** The response MODE to surface into the LLM context: `full` → the rows; `delta` → only the
     *  changes (the token win); `not_modified` → nothing new (the base is already in context). */
    mode: 'full' | 'delta' | 'not_modified';
}
/**
 * One delta-negotiated read for a view. Sends the cached cursor, ingests the response, and —
 * if the delta can't be safely applied (checksum mismatch / no base) — re-dispatches WITHOUT
 * the cursor for a clean full, so the consumer (and the model) NEVER sees a wrong/partial view.
 * Pure orchestration over an abstract {@link DeltaDispatch}; the wiring layer provides the
 * concrete dispatch + the registry-resolved `itemKey`.
 */
export declare function dispatchWithDelta(client: DeltaToolClient, viewKey: string, itemKey: (row: unknown) => string, dispatch: DeltaDispatch): Promise<DeltaDispatchResult>;
/**
 * OUT-OF-PROCESS variant of {@link dispatchWithDelta} for a client (the MCP proxy) that
 * has NO access to the tool's `itemKey` FUNCTION (it can't cross a process boundary). It
 * LEARNS the itemKey FIELD NAME from the `itemKeyField` the server conveys on a full/delta
 * response, caches it per view in `fieldByView` (one map per proxy session), and merges via
 * `row[field]`. Same checksum→refetch-full guard — a delta it can't key (no field yet) or a
 * mismatched merge degrades to a clean full, never a wrong view.
 *
 * SCOPE (P-004 terminal disposition): this is the buildable, reusable half of the
 * out-of-process delta proxy — usable only by an out-of-process consumer whose turn wrapper
 * Papercusp STILL controls (so base-presence can be paired with a {@link BasePresenceTracker}
 * configured `enabled:true`). It must NOT drive LLM-facing `not_modified`/`delta` for an
 * EXTERNAL Claude Code / Codex session: the base-presence contract (D-006,
 * `agent-insights/tool-delta-base-presence-contract.mdx` §Scope) forbids it — the proxy
 * cannot see the external client's compaction, so it can't guarantee the base is in context.
 * For those, the proxy reconstructs the full view (a localhost wire saving only, no model-token
 * win) or simply serves `full`. That contract boundary — not a missing build — is why P-004
 * stops here: the merge LOGIC ships; the Claude-Code-facing compact-delta delivery is by-design
 * absent.
 */
export declare function dispatchWithConveyedDelta(client: DeltaToolClient, fieldByView: Map<string, string>, viewKey: string, dispatch: DeltaDispatch): Promise<DeltaDispatchResult>;
