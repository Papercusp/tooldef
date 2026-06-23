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
import { applySemanticDelta, computeViewChecksum, type DeltaChange } from './delta-protocol';

/** A server delta response as the client observes it (parsed from `_meta.delta` + the body). */
export type DeltaResponse =
  | { mode: 'full'; cursor?: string; rows: unknown[] }
  | { mode: 'not_modified'; cursor?: string }
  | { mode: 'delta'; cursor?: string; checksum?: string; changes: DeltaChange[] };

export interface DeltaIngestResult {
  /** The full row-set to hand the consumer (reconstructed for a delta; the cached base for not_modified). */
  rows: unknown[];
  /** True when the response could NOT be safely used (checksum mismatch, or a delta/not_modified
   *  with no retained base) — the caller MUST re-request WITHOUT the cursor (a full refetch). */
  refetchFull: boolean;
}

interface View {
  cursor: string;
  rows: unknown[];
}

/**
 * Per-consumer cache of tool VIEWS for the delta protocol. One instance per agent
 * session / conversation; `viewKey` is a stable id for a logical view (e.g.
 * `"plans:list:" + canonicalArgs`). Not thread-safe; drive it from one tool-call loop.
 */
export class DeltaToolClient {
  private readonly views = new Map<string, View>();

  /** The cursor to attach as `_meta.delta` for `viewKey`, or undefined for a cold first read. */
  cursorFor(viewKey: string): string | undefined {
    return this.views.get(viewKey)?.cursor;
  }

  /** Fold a server response into the cache. Returns the full rows + whether a full refetch is needed. */
  ingest(viewKey: string, res: DeltaResponse, itemKey: (row: unknown) => string): DeltaIngestResult {
    if (res.mode === 'full') {
      this.views.set(viewKey, { cursor: res.cursor ?? '', rows: res.rows });
      return { rows: res.rows, refetchFull: false };
    }

    const prev = this.views.get(viewKey);
    if (!prev) {
      // not_modified / delta with no retained base — we can't reconstruct; refetch full.
      this.views.delete(viewKey);
      return { rows: [], refetchFull: true };
    }

    if (res.mode === 'not_modified') {
      if (res.cursor) prev.cursor = res.cursor;
      return { rows: prev.rows, refetchFull: false };
    }

    // mode === 'delta'
    const merged = applySemanticDelta(prev.rows, res.changes, itemKey);
    if (res.checksum != null && computeViewChecksum(merged, itemKey) !== res.checksum) {
      // The merged set diverged from the server's authoritative view — never hand a
      // possibly-wrong view to the model. Drop the base + force a clean full refetch.
      this.views.delete(viewKey);
      return { rows: prev.rows, refetchFull: true };
    }
    this.views.set(viewKey, { cursor: res.cursor ?? prev.cursor, rows: merged });
    return { rows: merged, refetchFull: false };
  }

  /** Drop a cached view (e.g. on a scope change or an explicit reset). */
  forget(viewKey: string): void {
    this.views.delete(viewKey);
  }

  /** Number of cached views (introspection / tests). */
  get size(): number {
    return this.views.size;
  }
}
