/**
 * rows-delta — server-side delta negotiation for a BARE ROW ARRAY (a sync RESOURCE),
 * the resolver/SSE-path sibling of define-tool's `negotiateToolDelta`. Where the tool
 * path negotiates over a ToolResponse, a sync resolver (e.g. `plans.attention`) returns
 * a plain rows array; this composes the SAME delta primitives (computeRowDigest +
 * computeViewChecksum + diffFromDigest + the cursor codec) to turn "client cursor + the
 * freshly-resolved rows" into a `full` or `delta` response.
 *
 * agent-tool-delta-client-rollout-2026-06-23 P-006 (the 327GB sync win): the UI re-fetches
 * the full ~633KB plans.attention view on every plans-table invalidation. With a delta-aware
 * client (useSyncResource sending its cursor) only the changed rows travel. Correctness is the
 * SAME structural guarantee as the tool path: the response carries the full-view `checksum`, the
 * client verifies its merge against it and refetches a full on any mismatch — never a wrong view.
 */
import {
  computeRowDigest,
  computeViewChecksum,
  diffFromDigest,
  encodeDeltaCursor,
  decodeDeltaCursor,
  type DeltaChange,
} from './delta-protocol';

export interface RowsDeltaResult {
  /** `full` = the complete rows; `delta` = only the changed rows (the token/bandwidth win). */
  mode: 'full' | 'delta';
  /** Present iff `mode==='full'` — the complete current view. */
  rows?: unknown[];
  /** Present iff `mode==='delta'` — the added/updated/removed rows vs the client's cursor base. */
  changes?: DeltaChange[];
  /** Set-based checksum of the FULL current view — the client verifies its merge against this
   *  and refetches a full on mismatch (the no-wrong-view guard). */
  checksum: string;
  /** Fresh cursor to hand back; encodes the current row digest so the NEXT call can diff from it. */
  cursor: string;
  /** The itemKey FIELD NAME, so an out-of-process client merges generically (`row[itemKeyField]`). */
  itemKeyField?: string;
}

/**
 * Negotiate a `full` vs `delta` response for a resolved rows array. Pure: same inputs →
 * same output. A cold call (no cursor), a cursor for a different schema, or a cursor with
 * no row digest all degrade to `full` (+ a fresh cursor). A cursor whose checksum already
 * matches the current view yields an empty `delta` (nothing changed). Otherwise it diffs the
 * current rows against the cursor's base digest.
 */
export function negotiateRowsDelta(input: {
  /** The client's prior cursor (encodes its base digest), or undefined for a cold full. */
  cursor: string | undefined;
  rows: unknown[];
  itemKey: (row: unknown) => string;
  itemKeyField?: string;
  schemaVersion?: string;
}): RowsDeltaResult {
  const { cursor, rows, itemKey, itemKeyField, schemaVersion } = input;
  const checksum = computeViewChecksum(rows, itemKey);
  const digest = computeRowDigest(rows, itemKey);
  const freshCursor = encodeDeltaCursor({
    v: 1,
    fp: '',
    rev: checksum,
    ...(schemaVersion ? { sv: schemaVersion } : {}),
    ...(digest ? { dg: digest } : {}),
  });
  const full = (): RowsDeltaResult => ({ mode: 'full', rows, checksum, cursor: freshCursor, itemKeyField });

  if (!cursor) return full();
  const decoded = decodeDeltaCursor(cursor);
  // Malformed, a schema bump, or a cursor without a row digest → can't diff → full.
  if (!decoded || (decoded.sv ?? '') !== (schemaVersion ?? '') || !decoded.dg) return full();
  // Unchanged view → an empty delta (the client keeps its base; the whole point).
  if (decoded.rev === checksum) {
    return { mode: 'delta', changes: [], checksum, cursor: freshCursor, itemKeyField };
  }
  const changes = diffFromDigest(decoded.dg, rows, itemKey);
  return { mode: 'delta', changes, checksum, cursor: freshCursor, itemKeyField };
}
