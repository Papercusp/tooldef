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

/* ──────────────────────────────────────────────────────────────────────────
 * Wire request (parsed from `_meta.delta` / `?delta=`)
 * ────────────────────────────────────────────────────────────────────────── */

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
export function parseDeltaRequest(raw: string | null | undefined): DeltaRequest | undefined {
  if (raw == null) return undefined;
  const trimmed = String(raw).trim();
  if (trimmed === '') return undefined;
  const sep = trimmed.indexOf('~');
  const rawMode = (sep === -1 ? trimmed : trimmed.slice(0, sep)).toLowerCase();
  const cursor = sep === -1 ? undefined : trimmed.slice(sep + 1) || undefined;
  const mode: DeltaMode =
    rawMode === 'full' || rawMode === 'not_modified' || rawMode === 'auto' ? (rawMode as DeltaMode) : 'auto';
  return cursor ? { mode, cursor } : { mode };
}

/** Re-serialize a `DeltaRequest` to its wire token (the inverse of `parseDeltaRequest`). */
export function formatDeltaRequest(req: DeltaRequest): string {
  return req.cursor ? `${req.mode}~${req.cursor}` : req.mode;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Stateless opaque cursor
 * ────────────────────────────────────────────────────────────────────────── */

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

function toBase64Url(s: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf8').toString('base64url');
  // Runtime-agnostic fallback (browser/edge): UTF-8 → base64 → base64url.
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  // eslint-disable-next-line no-undef
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string | null {
  try {
    if (typeof Buffer !== 'undefined') return Buffer.from(s, 'base64url').toString('utf8');
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    // eslint-disable-next-line no-undef
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Encode a cursor payload into a compact, URL-safe, opaque token. */
export function encodeDeltaCursor(payload: DeltaCursorPayload): string {
  return toBase64Url(JSON.stringify(payload));
}

/**
 * Decode an opaque cursor token. Returns `null` (never throws) for any malformed
 * / unversioned / structurally-invalid token — the caller treats a `null` decode
 * exactly like a missing cursor and falls back to `full`.
 */
export function decodeDeltaCursor(token: string | null | undefined): DeltaCursorPayload | null {
  if (!token) return null;
  const json = fromBase64Url(token);
  if (json == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1 || typeof p.fp !== 'string' || typeof p.rev !== 'string') return null;
  if (p.sv !== undefined && typeof p.sv !== 'string') return null;
  const dg = isStringRecord(p.dg) ? (p.dg as Record<string, string>) : undefined;
  const ts = typeof p.ts === 'number' && Number.isFinite(p.ts) ? p.ts : undefined;
  return {
    v: 1,
    fp: p.fp,
    rev: p.rev,
    ...(typeof p.sv === 'string' ? { sv: p.sv } : {}),
    ...(dg ? { dg } : {}),
    ...(ts !== undefined ? { ts } : {}),
  };
}

/** True for a flat `{ [string]: string }` object — the shape of a cursor digest. */
function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (typeof val !== 'string') return false;
  }
  return true;
}

/* ──────────────────────────────────────────────────────────────────────────
 * View fingerprint (deterministic, order-insensitive on object keys)
 * ────────────────────────────────────────────────────────────────────────── */

/** Stable, key-sorted JSON — two structurally-equal values stringify identically. */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    if (obj[k] === undefined) continue; // omit undefined — JSON would drop it anyway
    parts.push(`${JSON.stringify(k)}:${canonicalStringify(obj[k])}`);
  }
  return `{${parts.join(',')}}`;
}

/** FNV-1a 64-bit over a string → base36. Pure, deterministic, dependency-free. */
function fnv1a64(str: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(36);
}

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
export function computeViewFingerprint(input: {
  toolName: string;
  args: unknown;
  scope?: string;
  format?: string;
}): string {
  const material = canonicalStringify([
    input.toolName,
    input.args ?? null,
    input.scope ?? '',
    input.format ?? '',
  ]);
  return fnv1a64(material);
}

/**
 * A content hash of an arbitrary value (key-sorted, so structurally-equal values
 * hash identically) — the auto-derived view revision for a `delta` capability
 * that declares no `revision` and isn't row-shaped. `not_modified` then means
 * "the whole rendered output is byte-identical to last time" (safe for any shape,
 * incl. a grouped aggregate like `plans:attention`).
 */
export function contentRevision(value: unknown): string {
  return fnv1a64(canonicalStringify(value));
}

/* ──────────────────────────────────────────────────────────────────────────
 * Endpoint opt-in declaration (D-002 — minimal for Lane B)
 * ────────────────────────────────────────────────────────────────────────── */

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

  /* ── Semantic surface (Lane E) — declaring `itemKey` graduates the tool from
   * `not_modified`-only to true `added/updated/removed` delta bodies. All optional;
   * a tool with only `revision`/`scope`/`schemaVersion` stays Lane-B (full | not_modified). */

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

/* ──────────────────────────────────────────────────────────────────────────
 * Negotiation (pure)
 * ────────────────────────────────────────────────────────────────────────── */

