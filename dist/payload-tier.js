"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PAYLOAD_TIER_HARD_CEILING_CHARS = exports.PAYLOAD_TIER_RATCHET_CHARS = exports.PAYLOAD_TIERS = void 0;
exports.parsePayloadTier = parsePayloadTier;
exports.extractPayloadTier = extractPayloadTier;
exports.resolvePayloadTier = resolvePayloadTier;
exports.resetPayloadTierRatchet = resetPayloadTierRatchet;
exports.applyPayloadTier = applyPayloadTier;
exports.PAYLOAD_TIERS = ['trimmed', 'standard', 'full'];
function parsePayloadTier(v) {
    return typeof v === 'string' && exports.PAYLOAD_TIERS.includes(v)
        ? v
        : undefined;
}
/**
 * Pull a per-call `payloadTier` override out of the RAW input (before schema
 * validation — the arg is framework-reserved, not part of any tool's schema).
 * Unknown/absent values leave the input untouched.
 */
function extractPayloadTier(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return { input };
    const raw = input.payloadTier;
    if (raw === undefined)
        return { input };
    const callTier = parsePayloadTier(raw);
    const { payloadTier: _dropped, ...rest } = input;
    return { input: rest, callTier };
}
/** Per-call override outranks the session tier; absent both ⇒ full. */
function resolvePayloadTier(callTier, ctxTier) {
    return callTier ?? ctxTier ?? 'full';
}
/** Unshaped payloads above this (JSON chars) served to a non-full session trip
 *  the ratchet warning — roughly the "worth writing a shaper" bar. */
exports.PAYLOAD_TIER_RATCHET_CHARS = 8_000;
/**
 * HARD CEILING (JSON chars). A tool result — even `full`, even an already-shaped
 * one — must NEVER exceed the transport's result cap: the MCP client rejects an
 * over-cap result and dumps it to a file the caller has to page back in (the
 * coord:orient 59.8KB incident, WI-2859). So when a response exceeds this and the
 * tool DECLARED a shaper, force-apply the SMALLEST shaper regardless of the
 * resolved tier — graceful degradation (top rows + fetch-pointers) instead of a
 * hard failure. Set well under a typical client cap; force-shaping only ever
 * triggers on genuinely oversized payloads, so normal results are untouched. */
exports.PAYLOAD_TIER_HARD_CEILING_CHARS = 30_000;
/** Once-per-(tool,tier) dedup for ratchet warnings — a worklist, not a log storm. */
const ratchetWarned = new Set();
/** Test seam. */
function resetPayloadTierRatchet() {
    ratchetWarned.clear();
}
/** Best-effort serialized length; 0 on a circular/throwing value. */
function jsonLen(v) {
    try {
        return JSON.stringify(v)?.length ?? 0;
    }
    catch {
        return 0;
    }
}
/** Stamp a marker so a caller can tell its `full`/`standard` request was
 *  force-downgraded to fit the transport cap (and can re-fetch specifics via the
 *  in-payload `*Truncated` pointers). No-op on non-object data. */
function markForced(data) {
    return data && typeof data === 'object' && !Array.isArray(data)
        ? { ...data, payloadTierForced: 'trimmed' }
        : data;
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
function applyPayloadTier(opts) {
    const { toolName, shape, response, tier, args, log } = opts;
    if (!response || typeof response !== 'object' || response.data === undefined)
        return response;
    // 1. Normal tier shaping (full ⇒ no tier shaper; keeps prior behavior).
    let out = response;
    const tierShaper = tier === 'full' ? undefined : tier === 'trimmed' ? (shape?.trimmed ?? shape?.standard) : shape?.standard;
    if (tierShaper) {
        try {
            out = { ...response, data: tierShaper(response.data, { args, tier }) };
        }
        catch (err) {
            (log ?? console.warn)(`[payload-tier] ${toolName} ${tier} shaper threw (serving unshaped data): ${err instanceof Error ? err.message : String(err)}`);
            out = response;
        }
    }
    else if (tier !== 'full') {
        // Ratchet: name the fat unshaped payloads non-full sessions are paying for.
        const size = jsonLen(response.data);
        const key = `${toolName} ${tier}`;
        if (size > exports.PAYLOAD_TIER_RATCHET_CHARS && !ratchetWarned.has(key)) {
            ratchetWarned.add(key);
            (log ?? console.warn)(`[payload-tier] ${toolName} served a ${size}-char full payload to a '${tier}' session with no ${tier} shaper — add shape.${tier} (context-trimming-tiers P-011)`);
        }
    }
    // 2. Hard ceiling: never emit an over-cap result. If still oversized and a
    //    shaper exists, force the SMALLEST one (even for `full`).
    const size = jsonLen(out.data);
    if (size > exports.PAYLOAD_TIER_HARD_CEILING_CHARS) {
        const smallest = shape?.trimmed ?? shape?.standard;
        if (smallest) {
            try {
                const forced = smallest(response.data, { args, tier: 'trimmed' });
                const forcedSize = jsonLen(forced);
                // Only swap if it genuinely shrank (a trimmed tier already at this size
                // gains nothing — that shaper still needs to bound a growing field).
                if (forcedSize < size) {
                    (log ?? console.warn)(`[payload-tier] ${toolName} '${tier}' result ${size} chars > hard ceiling ${exports.PAYLOAD_TIER_HARD_CEILING_CHARS}; force-applied the trimmed shaper (${forcedSize} chars) to fit the transport cap (WI-2859)`);
                    return { ...response, data: markForced(forced) };
                }
            }
            catch (err) {
                (log ?? console.warn)(`[payload-tier] ${toolName} hard-ceiling force-shape threw (serving as-is): ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    return out;
}
