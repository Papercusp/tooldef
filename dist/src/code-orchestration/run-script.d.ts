import type { ToolFacade } from './tool-facade';
/**
 * EI-19301148486657755 — one recorded read of a field the tool result does NOT have.
 *
 * A wrong TOOL name has always been caught (typed signatures come back inline); a wrong FIELD
 * name was silent, because `undefined` from a property access is indistinguishable from a
 * legitimately-absent value — and the `?? null` / `?? 0` fallbacks agents write to keep summaries
 * bounded then convert that into a confident number. Live case: a monitor script read
 * `claimable.count` (the real key is `claimableCount`), summarised `count: null`, and the leader
 * read it as "0 claimable" against a queue of 1,397 — one step from standing down a 10-agent fleet.
 *
 * Same bug class as WI-6674's always-NULL accessor: a value meaning "I could not see it" sharing a
 * representation with a value meaning "there is none".
 */
export interface FieldMiss {
    /** The tool whose result was read, in colon form (e.g. `work_items:claimable`). */
    tool: string;
    /** Dotted path of the container that was read, or `(root)` for the result object itself. */
    path: string;
    /** The field name the script asked for and did not find. */
    read: string;
    /** The keys that ARE present on that container — i.e. what the author probably meant. */
    available: string[];
    /**
     * EI-21163938645109933 / EI-21164455886001541: a miss is one of two very different things, and
     * reporting both with the same warning is what made this signal read as noise. `typo` is the
     * case this detector exists for (a misspelled field, silently undefined). `optional-field` is a
     * read of a key that resembles nothing on the shape — almost always a legitimately-optional
     * field that is simply not set on this result. The Proxy cannot see the surrounding syntax, so
     * it cannot tell them apart from the READ; but the KEY ITSELF can, by proximity to what is
     * actually there. Absent on results produced before this classification existed.
     */
    likely?: 'typo' | 'optional-field';
    /** The available key this read most resembles. Only set when `likely` is `typo`. */
    didYouMean?: string;
}
/**
 * EI-19324793244855883 — one recorded read of a WINDOW that was silently shorter than requested.
 *
 * `sleep(ms)` is capped at `SLEEP_MAX_MS` per call so a runaway wait degrades to the script's
 * overall timeout instead of hanging. Before this, the clamp was silent: no throw, no log line,
 * no field anywhere saying the delay was shortened — so a script measuring a rate/share over a
 * requested window (e.g. `await sleep(30000)` to sample a 30s DB-time delta) got back a window
 * 3x+ shorter than it asked for and divided by the number it *requested*, not the number it
 * *got*. The derived rate/share then looks perfectly well-formed and is wrong. Same bug shape as
 * {@link FieldMiss}: a value meaning "this was cut short" sharing a representation (silent
 * success) with a value meaning "this ran to completion".
 */
export interface SleepCap {
    /** The ms the script asked `sleep()` to wait. */
    requestedMs: number;
    /** The ms it actually waited (== SLEEP_MAX_MS whenever requestedMs exceeds the cap). */
    actualMs: number;
}
/** JSON-only values that may cross into the orchestration VM as frozen runtime inputs. */
export type OrchestrationInputValue = null | boolean | number | string | readonly OrchestrationInputValue[] | {
    readonly [key: string]: OrchestrationInputValue;
};
/**
 * Runtime recipe/script inputs. The host validates this shape before constructing the worker;
 * the worker then structured-clones it and reconstructs it with the VM realm's own JSON/Object
 * intrinsics before recursively freezing it. No host object prototype or callable crosses in.
 */
