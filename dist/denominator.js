/** A finite, non-negative integer count. Anything else is not a count. */
function isCount(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}
/**
 * Normalize a candidate into a valid stamp, or `null`.
 *
 * A malformed stamp is DROPPED rather than half-rendered: a partially-true
 * denominator is worse than none, because it still reads as authoritative.
 */
function normalize(d) {
    if (!d || typeof d !== 'object')
        return null;
    const raw = d;
    if (!isCount(raw.matched))
        return null;
    // Narrow via the value, not a boolean flag — TS cannot carry a guard through
    // an intermediate `const ok = ...`.
    const population = raw.population;
    if (population !== 'unknown' && !isCount(population))
        return null;
    // A population smaller than what we matched from it is arithmetically
    // impossible, so one of the two numbers is measuring something other than it
    // claims. Reporting the ratio anyway would launder that bug into a confident
    // ">100%" base rate, so refuse the stamp instead.
    if (typeof population === 'number' && population < raw.matched)
        return null;
    const out = { matched: raw.matched, population };
    if (typeof raw.of === 'string' && raw.of.trim())
        out.of = raw.of.trim();
    if (typeof raw.window === 'string' && raw.window.trim())
        out.window = raw.window.trim();
    if (typeof raw.note === 'string' && raw.note.trim())
        out.note = raw.note.trim();
    return out;
}
/**
 * Resolve a `guidance.denominator` against a concrete result.
 *
 * Evaluating the function form NEVER throws out — a broken denominator
 * callback must never fail the underlying tool call.
 */
export function resolveDenominator(spec, result, args, ctx) {
    if (!spec)
        return null;
    let value;
    if (typeof spec === 'function') {
        try {
            value = spec(result, args, ctx);
        }
        catch {
            return null;
        }
    }
    else {
        value = spec;
    }
    return normalize(value);
}
/** Percentage rendered at a precision that cannot imply false resolution. */
function ratioText(matched, population) {
    if (population === 0)
        return '0 exist';
    const pct = (matched / population) * 100;
    if (pct > 0 && pct < 0.1)
        return '<0.1%';
    return `${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}
/**
 * Render a stamp to one line.
 *
 * The `'unknown'` branch deliberately spends more words than the known one:
 * that is the case where a reader is most likely to mistake a slice for a
 * census, so it says the quiet part out loud.
 */
export function renderDenominatorText(d) {
    const of = d.of ? ` ${d.of}` : '';
    const inWindow = d.window ? ` in ${d.window}` : '';
    const note = d.note ? ` — ${d.note}` : '';
    if (d.population === 'unknown') {
        return (`Denominator: ${d.matched}${of} matched${inWindow}; population UNKNOWN. ` +
            `This is a FILTERED SLICE, not a census — it cannot support a base-rate ` +
            `or "unusual/anomalous" claim without counting the population first.${note}`);
    }
    return (`Denominator: ${d.matched} of ${d.population}${of}${inWindow} ` +
        `(${ratioText(d.matched, d.population)}).${note}`);
}
/**
 * Apply `guidance.denominator` to a tool result: inject structured
 * `_meta._denominator` + append the one-line stamp to `content`.
 *
 * Returns the result UNCHANGED when the tool declares no denominator, when the
 * callback self-gates, when the stamp is malformed, or when the result is a
 * soft error — so unrelated / failed calls pay nothing. Never throws.
 */
export function applyDenominator(result, spec, args, ctx) {
    if (!spec || result.isError)
        return result;
    const d = resolveDenominator(spec, result, args, ctx);
    if (!d)
        return result;
    return {
        ...result,
        _meta: { ...(result._meta ?? {}), _denominator: d },
        content: [...result.content, { type: 'text', text: renderDenominatorText(d) }],
    };
}
