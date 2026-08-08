/**
 * Payload tiers — a per-session / per-call axis over WHAT a tool returns
 * (field selection, row caps), distinct from the result-FORMAT axis
 * (serialize-result.ts, which encodes whatever data it is given).
 *
 * Contract (context-trimming-tiers-2026-07-01 D-004, owner-ratified):
 *   - `full` IS the tool's unshaped response while it fits the transport.
 *     Normal-size unshaped tools remain byte-identical (zero migration);
 *     oversized default-tier responses get a loud generic projection.
 *   - Tools opt in incrementally by declaring `shape.standard` /
 *     `shape.trimmed` on their definition; resolution falls back
 *     trimmed → standard → full.
 *   - The session's tier rides the host context (`ctx.contextTier`, wired by
 *     the host from its transport — e.g. an MCP URL param); any single call
 *     may override with a `payloadTier` arg (stripped before schema
 *     validation), so a trimmed session can always fetch one full payload.
 *   - Shaping NEVER breaks a call: a throwing shaper logs and serves the
 *     unshaped data.
 *   - No silent caps at the meta level: when a non-full session would receive
 *     a LARGE unshaped payload, the framework returns a bounded projection
 *     with omission evidence + a full-detail re-fetch instruction. A
 *     once-per-tool ratchet warning still names the missing custom shaper.
 *   - HARD CEILING (WI-2859): even `full` must fit the transport result cap —
 *     an over-cap result is rejected/file-dumped by the client, which is worse
 *     than a graceful downgrade. So a result over PAYLOAD_TIER_HARD_CEILING_CHARS
 *     force-applies the smallest declared shaper regardless of the resolved tier.
 */
import type { ToolResponse } from './types';

export type PayloadTier = 'trimmed' | 'standard' | 'full';
export const PAYLOAD_TIERS: readonly PayloadTier[] = ['trimmed', 'standard', 'full'] as const;

/** Context handed to a shaper: the validated call args + the resolved tier. */
export interface PayloadShaperCtx {
  args: unknown;
  tier: 'trimmed' | 'standard';
}

/**
 * Per-tool payload shapers. Each takes the handler's `data` and returns the
 * tier-appropriate projection of it (smaller field set, capped rows — with
 * counts/pointers for anything dropped, never a silent cap). Both optional:
 * absent tiers fall back down the chain (trimmed → standard → full).
 */
export interface PayloadShapers {
  standard?: (data: unknown, sctx: PayloadShaperCtx) => unknown;
  trimmed?: (data: unknown, sctx: PayloadShaperCtx) => unknown;
}

export function parsePayloadTier(v: unknown): PayloadTier | undefined {
  return typeof v === 'string' && (PAYLOAD_TIERS as readonly string[]).includes(v)
    ? (v as PayloadTier)
    : undefined;
}

/**
 * Pull a per-call `payloadTier` override out of the RAW input (before schema
 * validation — the arg is framework-reserved, not part of any tool's schema).
 * Unknown/absent values leave the input untouched.
 */
export function extractPayloadTier(input: unknown): { input: unknown; callTier?: PayloadTier } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { input };
  const raw = (input as Record<string, unknown>).payloadTier;
  if (raw === undefined) return { input };
  const callTier = parsePayloadTier(raw);
  const { payloadTier: _dropped, ...rest } = input as Record<string, unknown>;
  return { input: rest, callTier };
}

/** Per-call override outranks the session tier; absent both ⇒ full. */
export function resolvePayloadTier(
  callTier: PayloadTier | undefined,
  ctxTier: PayloadTier | undefined,
): PayloadTier {
  return callTier ?? ctxTier ?? 'full';
}

/** Unshaped payloads above this (JSON chars) served to a non-full session trip
 *  the ratchet warning — roughly the "worth writing a shaper" bar. */
export const PAYLOAD_TIER_RATCHET_CHARS = 8_000;

/**
 * HARD CEILING (JSON chars). A tool result — even `full`, even an already-shaped
 * one — must NEVER exceed the transport's result cap: the MCP client rejects an
 * over-cap result and dumps it to a file the caller has to page back in (the
 * coord:orient 59.8KB incident, WI-2859). So when a response exceeds this and the
 * tool DECLARED a shaper, force-apply the SMALLEST shaper regardless of the
 * resolved tier — graceful degradation (top rows + fetch-pointers) instead of a
 * hard failure. Set well under a typical client cap; force-shaping only ever
 * triggers on genuinely oversized payloads, so normal results are untouched. */
