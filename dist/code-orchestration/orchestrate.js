import { buildToolFacade } from './tool-facade';
import { realDispatch, isPreExecutionFailure } from './dispatch-binding';
import { runOrchestrationScript, } from './run-script';
import { checkScript, ensureParseCheckReady } from './parse-check';
function setContainsAll(superset, subset) {
    if (!subset || subset.size === 0)
        return true;
    if (!superset)
        return false;
    for (const value of subset)
        if (!superset.has(value))
            return false;
    return true;
}
/** True only when the actual inner-dispatch context has a grant the outer caller lacked. */
function authorityWidened(outer, inner) {
    if (inner.isSuperuser === true && outer.isSuperuser !== true)
        return true;
    if (inner.role !== outer.role)
        return true;
    const outerPrincipal = outer.principal;
    const innerPrincipal = inner.principal;
    if (!innerPrincipal)
        return false;
    if (!outerPrincipal)
        return true;
    if (innerPrincipal.slug !== outerPrincipal.slug)
        return true;
    if (!setContainsAll(outerPrincipal.capabilities, innerPrincipal.capabilities))
        return true;
    if (!setContainsAll(outerPrincipal.roles, innerPrincipal.roles))
        return true;
    return false;
}
/**
 * Resolve a projected tool's effect for one facade call. A classifier is
 * advisory metadata: malformed output or a thrown classifier must not turn a
 * safe static write into an executable dry-run call.
 */
export function resolveToolEffect(tool, args) {
    const fallback = tool.effect === 'read' || tool.effect === 'write' ? tool.effect : 'unknown';
    if (typeof tool.effectForCall !== 'function')
        return fallback;
    try {
        const resolved = tool.effectForCall(args);
        return resolved === 'read' || resolved === 'write' ? resolved : fallback;
    }
    catch {
        return fallback;
    }
}
export function detectStrandedWrites(staticCalls, tools, dispatchedToolNames) {
    // `expose.mcp.name` is the canonical projected name — the SAME accessor buildToolFacade and
    // facadeToolNames use, and the one `checkScript` resolves its `calls` against. A ProjectedTool
    // has no top-level `.name`; reading one yields `undefined` for every tool, which silently
    // empties this set and makes the whole detector a no-op that still passes any unit test whose
    // fixture invents the field. (It did exactly that until an end-to-end run caught it.)
    const toolsByName = new Map(tools
        .map((tool) => [tool.expose?.mcp?.name, tool])
        .filter((entry) => typeof entry[0] === 'string'));
    const dispatched = new Set(dispatchedToolNames);
    const stranded = [];
    const seen = new Set();
    for (const call of staticCalls) {
        const name = call.tool;
        const tool = toolsByName.get(name);
        if (!tool || resolveToolEffect(tool, call.args) !== 'write')
            continue; // reads are re-runnable; only writes strand
        if (dispatched.has(name))
            continue; // ran at least once — cannot prove anything about the rest
        if (seen.has(name))
            continue;
        seen.add(name);
        stranded.push(name);
    }
    return stranded;
}
/** True when `value` is a plain object carrying a top-level `ok: false` — the tool's own
 *  reported semantic failure, as distinct from a dispatch-level throw (already handled by
 *  realDispatch before the result ever reaches here). */
function isOkFalseResult(value) {
    return (typeof value === 'object' &&
        value !== null &&
        'ok' in value &&
        value.ok === false);
}
/**
 * True when `value` is a house BULK envelope (`{ ok: true, results: [...], counts: { failed } }`
 * — the keyed-array bulk contract, `_bulk.ts`'s `runBulk`/`bulkContent`) reporting at least one
 * per-item failure. By that contract's OWN design the top-level `ok` is ALWAYS `true` ("the batch
 * ran"; `counts.failed` is where per-item truth lives), so `isOkFalseResult` alone never catches a
 * partial bulk failure (EI-18664105352441219: `plans:add-item` against a non-existent plan
 * returned `{ ok:true, results:[{ ok:false, error:'not_found' }], counts:{ ok:0, failed:1 } }`,
 * and a batched script's own mutation tally read it as a landed write — `code:run` reported
 * `mutations:{ count:1 }` for a write that never happened). Detecting this here, once, covers
 * every one of the ~64 existing bulk-contract tools (and any future one) without each having to
 * special-case its own top-level `ok`.
 */
