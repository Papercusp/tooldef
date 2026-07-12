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
import { _resetProjectionRegistryForTests, type UnifiedToolContext } from './tool-projection';
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
    const tool = defineTool({
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
      tool,
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
    const tool = defineTool({
      name: 'test:legacy-ctx-no-identity',
      capability: 'test:read',
      description: 'fixture',
      args: z.object({}),
      async handler(_args, handlerCtx) {
        received = handlerCtx as typeof received;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });

    await dispatchProjectedTool(tool, 'test:legacy-ctx-no-identity', {}, ctx(), DEPS);

    expect(received?.role).toBeUndefined();
    expect(received?.uiClientId).toBeUndefined();
    expect(received && 'role' in received).toBe(false);
    expect(received && 'uiClientId' in received).toBe(false);
  });
});
