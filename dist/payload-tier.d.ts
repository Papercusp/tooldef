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
export declare const PAYLOAD_TIERS: readonly PayloadTier[];
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
export declare function parsePayloadTier(v: unknown): PayloadTier | undefined;
/**
 * Pull a per-call `payloadTier` override out of the RAW input (before schema
 * validation — the arg is framework-reserved, not part of any tool's schema).
 * Unknown/absent values leave the input untouched.
 */
export declare function extractPayloadTier(input: unknown): {
    input: unknown;
    callTier?: PayloadTier;
};
/** Per-call override outranks the session tier; absent both ⇒ full. */
export declare function resolvePayloadTier(callTier: PayloadTier | undefined, ctxTier: PayloadTier | undefined): PayloadTier;
/** Unshaped payloads above this (JSON chars) served to a non-full session trip
 *  the ratchet warning — roughly the "worth writing a shaper" bar. */
export declare const PAYLOAD_TIER_RATCHET_CHARS = 8000;
/**
 * HARD CEILING (JSON chars). A tool result — even `full`, even an already-shaped
 * one — must NEVER exceed the transport's result cap: the MCP client rejects an
 * over-cap result and dumps it to a file the caller has to page back in (the
 * coord:orient 59.8KB incident, WI-2859). So when a response exceeds this and the
 * tool DECLARED a shaper, force-apply the SMALLEST shaper regardless of the
 * resolved tier — graceful degradation (top rows + fetch-pointers) instead of a
 * hard failure. Set well under a typical client cap; force-shaping only ever
 * triggers on genuinely oversized payloads, so normal results are untouched. */
export declare const PAYLOAD_TIER_HARD_CEILING_CHARS = 30000;
/** Test seam. */
export declare function resetPayloadTierRatchet(): void;
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
export declare function applyPayloadTier(opts: ApplyPayloadTierOpts): ToolResponse;