function isBulkPartialFailure(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const v = value;
    if (v.ok !== true || !Array.isArray(v.results))
        return false;
    const counts = v.counts;
    if (typeof counts !== 'object' || counts === null)
        return false;
    const failed = counts.failed;
    return typeof failed === 'number' && failed > 0;
}
const OUTPUT_REFERENCE_SHA_RE = /^[0-9a-f]{64}$/i;
const OUTPUT_REFERENCE_AUDIENCES = new Set(['owner', 'workspace', 'public']);
/**
 * Copy only the integrity-bearing subset of a typed P-006 reference. Reject
 * credential-bearing/query URIs and malformed metadata rather than letting a
 * result-shaped object smuggle arbitrary text into a persisted execution trace.
 */
function safeOutputReference(value) {
    if (!isPlainRecord(value) || value.kind !== 'reference')
        return null;
    const { uri, byteCount, sha256, expiresAt, audience } = value;
    if (typeof uri !== 'string' ||
        uri.length === 0 ||
        uri.length > 2_048 ||
        typeof byteCount !== 'number' ||
        !Number.isSafeInteger(byteCount) ||
        byteCount < 0 ||
        typeof sha256 !== 'string' ||
        !OUTPUT_REFERENCE_SHA_RE.test(sha256)) {
        return null;
    }
    let parsed;
    try {
        parsed = new URL(uri);
    }
    catch {
        return null;
    }
    if ((parsed.protocol !== 'papercusp:' && parsed.protocol !== 'https:') ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash) {
        return null;
    }
    if (expiresAt !== undefined && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) {
        return null;
    }
    if (audience !== undefined && (typeof audience !== 'string' || !OUTPUT_REFERENCE_AUDIENCES.has(audience))) {
        return null;
    }
    return {
        uri,
        byteCount,
        sha256: sha256.toLowerCase(),
        ...(typeof expiresAt === 'string' ? { expiresAt } : {}),
        ...(audience === 'owner' || audience === 'workspace' || audience === 'public' ? { audience } : {}),
    };
}
/** Bounded recursive scan: inner tool results are arbitrary transport values. */
function extractOutputReferences(value) {
    const found = [];
    const seenObjects = new Set();
    const seenRefs = new Set();
    const pending = [{ value, depth: 0 }];
    let visited = 0;
    while (pending.length > 0 && visited < 2_000 && found.length < 32) {
        const current = pending.pop();
        visited += 1;
        if (typeof current.value !== 'object' || current.value === null || current.depth > 16)
            continue;
        if (seenObjects.has(current.value))
            continue;
        seenObjects.add(current.value);
        const reference = safeOutputReference(current.value);
        if (reference) {
            const key = `${reference.uri}\u0000${reference.sha256}`;
            if (!seenRefs.has(key)) {
                seenRefs.add(key);
                found.push(reference);
            }
            continue;
        }
        if (Array.isArray(current.value)) {
            for (let index = current.value.length - 1; index >= 0; index -= 1) {
                pending.push({ value: current.value[index], depth: current.depth + 1 });
            }
            continue;
        }
        for (const child of Object.values(current.value)) {
            pending.push({ value: child, depth: current.depth + 1 });
        }
    }
    return found;
}
const STRICT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MEDIA_MIME_RE = /^(image|audio)\/[A-Za-z0-9][A-Za-z0-9.+_-]*$/;
const GENERATED_IMAGE_DATA_URL_RE = /^data:(image\/[A-Za-z0-9][A-Za-z0-9.+_-]*);base64,(.+)$/;
function isPlainRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
function validateMediaItem(value, index) {
    if (!isPlainRecord(value))
        return `media[${index}] must be an object`;
    const type = value.type;
    if (type !== 'image' && type !== 'audio') {
        return `media[${index}].type must be "image" or "audio"`;
    }
    if (typeof value.data !== 'string' || value.data.length === 0 || !STRICT_BASE64_RE.test(value.data)) {
        return `media[${index}].data must be non-empty canonical base64`;
    }
    if (typeof value.mimeType !== 'string' || !MEDIA_MIME_RE.test(value.mimeType)) {
        return `media[${index}].mimeType must be a concrete image/* or audio/* MIME type`;
    }
    if (!value.mimeType.startsWith(`${type}/`)) {
        return `media[${index}].mimeType must match its ${type} content type`;
    }
    // Copy only the validated MCP fields: arbitrary sibling properties from script data must not
    // hitch a ride around the authored summary/result-door contract.
    return { type, data: value.data, mimeType: value.mimeType };
}
function validateGeneratedImages(values) {
    const media = [];
    for (let index = 0; index < (values?.length ?? 0); index += 1) {
        const value = values[index];
        if (!isPlainRecord(value)) {
            return { media: [], error: `invalid_generated_image: generatedImages[${index}] must be an object` };
        }
        if (typeof value.image_url !== 'string') {
            return { media: [], error: `invalid_generated_image: generatedImages[${index}].image_url must be a data URL` };
        }
        const match = GENERATED_IMAGE_DATA_URL_RE.exec(value.image_url);
        if (!match || !STRICT_BASE64_RE.test(match[2])) {
            return {
                media: [],
                error: `invalid_generated_image: generatedImages[${index}].image_url must be a canonical base64 image data URL`,
            };
        }
        if (value.output_hint !== undefined &&
            (typeof value.output_hint !== 'string' || value.output_hint.length > 2_000)) {
            return {
                media: [],
                error: `invalid_generated_image: generatedImages[${index}].output_hint must be a string of at most 2000 characters`,
            };
        }
        media.push({
            type: 'image',
            data: match[2],
            mimeType: match[1],
            ...(value.output_hint === undefined ? {} : { _meta: { output_hint: value.output_hint } }),
        });
    }
    return { media };
}
/**
 * Interpret the opt-in final media contract without changing legacy summaries. An ordinary
 * returned object — including `{ summary: ... }` — remains byte-for-byte the script summary;
 * only the presence of `media` activates the envelope and therefore requires `summary` too.
 */
