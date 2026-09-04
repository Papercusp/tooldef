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
    /**
     * EI-20803112372029993 — opt a row-shaped `trimmed` projection into the
     * contract check (`trimmed-contract.ts`).
     *
     * A `trimmed` shaper that REBUILDS each row from a hardcoded allowlist drops
     * any field not on that list, on the tier agents get BY DEFAULT — and the
     * result still reads `ok:true` with a well-formed row, so the field looks
     * absent from the data rather than removed by the shaper. `routines:list`
     * shipped exactly that defect three times on one allowlist.
     *
     * Declaring `rows` is the whole opt-in. The FIELD LIST is deliberately NOT
     * repeated here: it is derived from the tool's own `guidance.returns`
     * "Each row: { a, b, c }" promise, so the promise and the check are one
     * artifact and cannot drift. `fields` is the escape hatch for a tool whose
     * `returns` prose is not in that form.
     */
    contract?: {
        /** Key of the row array in the handler's `data` envelope (e.g. `'routines'`). */
        rows: string;
        /** Override the fields parsed from `returns`. Prefer the derived list. */
        fields?: readonly string[];
    };
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
export declare function resolvePayloadTier(callTier: PayloadTier | undefined, ctxTier: PayloadTier | undefined, opts?: {
    /**
     * WI-37843: this tool declared `ignoreSessionPayloadTier` — routine
     * per-session shaping does not apply to it, so the SESSION tier is
     * discarded and an un-overridden call resolves to 'full'.
     *
     * Deliberately narrow: an EXPLICIT per-call `payloadTier` still wins, so a
     * caller that asks for 'trimmed' still gets 'trimmed'. Only the ambient
     * session tier is ignored — the thing the caller never chose.
     */
    ignoreSessionTier?: boolean;
}): PayloadTier;
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
export interface BoundedPayloadProjection {
    _projection: {
        kind: 'bounded-payload';
        truncated: true;
        tier: PayloadTier;
        forced: boolean;
        originalChars: number;
        returnedChars: number;
        omittedCount: number;
        omitted: Array<{
            path: string;
            reason: string;
        }>;
        /** True when the `omitted` SAMPLE list was itself shortened to buy budget back
         *  for real content (EI-21215297173311865). `omittedCount` remains exact — only
         *  the per-path examples were shed. Absent means the sample list is as complete
         *  as GENERIC_PROJECTION_OMISSION_SAMPLES allows. */
        omittedSamplesDropped?: true;
        cursor: {
            /** Host-defined recovery cursors may page a durable spill instead of
             * re-running the producing tool. `full-detail` remains the default. */
            kind: string;
            tool: string;
            args: Record<string, unknown>;
            /** True when args is an identity-only preview and cannot be replayed as-is. */
            argsTruncated?: true;
            [key: string]: unknown;
        };
        next: string;
    };
    [key: string]: unknown;
}
export interface BoundedPayloadRecovery {
    /** A schema-valid call the client can execute directly. */
    cursor: BoundedPayloadProjection['_projection']['cursor'];
    /** Human-readable recovery instruction paired with the cursor. */
    next: string;
}
export interface ProjectBoundedPayloadOpts {
    toolName: string;
    tier: PayloadTier;
    forced?: boolean;
    originalChars?: number;
    args?: unknown;
    /** Exact serialized target for this projection. The default remains the
     * tier's generic payload budget; transport doors can pass their own cap. */
    targetChars?: number;
    /** Override the default raw-args re-call with a host-owned durable cursor. */
    recovery?: BoundedPayloadRecovery;
    /**
     * Top-level fields the host must keep visible in the last-resort identity
     * fallback. The normal projection already preserves insertion order, but its
     * final metadata defense intentionally rebuilds a tiny identity-only preview;
     * a host may nominate an additional load-bearing field (for example,
     * coord:orient's post-compaction recovery block) for that rebuild.
     */
    preserveTopLevelKeys?: readonly string[];
    /**
     * Keep a projected top-level array as an array in the serialized result.
     *
     * The generic payload-tier contract defaults to an object wrapper so its
     * `_projection` metadata survives JSON serialization. A model-facing result
     * door may opt into the source tool's array root instead; metadata remains
     * attached as a non-enumerable property for the in-memory caller and the
     * door's own machine-readable metadata path.
     */
    preserveArrayRoot?: boolean;
    /**
     * Explicit caller-selected paths that must remain addressable when the bounded
     * preview reaches its depth/key fallback. The result door supplies the same
     * paths its caller used for `projection.pick`; values remain subject to the
     * normal string, key, array, and transport budgets.
     */
    preservePaths?: readonly string[];
    /**
     * EI-20720054720826414: the host's concrete raw-args dispatch spelling for a
     * `payloadTier:'full'` re-call (`{tool}` substituted with the tool name) —
     * see UnifiedToolContext.rawDispatchTemplate. Present ⇒ the recovery `next`
     * prints an EXECUTABLE call; absent ⇒ the generic host-neutral wording.
     */
    rawDispatchTemplate?: string;
}
/** Test seam. */
export declare function resetPayloadTierRatchet(): void;
/**
 * Framework fallback for a large result whose tool has no usable custom
 * shaper. It preserves a structural preview, makes every omission explicit,
 * and points to the opt-in full-detail request. The returned value is always
 * an object so arrays/scalars can carry projection metadata too.
 */
export declare function projectBoundedPayload(data: unknown, opts: ProjectBoundedPayloadOpts): BoundedPayloadProjection;
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
    /**
     * WI-37843: per-tool override of `PAYLOAD_TIER_HARD_CEILING_CHARS` for THIS
     * tool, from its `payloadTierCeilingChars` declaration. Absent (or not a
     * finite positive number) ⇒ the shared ceiling, unchanged.
     *
     * Exists because exempting a tool from the result door is only half an
     * uncapping — this ceiling runs EARLIER and is strictly worse when it fires,
     * since what it drops is never serialized (the door at least spills what it
     * cuts). Raising it is deliberately per-tool: the shared default protects
     * every ordinary result, and only a tool whose full payload is the point
     * should opt out of it.
     */
    ceilingChars?: number;
    /** See ProjectBoundedPayloadOpts.rawDispatchTemplate — threaded from the
     * host's UnifiedToolContext into every generic bounded projection this
     * function emits (EI-20720054720826414). */
    rawDispatchTemplate?: string;
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
export declare function applyPayloadTier(opts: ApplyPayloadTierOpts): ToolResponse;