export type OrchestrationInputs = Readonly<Record<string, OrchestrationInputValue>>;
export interface RunScriptResult {
    ok: boolean;
    /** The script's returned value — the summary that re-enters the model's context. */
    result?: unknown;
    /** Captured console output from the script (bounded by maxLogLines). */
    logs: string[];
    /** Present when ok=false: 'compile_error: …', 'script_timeout …', or the thrown message. */
    error?: string;
    /**
     * Reads of fields that did not exist on a tool result (see {@link FieldMiss}). Present only when
     * non-empty, so a correct script pays nothing and sees nothing — this fires exactly when the
     * author was already wrong, which is what makes it safe to surface unconditionally.
     */
    fieldMisses?: FieldMiss[];
    /**
     * `sleep(ms)` calls that asked for longer than `SLEEP_MAX_MS` and were silently clamped (see
     * {@link SleepCap}). Present only when non-empty.
     */
    sleepCaps?: SleepCap[];
    /** Explicit replay state after any store/load helper call. Seeded from `inputs`. */
    state?: OrchestrationInputs;
    /** Raw generated-image helper calls; validated and converted by the orchestration boundary. */
    generatedImages?: GeneratedImageRequest[];
}
export interface GeneratedImageRequest {
    image_url: string;
    output_hint?: string;
}
/**
 * Default wall-clock budget for one orchestration script.
 *
 * EXPORTED because it is not only this function's default — it is the budget every caller who
 * RECOMMENDS folding tool calls into a script is implicitly promising. EI-21254965187146713: the
 * batch-hint told an agent to chain N `testing:run` calls inside one script, and the fold could
 * not finish, because a single child tool is allowed 60s by the dispatch stack (`exec.tool
 * .timeoutSec ?? 60`) while the script wrapping it had 30s. Nothing was wrong with either number
 * in isolation; the advice restated the script budget from memory instead of reading it. Anything
 * reasoning about whether a fold FITS must import this rather than repeat the literal.
 */
export declare const DEFAULT_SCRIPT_TIMEOUT_MS = 30000;
/**
 * Maximum time the host gets to settle tool calls after the script worker hits its wall-clock
 * deadline. The worker is terminated immediately at the deadline; this grace only keeps the
 * outer result open long enough for cooperative host handlers to report their final disposition.
 * Calls that still have not settled when this window closes are returned as detached evidence by
 * the orchestration composition layer.
 */
export declare const DEFAULT_TIMEOUT_SETTLEMENT_GRACE_MS = 1000;
export interface RunScriptOptions {
    /** Wall-clock budget for the whole script. Defaults to {@link DEFAULT_SCRIPT_TIMEOUT_MS} (30s).
     *  Sync loops are killed at this bound. */
    timeoutMs?: number;
    /**
     * Called immediately before the worker is terminated by the wall-clock budget. Host-side tool
     * calls may still be awaiting their real handler after the worker is gone. The hook may return
     * a promise; the executor waits for it up to {@link timeoutGraceMs} before returning, so a
     * cooperative host handler can settle without making the script timeout unbounded
     * (EI-20282336542235171).
     */
    onTimeout?: () => void | Promise<void>;
    /**
     * Bounded host-settlement grace after {@link onTimeout} runs. Defaults to
     * {@link DEFAULT_TIMEOUT_SETTLEMENT_GRACE_MS}. The worker is hard-terminated before this
     * window starts, so it cannot emit more calls while host dispatches settle.
     */
    timeoutGraceMs?: number;
    /** Cap on captured console lines. Default 200. */
    maxLogLines?: number;
    /**
     * Optional V8 old-generation heap cap (MB) for the worker. When set, a script that allocates
     * past it is killed by the runtime with a heap-OOM error instead of bloating the host. Omit for
     * no explicit cap (the Node default). Very small values (<16) can make the worker fail to boot.
     */
    maxOldGenerationSizeMb?: number;
    /**
     * Per-call cap (ms) for the sandbox's `sleep(ms)` helper. Default 10_000 (see the header note on
     * `sleep`). Exposed mainly so tests can exercise the clamp path without a real multi-second wait;
     * production callers should leave this at the default.
     */
    sleepMaxMs?: number;
    /** Optional JSON-only runtime inputs exposed to the script as the deeply frozen `inputs` value. */
    inputs?: OrchestrationInputs;
    /** Streaming helper sink. notify/yield_control map to this caller-scoped transport callback. */
    emit?: (name: string, data: unknown) => void;
}
export declare function runOrchestrationScript(script: string, facade: ToolFacade, opts?: RunScriptOptions): Promise<RunScriptResult>;
