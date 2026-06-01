import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { defineTool } from './define-tool';
import { listAllProjectedTools, _resetProjectionRegistryForTests } from './tool-projection';

/**
 * Phase E8: `defineTool({ expose: { ipc: true } })` must thread through to the
 * projected-tool registry so the host's IPC server can derive its allowlist
 * from `expose.ipc` instead of a hardcoded list.
 */
afterEach(() => _resetProjectionRegistryForTests());

describe('defineTool expose.ipc threading', () => {
  const base = {
    capability: 'intel:read' as const,
    args: z.object({}),
    requirePrincipal: false as const,
    agentRoles: ['operator'],
    handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  };

  it('projects expose.ipc=true when the tool opts in', () => {
    defineTool({ name: 'test:ipc_on', expose: { ipc: true }, ...base });
    const t = listAllProjectedTools().find((p) => p.expose.mcp?.name === 'test:ipc_on');
    expect(t).toBeDefined();
    expect(t?.expose.ipc).toBe(true);
  });

  it('omits expose.ipc when the tool does not opt in', () => {
    defineTool({ name: 'test:ipc_off', ...base });
    const t = listAllProjectedTools().find((p) => p.expose.mcp?.name === 'test:ipc_off');
    expect(t).toBeDefined();
    expect(t?.expose.ipc).toBeUndefined();
  });
});