export const PAYLOAD_TIER_HARD_CEILING_CHARS = 30_000;

/** Generic projections intentionally leave ample room for transport envelopes. */
const GENERIC_PROJECTION_TARGET_CHARS: Record<'trimmed' | 'standard', number> = {
  trimmed: 7_000,
  standard: 18_000,
};
const GENERIC_PROJECTION_OMISSION_SAMPLES = 20;

export interface BoundedPayloadProjection {
  _projection: {
    kind: 'bounded-payload';
    truncated: true;
    tier: PayloadTier;
    forced: boolean;
    originalChars: number;
    returnedChars: number;
    omittedCount: number;
    omitted: Array<{ path: string; reason: string }>;
    cursor: {
      kind: 'full-detail';
      tool: string;
      args: Record<string, unknown> & { payloadTier: 'full' };
    };
    next: string;
  };
  [key: string]: unknown;
}

/** Once-per-(tool,tier) dedup for ratchet warnings — a worklist, not a log storm. */
const ratchetWarned = new Set<string>();

/** Test seam. */
export function resetPayloadTierRatchet(): void {
  ratchetWarned.clear();
}

/** Best-effort serialized length; 0 on a circular/throwing value. */
function jsonLen(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

interface ProjectionState {
  remaining: number;
  omittedCount: number;
  omitted: Array<{ path: string; reason: string }>;
  active: WeakSet<object>;
  limits: { maxArray: number; maxDepth: number; maxKeys: number; maxString: number };
}

function recordOmission(state: ProjectionState, path: string, reason: string, count = 1): void {
  state.omittedCount += Math.max(1, count);
  if (state.omitted.length < GENERIC_PROJECTION_OMISSION_SAMPLES) {
    state.omitted.push({ path, reason });
  }
}

/**
 * A clipped string must ANNOUNCE ITS OWN CLIPPING, IN BAND.
 *
 * EI-19447969329510166. The previous marker was a bare `…` — a character that
 * occurs constantly inside real content (checkpoints, prose, tool guidance,
 * this very file's comments), so a truncated value was INDISTINGUISHABLE from a
 * complete one. The only evidence lived in a sibling `_projection.omitted` entry
 * the reader has to think to correlate.
 *
 * Measured cost: a `work_items:get` checkpoint clipped from ~13,000 chars to 800
 * read as a complete (if terse) note — the visible head ended mid-sentence at a
 * `-` and the reader nearly acted on a SUPERSEDED root-cause block whose
 * retraction sat in the dropped 85%. On the designated continuity surface a
 * silent clip does not merely lose information, it MANUFACTURES confident wrong
 * state, which is strictly worse than returning nothing.
 *
 * The marker is charged to the same projection budget as the content, so keep it
 * cheap — but never confusable with content. The square-bracket form matches
 * this file's existing `[circular]` / `[omitted: projection budget]` convention,
 * and `TRUNCATED` is greppable in a transcript.
 */
function truncationMarker(omittedChars: number): string {
  return `…[TRUNCATED +${omittedChars} chars — see _projection.cursor]`;
}

function clipString(value: string, keep: number): string {
  const head = value.slice(0, Math.max(0, keep));
  return `${head}${truncationMarker(value.length - head.length)}`;
}

/**
 * WI-36048 (borrow item 1 of the opencode/OMP token-reduction research).
 *
 * The sibling of `truncationMarker` above, for values dropped WHOLE rather than
 * clipped. Both answer the same question — "what was here, and can I get it
 * back?" — and until now only the clip path did.
 *
 * The comparison that motivated it: OMP replaces evicted content with
 * `[shaken ~N tokens — recover: artifact://<id> (region N)]`; opencode uses a
 * fixed `[Old tool result content cleared]`. The first tells the model how much
 * went and how to get it back, so it can decide whether recovery is worth a
 * call; the second tells it neither, so the only rational move is to re-run the
 * whole tool or silently proceed on partial data. Our bare
 * `[omitted: projection budget]` was the second kind.
 *
 * ⚠ The research is equally explicit that a self-describing placeholder is WORSE
 * than nothing if the recovery pointer it advertises does not resolve — it
 * becomes a lie the model trusts. So the pointer here is deliberately NOT the
 * result-door spill, which provably cannot recover these (the omitted values are
 * never serialized, so they are not in the spill either). It is the re-call with
 * an EXPLICIT `payloadTier:'full'`, which sets `explicitFullRequest` — the one
 * documented exit from the hard-ceiling force-shape (see applyPayloadTier
 * below). That path resolves; the spill path does not.
 *
 * Size is included only where the caller ALREADY computed it. The depth-boundary
 * sites deliberately omit it rather than pay a `JSON.stringify` per dropped node
 * — this marker is charged to the same projection budget as the content it
 * replaces, so it stays cheap.
 */
function omissionMarker(reason: string, omittedChars?: number): string {
  const size = omittedChars != null && omittedChars > 0 ? `, ~${omittedChars} chars` : '';
  return `[omitted: ${reason}${size} — recover: re-call with payloadTier:'full']`;
}

function takePrimitive(state: ProjectionState, value: unknown, path: string): unknown {
  if (typeof value !== 'string') {
    const size = jsonLen(value);
    if (size > state.remaining) {
      recordOmission(state, path, 'value omitted to fit projection budget');
      return omissionMarker('projection budget', size);
    }
    state.remaining -= size;
    return value;
  }

  // Two independent clip pressures — the per-tier `maxString` cap and the
  // running budget. The SECOND one used to be entirely silent: the old halving
  // loop appended a bare `…` and never called recordOmission at all, so a string
  // clipped by budget alone produced NO in-band marker AND no `_projection`
  // entry — nothing anywhere said it had been cut. Both paths now converge on
  // one clip + exactly one omission record carrying the FINAL char count.
  let keep = value.length > state.limits.maxString ? state.limits.maxString : value.length;
  let candidate = keep < value.length ? clipString(value, keep) : value;
  let size = jsonLen(candidate);
  while (size > state.remaining && keep > 32) {
    keep = Math.max(32, Math.floor(keep / 2) - 1);
    candidate = clipString(value, keep);
    size = jsonLen(candidate);
  }
  if (keep < value.length) {
    recordOmission(state, path, `${value.length - keep} string characters omitted`);
  }
  if (size > state.remaining) {
    recordOmission(state, path, 'value omitted to fit projection budget');
    // The WHOLE string is dropped here, not the clipped candidate — so the
    // omitted amount is the original length, which we already have for free.
    return omissionMarker('projection budget', value.length);
  }
  state.remaining -= size;
  return candidate;
}

/**
 * Identity fields survive when a useful row lands exactly at the generic depth
 * limit. EI-11404's concrete failure was a recipes:run summary containing ten
 * successful work_items:get envelopes: every array element became the same
 * `[omitted: depth limit]` scalar, erasing the ids needed to fetch or act on a
 * row. At the boundary we now spend the remaining budget on a deliberately
 * small per-row projection instead of erasing the whole value.
 */
const IDENTITY_FIELDS = new Set([
  'id', 'title', 'name', 'slug', 'ref', 'kind', 'state', 'status', 'ok', 'error',
  'item', 'itemId', 'plan', 'planSlug', 'rubricRef', 'workItemId',
]);
const IDENTITY_ENVELOPES = new Set(['results', 'items', 'workItem', 'counts']);
const IDENTITY_PREVIEW_DEPTH = 4;

function projectIdentityPreview(
  value: unknown,
  path: string,
  depth: number,
  state: ProjectionState,
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return takePrimitive(state, value, path);
  }
  if (typeof value === 'bigint') return takePrimitive(state, value.toString(), path);
  if (typeof value === 'undefined') return takePrimitive(state, '[undefined]', path);
  if (typeof value === 'function' || typeof value === 'symbol') {
    return takePrimitive(state, `[${typeof value}]`, path);
  }
  if (value instanceof Date) return takePrimitive(state, value.toISOString(), path);
  if (value instanceof Error) {
    return projectIdentityPreview({ name: value.name, error: value.message }, path, depth, state);
  }
  if (typeof value !== 'object') return takePrimitive(state, String(value), path);
  if (state.active.has(value)) {
    recordOmission(state, path, 'circular reference omitted');
    return '[circular]';
  }
  if (depth >= IDENTITY_PREVIEW_DEPTH) {
    recordOmission(state, path, 'non-identity detail omitted at compact preview depth');
    return omissionMarker('compact preview depth');
  }

  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      const shown = value.slice(0, state.limits.maxArray);
      const projected: unknown[] = [];
      for (let i = 0; i < shown.length; i += 1) {
        if (state.remaining < 128) {
          recordOmission(state, `${path}[${i}]`, 'remaining identity rows omitted to fit projection budget', value.length - i);
          break;
        }
        projected.push(projectIdentityPreview(shown[i], `${path}[${i}]`, depth + 1, state));
      }
      if (value.length > shown.length) {
        recordOmission(state, `${path}[${shown.length}]`, `${value.length - shown.length} identity rows omitted`, value.length - shown.length);
      }
      return projected;
    }

    const entries = Object.entries(value as Record<string, unknown>);
    const chosen = entries.filter(([key]) => IDENTITY_FIELDS.has(key) || IDENTITY_ENVELOPES.has(key));
    if (chosen.length === 0) {
      recordOmission(state, path, 'nested value omitted at projection depth limit');
      return omissionMarker('depth limit');
    }

    const projected: Record<string, unknown> = {};
    for (const [key, child] of chosen) {
      const keyCost = jsonLen(key) + 2;
      if (state.remaining < keyCost + 128) {
        recordOmission(state, `${path}.${key}`, 'remaining identity fields omitted to fit projection budget', chosen.length - Object.keys(projected).length);
        break;
      }
      state.remaining -= keyCost;
      projected[key] = projectIdentityPreview(child, `${path}.${key}`, depth + 1, state);
    }
    const dropped = entries.length - chosen.length;
    if (dropped > 0) {
      recordOmission(state, `${path}.*`, `${dropped} non-identity fields omitted at projection depth limit`, dropped);
    }
    return projected;
  } finally {
    state.active.delete(value);
  }
}