export type NegotiatedDeltaMode = 'full' | 'not_modified' | 'delta';

/**
 * Small-response bypass threshold (bytes of the full JSON body). Below this a
 * `not_modified` round-trip barely saves anything once the cursor + envelope
 * (~120 bytes) is counted, so the framework skips delta machinery and serves
 * full with no cursor. (agent-tool-delta-protocol-2026-06-22, P-004.)
 */
export const DELTA_SMALL_RESPONSE_BYTES = 256;

/** Why `full` was served despite a `not_modified`/`auto` request (telemetry + harness signal). */
export type DeltaFullReason =
  | 'no_request' // no _delta on the call
  | 'requested_full' // client asked for full
  | 'no_cursor' // delta requested but first call / no cursor
  | 'cursor_malformed'
  | 'schema_changed'
  | 'view_changed' // fingerprint mismatch (different tool/args/scope/format)
  | 'changed' // same view, but the revision advanced — here is the new state
  | 'revision_error' // the endpoint's revision() threw — degrade to full
  | 'not_capable' // endpoint declared no delta capability
  | 'bypass' // small-response bypass
  | 'no_digest' // semantic delta wanted but the prior cursor carried no row digest
  | 'max_age' // cursor older than maxDeltaAge — periodic forced-full
  | 'delta_too_large' // the computed delta wasn't smaller than a full resend
  | 'changesSince_error' // the endpoint's changesSince() threw — degrade to full
  | 'flag_off'; // semantic delta gated off by the host (FLAGS.TOOL_DELTA_PROTOCOL) — Lane-B full

