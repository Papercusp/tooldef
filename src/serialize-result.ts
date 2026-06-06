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

import {
  encode,
  encodeAuto,
  encodeToonChecked,
  encodePositionalRows,
  isFlatObjectArray,
  parseFormatRequest,
  readPrePromptFormat,
  type ColumnSpec,
  type EligibilityResult,
  type FormatRequest,
  type ResultFormat,
} from '@papercusp/result-encoding';
import type { ToolResponse } from './types';
import type { UnifiedToolContext } from './tool-projection';

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
export function formatOptsFromCtx(
  ctx: Pick<UnifiedToolContext, 'requestedFormat' | 'transport' | 'requestedStructured'>,
  eligibility: EligibilityResult | undefined,
): SerializeFormatOpts {
  return {
    requested: parseFormatRequest(ctx.requestedFormat),
    eligibility,
    // The MCP transport is the agent-facing surface (the LLM reads content text):
    // deliver compact by default. Every other transport (HTTP catch-all,
    // in-process, IPC) defaults to lossless JSON unless it explicitly negotiates.
    defaultCompact: ctx.transport === 'mcp',
    includeStructured: ctx.requestedStructured === true,
  };
}

/** Encode `data` in `format`, or return null when it can't be represented losslessly/validly. */
function tryEncode(format: ResultFormat, data: unknown): { format: ResultFormat; text: string } | null {
  try {
    if (format === 'json') return { format, text: encode(data, 'json') };
    if (format === 'toon') {
      const t = encodeToonChecked(data);
      return t.lossless ? { format, text: t.text } : null;
    }
    // csv / tsv / md require a flat array of scalar-only objects at runtime.
    if (!isFlatObjectArray(data)) return null;
    return { format, text: encode(data, format) };
  } catch {
    return null;
  }
}

function chooseFormat(
  data: unknown,
  opts: SerializeFormatOpts,
): { format: ResultFormat; text: string; fallback: boolean } {
  const req: FormatRequest = opts.requested ?? (opts.defaultCompact ? 'compact' : 'json');
  const autoBest: ResultFormat = Array.isArray(data) ? 'toon' : 'json';

  // `want` = the format the request IDEALLY maps to (what a successful serve
  // looks like); `candidates` = the ordered try-list (excludes formats the
  // capability set disallows). `fallback` is then "we served something other
  // than `want`" — which correctly flags both an unsupported explicit request
  // and a compact request whose ideal format couldn't represent the data.
  let want: ResultFormat;
  let candidates: ResultFormat[];
  if (req === 'json') {
    want = 'json';
    candidates = ['json'];
  } else if (req === 'compact') {
    want = opts.eligibility ? opts.eligibility.bestFormat : autoBest;
    candidates = [want, 'json'];
  } else {
    want = req; // the client explicitly named this format
    const allowed = opts.eligibility ? opts.eligibility.capabilities.has(req) : true;
    const fb = opts.eligibility ? opts.eligibility.bestFormat : autoBest;
    candidates = allowed ? [req, fb, 'json'] : [fb, 'json'];
  }

  for (const f of candidates) {
    const r = tryEncode(f, data);
    if (r) return { ...r, fallback: r.format !== want };
  }
  // Unreachable in practice (json always encodes), but keep the contract total.
  return { format: 'json', text: encode(data, 'json'), fallback: want !== 'json' };
}

/**
 * Tier-3 read path (token-efficient-agent-io P-004/D-001): when the tool is in
 * the pre-prompt registry and its `data` is a flat scalar array, render it as a
 * HEADERLESS CSV/TSV body with a `[N]` row-count guard — the columns live in the
 * prompt's "## Wire schemas" legend, not on the wire. Returns null (fall through
 * to the normal compact path) unless every precondition holds AND the resolved
 * request is compact (an explicit `json`/`toon`/other ask is respected, so a UI
 * or lossless consumer is never handed the headerless form).
 */
function tryTier3Read(
  data: unknown,
  opts: SerializeFormatOpts,
): { format: ResultFormat; text: string } | null {
  if (!opts.toolName || !opts.readColumns || opts.readColumns.length === 0) return null;
  const fmt = readPrePromptFormat(opts.toolName);
  if (fmt !== 'csv' && fmt !== 'tsv') return null; // 'toon' / 'off' → normal path
  if (opts.includeStructured) return null; // structured consumer wants the lossless body
  const req: FormatRequest = opts.requested ?? (opts.defaultCompact ? 'compact' : 'json');
  if (req !== 'compact' && req !== fmt) return null; // honor an explicit different/lossless ask
  // Shape must actually be a flat array at runtime — but an EMPTY array is valid
  // (renders as `[0]`), so a Tier-3 tool always self-presents in the declared
  // format (the model never sees TOON for the empty case). A non-empty array with
  // a nested cell declines Tier-3 → safe fallback to the compact/lossless path.
  if (!Array.isArray(data)) return null;
  if (data.length > 0 && !isFlatObjectArray(data)) return null;
  const text = encodePositionalRows(data as Array<Record<string, unknown>>, opts.readColumns, fmt === 'tsv' ? '\t' : ',');
  return { format: fmt, text };
}

/**
 * Serialize a `ToolResponse` into MCP `content[]` + `_meta`. `uiResources` are
 * appended verbatim after the text item (parity with the legacy wrappers).
 */
export function serializeToolResponse(
  response: ToolResponse,
  opts: SerializeFormatOpts,
): SerializedToolResult {
  const _meta: Record<string, unknown> = {};
  const hasData = response.data !== undefined && response.data !== null;
  if (hasData) {
    if (response.nextCursor !== undefined) _meta.nextCursor = response.nextCursor;
    if (response.degraded !== undefined) _meta.degraded = response.degraded;
    if (response.degradedReasons !== undefined) _meta.degradedReasons = response.degradedReasons;
  }
  const data = response.data ?? response;

  // Tier-3 (prompt-declared columns) takes precedence over the generic compact
  // path for registry tools; otherwise fall through to bestFormat/TOON-auto.
  const tier3 = tryTier3Read(data, opts);
  const chosen = tier3 ? { ...tier3, fallback: false } : chooseFormat(data, opts);
  _meta.format = chosen.format;
  if (tier3) _meta.prePrompt = true;
  if (chosen.fallback) _meta.formatFallback = true;

  // Compact payloads self-identify with a ~3-token marker; JSON (the assumed
  // default) is left unmarked so its bytes are identical to the legacy path.
  const text = chosen.format === 'json' ? chosen.text : `format: ${chosen.format}\n${chosen.text}`;

  const content: Array<Record<string, unknown>> = [{ type: 'text', text }];
  if (Array.isArray(response.uiResources)) {
    for (const ui of response.uiResources) content.push(ui as unknown as Record<string, unknown>);
  }
  const result: SerializedToolResult = { content, _meta, format: chosen.format, fallback: chosen.fallback };
  // Opt-in lossless structured payload for UI/programmatic consumers (P-010).
  // Only meaningful when the body itself isn't already the lossless JSON.
  if (opts.includeStructured && hasData && chosen.format !== 'json') {
    result.structuredContent = data;
    _meta.structured = true;
  }
  return result;
}
