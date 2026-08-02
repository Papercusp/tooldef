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
  computeRowDigestUncapped,
  computeViewChecksum,
  diffFromDigest,
  encodeDeltaCursor,
  decodeDeltaCursor,
  type DeltaChange,
} from './delta-protocol';
import { putRowDigest, getRowDigest } from './delta-digest-store';

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
  /**
   * Stable identity of THIS view (e.g. `"plans.list:<canonical args>"`) — enables the
   * large-view path (P-024). Above `DELTA_MAX_DIGEST_ENTRIES` the digest cannot ride the
   * cursor, so it is parked server-side under this key and only an id travels.
   *
   * REQUIRED for that path, not optional politeness: the cursor is client-supplied, and
   * `diffFromDigest` reports `removed` ids, so an unbound id would let one caller pair its
   * own cursor with another view's digest and read back that view's row ids. Omit it and
   * behaviour is exactly as before (a large view degrades to `full`) — safe, just not fixed.
   */
  viewKey?: string;
}): RowsDeltaResult {
  const { cursor, rows, itemKey, itemKeyField, schemaVersion, viewKey } = input;
  const checksum = computeViewChecksum(rows, itemKey);
  const digest = computeRowDigest(rows, itemKey);
  // P-024: the measured miss. `plans.list` (933 rows) is over the embed cap, so `digest`
  // is null, the cursor shipped without `dg`, and EVERY warm poll re-sent the full ~822 KB
  // (~52 MB/hour per open window) — while `plans.attention` (165 rows) got 83x on this
  // very function. The cap governs what fits in a cursor, not what can be diffed.
  const digestId =
    !digest && viewKey ? putRowDigest(computeRowDigestUncapped(rows, itemKey), viewKey, rows.length) : undefined;
  const freshCursor = encodeDeltaCursor({
    v: 1,
    fp: '',
    rev: checksum,
    ...(schemaVersion ? { sv: schemaVersion } : {}),
    ...(digest ? { dg: digest } : {}),
    ...(digestId ? { di: digestId } : {}),
  });
  const full = (): RowsDeltaResult => ({ mode: 'full', rows, checksum, cursor: freshCursor, itemKeyField });

  if (!cursor) return full();
  const decoded = decodeDeltaCursor(cursor);
  // Malformed or a schema bump → can't diff → full.
  if (!decoded || (decoded.sv ?? '') !== (schemaVersion ?? '')) return full();
  // The prior state is either embedded (`dg`, small views) or parked server-side (`di`,
  // large views — P-024). A `di` miss (eviction, restart, or a viewKey mismatch) is an
  // ordinary miss: degrade to `full`, never to a wrong delta.
  const priorDigest = decoded.dg ?? (decoded.di && viewKey ? getRowDigest(decoded.di, viewKey) : undefined);
  if (!priorDigest) return full();
  // Unchanged view → an empty delta (the client keeps its base; the whole point).
  if (decoded.rev === checksum) {
    return { mode: 'delta', changes: [], checksum, cursor: freshCursor, itemKeyField };
  }
  const changes = diffFromDigest(priorDigest, rows, itemKey);
  return { mode: 'delta', changes, checksum, cursor: freshCursor, itemKeyField };
}