export interface DeltaNegotiation {
  /** What to actually serve. `full` (complete body) | `not_modified` (no body) | `delta` (changed rows only). */
  mode: NegotiatedDeltaMode;
  /** Did the endpoint declare a `DeltaCapability`? Harness uses this to stop re-sending `_delta`. */
  supported: boolean;
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
  counts?: { added: number; updated: number; removed: number };
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
export function negotiateDelta(input: {
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
}): DeltaNegotiation {
  const { request, capabilityDeclared, currentRevision, currentFingerprint, schemaVersion, bypass, cursorExtra } = input;

  if (!capabilityDeclared) {
    return { mode: 'full', supported: false, reason: 'not_capable' };
  }
  if (bypass) {
    return { mode: 'full', supported: true, reason: 'bypass' };
  }

  // Capable endpoint always mints a fresh cursor for the CURRENT view+revision.
  const freshCursor = encodeDeltaCursor({
    v: 1,
    fp: currentFingerprint ?? '',
    rev: currentRevision ?? '',
    ...(schemaVersion ? { sv: schemaVersion } : {}),
    ...(cursorExtra?.dg ? { dg: cursorExtra.dg } : {}),
    ...(cursorExtra?.ts !== undefined ? { ts: cursorExtra.ts } : {}),
  });

  if (!request || request.mode === 'full') {
    return { mode: 'full', supported: true, cursor: freshCursor, reason: request ? 'requested_full' : 'no_request' };
  }
  if (!request.cursor) {
    return { mode: 'full', supported: true, cursor: freshCursor, reason: 'no_cursor' };
  }

  const decoded = decodeDeltaCursor(request.cursor);
  if (!decoded) {
    return { mode: 'full', supported: true, cursor: freshCursor, reason: 'cursor_malformed' };
  }
  if ((decoded.sv ?? '') !== (schemaVersion ?? '')) {
    return { mode: 'full', supported: true, cursor: freshCursor, reason: 'schema_changed' };
  }
  if (decoded.fp !== (currentFingerprint ?? '')) {
    return { mode: 'full', supported: true, cursor: freshCursor, reason: 'view_changed' };
  }
  if (decoded.rev === (currentRevision ?? '')) {
    return { mode: 'not_modified', supported: true, cursor: freshCursor };
  }
  return { mode: 'full', supported: true, cursor: freshCursor, reason: 'changed' };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Semantic-delta flag gate (P-016, dormant-safe)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Resolver consulted before UPGRADING a `changed` view to a `mode:'delta'` body.
 * The always-safe modes (`full`, `not_modified`) are NEVER gated — only the
 * semantic added/updated/removed delta is, because it carries the
 * silent-wrong-merge risk the owner BUILD decision retires by test (D-007/D-008).
 *
 * Defaults to ALWAYS-ON so the generic lib + its tests exercise the real path; the
 * Papercusp host overrides it at boot to read the dark `TOOL_DELTA_PROTOCOL` flag
 * (default OFF), so semantic deltas are dormant in production until the P-016
 * flip-gate (recorded Lane-C scenario verdicts) clears.
 */
let semanticDeltaEnabledResolver: (ctx: unknown) => boolean | Promise<boolean> = () => true;

/** Install the host's flag-backed resolver (Papercusp wires this at boot). */
export function setSemanticDeltaEnabledResolver(fn: (ctx: unknown) => boolean | Promise<boolean>): void {
  semanticDeltaEnabledResolver = fn;
}

/** Reset to the always-on default (tests). */
export function resetSemanticDeltaEnabledResolver(): void {
  semanticDeltaEnabledResolver = () => true;
}

/** Is the `mode:'delta'` upgrade permitted for this call? (full/not_modified are always allowed.) */
export function isSemanticDeltaEnabled(ctx: unknown): boolean | Promise<boolean> {
  return semanticDeltaEnabledResolver(ctx);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Semantic deltas (Lane E) — pure row diffing, checksum, and reference merge
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Max rows whose digest is embedded in a cursor. Above this the digest is omitted
 * (the cursor stays small) and the tool degrades to `not_modified`/`full` only —
 * a bounded view (e.g. `plans:attention`, tens of rows) gets full semantic deltas;
 * an unbounded one should supply `changesSince` (watermark-backed) instead.
 */
export const DELTA_MAX_DIGEST_ENTRIES = 500;

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

/** Per-row revision: the endpoint's `rowRevision`, else a stable content hash. */
function rowRev(row: unknown, rowRevision?: (row: unknown) => string | number): string {
  return rowRevision ? String(rowRevision(row)) : fnv1a64(canonicalStringify(row));
}

/**
 * `{ itemKey → rowRevision }` for the current rows — the digest embedded in a
 * cursor so the next call can diff statelessly. Returns null when the view
 * exceeds `DELTA_MAX_DIGEST_ENTRIES` (caller omits the digest → no semantic delta).
 */
export function computeRowDigest(
  rows: readonly unknown[],
  itemKey: (row: unknown) => string,
  rowRevision?: (row: unknown) => string | number,
): Record<string, string> | null {
  if (rows.length > DELTA_MAX_DIGEST_ENTRIES) return null;
  const out: Record<string, string> = {};
  for (const row of rows) out[itemKey(row)] = rowRev(row, rowRevision);
  return out;
}

/**
 * A set-based checksum of the full view — a stable hash over the sorted
 * `id=rev` pairs. The harness recomputes the SAME over its merged set and
 * force-fulls on mismatch (D-007). Order-insensitive: the harness re-sorts by the
 * declared `orderKey` field carried in each row's data, so a pure reorder doesn't
 * need to bust the checksum.
 */
export function computeViewChecksum(
  rows: readonly unknown[],
  itemKey: (row: unknown) => string,
  rowRevision?: (row: unknown) => string | number,
): string {
  const pairs: string[] = [];
  for (const row of rows) pairs.push(`${itemKey(row)}=${rowRev(row, rowRevision)}`);
  pairs.sort();
  return fnv1a64(pairs.join(';'));
}

/**
 * Compute added/updated/removed from a prior cursor digest + the current rows —
 * the generic stateless differ used when the endpoint declares no `changesSince`.
 * Complete (incl. removals) because the prior state IS the digest. `added` =
 * id absent from the digest; `updated` = id present but the rowRevision differs;
 * `removed` = a digest id absent from the current rows.
 */
export function diffFromDigest(
  priorDigest: Record<string, string>,
  rows: readonly unknown[],
  itemKey: (row: unknown) => string,
  opts: { rowRevision?: (row: unknown) => string | number; rowType?: (row: unknown) => string } = {},
): DeltaChange[] {
  const { rowRevision, rowType } = opts;
  const changes: DeltaChange[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = itemKey(row);
    seen.add(id);
    const rev = rowRev(row, rowRevision);
    const type = rowType?.(row);
    if (!(id in priorDigest)) changes.push({ change: 'added', id, ...(type ? { type } : {}), data: row });
    else if (priorDigest[id] !== rev) changes.push({ change: 'updated', id, ...(type ? { type } : {}), data: row });
    // unchanged → omitted
  }
  for (const id of Object.keys(priorDigest)) {
    if (!seen.has(id)) changes.push({ change: 'removed', id });
  }
  return changes;
}

/**
 * Reference merge — apply a delta to a base row-set, keyed by `itemKey`. This is
 * exactly what the agent harness must do to reconstruct the full view from its
 * retained base + a `mode:'delta'` response; exported so the harness (and the
 * tests that prove merge-correctness) share ONE implementation. Returns the
 * merged rows in insertion order (the caller re-sorts by `orderKey`).
 */
export function applySemanticDelta<T>(
  base: readonly T[],
  changes: readonly DeltaChange<T>[],
  itemKey: (row: T) => string,
): T[] {
  const map = new Map<string, T>();
  for (const row of base) map.set(itemKey(row), row);
  for (const c of changes) {
    if (c.change === 'removed') map.delete(c.id);
    else if (c.data !== undefined) map.set(c.id, c.data);
  }
  return [...map.values()];
}

/** `{ added, updated, removed }` counts over a change set (for the envelope + telemetry). */
export function deltaCounts(changes: readonly DeltaChange[]): { added: number; updated: number; removed: number } {
  const counts = { added: 0, updated: 0, removed: 0 };
  for (const c of changes) counts[c.change]++;
  return counts;
}
