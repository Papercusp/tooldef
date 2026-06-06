/**
 * End-to-end positional I/O through the real defineTool → projected dispatcher
 * path (token-efficient-agent-io P-008/P-009/P-014). Verifies the WIRING:
 *   - write: a registry write-positional tool advertises a single `row` string;
 *     a dispatched `{ row }` is reconstructed to typed args before the handler;
 *     a misaligned row is REJECTED by the guard (not silently mis-written);
 *     keyed args still work for a non-prompt-aware caller.
 *   - read: a registry read tool with a flat result schema serves headerless
 *     CSV + `[N]` through the full dispatch path.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from './define-tool';
import { dispatchProjectedTool, type DispatchProjectedDeps } from './dispatch-projected';
import {
  configurePrePromptRegistry,
  clearPrePromptRegistry,
  advertisedArgsSchema,
} from '@papercusp/result-encoding';
import {
  lookupByMcpName,
  listMcpProjections,
  _resetProjectionRegistryForTests,
  type UnifiedToolContext,
} from './tool-projection';

const DEPS: DispatchProjectedDeps = {};

const ctx = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'w',
  runId: 'r',
  transport: 'mcp',
  ...over,
});

afterEach(() => {
  _resetProjectionRegistryForTests();
  clearPrePromptRegistry();
});

/** A write-tool whose handler records the args it actually received. */
function defineSetState(name: string): { received: () => unknown } {
  let received: unknown;
  defineTool({
    name,
    requirePrincipal: false,
    capability: 'test:write',
    args: z.object({
      id: z.string().regex(/^WI-\d+$/),
      state: z.enum(['todo', 'passed', 'failing']),
      harness: z.string().optional(),
    }),
    handler: async (args) => {
      received = args;
      return { data: { ok: true } };
    },
  });
  return { received: () => received };
}

describe('positional write shim — end-to-end (P-008/P-009)', () => {
  it('advertises a single `row` string for a registry write-positional tool', () => {
    defineSetState('wi:set_state');
    configurePrePromptRegistry([{ name: 'wi:set_state', write: 'positional' }]);
    // The transport handlers run the registered inputSchema through
    // advertisedArgsSchema before serving tools/list (post-manifest).
    const listing = listMcpProjections().find((l) => l.name === 'wi:set_state')!;
    const advertised = advertisedArgsSchema('wi:set_state', listing.inputSchema as Record<string, unknown>);
    const props = (advertised as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props)).toEqual(['row']);
    expect((props.row as { description?: string }).description).toContain('id, state, harness?');
  });

  it('reconstructs a positional `{ row }` into typed args before the handler', async () => {
    const tool = defineSetState('wi:set_state2');
    configurePrePromptRegistry([{ name: 'wi:set_state2', write: 'positional' }]);
    const r = await dispatchProjectedTool(
      lookupByMcpName('wi:set_state2')!,
      'wi:set_state2',
      { row: 'WI-12,passed' },
      ctx(),
      DEPS,
    );
    expect(r.ok).toBe(true);
    expect(tool.received()).toEqual({ id: 'WI-12', state: 'passed' });
  });

  it('GUARD: a misaligned row (bad enum) is rejected, not silently written', async () => {
    const tool = defineSetState('wi:set_state3');
    configurePrePromptRegistry([{ name: 'wi:set_state3', write: 'positional' }]);
    const r = await dispatchProjectedTool(
      lookupByMcpName('wi:set_state3')!,
      'wi:set_state3',
      { row: 'WI-12,not-a-state' },
      ctx(),
      DEPS,
    );
    expect(r.ok).toBe(false);
    expect(tool.received()).toBeUndefined();
  });

  it('keyed args still work for a non-prompt-aware caller', async () => {
    const tool = defineSetState('wi:set_state4');
    configurePrePromptRegistry([{ name: 'wi:set_state4', write: 'positional' }]);
    const r = await dispatchProjectedTool(
      lookupByMcpName('wi:set_state4')!,
      'wi:set_state4',
      { id: 'WI-7', state: 'failing' },
      ctx(),
      DEPS,
    );
    expect(r.ok).toBe(true);
    expect(tool.received()).toEqual({ id: 'WI-7', state: 'failing' });
  });

  it('a non-registry tool keeps its keyed args schema', () => {
    defineSetState('wi:set_state5'); // not configured
    const listing = listMcpProjections().find((l) => l.name === 'wi:set_state5')!;
    const props = (listing.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props).sort()).toEqual(['harness', 'id', 'state']);
  });

  it('trailing free-text keeps embedded commas through the full path', async () => {
    let received: unknown;
    defineTool({
      name: 'wi:comment',
      requirePrincipal: false,
      capability: 'test:write',
      args: z.object({ id: z.string(), body: z.string() }),
      handler: async (args) => {
        received = args;
        return { data: { ok: true } };
      },
    });
    configurePrePromptRegistry([{ name: 'wi:comment', write: 'positional' }]);
    const r = await dispatchProjectedTool(
      lookupByMcpName('wi:comment')!,
      'wi:comment',
      { row: 'WI-9,fixed it, added a test, shipped' },
      ctx(),
      DEPS,
    );
    expect(r.ok).toBe(true);
    expect(received).toEqual({ id: 'WI-9', body: 'fixed it, added a test, shipped' });
  });
});

describe('Tier-3 read — end-to-end (P-004/P-005)', () => {
  it('a registry read tool serves headerless CSV + [N] through dispatch', async () => {
    defineTool({
      name: 'wi:list',
      requirePrincipal: false,
      capability: 'test:read',
      args: z.object({}),
      result: z.array(z.object({ id: z.string(), state: z.enum(['todo', 'done']) })),
      handler: async () => ({
        data: [
          { id: 'WI-1', state: 'todo' },
          { id: 'WI-2', state: 'done' },
        ],
      }),
    });
    configurePrePromptRegistry([{ name: 'wi:list', read: 'csv' }]);
    const r = await dispatchProjectedTool(lookupByMcpName('wi:list')!, 'wi:list', {}, ctx(), DEPS);
    expect(r.ok).toBe(true);
    const text = (r.result!.content[0] as { text: string }).text;
    expect(text).toBe('format: csv\n[2]\nWI-1,todo\nWI-2,done');
    expect(r.result!._meta?.prePrompt).toBe(true);
  });
});
