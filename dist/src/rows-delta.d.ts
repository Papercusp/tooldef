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
import { type DeltaChange } from './delta-protocol';
/**
 * Max ENCODED CURSOR LENGTH (chars) that may carry an embedded row digest (`dg`).
 *
 * The cursor rides back as a `?delta=` query param, so it is bounded by the server's request-line
 * / header limit (Node's default max header size is 16 KB) — NOT by the row count that
 * `DELTA_MAX_DIGEST_ENTRIES` governs. Measured live 2026-08-08: a 22,207-char cursor returned
 * HTTP 431 while 14,591 was fine. 8,000 leaves better than 2x headroom for the rest of the
 * request line (route, `name`, and a potentially long `args` JSON) plus all other headers.
 *
 * Above this, the digest is parked server-side and only its id (`di`) travels — the P-024 path.
 */
export declare const DELTA_MAX_EMBEDDED_CURSOR_CHARS = 8000;
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
    /**
     * Present iff `mode==='full'` — WHY this call could not delta. Without it a client sees an
     * unexplained full and cannot tell a one-off miss from a view that will never delta, which
     * is the diagnosability half of P-024 (a `full` that says nothing is what hid the original
     * ~822 KB/poll regression for so long).
     *
     * `digest_expired` is the only RECOVERABLE one — the next call re-parks and wins. The rest
     * are either expected-once (`cold`, `schema_changed`) or structural (`no_digest`: the view
     * is over the embed cap and no `viewKey` was supplied, so it can never delta as wired).
     */
    fullReason?: 'cold' | 'malformed_cursor' | 'schema_changed' | 'digest_expired' | 'no_digest';
}
/**
 * Negotiate a `full` vs `delta` response for a resolved rows array. Pure: same inputs →
 * same output. A cold call (no cursor), a cursor for a different schema, or a cursor with
 * no row digest all degrade to `full` (+ a fresh cursor). A cursor whose checksum already
 * matches the current view yields an empty `delta` (nothing changed). Otherwise it diffs the
 * current rows against the cursor's base digest.
 */
export declare function negotiateRowsDelta(input: {
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
}): RowsDeltaResult;
