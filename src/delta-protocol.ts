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
  return { v: 1, fp: p.fp, rev: p.rev, ...(typeof p.sv === 'string' ? { sv: p.sv } : {}) };
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
   */
  revision: (args: Args, ctx: Ctx) => string | number | Promise<string | number>;
  /**
   * Auth/scope discriminator folded into the fingerprint (e.g.
   * `workspace:harness:role`). Two callers with different scope get different
   * fingerprints, so a cursor never crosses a scope boundary. Defaults to ''.
   */
  scope?: (args: Args, ctx: Ctx) => string;
  /**
   * Bump this to invalidate EVERY outstanding cursor for the endpoint at once
   * (e.g. after a result-shape change). A cursor whose `sv` differs falls back
   * to `full`.
   */
  schemaVersion?: string;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Negotiation (pure)
 * ────────────────────────────────────────────────────────────────────────── */

export type NegotiatedDeltaMode = 'full' | 'not_modified';

/** Why `full` was served despite a `not_modified`/`auto` request (telemetry + harness signal). */
export type DeltaFullReason =
  | 'no_request' // no _delta on the call
  | 'requested_full' // client asked for full
  | 'no_cursor' // delta requested but first call / no cursor
  | 'cursor_malformed'
  | 'schema_changed'
  | 'view_changed' // fingerprint mismatch (different tool/args/scope/format)
  | 'changed' // same view, but the revision advanced — here is the new state
  | 'not_capable' // endpoint declared no delta capability
  | 'bypass'; // small-response bypass

export interface DeltaNegotiation {
  /** What to actually serve. Lane B: only `full` or `not_modified` — never a partial body. */
  mode: NegotiatedDeltaMode;
  /** Did the endpoint declare a `DeltaCapability`? Harness uses this to stop re-sending `_delta`. */
  supported: boolean;
  /** Fresh cursor to attach (only for delta-capable, non-bypass responses). */
  cursor?: string;
  /** Present when `mode === 'full'` despite the client wanting otherwise. */
  reason?: DeltaFullReason;
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
}): DeltaNegotiation {
  const { request, capabilityDeclared, currentRevision, currentFingerprint, schemaVersion, bypass } = input;

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
