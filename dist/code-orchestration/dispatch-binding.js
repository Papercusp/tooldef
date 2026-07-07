"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unwrapToolResult = unwrapToolResult;
exports.realDispatch = realDispatch;
const dispatch_projected_1 = require("../dispatch-projected");
const result_encoding_1 = require("@papercusp/result-encoding");
/** Matches the `format: <fmt>\n` self-identifying marker `serializeToolResponse` prefixes onto
 *  any non-JSON compact body (serialize-result.ts) — JSON itself carries no marker. */
const FORMAT_MARKER_RE = /^format: (\S+)\n/;
/**
 * Unwrap a settled `ToolResult` into the plain value the script should receive:
 * `structuredContent` if present, else the decoded text payload, else the raw text.
 *
 * EI-7689: a compact (non-JSON) tool response self-identifies with a leading `format:
 * <fmt>\n` marker (TOON/CSV/TSV/MD — serialize-result.ts) — none of those are valid JSON,
 * so a plain `JSON.parse` always THROWS on them and this used to silently fall back to
 * handing the script the raw marker+encoded STRING as its `result`. Any in-script
 * truthiness/property check on that string (`if (result.ok)`) then silently lies: a
 * non-empty string is always truthy no matter what's encoded inside it, so a genuine
 * server-side failure can read as success. Reproduced live 2026-07-05 (su-15a64): a
 * `plans:new` call failed server-side (`similar_exists`) but returned a truthy TOON
 * string, and the script's `result.ok` check passed, reporting a phantom plan creation.
 * Parse the marker first and DECODE with the matching format (the lossless inverse of
 * the encoder that produced it) so the script always sees the real structured value.
 */
function unwrapToolResult(result) {
    if (!result)
        return undefined;
    if (result.structuredContent !== undefined)
        return result.structuredContent;
    // Narrow on the `type` discriminant — the prior `c is { text: string }` predicate was not a
    // subtype of the content union (TS2677) so it failed to narrow, leaving `.text` unreadable on
    // the image/resource variants (TS2339). Extracting the 'text' member fixes both.
    const textItem = result.content?.find((c) => c.type === 'text');
    if (!textItem)
        return result;
    const text = textItem.text;
    const marker = FORMAT_MARKER_RE.exec(text);
    if (marker && (0, result_encoding_1.isResultFormat)(marker[1]) && marker[1] !== 'md') {
        try {
            return (0, result_encoding_1.decode)(text.slice(marker[0].length), marker[1]);
        }
        catch {
            // Fall through to the JSON/raw-text attempts below — never let a decode
            // edge case throw here where the old behavior returned SOMETHING.
        }
    }
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
function realDispatch(ctx, deps) {
    return async (tool, toolName, args) => {
        const r = await (0, dispatch_projected_1.dispatchProjectedTool)(tool, toolName, args, ctx, deps);
        if (!r.ok) {
            throw new Error(`tool ${toolName} failed [${r.error?.code ?? 'error'}]: ${r.error?.message ?? 'unknown error'}`);
        }
        return unwrapToolResult(r.result);
    };
}
