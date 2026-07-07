/**
 * delta-protocol.ts — framework freshness plumbing for agent tool results.
 * (agent-tool-delta-protocol-2026-06-22, Lane B / P-004 contract + P-005 impl.)
 *
 * The PURE core of the "don't replay an unchanged snapshot into LLM context"
 * protocol. It implements ONLY the always-safe modes — `full` and
 * `not_modified` (HTTP ETag / If-None-Match semantics) — and NEVER a partial
 * `delta` body. Semantic added/updated/removed deltas are a separate,
 * endpoint-opt-in layer (Lane E, D-001) that builds ON this contract; this
 * module deliberately stops short of them so it is base-presence-safe by
 * construction (D-004/D-006):
 *
 *   - a `full` response needs no prior base in the model's context;
 *   - a `not_modified` response carries NO data to merge.
 *
 * So there is nothing a model can silently mis-merge — the silent-wrong-merge
 * hazard only enters with semantic delta bodies (Lane E, gated on the Lane-C
 * behavior tests). The harness, not the model, owns base presence: it only ever
 * asks for `not_modified` when it can prove the matching base is still in
 * context (mirroring coord's `coord_watermarks` + `snapshot_rebootstrap_pending`,
 * `coord-schema.ts`); when the base was compacted away it asks for `full`.
 *
 * Control rides the MCP `_meta` ENVELOPE (sibling of `arguments`), NOT inside a
 * tool's `arguments` — D-001: ~9 `.strict()` tools + the converse/sentinel
 * `additionalProperties:false` rejection-contract would 400 on an unknown
 * `arguments` key. The transport parses `_meta.delta` (or a connection-level
 * `?delta=`, mirroring `?format=`) into a `DeltaRequest` and threads it through
 * `UnifiedToolContext.requestedDelta`.
 *
 * Cursors are STATELESS and opaque (D-002): everything needed to validate a
 * cursor on the next call — the view fingerprint, the revision it was issued
 * at, and the endpoint schema version — lives INSIDE the base64url token. No
 * server-side snapshot store, so no retention/scaling burden and no stale-base
 * class of bug.
 *
 * This file is intentionally DOMAIN-FREE and dependency-free (no zod, no Node
 * APIs beyond an optional `Buffer` fast-path): the generic `tooldef` lib owns
 * the protocol mechanics; endpoints opt in by declaring a `DeltaCapability`.
 */
/**
 * What the client asked for:
 *   - `full`         — always send the complete snapshot (the safe default; what
 *                      an absent `_delta` also means). Issues a fresh cursor.
 *   - `not_modified` — the harness ASSERTS it still holds the matching base and
 *                      only wants to know whether the view changed (If-None-Match).
 *   - `auto`         — "send the cheapest correct thing": `not_modified` when the
 *                      cursor is valid + the revision matches, else `full`.
 *
 * In this lane `auto` and `not_modified` resolve identically (both yield
 * `not_modified` only when unchanged, `full` otherwise); the distinction is
 * recorded for telemetry and matters once semantic deltas land (Lane E), where
 * `auto` would prefer a partial `delta` body.
 */
export type DeltaMode = 'auto' | 'full' | 'not_modified';
export interface DeltaRequest {
    mode: DeltaMode;
    /** Opaque cursor echoed back from a prior response's `_meta.delta.cursor`. */
    cursor?: string;
}
/**
 * Parse the raw `_meta.delta` / `?delta=` token into a `DeltaRequest`.
 *
 * Wire form (a single string, like `?format=`): `"<mode>"` or
 * `"<mode>~<cursor>"`. The cursor is base64url (alphabet `A–Za–z0–9-_`), which
 * never contains `~`, so the first `~` is an unambiguous separator. An empty /
 * absent token ⇒ `undefined` (no delta negotiation; behave exactly as today).
 * An unrecognized mode is coerced to `auto` (defensive: never throw on a stray
 * token; `auto` without a cursor degrades to `full` anyway).
 */
