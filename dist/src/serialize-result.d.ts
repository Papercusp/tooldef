/**
 * Format-aware serialization of a `ToolResponse` → MCP `content[]` + `_meta`.
 *
 * This is the SINGLE place result-format logic lives (plan P-005/P-006/P-007).
 * Every transport's projection — the principal-gated wrapper, the role-gated
 * wrapper, and the stdio MCP server — calls `serializeToolResponse` instead of
 * its own `JSON.stringify`, so the format contract can't drift across paths.
 *
 * Contract (D-004/D-006):
 *   - `response.data` is serialized in the chosen format; the pagination /
 *     degraded ENVELOPE (`nextCursor`, `degraded`, `degradedReasons`) is routed
 *     to `_meta`, never into the tabular body — that is what makes compact
 *     formats safe for paginated list tools.
 *   - Compact payloads self-identify: `content[0].text` is prefixed with a
 *     `format: <fmt>` marker (JSON, the assumed default, carries no marker so
 *     its bytes are unchanged).
 *   - The lossless guarantee is upheld by falling back to JSON whenever the
 *     chosen compact format can't faithfully represent the data; the downgrade
 *     is labeled via `_meta.formatFallback`.
 */
import { type ColumnSpec, type EligibilityResult, type FormatRequest, type ResultFormat } from '@papercusp/result-encoding';
import type { ToolResponse } from './types';
import type { UnifiedToolContext } from './tool-projection';
import type { DeltaNegotiation } from './delta-protocol';
export interface SerializeFormatOpts {
    /** Explicit client-requested format (negotiation), already parsed. Undefined → transport default. */
    requested?: FormatRequest;
    /** Capability info derived from the tool's output schema, or undefined (no schema → runtime auto). */
    eligibility?: EligibilityResult;
    /** When nothing is explicitly requested, default to compact? (MCP agent transport → true.) */
    defaultCompact: boolean;
    /**
     * Also attach the lossless structured `data` as `structuredContent` (P-010).
     * OFF by default — gated so the model never pays for both the compact text AND
     * the full JSON; a UI/programmatic consumer opts in (`?structured=1`).
     */
    includeStructured?: boolean;
    /**
     * Full tool name (e.g. `coord:inbox`) — consulted against the pre-prompt
     * registry for the Tier-3 prompt-declared-column read path
     * (token-efficient-agent-io P-004). Undefined → the tool isn't registry-aware.
     */
    toolName?: string;
    /**
     * The tool's READ columns (projected once at registration from its output
     * `data` schema). Present only when the schema is a flat scalar array; the
     * SAME projection drives the prompt legend (anti-desync guarantee, P-011).
     */
    readColumns?: ColumnSpec[];
    /**
     * Negotiated freshness outcome (agent-tool-delta-protocol-2026-06-22, P-005),
     * computed upstream from the tool's `delta` capability + `ctx.requestedDelta`.
     * When `mode === 'not_modified'` the data body is SUPPRESSED (the harness holds
     * the matching base) and only the marker + cursor are sent; otherwise the
     * fresh cursor rides `_meta.delta` alongside the normal full body. Absent ⇒ no
     * negotiation (today's behavior). The `delta` field never appears for a tool
     * that didn't declare a `delta` capability AND didn't get a `_delta` request.
     */
    delta?: DeltaNegotiation;
}
export interface SerializedToolResult {
    content: Array<Record<string, unknown>>;
    _meta: Record<string, unknown>;
    format: ResultFormat;
    /** True when the served format differs from the requested/ideal one (graceful downgrade). */
    fallback: boolean;
    /** Lossless structured `data`, present only when `includeStructured` was set (P-010). */
    structuredContent?: unknown;
}
/** Build the format options for a call from the request context + the tool's precomputed eligibility. */
export declare function formatOptsFromCtx(ctx: Pick<UnifiedToolContext, 'requestedFormat' | 'transport' | 'requestedStructured'>, eligibility: EligibilityResult | undefined): SerializeFormatOpts;
/**
 * Serialize a `ToolResponse` into MCP `content[]` + `_meta`. `uiResources` are
 * appended verbatim after the text item (parity with the legacy wrappers).
 */
export declare function serializeToolResponse(response: ToolResponse, opts: SerializeFormatOpts): SerializedToolResult;
