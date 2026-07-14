/** Normalize a single entry to a pointer; a bare string becomes `{ tool }`. */
function normalizeEntry(entry) {
    if (typeof entry === 'string') {
        const tool = entry.trim();
        return tool ? { tool } : null;
    }
    if (entry &&
        typeof entry === 'object' &&
        typeof entry.tool === 'string' &&
        entry.tool.trim()) {
        const p = { tool: entry.tool.trim() };
        if (typeof entry.reason === 'string' && entry.reason.trim())
            p.reason = entry.reason.trim();
        if (typeof entry.selector === 'string' && entry.selector.trim()) {
            p.selector = entry.selector.trim();
        }
        return p;
    }
    return null;
}
/**
 * Resolve a `guidance.seeAlso` value against a concrete result into a list of
 * normalized pointers. Evaluating the function form NEVER throws out — a broken
 * seeAlso callback must never fail the underlying tool call, so we swallow and
 * return `[]`.
 */
export function resolveSeeAlso(seeAlso, result, args, ctx) {
    if (!seeAlso)
        return [];
    let entries;
    if (typeof seeAlso === 'function') {
        try {
            entries = seeAlso(result, args, ctx);
        }
        catch {
            return [];
        }
    }
    else {
        entries = seeAlso;
    }
    if (!entries || !Array.isArray(entries))
        return [];
    const out = [];
    for (const e of entries) {
        const p = normalizeEntry(e);
        if (p)
            out.push(p);
    }
    return out;
}
/** Render pointers to a single "See also:" line: `tool selector — reason; …`. */
export function renderSeeAlsoText(pointers) {
    const parts = pointers.map((p) => {
        let s = p.tool;
        if (p.selector)
            s += ` ${p.selector}`;
        if (p.reason)
            s += ` — ${p.reason}`;
        return s;
    });
    return `See also: ${parts.join('; ')}`;
}
/**
 * Convenience for content-encoded tools (those returning a JSON-stringified
 * output as the first text block): parse it back into the semantic object a
 * `seeAlso` callback wants to read. Returns `undefined` on any failure.
 */
export function readJsonResult(result) {
    const first = result.content?.find((c) => c.type === 'text');
    if (!first || first.type !== 'text')
        return undefined;
    try {
        return JSON.parse(first.text);
    }
    catch {
        return undefined;
    }
}
/**
 * Apply `guidance.seeAlso` to a tool result: inject a structured
 * `_meta._seeAlso` array + append a one-line "See also:" text block to
 * `content`. Returns the result UNCHANGED when there are no pointers
 * (self-gating), when the tool declares no `seeAlso`, or when the result is a
 * soft error — so unrelated / failed calls pay nothing. Never throws.
 */
export function applySeeAlso(result, seeAlso, args, ctx) {
    if (!seeAlso || result.isError)
        return result;
    const pointers = resolveSeeAlso(seeAlso, result, args, ctx);
    if (pointers.length === 0)
        return result;
    return {
        ...result,
        _meta: { ...(result._meta ?? {}), _seeAlso: pointers },
        content: [...result.content, { type: 'text', text: renderSeeAlsoText(pointers) }],
    };
}
