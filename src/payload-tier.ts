/**
 * Payload tiers — a per-session / per-call axis over WHAT a tool returns
 * (field selection, row caps), distinct from the result-FORMAT axis
 * (serialize-result.ts, which encodes whatever data it is given).
 *
 * Contract (context-trimming-tiers-2026-07-01 D-004, owner-ratified):
 *   - `full` IS the tool's unshaped response — an unshaped tool is
 *     byte-identical to its pre-tier behavior on EVERY tier (zero migration).
 *   - Tools opt in incrementally by declaring `shape.standard` /
 *     `shape.trimmed` on their definition; resolution falls back
 *     trimmed → standard → full.
 *   - The session's tier rides the host context (`ctx.contextTier`, wired by
 *     the host from its transport — e.g. an MCP URL param); any single call
 *     may override with a `payloadTier` arg (stripped before schema
 *     validation), so a trimmed session can always fetch one full payload.
 *   - Shaping NEVER breaks a call: a throwing shaper logs and serves the
 *     unshaped data.
 *   - No silent caps at the meta level: when a non-full session receives a
 *     LARGE unshaped payload (no applicable shaper), a once-per-tool ratchet
 *     warning names it — that log is the shaper-migration worklist.
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
 * standard → shape.standard ?? unshaped; full → unshaped. A missing shaper on
 * a LARGE payload fires the once-per-tool ratchet warning (the migration
 * worklist); a throwing shaper logs and serves the unshaped data.
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
  if (tierShaper) {
    try {
      // `tierShaper` is only ever set (see the ternary above) when
      // `tier !== 'full'` — TS can't see that implication through the
      // separate `tierShaper` variable, so narrow explicitly at the call
      // site rather than widening PayloadShaperCtx.tier to include 'full'
      // (a shaper is never invoked for 'full', so it should never need to
      // handle it).
      out = { ...response, data: tierShaper(response.data, { args, tier: tier as 'trimmed' | 'standard' }) };
    } catch (err) {
      (log ?? console.warn)(
        `[payload-tier] ${toolName} ${tier} shaper threw (serving unshaped data): ${err instanceof Error ? err.message : String(err)}`,
      );
      out = response;
    }
  } else if (tier !== 'full') {
    // Ratchet: name the fat unshaped payloads non-full sessions are paying for.
    const size = jsonLen(response.data);
    const key = `${toolName} ${tier}`;
    if (size > PAYLOAD_TIER_RATCHET_CHARS && !ratchetWarned.has(key)) {
      ratchetWarned.add(key);
      (log ?? console.warn)(
        `[payload-tier] ${toolName} served a ${size}-char full payload to a '${tier}' session with no ${tier} shaper — add shape.${tier} (context-trimming-tiers P-011)`,
      );
    }
  }

  // 2. Hard ceiling: never emit an over-cap result. If still oversized and a
  //    shaper exists, force the SMALLEST one (even for `full`).
  const size = jsonLen(out.data);
  if (size > PAYLOAD_TIER_HARD_CEILING_CHARS) {
    const smallest = shape?.trimmed ?? shape?.standard;
    if (smallest) {
      try {
        const forced = smallest(response.data, { args, tier: 'trimmed' });
        const forcedSize = jsonLen(forced);
        // Only swap if it genuinely shrank (a trimmed tier already at this size
        // gains nothing — that shaper still needs to bound a growing field).
        if (forcedSize < size) {
          (log ?? console.warn)(
            `[payload-tier] ${toolName} '${tier}' result ${size} chars > hard ceiling ${PAYLOAD_TIER_HARD_CEILING_CHARS}; force-applied the trimmed shaper (${forcedSize} chars) to fit the transport cap (WI-2859)`,
          );
          return { ...response, data: markForced(forced) };
        }
      } catch (err) {
        (log ?? console.warn)(
          `[payload-tier] ${toolName} hard-ceiling force-shape threw (serving as-is): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return out;
}
