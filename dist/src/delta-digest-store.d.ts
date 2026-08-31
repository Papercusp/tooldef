/**
 * Server-held row digests for views too large to embed one in the URL cursor
 * (no-http-anywhere-2026-07-28 P-024).
 *
 * THE PROBLEM. A semantic delta needs the PRIOR state to diff against. Lane E carries
 * that state in the cursor itself (`dg`), which is elegant and stateless — until the
 * view is big, at which point the cursor would be enormous, so `computeRowDigest`
 * refuses above `DELTA_MAX_DIGEST_ENTRIES` and the tool silently degrades to full
 * FOREVER. Measured: `plans.list` (933 rows) re-shipped ~822 KB on every warm poll —
 * ~52 MB/hour per open window — while `plans.attention` (165 rows) got an 83x
 * reduction on the identical code path. The cliff, not the size, was the bug.
 *
 * WHY NOT JUST RAISE THE CAP: it only moves the cliff, and it moves the cost into the
 * URL, where a 933-entry digest is a multi-KB cursor echoed on every request.
 *
 * WHY NOT `@papercusp/cache`'s `LruCache`: it bounds ENTRY COUNT. Digests here differ
 * in size by two orders of magnitude (tens of rows to ~1k), so an entry-count bound
 * gives an unbounded MEMORY bound — 500 retained digests could be 5k rows or 500k.
 * This store budgets TOTAL RETAINED ROWS instead, which is the quantity that actually
 * costs memory. That is a different data structure, not a re-implementation of one.
 *
 * SAFETY PROPERTIES, both load-bearing:
 *   1. A miss is ALWAYS safe. Eviction, a process restart, or a forged id degrades to
 *      a normal `full` response — never a wrong delta. Nothing here is durable state.
 *   2. An entry is BOUND TO ITS VIEW FINGERPRINT. The cursor is client-supplied, so a
 *      caller could otherwise pair its own `fp` with someone else's digest id; because
 *      `diffFromDigest` reports `removed` ids (ids in the prior digest but not in the
 *      current rows), that would leak row ids from another view/tenant. Lookup requires
 *      the caller's current fingerprint to equal the one the digest was stored under,
 *      so a mismatched id is simply a miss.
 */
/** `{ itemKey → rowRevision }` — the same shape `computeRowDigest` produces. */
export type RowDigest = Record<string, string>;
/**
 * Total rows retained across ALL stored digests. At ~80 bytes per `id→rev` pair this
 * is roughly 16 MB worst case — bounded, and small next to the ~52 MB/hour PER WINDOW
 * that the un-deltaable path was spending on the wire.
 */
export declare const DIGEST_STORE_MAX_ROWS = 200000;
/**
 * Park a digest server-side and return the opaque id to carry in the cursor (`di`).
 * Evicts oldest-first until the row budget is satisfied.
 */
export declare function putRowDigest(digest: RowDigest, fp: string, rows: number): string;
/**
 * Look a digest up. Returns undefined on eviction, an unknown id, OR a fingerprint
 * mismatch — all three are ordinary misses the caller degrades to `full` for.
 *
 * PEEK, not take: a client may legitimately retry the same cursor (a dropped response,
 * a duplicated poll), and consuming the entry would turn the retry into a silent full.
 * Retention is governed by the row budget, not by reads.
 */
export declare function getRowDigest(id: string, fp: string): RowDigest | undefined;
/** Test seam + a hook for a host that wants to drop the cache (e.g. on reload). */
export declare function resetRowDigestStore(): void;
/** Observability: current retention, for tests and host telemetry. */
export declare function rowDigestStoreStats(): {
    entries: number;
    rows: number;
    maxRows: number;
};