function projectValue(value: unknown, path: string, depth: number, state: ProjectionState): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return takePrimitive(state, value, path);
  }
  if (typeof value === 'bigint') return takePrimitive(state, value.toString(), path);
  if (typeof value === 'undefined') return takePrimitive(state, '[undefined]', path);
  if (typeof value === 'function' || typeof value === 'symbol') {
    return takePrimitive(state, `[${typeof value}]`, path);
  }
  if (value instanceof Date) return takePrimitive(state, value.toISOString(), path);
  if (value instanceof Error) {
    return projectValue({ name: value.name, message: value.message }, path, depth, state);
  }
  if (typeof value !== 'object') return takePrimitive(state, String(value), path);
  if (state.active.has(value)) {
    recordOmission(state, path, 'circular reference omitted');
    return '[circular]';
  }
  if (depth >= state.limits.maxDepth) {
    recordOmission(state, path, 'nested value compacted at projection depth limit');
    return projectIdentityPreview(value, path, 0, state);
  }

  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      const shown = value.slice(0, state.limits.maxArray);
      const projected: unknown[] = [];
      for (let i = 0; i < shown.length; i += 1) {
        if (state.remaining < 128) {
          recordOmission(state, `${path}[${i}]`, 'remaining array values omitted to fit projection budget', value.length - i);
          break;
        }
        projected.push(projectValue(shown[i], `${path}[${i}]`, depth + 1, state));
      }
      if (value.length > shown.length) {
        recordOmission(state, `${path}[${shown.length}]`, `${value.length - shown.length} array items omitted`, value.length - shown.length);
      }
      return projected;
    }

    // EI-18683546971375407: project IDENTITY_FIELDS (id/ok/kind/title/status/…)
    // BEFORE any other key, regardless of the object's own insertion order. Without
    // this, a bulk `results[i]` element whose non-identity fields (workItem,
    // checkpoint, summary, …) are large can exhaust `state.remaining` partway
    // through the key loop — and since the budget check below breaks the loop the
    // MOMENT it trips, whichever keys hadn't been reached yet (often `id` itself,
    // since handlers conventionally return `{ ok, id, ...detail }` but detail is
    // what's bulky) are silently dropped, producing a bare `{ok:true}` or even `{}`
    // stub that has lost its correlation key entirely. That reads exactly like a
    // dropped row (a bulk caller sees fewer usable results than ids requested,
    // `ok:true`, no error) when the row was actually present, just stripped bare by
    // projection. Same failure CLASS as EI-11404's depth-limit case (which already
    // fixed the analogous problem at the nesting-depth boundary via
    // projectIdentityPreview) — this fixes the budget-exhaustion boundary in the
    // NORMAL (non-depth-limited) path with the same IDENTITY_FIELDS priority.
    const entries = Object.entries(value as Record<string, unknown>);
    const prioritized = entries.length > 1
      ? [...entries].sort((a, b) => Number(IDENTITY_FIELDS.has(b[0])) - Number(IDENTITY_FIELDS.has(a[0])))
      : entries;
    const projected: Record<string, unknown> = {};
    const shown = prioritized.slice(0, state.limits.maxKeys);
    for (let i = 0; i < shown.length; i += 1) {
      const [key, child] = shown[i];
      const keyCost = jsonLen(key) + 2;
      if (state.remaining < keyCost + 128) {
        recordOmission(state, `${path}.${key}`, 'remaining fields omitted to fit projection budget', shown.length - i);
        break;
      }
      state.remaining -= keyCost;
      projected[key] = projectValue(child, `${path}.${key}`, depth + 1, state);
    }
    if (prioritized.length > shown.length) {
      recordOmission(state, `${path}.*`, `${prioritized.length - shown.length} object fields omitted`, prioritized.length - shown.length);
    }
    return projected;
  } finally {
    state.active.delete(value);
  }
}

