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
import { DEFAULT_DISPATCH_STACK, runDispatchStack, } from './dispatch-stack';
export { defaultComputeQuotaWindow, PASS_THROUGH, UnauthorizedToolError, HarnessRequiredError, InvalidInputError, } from './dispatch-types';
export { DEFAULT_DISPATCH_STACK, withReplacedStep, } from './dispatch-stack';
/* ─── Dispatcher entrypoint ──────────────────────────────────────────── */
/**
 * Dispatch a projected tool. Drives the default dispatch stack (gates,
 * decorators, invoke, telemetry); hosts that need a custom stack should
 * call `runDispatchStack` directly with their stack.
 */
export async function dispatchProjectedTool(tool, toolName, input, ctx, deps, stack = DEFAULT_DISPATCH_STACK) {
    return runDispatchStack(tool, toolName, input, ctx, deps, stack);
}
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
export async function* dispatchProjectedToolStream(tool, toolName, input, ctx, deps) {
    const queue = [];
    let resolveWait = null;
    const wake = () => {
        const r = resolveWait;
        resolveWait = null;
        r?.();
    };
    // Override emit + progress so each emit pushes onto our queue. The
    // dispatcher will wrap our emit with its idle-timeout watchdog (if
    // tool.idleTimeoutSec is set), so wake() still fires correctly.
    const streamEmit = (name, data) => {
        queue.push({ kind: 'event', name, data });
        wake();
    };
    const streamProgress = (pct, msg) => {
        streamEmit('progress', {
            progress: typeof pct === 'number' ? pct : 0,
            total: 100,
            ...(msg ? { message: msg } : {}),
        });
    };
    const streamCtx = {
        ...ctx,
        emit: streamEmit,
        progress: streamProgress,
    };
    const dispatchPromise = dispatchProjectedTool(tool, toolName, input, streamCtx, deps).then((r) => {
        if (r.ok && r.result)
            queue.push({ kind: 'done', result: r.result });
        else if (r.ok)
            queue.push({ kind: 'done', result: { content: [] } });
        else
            queue.push({ kind: 'error', error: r.error ?? { code: 'handler_error', message: '' } });
        wake();
    }, (err) => {
        queue.push({
            kind: 'error',
            error: { code: 'handler_error', message: err instanceof Error ? err.message : String(err) },
        });
        wake();
    });
    try {
        while (true) {
            if (queue.length === 0) {
                await new Promise((res) => {
                    resolveWait = res;
                });
            }
            while (queue.length > 0) {
                const ev = queue.shift();
                yield ev;
                if (ev.kind === 'done' || ev.kind === 'error')
                    return;
            }
        }
    }
    finally {
        await dispatchPromise.catch(() => { });
    }
}
