/**
 * EI-10358: a principal-gated (legacy) `defineTool` handler previously received
 * a `legacyCtx` narrowed to `{ principal, tx, log, contextTier? }` —
 * `registerLegacyAsProjected` silently dropped `role`/`uiClientId` even though
 * the outer `UnifiedToolContext` (populated by the host's MCP dispatch layer)
 * already carried both. That gap is exactly why `memory:remember` could not
 * attribute a write to a real session — `ctx.principal` alone collapses every
 * su session to the single shared `system:superuser` principal.
 *
 * This test pins the fix at the framework level: `role` and `uiClientId`
 * thread from the outer ctx into the handler's `legacyCtx`, and are absent
 * (not `undefined`-valued keys) when the outer ctx doesn't carry them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from './define-tool';
import { dispatchProjectedTool } from './dispatch-projected';
import { _resetProjectionRegistryForTests, lookupByMcpName } from './tool-projection';
const DEPS = {};
const ctx = (over = {}) => ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    emit: vi.fn(),
    workspaceId: 'default',
    runId: 'r',
    transport: 'mcp',
    principal: { slug: 'system:superuser', workspaceId: 'default', capabilities: new Set(['test:read']) },
    tx: {},
    ...over,
});
afterEach(() => _resetProjectionRegistryForTests());
describe('registerLegacyAsProjected — role/uiClientId threading (EI-10358)', () => {
    it('threads role + uiClientId from the outer ctx into the handler legacyCtx', async () => {
        let received;
        defineTool({
            name: 'test:legacy-ctx-identity',
            capability: 'test:read',
            description: 'fixture',
            args: z.object({}),
            async handler(_args, handlerCtx) {
                received = handlerCtx;
                return { content: [{ type: 'text', text: 'ok' }] };
            },
        });
        await dispatchProjectedTool(lookupByMcpName('test:legacy-ctx-identity'), 'test:legacy-ctx-identity', {}, ctx({ role: 'worker', uiClientId: 'su-abc123' }), DEPS);
        expect(received?.role).toBe('worker');
        expect(received?.uiClientId).toBe('su-abc123');
    });
    it('omits role/uiClientId (not undefined-valued keys) when the outer ctx carries neither', async () => {
        let received;
        defineTool({
            name: 'test:legacy-ctx-no-identity',
            capability: 'test:read',
            description: 'fixture',
            args: z.object({}),
            async handler(_args, handlerCtx) {
                received = handlerCtx;
                return { content: [{ type: 'text', text: 'ok' }] };
            },
        });
        await dispatchProjectedTool(lookupByMcpName('test:legacy-ctx-no-identity'), 'test:legacy-ctx-no-identity', {}, ctx(), DEPS);
        expect(received?.role).toBeUndefined();
        expect(received?.uiClientId).toBeUndefined();
        expect(received && 'role' in received).toBe(false);
        expect(received && 'uiClientId' in received).toBe(false);
    });
});
describe('registerLegacyAsProjected — explicit workspace transaction contract (EI-18808330244321407)', () => {
    it('omits tx from a default transaction-free handler context without touching the guard getter', async () => {
        let received;
        defineTool({
            name: 'test:legacy-ctx-no-workspace-tx',
            capability: 'test:read',
            description: 'fixture',
            args: z.object({}),
            async handler(_args, handlerCtx) {
                received = handlerCtx;
                return { content: [{ type: 'text', text: 'ok' }] };
            },
        });
        const result = await dispatchProjectedTool(lookupByMcpName('test:legacy-ctx-no-workspace-tx'), 'test:legacy-ctx-no-workspace-tx', {}, ctx({ tx: { marker: 'must-stay-hidden' } }), DEPS);
        expect(result.ok).toBe(true);
        expect(received && 'tx' in received).toBe(false);
    });
    it('passes the real bound tx only to a declared consumer', async () => {
        const workspaceTx = { marker: 'bound-workspace-tx' };
        let receivedTx;
        defineTool({
            name: 'test:legacy-ctx-needs-workspace-tx',
            capability: 'test:read',
            description: 'fixture',
            needsWorkspaceTx: true,
            args: z.object({}),
            async handler(_args, handlerCtx) {
                receivedTx = handlerCtx.tx;
                return { content: [{ type: 'text', text: 'ok' }] };
            },
        });
        const result = await dispatchProjectedTool(lookupByMcpName('test:legacy-ctx-needs-workspace-tx'), 'test:legacy-ctx-needs-workspace-tx', {}, ctx({ tx: workspaceTx }), DEPS);
        expect(result.ok).toBe(true);
        expect(receivedTx).toBe(workspaceTx);
    });
    it('rejects a declared consumer when the host bound no workspace tx', async () => {
        const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
        defineTool({
            name: 'test:legacy-ctx-missing-workspace-tx',
            capability: 'test:read',
            description: 'fixture',
            needsWorkspaceTx: true,
            args: z.object({}),
            handler,
        });
        const result = await dispatchProjectedTool(lookupByMcpName('test:legacy-ctx-missing-workspace-tx'), 'test:legacy-ctx-missing-workspace-tx', {}, ctx({ tx: undefined }), DEPS);
        expect(result.ok).toBe(false);
        expect(result.error?.message).toContain('requires a workspace-scoped call');
        expect(handler).not.toHaveBeenCalled();
    });
});
describe('payloadTier override threading for raw ToolResult handlers', () => {
    it('keeps an explicit full override distinct in the legacy handler context', async () => {
        let received;
        defineTool({
            name: 'test:legacy-ctx-payload-tier',
            capability: 'test:read',
            description: 'fixture',
            args: z.object({}),
            async handler(_args, handlerCtx) {
                received = handlerCtx;
                return { content: [{ type: 'text', text: 'ok' }] };
            },
        });
        await dispatchProjectedTool(lookupByMcpName('test:legacy-ctx-payload-tier'), 'test:legacy-ctx-payload-tier', { payloadTier: 'full' }, ctx({ contextTier: 'trimmed' }), DEPS);
        expect(received?.contextTier).toBe('full');
        expect(received?.payloadTierOverride).toBe('full');
    });
    it('keeps an explicit full override distinct in the role-gated handler context', async () => {
        let received;
        defineTool({
            name: 'test:role-ctx-payload-tier',
            capability: 'test:read',
            description: 'fixture',
            requirePrincipal: false,
            args: z.object({}),
            async handler(_args, handlerCtx) {
                received = handlerCtx;
                return { content: [{ type: 'text', text: 'ok' }] };
            },
        });
        await dispatchProjectedTool(lookupByMcpName('test:role-ctx-payload-tier'), 'test:role-ctx-payload-tier', { payloadTier: 'full' }, ctx({ contextTier: 'trimmed' }), DEPS);
        expect(received?.contextTier).toBe('full');
        expect(received?.payloadTierOverride).toBe('full');
    });
    it('passes the resolved tier to post-handler serialization for raw ToolResults', async () => {
        let observedScope;
        const payload = {
            ok: true,
            results: Array.from({ length: 12 }, (_, i) => ({
                id: `row-${i}`,
                summary: 'serialization context must honor the explicit full override',
            })),
            counts: { ok: 12, failed: 0 },
        };
        defineTool({
            name: 'test:role-raw-payload-tier-serialization',
            capability: 'test:read',
            description: 'fixture',
            requirePrincipal: false,
            args: z.object({}),
            async handler() {
                return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
            },
            delta: {
                scope: (_args, deltaCtx) => {
                    observedScope = deltaCtx.contextTier ?? 'missing';
                    return observedScope;
                },
            },
        });
        await dispatchProjectedTool(lookupByMcpName('test:role-raw-payload-tier-serialization'), 'test:role-raw-payload-tier-serialization', { payloadTier: 'full' }, ctx({ contextTier: 'trimmed', requestedDelta: 'auto' }), DEPS);
        expect(observedScope).toBe('full');
    });
});
/**
 * WI-4549 — the SAME allowlist, its third victim.
 *
 * A compound stamps `telemetrySurface` on the inner ctx (`inProcessCall(ctx, {
 * telemetrySurface: 'orient' })`) so its folded sub-call self-identifies: coord:orient's
 * memory:search fold should record recall telemetry under 'orient' instead of blending
 * into generic 'search'. memory:search is PRINCIPAL-gated, so it lands in this legacy
 * shim — which dropped the stamp. Live consequence: `orient` had ZERO rows in
 * memory_recall_stats for weeks while demonstrably folding recall on every call, so
 * per-entry-point recall quality was unmeasurable — the exact thing the stamp exists for.
 *
 * WHY IT SHIPPED GREEN: the unit test for this feature called
 * `search.handler(input, { telemetrySurface: 'orient' })` DIRECTLY. That proves the
 * handler READS the field; it can never prove dispatch DELIVERS it. A ctx-borne field
 * has two halves and the test only pinned one. These cases pin the other half — the
 * delivery — by driving the real `dispatchProjectedTool` path.
 */
