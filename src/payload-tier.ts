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

function takePrimitive(state: ProjectionState, value: unknown, path: string): unknown {
  let candidate = value;
  if (typeof value === 'string' && value.length > state.limits.maxString) {
    candidate = `${value.slice(0, state.limits.maxString)}…`;
    recordOmission(state, path, `${value.length - state.limits.maxString} string characters omitted`);
  }
  let size = jsonLen(candidate);
  while (typeof candidate === 'string' && size > state.remaining && candidate.length > 32) {
    candidate = `${candidate.slice(0, Math.max(32, Math.floor(candidate.length / 2) - 1))}…`;
    size = jsonLen(candidate);
  }
  if (size > state.remaining) {
    recordOmission(state, path, 'value omitted to fit projection budget');
    return '[omitted: projection budget]';
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
    return '[omitted: compact preview depth]';
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
      return '[omitted: depth limit]';
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

    const entries = Object.entries(value as Record<string, unknown>);
    const projected: Record<string, unknown> = {};
    const shown = entries.slice(0, state.limits.maxKeys);
    for (let i = 0; i < shown.length; i += 1) {
      const [key, child] = shown[i];
      const keyCost = jsonLen(key) + 2;
      if (state.remaining < keyCost + 128) {
        recordOmission(state, `${path}.${key}`, 'remaining fields omitted to fit projection budget', entries.length - i);
        break;
      }
      state.remaining -= keyCost;
      projected[key] = projectValue(child, `${path}.${key}`, depth + 1, state);
    }
    if (entries.length > shown.length) {
      recordOmission(state, `${path}.*`, `${entries.length - shown.length} object fields omitted`, entries.length - shown.length);
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
    next: `Call ${opts.toolName} with the exact args in _projection.cursor.args for full detail.`,
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
 * FINALLY, regardless of tier, a HARD CEILING guard force-applies the smallest
 * available shaper if the result is still oversized — so a shaper-tool can never
 * emit a result the transport rejects (WI-2859).
 */
export function applyPayloadTier(opts: ApplyPayloadTierOpts): ToolResponse {
  const { toolName, shape, response, tier, args, log } = opts;
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
      out = { ...response, data: projectBoundedPayload(response.data, { toolName, tier, originalChars: size, args }) };
    }
  }

  // 2. Hard ceiling: never emit an over-cap result. Prefer the tool's smallest
  //    domain-specific shaper, then fall back to the generic bounded projection.
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
          return { ...response, data: markForced(forced) };
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
    return {
      ...response,
      data: projectBoundedPayload(out.data, { toolName, tier, forced: true, originalChars: size, args }),
    };
  }
  return out;
}
