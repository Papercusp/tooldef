/**
 * Budget for the rendered call. Deliberately far below `ARGS_SCHEMA_HINT_MAX` (1800): this
 * text is worth more per character than a schema dump, so it must not be the thing that
 * pushes the schema hint out of the result — the two are complements, not rivals.
 */
const RENDERED_MAX = 700;
/** Longest scalar echoed back before it is replaced by a placeholder. */
const VALUE_MAX = 96;
/**
 * Set `path` (dot-delimited) on `target`, creating plain objects along the way.
 *
 * Refuses to descend through a non-object that the caller already supplied, returning false
 * so the caller degrades to `dropped` rather than silently destroying data: overwriting a
 * value the caller sent, in order to advertise a "correction", would make the corrected
 * call lossy in a way nothing downstream could detect.
 */
function setPath(target, path, value) {
    const segments = path.split('.').filter((segment) => segment.length > 0);
    if (segments.length === 0)
        return false;
    let cursor = target;
    for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i];
        const existing = cursor[segment];
        if (existing === undefined) {
            const created = {};
            cursor[segment] = created;
            cursor = created;
            continue;
        }
        if (typeof existing !== 'object' || existing === null || Array.isArray(existing))
            return false;
        cursor = existing;
    }
    cursor[segments[segments.length - 1]] = value;
    return true;
}
/** Compact, bounded rendering of one value — bulk becomes a labelled placeholder. */
function renderValue(value) {
    if (typeof value === 'string') {
        if (value.length <= VALUE_MAX)
            return JSON.stringify(value);
        // Say what was removed and that the ORIGINAL should be re-sent. A silently clipped
        // string would be copy-pasted as-is and truncate the caller's own data.
        return JSON.stringify(`<your original ${value.length}-char string>`);
    }
    let serialized;
    try {
        serialized = JSON.stringify(value) ?? 'null';
    }
    catch {
        return '"<unserializable>"';
    }
    if (serialized.length <= VALUE_MAX)
        return serialized;
    if (Array.isArray(value))
        return `<your original ${value.length}-item array>`;
    return '<your original value>';
}
function renderArgs(args) {
    const parts = [];
    let used = 0;
    let omitted = 0;
    for (const [key, value] of Object.entries(args)) {
        if (value === undefined)
            continue;
        const part = `${JSON.stringify(key)}: ${renderValue(value)}`;
        if (used + part.length > RENDERED_MAX) {
            omitted += 1;
            continue;
        }
        used += part.length + 2;
        parts.push(part);
    }
    // Report the overflow rather than trailing off: a call rendered as if complete, but
    // silently missing keys, is worse than the refusal it replaced.
    const tail = omitted > 0 ? `, /* +${omitted} more arg(s) you sent, unchanged */` : '';
    return `{ ${parts.join(', ')}${tail} }`;
}
/**
 * Build the corrected call for an unrecognized-key refusal.
 *
 * `unknownKeys` must be the FULL set of keys the tool rejected — including ones for which no
 * correction was found. Those are the `dropped` cases, and they are the highest-value half:
 * D-105's `omp:sessions` finding is exactly this shape (66 rejections, ten agents, one
 * undeclared `cwd` with no counterpart), and its stated remedy is the honest
 * "`cwd` is not accepted; drop it" rather than a schema wall.
 *
 * Returns null when there is nothing useful to say — no object input, or no key actually
 * changed — so the caller appends nothing rather than an empty flourish.
 */
export function buildCorrectedCall(params) {
    const { toolName, input, corrections, unknownKeys } = params;
    const acceptedElsewhere = new Set(params.acceptedOnOtherVariant ?? []);
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return null;
    if (unknownKeys.length === 0)
        return null;
    const args = { ...input };
    const steps = [];
    // An authored redirect points at a DIFFERENT tool, so its value cannot be relocated
    // within this call — the key is simply not ours. It is still dropped here (leaving it
    // would re-trigger the same rejection), and the redirect's own rendered call, which
    // `unknownArgHint` already emits, remains the answer for where the value belongs.
    const byArg = new Map();
    for (const correction of corrections) {
        if (correction.kind === 'authored-redirect')
            continue;
        if (!byArg.has(correction.rejectedArg))
            byArg.set(correction.rejectedArg, correction);
    }
    for (const key of unknownKeys) {
        if (!(key in args))
            continue;
        const value = args[key];
        const correction = byArg.get(key);
        if (correction && setPath(args, correction.target, value)) {
            delete args[key];
            steps.push({
                rejectedArg: key,
                action: 'relocated',
                target: correction.target,
                kind: correction.kind,
            });
            continue;
        }
        delete args[key];
        steps.push({
            rejectedArg: key,
            action: 'dropped',
            ...(acceptedElsewhere.has(key) ? { acceptedOnOtherVariant: true } : {}),
        });
    }
    if (steps.length === 0)
        return null;
    return {
        tool: toolName,
        args,
        steps,
        rendered: `${toolName}(${renderArgs(args)})`,
        droppedUnaccepted: steps.some((step) => step.action === 'dropped'),
    };
}
/**
 * The sentence appended to the refusal. Leads with the finished call, then explains what was
 * changed — the order matters: pg_query's 42703 path learned the same lesson the hard way
 * ("an advisory emitted after that wall is one the reader has already scrolled past").
 */
export function correctedCallHint(corrected) {
    if (!corrected)
        return '';
    const relocated = corrected.steps
        .filter((step) => step.action === 'relocated')
        .map((step) => `\`${step.rejectedArg}\` -> \`${step.target}\``);
    const droppedSteps = corrected.steps.filter((step) => step.action === 'dropped');
    const wrongVariant = droppedSteps
        .filter((step) => step.acceptedOnOtherVariant)
        .map((step) => `\`${step.rejectedArg}\``);
    const unknownAnywhere = droppedSteps
        .filter((step) => !step.acceptedOnOtherVariant)
        .map((step) => `\`${step.rejectedArg}\``);
    const changes = [];
    if (relocated.length > 0)
        changes.push(`moved ${relocated.join(', ')}`);
    if (unknownAnywhere.length > 0) {
        changes.push(`removed ${unknownAnywhere.join(', ')} (this tool declares no counterpart — the fix is to drop it, not to look for a synonym)`);
    }
    if (wrongVariant.length > 0) {
        changes.push(`removed ${wrongVariant.join(', ')} (declared by this tool, but NOT on the variant your other args select — switch variant if you need it, do not rename it)`);
    }
    return (` CORRECTED CALL — send this: ${corrected.rendered}` +
        ` (${changes.join('; ')}).` +
        ' This resolves the rejected keys against the args you actually sent; it does not' +
        ' guarantee the call validates, since a value-level or missing-field error would' +
        ' not have been visible to this check.');
}