describe('registerLegacyAsProjected — telemetrySurface threading (WI-4549)', () => {
    it("threads a compound's telemetrySurface stamp into the handler legacyCtx", async () => {
        let received;
        defineTool({
            name: 'test:legacy-ctx-telemetry',
            capability: 'test:read',
            description: 'fixture',
            args: z.object({}),
            async handler(_args, handlerCtx) {
                received = handlerCtx;
                return { content: [{ type: 'text', text: 'ok' }] };
            },
        });
        await dispatchProjectedTool(lookupByMcpName('test:legacy-ctx-telemetry'), 'test:legacy-ctx-telemetry', {}, ctx({ telemetrySurface: 'orient' }), DEPS);
        expect(received?.telemetrySurface).toBe('orient');
    });
    it('omits telemetrySurface when the outer ctx carries none (a DIRECT call must stay unstamped)', async () => {
        let received;
        defineTool({
            name: 'test:legacy-ctx-no-telemetry',
            capability: 'test:read',
            description: 'fixture',
            args: z.object({}),
            async handler(_args, handlerCtx) {
                received = handlerCtx;
                return { content: [{ type: 'text', text: 'ok' }] };
            },
        });
        await dispatchProjectedTool(lookupByMcpName('test:legacy-ctx-no-telemetry'), 'test:legacy-ctx-no-telemetry', {}, ctx(), DEPS);
        // Absent, not an undefined-valued key — the consumer's `?? 'search'` fallback
        // is what makes a direct memory:search record as 'search'.
        expect(received?.telemetrySurface).toBeUndefined();
        expect(received && 'telemetrySurface' in received).toBe(false);
    });
});