/**
 * Framework fallback for a large result whose tool has no usable custom
 * shaper. It preserves a structural preview, makes every omission explicit,
 * and points to the opt-in full-detail request. The returned value is always
 * an object so arrays/scalars can carry projection metadata too.
 */
export function projectBoundedPayload(
  data: unknown,
  opts: { toolName: string; tier: PayloadTier; forced?: boolean; originalChars?: number; args?: unknown },
): BoundedPayloadProjection {
  const projectionTier = opts.tier === 'standard' ? 'standard' : 'trimmed';
  const target = GENERIC_PROJECTION_TARGET_CHARS[projectionTier];
  const state: ProjectionState = {
    remaining: Math.max(1_000, target - 1_600),
    omittedCount: 0,
    omitted: [],
    active: new WeakSet<object>(),
    limits: projectionTier === 'standard'
      ? { maxArray: 40, maxDepth: 8, maxKeys: 100, maxString: 2_500 }
      : { maxArray: 12, maxDepth: 5, maxKeys: 40, maxString: 800 },
  };
  const preview = projectValue(data, '$', 0, state);
  const metadata: BoundedPayloadProjection['_projection'] = {
    kind: 'bounded-payload',
    truncated: true,
    tier: opts.tier,
    forced: opts.forced === true,
    originalChars: opts.originalChars ?? jsonLen(data),
    returnedChars: 0,
    omittedCount: Math.max(1, state.omittedCount),
    omitted: state.omitted,
    cursor: {
      kind: 'full-detail',
      tool: opts.toolName,
      args: {
        ...(opts.args && typeof opts.args === 'object' && !Array.isArray(opts.args)
          ? opts.args as Record<string, unknown>
          : {}),
        payloadTier: 'full',
      },
    },
    // EI-19447969329510166: this used to read "Call <tool> with the EXACT args in
    // _projection.cursor.args" — advice that is literally un-executable from a
    // schema-validating client. `payloadTier` is framework-reserved: it is pulled
    // off the raw input by extractPayloadTier BEFORE schema validation, so it is
    // deliberately absent from every published input schema, and
    // deepStrictifyInPlace stamps those schemas additionalProperties:false. The
    // caller therefore gets a validation rejection while following the tool's own
    // printed recovery instruction — at exactly the moment they are trying to
    // recover a field they have just been told was dropped. Say what is true.
    next:
      `Call ${opts.toolName} again with _projection.cursor.args for full detail. ` +
      `NOTE: 'payloadTier' is FRAMEWORK-RESERVED — stripped before schema validation and absent from ` +
      `${opts.toolName}'s published schema (additionalProperties:false), so a schema-validating client ` +
      `REJECTS it on a direct call; route these args through your host's raw-args dispatch path instead.`,
  };
  let result: BoundedPayloadProjection = Array.isArray(preview)
    ? { items: preview, _projection: metadata }
    : preview && typeof preview === 'object'
      ? { ...(preview as Record<string, unknown>), _projection: metadata }
      : { value: preview, _projection: metadata };
  metadata.returnedChars = jsonLen(result);

  // Exact last-line defense: pathological keys/escaping must not defeat the
  // transport bound even if the approximate recursion budget under-counted.
  if (metadata.returnedChars >= PAYLOAD_TIER_HARD_CEILING_CHARS) {
    result = {
      summary: '[payload preview omitted: serialized projection exceeded transport budget]',
      _projection: { ...metadata, returnedChars: 0 },
    };
    result._projection.returnedChars = jsonLen(result);
  }
  return result;
}

