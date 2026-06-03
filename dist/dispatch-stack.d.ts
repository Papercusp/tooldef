/**
 * Named, ordered, replaceable dispatch pipeline.
 *
 * The dispatcher's pre-handler gates (role, capability, quota), context
 * decorators (timeout, idle watchdog, replay buffer, ctx.emit/progress/
 * askUser/publishState/metadata wrappers), and handler-invoke step are
 * each one entry in a typed stack.
 *
 * The stack ordering is load-bearing (e.g. timeout must arm before
 * idle-watchdog because idle-watchdog races against the same
 * AbortController). The default order is exported as a constant and is
 * what production uses. Hosts can derive a customized stack by replacing
 * a step by name (`withReplacedStep`); inserting / removing steps is
 * intentionally not supported in v1 — the stack invariants are tighter
 * than that.
 *
 * Telemetry sits outside the stack: it runs in the orchestrator's
 * finally block with the final result, on every termination (gate
 * denial, success, error, timeout). Surfaces as `recordTelemetry()` here
 * so it stays co-located with the steps it observes.
 */
import type { ToolResult } from './wire';
import { type ProjectedTool, type UnifiedToolContext } from './tool-projection';
import { type ReplayBufferWriter } from './replay-buffer';
import { type DispatchProjectedDeps, type DispatchProjectedResult } from './dispatch-types';
export type DispatchStepName = 'default-deny' | 'role-allowlist' | 'capability-check' | 'role-requirement' | 'harness-check' | 'quota' | 'authorize' | 'timeout' | 'idle-watchdog' | 'replay-buffer' | 'ctx-bindings' | 'invoke';
/**
 * Mutable state that flows between steps. Read-only fields are set at
 * init; mutable fields are written by specific steps (named in each
 * field's comment). Keeping this typed lets a future step author see
 * which prior steps they depend on without having to read the code.
 */
export interface DispatchExecution {
    readonly tool: ProjectedTool;
    readonly toolName: string;
    readonly input: unknown;
    /** Original ctx as received by the dispatcher. */
    readonly ctx: UnifiedToolContext;
    readonly deps: DispatchProjectedDeps;
    readonly startedAt: number;
    /** Quota/telemetry window key, or null when ctx has no run/chunk to scope to. */
    readonly windowKey: string | null;
    /** Quota ceiling within the window, or null when the call is unlimited. */
    readonly quotaLimit: number | null;
    abort: AbortController;
    timeoutSec: number;
    idleSec: number;
    lastEmitMs: number;
    idleTimer: ReturnType<typeof setInterval> | null;
    timeoutTimer: ReturnType<typeof setTimeout> | null;
    bufferWriter: ReplayBufferWriter | null;
    /** Bumped on every wrappedEmit call. Surfaced in telemetry. */
    eventCount: number;
    /** Per-call metadata accumulator. Most recent ctx.metadata() wins. */
    metadataJson: Record<string, unknown> | null;
    /** ctx with emit/progress/askUser/publishState/metadata wrappers applied. */
    handlerCtx: UnifiedToolContext;
    handlerResult: ToolResult | null;
}
/**
 * A dispatch step. Returns:
 *   - `DispatchProjectedResult` to short-circuit the pipeline (gate
 *     denied, handler returned, handler errored, etc). Subsequent
 *     steps are skipped; telemetry runs on the returned result.
 *   - `null` to continue to the next step.
 */
export interface DispatchStep {
    name: DispatchStepName;
    run(exec: DispatchExecution): Promise<DispatchProjectedResult | null>;
}
/**
 * Default ordered stack the dispatcher runs. Steps execute in this order;
 * the first one to return a `DispatchProjectedResult` short-circuits.
 *
 * Ordering invariants:
 *   - All gates (role / capability / harness / quota / authorize) come first
 *     so denials are cheap (no timer arming, no buffer allocation, no ctx
 *     wrappers). `authorize` runs last among the gates — it is the
 *     finest-grained and may touch the resource — but still before `timeout`.
 *   - `timeout` arms the AbortController; every subsequent step that
 *     races against it depends on this having run.
 *   - `idle-watchdog` runs after `timeout` so it composes with the same
 *     controller. It also runs before `ctx-bindings` because the wrapped
 *     emit refreshes `lastEmitMs`.
 *   - `replay-buffer` runs before `ctx-bindings` because the wrapped
 *     emit pushes into the buffer.
 *   - `ctx-bindings` is the last decorator before `invoke`.
 *   - `invoke` is always terminal.
 */
export declare const DEFAULT_DISPATCH_STACK: ReadonlyArray<DispatchStep>;
/**
 * Derive a stack from the default with one step replaced by name. The
 * returned array is the same length and in the same order — only the
 * named step's `run` is swapped. Hosts override e.g. quota for an
 * embedded test environment, or invoke to slip in a profiler.
 *
 * Insertion / removal is intentionally not supported in v1: the
 * ordering invariants documented on `DEFAULT_DISPATCH_STACK` are tight,
 * and a single replaceable position is the smallest knob that proves
 * the surface is real.
 */
export declare function withReplacedStep(stack: ReadonlyArray<DispatchStep>, name: DispatchStepName, replacement: DispatchStep['run']): ReadonlyArray<DispatchStep>;
/**
 * Drive a stack to completion. Initializes execution state, iterates
 * the stack, records telemetry, and runs cleanup. Returns the result
 * the first short-circuiting step produced — or the result `invoke`
 * returned, if no gate fired.
 */
export declare function runDispatchStack(tool: ProjectedTool, toolName: string, input: unknown, ctx: UnifiedToolContext, deps: DispatchProjectedDeps, stack?: ReadonlyArray<DispatchStep>): Promise<DispatchProjectedResult>;