export declare function parseDeltaRequest(raw: string | null | undefined): DeltaRequest | undefined;
/** Re-serialize a `DeltaRequest` to its wire token (the inverse of `parseDeltaRequest`). */
export declare function formatDeltaRequest(req: DeltaRequest): string;
/** Decoded cursor payload. Compact field names keep the wire token small. */
export interface DeltaCursorPayload {
    /** Cursor format version. Bump if this struct ever changes shape. */
    v: 1;
    /** View fingerprint: hash of (toolName + canonical args + scope + format). */
    fp: string;
    /** The view's revision/checksum at the moment the cursor was issued. */
    rev: string;
    /** Endpoint schema version (a cursor-wide invalidation knob). Optional. */
    sv?: string;
    /**
     * Semantic-delta row digest — `{ itemKey → per-row revision }` of the view at
     * issue time (Lane E). Present only for tools that declared the semantic surface
     * (`itemKey`); lets the NEXT call compute added/updated/removed STATELESSLY from
     * (this digest) + (the current rows) — no server-stored snapshot. Omitted when
     * the view is too large to embed (`DELTA_MAX_DIGEST_ENTRIES`), in which case the
     * tool degrades to `not_modified`/`full` only.
     */
    dg?: Record<string, string>;
    /** Issued-at epoch ms — drives the `maxDeltaAge` periodic-forced-full (Lane E). */
    ts?: number;
}
/** Encode a cursor payload into a compact, URL-safe, opaque token. */
export declare function encodeDeltaCursor(payload: DeltaCursorPayload): string;
/**
 * Decode an opaque cursor token. Returns `null` (never throws) for any malformed
 * / unversioned / structurally-invalid token — the caller treats a `null` decode
 * exactly like a missing cursor and falls back to `full`.
 */
export declare function decodeDeltaCursor(token: string | null | undefined): DeltaCursorPayload | null;
/**
 * The fingerprint that a cursor is bound to. Any change to the tool, the
 * canonical arguments, the auth/scope discriminator, or the requested
 * serialization format produces a different fingerprint, so a cursor minted for
 * one view can never be honored for another (it falls back to `full`).
 *
 * Uses the REQUESTED format (stable across calls), never the served format —
 * which is chosen downstream and would couple the fingerprint to size-guard
 * decisions.
 */
export declare function computeViewFingerprint(input: {
    toolName: string;
    args: unknown;
    scope?: string;
    format?: string;
}): string;
/**
 * A content hash of an arbitrary value (key-sorted, so structurally-equal values
 * hash identically) — the auto-derived view revision for a `delta` capability
 * that declares no `revision` and isn't row-shaped. `not_modified` then means
 * "the whole rendered output is byte-identical to last time" (safe for any shape,
 * incl. a grouped aggregate like `plans:attention`).
 */
export declare function contentRevision(value: unknown): string;
/**
 * An endpoint opts into freshness negotiation by declaring `delta` on its
 * `defineTool`. For Lane B (framework plumbing, no semantic deltas) the minimal
 * contract is just a `revision` source — the monotonic / checksum signal the
 * framework compares against the cursor to answer "did this view change?".
 *
 * Ready-made revision sources the audit confirmed exist (D-002/D-009):
 * `plan_revisions.seq`, a plan row's `version`/`contentHash`/`updatedAt`, cache
 * generation counters, `coord_watermarks` per-channel timestamps.
 *
 * NOTE: the semantic `changesSince(args, cursor, ctx)` that returns
 * added/updated/removed rows is Lane E and deliberately NOT part of this
 * interface yet — adding it is what graduates an endpoint from `not_modified`
 * to true `delta` bodies.
 */