/** Stamp a marker so a caller can tell its `full`/`standard` request was
 *  force-downgraded to fit the transport cap (and can re-fetch specifics via the
 *  in-payload `*Truncated` pointers). No-op on non-object data. */
function markForced(data: unknown): unknown {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? { ...(data as Record<string, unknown>), payloadTierForced: 'trimmed' }
    : data;
}

export interface ApplyPayloadTierOpts {
  toolName: string;
  shape: PayloadShapers | undefined;
  response: ToolResponse;
  tier: PayloadTier;
  /**
   * True when the CALLER explicitly passed `payloadTier: 'full'` on this call
   * (as opposed to 'full' merely being the resolved default). An explicit full
   * request is the documented escape hatch out of shaping (every shaper `hint`
   * points at it — e.g. plans:attention's attention-shape.ts) and is how
   * capped-transport-exempt consumers (the in-process sync-resolver / admin-UI
   * dispatch, which feed the operator UI) read the unshaped payload. It SKIPS
   * the hard-ceiling force-shape below: before this flag the ceiling re-trimmed
   * even explicit-full reads, which silently emptied every plans.attention UI
   * surface (Queue / Overview needs-you / sidebar Inbox — WI-5078: the UI's
   * normalizeAttentionGroups drops the item-less summary rows the forced
   * shaper emits). An MCP agent that explicitly asks for full and overflows
   * its client cap gets the client's own result-door (file + paged reads) —
   * a deliberate choice, not a silent failure.
   */
  explicitFullRequest?: boolean;
  args: unknown;
  log?: (msg: string) => void;
}

