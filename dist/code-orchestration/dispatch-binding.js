"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unwrapToolResult = unwrapToolResult;
exports.realDispatch = realDispatch;
const dispatch_projected_1 = require("../dispatch-projected");
/**
 * Unwrap a settled `ToolResult` into the plain value the script should receive:
 * `structuredContent` if present, else the JSON-parsed text payload, else the raw text.
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
    try {
        return JSON.parse(textItem.text);
    }
    catch {
        return textItem.text;
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