export interface DeltaCapability<Args = unknown, Ctx = unknown> {
    /**
     * The view's current revision/checksum — the freshness signal. Coerced to a
     * string; equal strings ⇒ "unchanged". May be async (e.g. a `SELECT max(seq)`).
     *
     * OPTIONAL: when omitted the framework derives the revision automatically — the
     * view CHECKSUM for a semantic tool (`itemKey` + extractable rows), else a
     * content hash of the whole response data. So the simplest opt-in is `delta:{}`
     * (whole-output content-hash `not_modified`); declare `revision` only for a
     * cheaper/more-precise signal (a `max(seq)` that needn't hash the body).
     *
     * Method-shorthand (not an arrow property) on purpose: it makes the parameter
     * types bivariant, so a `DeltaCapability<SpecificArgs, Ctx>` declared on a
     * `defineTool` is assignable to the framework's `DeltaCapability<unknown,…>`
     * call site. Authors may still write `revision: (args, ctx) => …` (an arrow
     * property satisfies a method signature).
     */
    revision?(args: Args, ctx: Ctx): string | number | Promise<string | number>;
    /**
     * Auth/scope discriminator folded into the fingerprint (e.g.
     * `workspace:harness:role`). Two callers with different scope get different
     * fingerprints, so a cursor never crosses a scope boundary. Defaults to ''.
     */
    scope?(args: Args, ctx: Ctx): string;
    /**
     * Bump this to invalidate EVERY outstanding cursor for the endpoint at once
     * (e.g. after a result-shape change). A cursor whose `sv` differs falls back
     * to `full`.
     */
    schemaVersion?: string;
    /**
     * Extract the diffable ROW ARRAY from the response `data` when `data` is not
     * itself the array (e.g. `plans:attention` returns `{ groups, tierCounts }` —
     * `rows: (d) => d.groups.flatMap(g => g.items)`). Return null/undefined to opt a
     * particular response out of semantic diffing (→ `not_modified`/`full` only).
     * Defaults to "the data IS the array" when omitted.
     */
    rows?(data: unknown): unknown[] | null | undefined;
    /**
     * Stable per-row identity. REQUIRED to emit semantic deltas — it is the `id` in
     * each `DeltaChange` and the key the harness merges on. Must be stable across
     * calls for the "same" logical row.
     */
    itemKey?(row: unknown): string;
    /**
     * Optional FIELD NAME corresponding to `itemKey` (e.g. `'id'`, `'slug'`). Conveyed
     * in the `_meta.delta` response envelope so an OUT-OF-PROCESS client (the MCP proxy)
     * can merge a delta generically — `row[itemKeyField]` — without the `itemKey` function
     * (which can't cross a process boundary). In-process clients read `itemKey` from the
     * registry and ignore this. Declare it ONLY when `itemKey` is a simple field access.
     */
    itemKeyField?: string;
    /**
     * Per-row revision/version — the signal that a row was UPDATED (vs unchanged).
     * Defaults to a content hash of the row when omitted, so `updated` is still
     * detected; declare it when you have a cheaper/more-precise version (e.g. a row
     * `updatedAt` or `version`).
     */
    rowRevision?(row: unknown): string | number;
    /**
     * Optional row type tag, surfaced as `DeltaChange.type` (for heterogeneous
     * views like `plans:attention` whose rows are escalations / plan-items / …).
     */
    rowType?(row: unknown): string;
    /**
     * Optional sort-field name the row data carries — informational for the harness
     * (it re-sorts its merged set by this field; full row data is carried per change
     * so order is reconstructable). The framework's checksum stays set-based.
     */
    orderKey?: string;
    /**
     * Optional endpoint-supplied stateless change source: given the decoded cursor
     * (its `rev`/`ts`/`dg`), return the changes since it. Use for views too large to
     * embed a digest in the cursor (query "rows changed since `rev`" from a watermark
     * source + a tombstone for removals). When omitted, the framework computes the
     * diff generically from the cursor's embedded `dg` + the current rows.
     */
    changesSince?(args: Args, cursor: DeltaCursorPayload, ctx: Ctx): DeltaChange[] | Promise<DeltaChange[]>;
    /**
     * Max cursor age (ms). A cursor older than this forces a full reconciliation
     * (`reason:'max_age'`) — the periodic forced-full that bounds drift accumulation.
     * Omitted ⇒ no age limit.
     */
    maxDeltaAge?: number;
}
export type NegotiatedDeltaMode = 'full' | 'not_modified' | 'delta';
/**
 * Small-response bypass threshold (bytes of the full JSON body). Below this a
 * `not_modified` round-trip barely saves anything once the cursor + envelope
 * (~120 bytes) is counted, so the framework skips delta machinery and serves
 * full with no cursor. (agent-tool-delta-protocol-2026-06-22, P-004.)
 */