function parseFinalResult(value) {
    if (!isPlainRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'media')) {
        return { summary: value };
    }
    const summary = value.summary;
    if (!Object.prototype.hasOwnProperty.call(value, 'summary')) {
        return {
            summary: undefined,
            error: 'invalid_media_result: an explicit media result must include a summary field',
        };
    }
    if (!Array.isArray(value.media)) {
        return { summary, error: 'invalid_media_result: media must be an array' };
    }
    const media = [];
    for (let index = 0; index < value.media.length; index += 1) {
        const item = validateMediaItem(value.media[index], index);
        if (typeof item === 'string') {
            return { summary, error: `invalid_media_result: ${item}` };
        }
        media.push(item);
    }
    return { summary, media };
}
export async function runToolOrchestration(script, opts) {
    const { ctx, deps, tools, allowed, dryRun = false, timeoutMs, wrapDispatch } = opts;
    // The worker timeout in runOrchestrationScript kills only the script worker. Host-side tool
    // handlers can still be awaiting their own work after that point, so give every inner dispatch
    // a signal owned by this orchestration and abort it when the worker deadline fires. Without
    // this boundary a long foreground capability:bash keeps running after code:run returned with
    // no bash_id/resumable handle, and a retry can duplicate the command (EI-20282336542235171).
    const orchestrationAbort = new AbortController();
    const abortFromParent = () => {
        if (!orchestrationAbort.signal.aborted)
            orchestrationAbort.abort();
    };
    // `signal` is DECLARED required on UnifiedToolContext, but callers into the stack routinely omit
    // it — which is why the sibling boundary in dispatch-stack.ts guards it the same way rather than
    // trusting the type. Reading it unguarded here threw a TypeError before any work ran (WI-38330).
    if (ctx.signal?.aborted)
        abortFromParent();
    else
        ctx.signal?.addEventListener('abort', abortFromParent, { once: true });
    const dispatchCtx = { ...ctx, signal: orchestrationAbort.signal };
    const plannedMutations = [];
    const writeAttempts = [];
    const okFalseMutations = [];
    const childFailures = [];
    // EI-10951: a write that THREW never landed (rejected) or may have (uncertain) — but it
    // certainly was not "already executed", which is what we used to tell the caller.
    const rejectedMutations = [];
    const uncertainMutations = [];
    const callRecords = [];
    const dispatchedToolNames = [];
    let authorizationObservationCount = 0;
    let authorityWideningDetected = false;
    let dispatchCount = 0;
    let intermediateBytes = 0;
    await ensureParseCheckReady(); // lazy-load the TS compiler before the static parse-check (kept out of the eager client bundle)
    const check = checkScript(script, tools, allowed);
    // F8 (autonomous-loop-hardening / H2): an unknown tool ref no longer NUKES the whole run before
    // it starts (which forced a full re-run of the good calls too). We still surface `unknownRefs`
    // (→ advisory facadeHelp so the agent fixes the name), but we RUN the script — binding each
    // unknown ref to a stub that REJECTS only when CALLED. So the good calls execute and the author
    // can isolate the bad one (Promise.allSettled / try-catch) instead of re-running the whole batch,
    // and a bad ref in an unreached branch is a no-op. The `allowed` whitelist is still the security
    // boundary — a stub grants NO reach; it only turns a cryptic "cannot read undefined" into a clear
    // per-call error.
    const unknownRefs = check.ok ? undefined : check.unknownRefs;
    const dispatch = async (tool, name, args) => {
        const effect = resolveToolEffect(tool, args);
        const callRecord = {
            ordinal: callRecords.length,
            tool: name,
            effect,
            disposition: 'in_flight',
            outputReferences: [],
        };
        callRecords.push(callRecord);
        let writeAttempt;
        if (effect === 'write') {
            plannedMutations.push({ tool: name, args });
            if (dryRun) {
                callRecord.disposition = 'planned';
                return { dryRun: true, wouldCall: name, args };
            }
            writeAttempt = {
                index: writeAttempts.length,
                tool: name,
                disposition: 'in_flight',
            };
            writeAttempts.push(writeAttempt);
        }
        dispatchedToolNames.push(name);
        // Counted at the same point the host's dispatcher is entered (a throw below still
        // reached it), so this equals the number of inner telemetry rows the run produced —
        // what lets a wrapper tool (code:run / recipes:run) mark its own row as a dispatch
        // wrapper only when inner rows actually exist (census double-count, P-012).
        dispatchCount += 1;
        const call = (callCtx) => {
            // Observe the exact context that enters the real dispatcher, after any
            // per-call workspace/principal rebinding. This is the runtime-owned
            // authorization entry; the script cannot forge or suppress it.
            authorizationObservationCount += 1;
            authorityWideningDetected ||= authorityWidened(ctx, callCtx);
            return realDispatch(callCtx, deps)(tool, name, args);
        };
        try {
            const result = await (wrapDispatch
                ? wrapDispatch(tool, name, args, dispatchCtx, call)
                : call(dispatchCtx));
            // P-008: measure the exact serialized payload the script receives. Tool
            // results are JSON transport values; keep telemetry fail-soft if a custom
            // in-process fixture returns a non-serializable object.
            try {
                const serialized = JSON.stringify(result);
                if (serialized !== undefined) {
                    intermediateBytes += new TextEncoder().encode(serialized).byteLength;
                }
            }
            catch {
                // Telemetry must never turn a settled child call into a failed run.
            }
            callRecord.outputReferences = extractOutputReferences(result);
            // EI-7669: realDispatch only throws on a dispatch-level failure — a tool that dispatched fine
            // but reports its OWN semantic rejection (ok: false in its result body, e.g. a completion-
            // integrity check) resolves normally here. Tally those so a batched script that doesn't check
            // every result still gets visibility instead of silently counting the write as executed.
            if (isOkFalseResult(result) || isBulkPartialFailure(result)) {
                callRecord.disposition = 'semantic_rejected';
                childFailures.push({ tool: name, kind: 'semantic', result });
                if (effect === 'write') {
                    if (writeAttempt)
                        writeAttempt.disposition = 'semantic_rejected';
                    okFalseMutations.push({ tool: name, args, result });
                }
            }
            else if (writeAttempt) {
                writeAttempt.disposition = 'settled';
                callRecord.disposition = 'settled';
            }
            else {
                callRecord.disposition = 'settled';
            }
            return result;
        }
        catch (err) {
            // EI-10951: a write-effect call that THREW was still being counted as "already
            // executed", so a typo'd argument produced a scary — and false — "N writes already
            // landed, do NOT re-run" warning. Record WHY it threw: a pre-execution rejection
            // (bad args, a denied gate) provably wrote nothing and is safe to re-run, while any
            // other throw stays UNKNOWN and keeps the loud warning it deserves.
            const preExecution = isPreExecutionFailure(err);
            callRecord.disposition = preExecution ? 'rejected' : 'uncertain';
            childFailures.push({
                tool: name,
                kind: preExecution ? 'rejected' : 'uncertain',
                error: err instanceof Error ? err.message : String(err),
            });
            if (effect === 'write') {
                if (writeAttempt)
                    writeAttempt.disposition = preExecution ? 'rejected' : 'uncertain';
                (preExecution ? rejectedMutations : uncertainMutations).push({
                    tool: name,
                    args,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            throw err;
        }
    };
    const facade = buildToolFacade(tools, dispatch, allowed, unknownRefs);
    const run = await runOrchestrationScript(script, facade, {
        ...(timeoutMs ? { timeoutMs } : {}),
        onTimeout: abortFromParent,
        ...(opts.inputs ? { inputs: opts.inputs } : {}),
        ...(ctx.emit ? { emit: (name, data) => ctx.emit(name, data) } : {}),
    });
    ctx.signal?.removeEventListener('abort', abortFromParent);
    // P-020: only meaningful when the script ABORTED — a run that completed reached every line
    // it was going to, so an undispatched write there was a branch not taken, not a stranding.
    const strandedWrites = run.ok
        ? []
        : detectStrandedWrites(check.calls, tools, dispatchedToolNames);
    const notDispatchedWrites = strandedWrites.map((tool) => ({
        tool,
        executed: false,
    }));
    const finalResult = run.ok ? parseFinalResult(run.result) : { summary: run.result };
    const generated = validateGeneratedImages(run.generatedImages);
    const media = [...(finalResult.media ?? []), ...generated.media];
    const effectiveOk = run.ok && !finalResult.error && !generated.error;
    return {
        ok: effectiveOk,
        summary: finalResult.summary,
        ...(media.length ? { media } : {}),
        ...(run.state ? { state: run.state } : {}),
        logs: run.logs,
        error: finalResult.error ?? generated.error ?? run.error,
        ...(unknownRefs && unknownRefs.length ? { unknownRefs } : {}),
        dryRun,
        dispatchCount,
        intermediateBytes,
        runtimeObservations: {
            authorizationObservationCount,
            authorityWideningDetected,
            midTurnPromptInjectionObservability: 'not-observable',
        },
        plannedMutations,
        ...(!dryRun && writeAttempts.length
            ? { writeAttempts: writeAttempts.map((attempt) => ({ ...attempt })) }
            : {}),
        okFalseMutations,
        childFailures,
        ...(rejectedMutations.length ? { rejectedMutations } : {}),
        ...(uncertainMutations.length ? { uncertainMutations } : {}),
        ...(strandedWrites.length ? { strandedWrites } : {}),
        ...(notDispatchedWrites.length ? { notDispatchedWrites } : {}),
        ...(run.fieldMisses?.length ? { fieldMisses: run.fieldMisses } : {}),
        ...(run.sleepCaps?.length ? { sleepCaps: run.sleepCaps } : {}),
        callRecords: callRecords.map((record) => ({
            ...record,
            outputReferences: record.outputReferences.map((reference) => ({ ...reference })),
        })),
        // EI-7784: surfaced independent of `ok` — see the field doc above.
        partial: effectiveOk && childFailures.length > 0,
    };
}
