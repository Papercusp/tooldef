"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatOptsFromCtx = formatOptsFromCtx;
exports.serializeToolResponse = serializeToolResponse;
const result_encoding_1 = require("@papercusp/result-encoding");
/** Build the format options for a call from the request context + the tool's precomputed eligibility. */
function formatOptsFromCtx(ctx, eligibility) {
    return {
        requested: (0, result_encoding_1.parseFormatRequest)(ctx.requestedFormat),
        eligibility,
        // The MCP transport is the agent-facing surface (the LLM reads content text):
        // deliver compact by default. Every other transport (HTTP catch-all,
        // in-process, IPC) defaults to lossless JSON unless it explicitly negotiates.
        defaultCompact: ctx.transport === 'mcp',
        includeStructured: ctx.requestedStructured === true,
    };
}
/** Encode `data` in `format`, or return null when it can't be represented losslessly/validly. */
function tryEncode(format, data) {
    try {
        if (format === 'json')
            return { format, text: (0, result_encoding_1.encode)(data, 'json') };
        if (format === 'toon') {
            const t = (0, result_encoding_1.encodeToonChecked)(data);
            return t.lossless ? { format, text: t.text } : null;
        }
        // csv / tsv / md require a flat array of scalar-only objects at runtime.
        if (!(0, result_encoding_1.isFlatObjectArray)(data))
            return null;
        return { format, text: (0, result_encoding_1.encode)(data, format) };
    }
    catch {
        return null;
    }
}
function chooseFormat(data, opts) {
    const req = opts.requested ?? (opts.defaultCompact ? 'compact' : 'json');
    // Bare arrays AND object-rooted-but-array-bearing payloads (bulk envelopes
    // `{ ok, results:[…], counts }`, list wrappers `{ items:[…], nextCursor }`)
    // both win from TOON; a plain object / scalar stays JSON (TOON's gain there is
    // marginal). `encodeToonChecked` is lossless-or-fallback, so attempting TOON on
    // an object is safe — a non-lossless shape falls through to JSON below.
    // (definetool-token-optimization-adoption P-001.)
    const autoBest = Array.isArray(data) || (0, result_encoding_1.isObjectWithArrayField)(data) ? 'toon' : 'json';
    // `want` = the format the request IDEALLY maps to (what a successful serve
    // looks like); `candidates` = the ordered try-list (excludes formats the
    // capability set disallows). `fallback` is then "we served something other
    // than `want`" — which correctly flags both an unsupported explicit request
    // and a compact request whose ideal format couldn't represent the data.
    let want;
    let candidates;
    if (req === 'json') {
        want = 'json';
        candidates = ['json'];
    }
    else if (req === 'compact') {
        want = opts.eligibility ? opts.eligibility.bestFormat : autoBest;
        candidates = [want, 'json'];
    }
    else {
        want = req; // the client explicitly named this format
        const allowed = opts.eligibility ? opts.eligibility.capabilities.has(req) : true;
        const fb = opts.eligibility ? opts.eligibility.bestFormat : autoBest;
        candidates = allowed ? [req, fb, 'json'] : [fb, 'json'];
    }
    for (const f of candidates) {
        const r = tryEncode(f, data);
        if (r)
            return { ...r, fallback: r.format !== want };
    }
    // Unreachable in practice (json always encodes), but keep the contract total.
    return { format: 'json', text: (0, result_encoding_1.encode)(data, 'json'), fallback: want !== 'json' };
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
function tryTier3Read(data, opts) {
    if (!opts.toolName || !opts.readColumns || opts.readColumns.length === 0)
        return null;
    const fmt = (0, result_encoding_1.readPrePromptFormat)(opts.toolName);
    if (fmt !== 'csv' && fmt !== 'tsv')
        return null; // 'toon' / 'off' → normal path
    if (opts.includeStructured)
        return null; // structured consumer wants the lossless body
    const req = opts.requested ?? (opts.defaultCompact ? 'compact' : 'json');
    if (req !== 'compact' && req !== fmt)
        return null; // honor an explicit different/lossless ask
    // Shape must actually be a flat array at runtime — but an EMPTY array is valid
    // (renders as `[0]`), so a Tier-3 tool always self-presents in the declared
    // format (the model never sees TOON for the empty case). A non-empty array with
    // a nested cell declines Tier-3 → safe fallback to the compact/lossless path.
    if (!Array.isArray(data))
        return null;
    if (data.length > 0 && !(0, result_encoding_1.isFlatObjectArray)(data))
        return null;
    const text = (0, result_encoding_1.encodePositionalRows)(data, opts.readColumns, fmt === 'tsv' ? '\t' : ',');
    return { format: fmt, text };
}
/**
 * Serialize a `ToolResponse` into MCP `content[]` + `_meta`. `uiResources` are
 * appended verbatim after the text item (parity with the legacy wrappers).
 */
function serializeToolResponse(response, opts) {
    const _meta = {};
    const hasData = response.data !== undefined && response.data !== null;
    if (hasData) {
        if (response.nextCursor !== undefined)
            _meta.nextCursor = response.nextCursor;
        if (response.degraded !== undefined)
            _meta.degraded = response.degraded;
        if (response.degradedReasons !== undefined)
            _meta.degradedReasons = response.degradedReasons;
    }
    const data = response.data ?? response;
    // Tier-3 (prompt-declared columns) takes precedence over the generic compact
    // path for registry tools; otherwise fall through to bestFormat/TOON-auto.
    const tier3 = tryTier3Read(data, opts);
    const chosen = tier3 ? { ...tier3, fallback: false } : chooseFormat(data, opts);
    _meta.format = chosen.format;
    if (tier3)
        _meta.prePrompt = true;
    if (chosen.fallback)
        _meta.formatFallback = true;
    // Compact payloads self-identify with a ~3-token marker; JSON (the assumed
    // default) is left unmarked so its bytes are identical to the legacy path.
    const text = chosen.format === 'json' ? chosen.text : `format: ${chosen.format}\n${chosen.text}`;
    const content = [{ type: 'text', text }];
    if (Array.isArray(response.uiResources)) {
        for (const ui of response.uiResources)
            content.push(ui);
    }
    const result = { content, _meta, format: chosen.format, fallback: chosen.fallback };
    // Opt-in lossless structured payload for UI/programmatic consumers (P-010).
    // Only meaningful when the body itself isn't already the lossless JSON.
    if (opts.includeStructured && hasData && chosen.format !== 'json') {
        result.structuredContent = data;
        _meta.structured = true;
    }
    return result;
}