export declare const DELTA_SMALL_RESPONSE_BYTES = 256;
/** Why `full` was served despite a `not_modified`/`auto` request (telemetry + harness signal). */
export type DeltaFullReason = 'no_request' | 'requested_full' | 'no_cursor' | 'cursor_malformed' | 'schema_changed' | 'view_changed' | 'changed' | 'revision_error' | 'not_capable' | 'bypass' | 'no_digest' | 'max_age' | 'delta_too_large' | 'changesSince_error' | 'flag_off';
export interface DeltaNegotiation {
    /** What to actually serve. `full` (complete body) | `not_modified` (no body) | `delta` (changed rows only). */
    mode: NegotiatedDeltaMode;
    /** Did the endpoint declare a `DeltaCapability`? Harness uses this to stop re-sending `_delta`. */
    supported: boolean;
    /** The tool's itemKey FIELD NAME (`DeltaCapability.itemKeyField`), conveyed so an
     *  out-of-process client can merge a delta generically (`row[itemKeyField]`). */
    itemKeyField?: string;
    /** Fresh cursor to attach (only for delta-capable, non-bypass responses). */
    cursor?: string;
    /** Present when `mode === 'full'`/`'delta'` despite the client wanting otherwise. */
    reason?: DeltaFullReason;
    /** `mode==='delta'` only: the added/updated/removed rows (full data per changed row). */
    changes?: DeltaChange[];
    /**
     * Set-based checksum of the FULL current view (Lane E). On a `full` or `delta`
     * response the harness stores it; after applying a delta it recomputes the
     * checksum over its merged set and force-fulls on mismatch — the safety net that
     * makes an un-tombstoned removal or any mis-merge degrade to a re-fetch, never a
     * wrong action (D-007).
     */
    checksum?: string;
    /** `mode==='delta'` only: `{ added, updated, removed }` counts for the harness/telemetry. */
    counts?: {
        added: number;
        updated: number;
        removed: number;
    };
}
/**
 * The pure negotiation. Given the parsed request and the endpoint's current
 * revision/fingerprint (both already computed by the caller, since `revision`
 * may be async), decide `full` vs `not_modified` and mint the next cursor.
 *
 * Decision table (delta-capable endpoint):
 *   no request / mode=full / no cursor → full        (+ fresh cursor)
 *   cursor malformed                   → full        (reason: cursor_malformed)
 *   cursor.sv ≠ schemaVersion          → full        (reason: schema_changed)
 *   cursor.fp ≠ currentFingerprint     → full        (reason: view_changed)
 *   cursor.rev === currentRevision     → not_modified (+ fresh cursor)
 *   cursor.rev ≠ currentRevision       → full        (reason: changed)
 *
 * A non-capable endpoint (or the small-response bypass) always returns `full`
 * with `supported:false`/`bypass` and NO cursor.
 */