/**
 * Apply the resolved tier's shaper to a `{ data }` response.
 * Resolution: trimmed → shape.trimmed ?? shape.standard ?? unshaped;
 * standard → shape.standard ?? generic bounded projection; full → unshaped
 * while it fits the transport. A missing/throwing shaper on a LARGE default
 * payload fires the once-per-tool ratchet warning and returns the generic
 * projection instead of flooding the model context.
 *
 * FINALLY, regardless of RESOLVED tier, a HARD CEILING guard force-applies the
 * smallest available shaper if the result is still oversized — so a shaper-tool
 * can never emit a result the transport rejects (WI-2859). The ONE exit is an
 * EXPLICIT per-call `payloadTier: 'full'` (`explicitFullRequest`) — the escape
 * hatch every shaper hint documents, and the contract the UI's in-process
 * dispatch relies on (WI-5078).
 */
export function applyPayloadTier(opts: ApplyPayloadTierOpts): ToolResponse {
  const { toolName, shape, response, tier, explicitFullRequest, args, log } = opts;
  if (!response || typeof response !== 'object' || response.data === undefined) return response;

  // 1. Normal tier shaping (full ⇒ no tier shaper; keeps prior behavior).
  let out: ToolResponse = response;
  const tierShaper =
    tier === 'full' ? undefined : tier === 'trimmed' ? (shape?.trimmed ?? shape?.standard) : shape?.standard;
  let customShapeApplied = false;
  if (tierShaper) {
    try {
      // `tierShaper` is only ever set (see the ternary above) when
      // `tier !== 'full'` — TS can't see that implication through the
      // separate `tierShaper` variable, so narrow explicitly at the call
      // site rather than widening PayloadShaperCtx.tier to include 'full'
      // (a shaper is never invoked for 'full', so it should never need to
      // handle it).
      out = { ...response, data: tierShaper(response.data, { args, tier: tier as 'trimmed' | 'standard' }) };
      customShapeApplied = true;
    } catch (err) {
      (log ?? console.warn)(
        `[payload-tier] ${toolName} ${tier} shaper threw (serving unshaped data): ${err instanceof Error ? err.message : String(err)}`,
      );
      out = response;
    }
  }

  if (tier !== 'full' && !customShapeApplied) {
    // Ratchet + safe default: name fat unshaped payloads and bound them now.
    const size = jsonLen(response.data);
    const key = `${toolName} ${tier}`;
    if (size > PAYLOAD_TIER_RATCHET_CHARS) {
      if (!ratchetWarned.has(key)) {
        ratchetWarned.add(key);
        (log ?? console.warn)(
          `[payload-tier] ${toolName} bounded a ${size}-char unshaped payload for a '${tier}' session — add shape.${tier} for a domain-specific projection (context-trimming-tiers P-011)`,
        );
      }
      const projected = projectBoundedPayload(response.data, { toolName, tier, originalChars: size, args });
      out = {
        ...response,
        data: projected,
        payloadProjection: {
          truncated: true,
          tier: projected._projection.tier,
          forced: projected._projection.forced,
          originalChars: projected._projection.originalChars,
          returnedChars: projected._projection.returnedChars,
          omittedCount: projected._projection.omittedCount,
        },
      };
    }
  }

  // 2. Hard ceiling: never emit an over-cap result. Prefer the tool's smallest
  //    domain-specific shaper, then fall back to the generic bounded projection.
  //    An EXPLICIT payloadTier:'full' call opts out (see explicitFullRequest) —
  //    that is the documented escape hatch, and the UI/sync in-process path.
  if (explicitFullRequest) return out;
  const size = jsonLen(out.data);
  if (size > PAYLOAD_TIER_HARD_CEILING_CHARS) {
    const smallest = shape?.trimmed ?? shape?.standard;
    if (smallest) {
      try {
        const forced = smallest(response.data, { args, tier: 'trimmed' });
        const forcedSize = jsonLen(forced);
        // Only swap if it genuinely shrank (a trimmed tier already at this size
        // gains nothing — that shaper still needs to bound a growing field).
        if (forcedSize < size && forcedSize <= PAYLOAD_TIER_HARD_CEILING_CHARS) {
          (log ?? console.warn)(
            `[payload-tier] ${toolName} '${tier}' result ${size} chars > hard ceiling ${PAYLOAD_TIER_HARD_CEILING_CHARS}; force-applied the trimmed shaper (${forcedSize} chars) to fit the transport cap (WI-2859)`,
          );
          return {
            ...response,
            data: markForced(forced),
            // No `_projection` marker rides a custom shaper's own output, but
            // it is exactly as lossy from the door's point of view: `data` was
            // swapped for a smaller representation than the tool's true full
            // result. Flag it the same way (EI-13918) — omittedCount is
            // unknown here (the shaper owns its own omission bookkeeping), so
            // report it as unspecified (0) rather than fabricate a count.
            payloadProjection: {
              truncated: true,
              tier: 'trimmed',
              forced: true,
              originalChars: size,
              returnedChars: forcedSize,
              omittedCount: 0,
            },
          };
        }
      } catch (err) {
        (log ?? console.warn)(
          `[payload-tier] ${toolName} hard-ceiling force-shape threw (using generic bounded projection): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    (log ?? console.warn)(
      `[payload-tier] ${toolName} '${tier}' result ${size} chars > hard ceiling ${PAYLOAD_TIER_HARD_CEILING_CHARS}; used the generic bounded projection to fit the transport cap`,
    );
    {
      const projected = projectBoundedPayload(out.data, { toolName, tier, forced: true, originalChars: size, args });
      return {
        ...response,
        data: projected,
        payloadProjection: {
          truncated: true,
          tier: projected._projection.tier,
          forced: projected._projection.forced,
          originalChars: projected._projection.originalChars,
          returnedChars: projected._projection.returnedChars,
          omittedCount: projected._projection.omittedCount,
        },
      };
    }
  }
  return out;
}
