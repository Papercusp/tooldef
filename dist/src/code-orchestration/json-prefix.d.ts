/**
 * Parse a JSON value that a producer appended human-facing prose to.
 *
 * WI-6458: an MCP server we PROXY (rather than author) may end its text content with a
 * chat affordance — gitnexus appends `\n\n---\n**Next:** READ gitnexus://repo/{name}/context …`
 * after a perfectly good JSON array. The call succeeded and the data is right there, but
 * `JSON.parse` throws on the trailer, so the code-mode facade used to hand the script the
 * whole raw STRING. The script's first natural line of consumption then fails with
 * `Unexpected non-whitespace character after JSON at position 1040` — which reads as "the
 * tool is broken" and sends the agent back to grep, the exact behaviour the tool exists to
 * replace.
 *
 * Scanning for the balanced close of the FIRST value is what makes this safe. The obvious
 * workaround (`s.slice(0, s.lastIndexOf(']') + 1)`) is wrong on the real payload: gitnexus's
 * own footer contains a `{name}` placeholder, so the last bracket in the string sits AFTER
 * the JSON and the sliced parse throws too (measured 2026-07-27).
 */
export interface JsonWithTrailer {
    /** The parsed leading JSON value. */
    value: unknown;
    /** The trailing text that followed it, trimmed (never empty). */
    trailer: string;
}
/**
 * Parse a complete JSON object/array at the START of `text` when it is followed by
 * non-JSON trailing text; `null` when that is not the shape (so callers keep whatever
 * behaviour they had).
 *
 * Deliberately narrow — it returns null for all of:
 *   - text that is entirely valid JSON (a plain `JSON.parse` already handles that);
 *   - a leading bare scalar (`123 apples` must not read as `123`);
 *   - a trailer that is itself a JSON value (NDJSON / concatenated stream).
 */
export declare function parseJsonWithTrailer(text: string): JsonWithTrailer | null;