export declare function negotiateDelta(input: {
    request: DeltaRequest | undefined;
    capabilityDeclared: boolean;
    /** From `DeltaCapability.revision`, stringified. Required when capabilityDeclared. */
    currentRevision?: string;
    /** From `computeViewFingerprint`. Required when capabilityDeclared. */
    currentFingerprint?: string;
    /** From `DeltaCapability.schemaVersion`. */
    schemaVersion?: string;
    /** Small-response bypass: skip negotiation entirely, serve full, no cursor. */
    bypass?: boolean;
    /**
     * Extra fields folded into the freshly-minted cursor — the semantic-delta row
     * digest (`dg`) + issued-at (`ts`) for a Lane-E tool, so the NEXT call can diff
     * from this cursor. Omitted for a Lane-B (`revision`-only) tool.
     */
    cursorExtra?: Pick<DeltaCursorPayload, 'dg' | 'ts'>;
}): DeltaNegotiation;
/** Install the host's flag-backed resolver (Papercusp wires this at boot). */
export declare function setSemanticDeltaEnabledResolver(fn: (ctx: unknown) => boolean | Promise<boolean>): void;
/** Reset to the always-on default (tests). */
export declare function resetSemanticDeltaEnabledResolver(): void;
/** Is the `mode:'delta'` upgrade permitted for this call? (full/not_modified are always allowed.) */
export declare function isSemanticDeltaEnabled(ctx: unknown): boolean | Promise<boolean>;
/**
 * Max rows whose digest is embedded in a cursor. Above this the digest is omitted
 * (the cursor stays small) and the tool degrades to `not_modified`/`full` only —
 * a bounded view (e.g. `plans:attention`, tens of rows) gets full semantic deltas;
 * an unbounded one should supply `changesSince` (watermark-backed) instead.
 */
export declare const DELTA_MAX_DIGEST_ENTRIES = 500;
/**
 * A single semantic change in a `mode:'delta'` response (D-003 LLM-facing shape;
 * NOT JSON Patch). `added`/`updated` carry the FULL row `data` — a changed row
 * never depends on the model's base, only completeness + removals do. `removed`
 * carries just the `id`.
 */
export interface DeltaChange<T = unknown> {
    change: 'added' | 'updated' | 'removed';
    /** `itemKey` of the row. */
    id: string;
    /** Optional row type tag (heterogeneous views). */
    type?: string;
    /** Full row data for `added`/`updated`; omitted for `removed`. */
    data?: T;
    /** Optional per-row note (e.g. why it changed). */
    reason?: string;
}
/**
 * `{ itemKey → rowRevision }` for the current rows — the digest embedded in a
 * cursor so the next call can diff statelessly. Returns null when the view
 * exceeds `DELTA_MAX_DIGEST_ENTRIES` (caller omits the digest → no semantic delta).
 */
export declare function computeRowDigest(rows: readonly unknown[], itemKey: (row: unknown) => string, rowRevision?: (row: unknown) => string | number): Record<string, string> | null;
/**
 * A set-based checksum of the full view — a stable hash over the sorted
 * `id=rev` pairs. The harness recomputes the SAME over its merged set and
 * force-fulls on mismatch (D-007). Order-insensitive: the harness re-sorts by the
 * declared `orderKey` field carried in each row's data, so a pure reorder doesn't
 * need to bust the checksum.
 */
export declare function computeViewChecksum(rows: readonly unknown[], itemKey: (row: unknown) => string, rowRevision?: (row: unknown) => string | number): string;
/**
 * Compute added/updated/removed from a prior cursor digest + the current rows —
 * the generic stateless differ used when the endpoint declares no `changesSince`.
 * Complete (incl. removals) because the prior state IS the digest. `added` =
 * id absent from the digest; `updated` = id present but the rowRevision differs;
 * `removed` = a digest id absent from the current rows.
 */
export declare function diffFromDigest(priorDigest: Record<string, string>, rows: readonly unknown[], itemKey: (row: unknown) => string, opts?: {
    rowRevision?: (row: unknown) => string | number;
    rowType?: (row: unknown) => string;
}): DeltaChange[];
/**
 * Reference merge — apply a delta to a base row-set, keyed by `itemKey`. This is
 * exactly what the agent harness must do to reconstruct the full view from its
 * retained base + a `mode:'delta'` response; exported so the harness (and the
 * tests that prove merge-correctness) share ONE implementation. Returns the
 * merged rows in insertion order (the caller re-sorts by `orderKey`).
 */
export declare function applySemanticDelta<T>(base: readonly T[], changes: readonly DeltaChange<T>[], itemKey: (row: T) => string): T[];
/** `{ added, updated, removed }` counts over a change set (for the envelope + telemetry). */
export declare function deltaCounts(changes: readonly DeltaChange[]): {
    added: number;
    updated: number;
    removed: number;
};
