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
import { dispatchProjectedTool, type DispatchProjectedDeps } from './dispatch-projected';
import { _resetProjectionRegistryForTests, lookupByMcpName, type UnifiedToolContext } from './tool-projection';
import type { ToolContext } from './types';

const DEPS: DispatchProjectedDeps = {};

const ctx = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
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
    let received: (ToolContext & { role?: string; uiClientId?: string | null }) | undefined;
    defineTool({
      name: 'test:legacy-ctx-identity',
      capability: 'test:read',
      description: 'fixture',
      args: z.object({}),
      async handler(_args, handlerCtx) {
        received = handlerCtx as typeof received;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });

    await dispatchProjectedTool(
      lookupByMcpName('test:legacy-ctx-identity')!,
      'test:legacy-ctx-identity',
      {},
      ctx({ role: 'worker', uiClientId: 'su-abc123' }),
      DEPS,
    );

    expect(received?.role).toBe('worker');
    expect(received?.uiClientId).toBe('su-abc123');
  });

  it('omits role/uiClientId (not undefined-valued keys) when the outer ctx carries neither', async () => {
    let received: (ToolContext & { role?: string; uiClientId?: string | null }) | undefined;
    defineTool({
      name: 'test:legacy-ctx-no-identity',
      capability: 'test:read',
      description: 'fixture',
      args: z.object({}),
      async handler(_args, handlerCtx) {
        received = handlerCtx as typeof received;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });

    await dispatchProjectedTool(
      lookupByMcpName('test:legacy-ctx-no-identity')!,
      'test:legacy-ctx-no-identity',
      {},
      ctx(),
      DEPS,
    );

    expect(received?.role).toBeUndefined();
    expect(received?.uiClientId).toBeUndefined();
    expect(received && 'role' in received).toBe(false);
    expect(received && 'uiClientId' in received).toBe(false);
  });
});

/**
 * EI-10767 — the SAME allowlist, its third victim.
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
describe('registerLegacyAsProjected — telemetrySurface threading (EI-10767)', () => {
  it("threads a compound's telemetrySurface stamp into the handler legacyCtx", async () => {
    let received: (ToolContext & { telemetrySurface?: string }) | undefined;
    defineTool({
      name: 'test:legacy-ctx-telemetry',
      capability: 'test:read',
      description: 'fixture',
      args: z.object({}),
      async handler(_args, handlerCtx) {
        received = handlerCtx as typeof received;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });

    await dispatchProjectedTool(
      lookupByMcpName('test:legacy-ctx-telemetry')!,
      'test:legacy-ctx-telemetry',
      {},
      ctx({ telemetrySurface: 'orient' }),
      DEPS,
    );

    expect(received?.telemetrySurface).toBe('orient');
  });

  it('omits telemetrySurface when the outer ctx carries none (a DIRECT call must stay unstamped)', async () => {
    let received: (ToolContext & { telemetrySurface?: string }) | undefined;
    defineTool({
      name: 'test:legacy-ctx-no-telemetry',
      capability: 'test:read',
      description: 'fixture',
      args: z.object({}),
      async handler(_args, handlerCtx) {
        received = handlerCtx as typeof received;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });

    await dispatchProjectedTool(
      lookupByMcpName('test:legacy-ctx-no-telemetry')!,
      'test:legacy-ctx-no-telemetry',
      {},
      ctx(),
      DEPS,
    );

    // Absent, not an undefined-valued key — the consumer's `?? 'search'` fallback
    // is what makes a direct memory:search record as 'search'.
    expect(received?.telemetrySurface).toBeUndefined();
    expect(received && 'telemetrySurface' in received).toBe(false);
  });
});
