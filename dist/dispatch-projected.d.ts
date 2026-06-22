/**
 * Unified dispatcher entrypoints for projected tools.
 *
 * Both transports (MCP `tools/call` and HTTP catch-all) end up here.
 * The actual pipeline — gates, timeout/idle watchdog, replay buffer,
 * ctx-binding wrappers, handler invoke, telemetry — lives in
 * `dispatch-stack.ts` as a named, ordered, replaceable stack.
 * This file is the public surface (the two top-level functions every
 * consumer calls) plus the streaming wrapper.
 *
 * Re-exports the shared types from `dispatch-types.ts` so existing
 * imports of `DispatchProjectedDeps`, `PASS_THROUGH`, etc. from
 * `dispatch-projected` keep working without churn across the dozen+
 * consumer files (oracle.ts, agent-chats.ts, operator-scan/route.ts,
 * llm-testing/targets/operator.ts, …).
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */
import type { ToolResult } from './wire';
import type { ProjectedTool, UnifiedToolContext } from './tool-projection';
import { type DispatchStep } from './dispatch-stack';
import type { DispatchProjectedDeps, DispatchProjectedResult } from './dispatch-types';
export { defaultComputeQuotaWindow, PASS_THROUGH, UnauthorizedToolError, HarnessRequiredError, InvalidInputError, type QuotaWindow, type DispatchProjectedDeps, type DispatchProjectedErrorCode, type DispatchProjectedResult, type PostInvokeEvent, type CapabilityEnvelopeVerdict, type ToolDispatchOverrideFn, } from './dispatch-types';
export { DEFAULT_DISPATCH_STACK, withReplacedStep, type DispatchExecution, type DispatchStep, type DispatchStepName, } from './dispatch-stack';
/**
 * Dispatch a projected tool. Drives the default dispatch stack (gates,
 * decorators, invoke, telemetry); hosts that need a custom stack should
 * call `runDispatchStack` directly with their stack.
 */
export declare function dispatchProjectedTool(tool: ProjectedTool, toolName: string, input: unknown, ctx: UnifiedToolContext, deps: DispatchProjectedDeps, stack?: ReadonlyArray<DispatchStep>): Promise<DispatchProjectedResult>;
/**
 * One value yielded by `dispatchProjectedToolStream`.
 * - `event`: a ctx.emit(name, data) call from inside the handler.
 * - `done`: the handler returned successfully.
 * - `error`: dispatch/handler failed (role gate, quota, timeout, throw).
 */
export type DispatchStreamEvent = {
    kind: 'event';
    name: string;
    data: unknown;
} | {
    kind: 'done';
    result: ToolResult;
} | {
    kind: 'error';
    error: NonNullable<DispatchProjectedResult['error']>;
};
/**
 * In-process streaming wrapper around `dispatchProjectedTool` for
 * callers that want to consume a tool's typed event channel without
 * going through an HTTP or MCP transport.
 *
 * Goes through the full dispatcher — role check, quota, telemetry,
 * idle watchdog all apply. The escape hatch for callers who want to
 * bypass gating is to invoke `tool.fn(input, ctx)` directly (documented
 * as a footgun; loses RLS scoping and audit recording).
 *
 * Yields exactly one terminal event (`done` or `error`) before returning.
 */
export declare function dispatchProjectedToolStream(tool: ProjectedTool, toolName: string, input: unknown, ctx: UnifiedToolContext, deps: DispatchProjectedDeps): AsyncGenerator<DispatchStreamEvent, void, void>;
