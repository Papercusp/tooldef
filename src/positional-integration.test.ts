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
  listPrePromptEntries,
  projectReadColumns,
  projectWriteColumns,
  renderWireSchemas,
  reconstructArgs,
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

  it('tolerates the natural `WI-12, passed` spacing end-to-end (trim normalization)', async () => {
    const tool = defineSetState('wi:set_state_ws');
    configurePrePromptRegistry([{ name: 'wi:set_state_ws', write: 'positional' }]);
    const r = await dispatchProjectedTool(
      lookupByMcpName('wi:set_state_ws')!,
      'wi:set_state_ws',
      { row: 'WI-12, passed' }, // space after the comma
      ctx(),
      DEPS,
    );
    expect(r.ok).toBe(true);
    expect(tool.received()).toEqual({ id: 'WI-12', state: 'passed' });
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

describe('anti-desync: legend columns === wire columns (P-011)', () => {
  it('the prompt legend, the read serializer, and the write shim share one projection', async () => {
    // A read-list tool (no required args) and a write tool, both pre-prompted.
    defineTool({
      name: 'wi:rlist',
      requirePrincipal: false,
      capability: 'test:read',
      args: z.object({}),
      result: z.array(z.object({ id: z.string(), state: z.enum(['todo', 'done']) })),
      handler: async () => ({ data: [{ id: 'WI-1', state: 'todo' }] }),
    });
    let received: unknown;
    defineTool({
      name: 'wi:wstate',
      requirePrincipal: false,
      capability: 'test:write',
      args: z.object({ id: z.string(), state: z.enum(['todo', 'done']) }),
      handler: async (args) => {
        received = args;
        return { data: { ok: true } };
      },
    });
    configurePrePromptRegistry([
      { name: 'wi:rlist', read: 'csv' },
      { name: 'wi:wstate', write: 'positional' },
    ]);

    const rTool = lookupByMcpName('wi:rlist')!;
    const wTool = lookupByMcpName('wi:wstate')!;

    // The legend renders columns from each tool's OWN schema — the SAME
    // projection the wire paths use. A forked projection would diverge here.
    const legend = renderWireSchemas(listPrePromptEntries(), (e) =>
      e.name === 'wi:rlist'
        ? { read: projectReadColumns(rTool.outputJsonSchema) }
        : { write: projectWriteColumns(wTool.inputSchema as Record<string, unknown>) },
    );
    expect(legend).toContain('read → id:id, state:todo|done');
    expect(legend).toContain('write ← id:id, state:todo|done');

    // READ: the serializer emits VALUES in exactly the legend's column order.
    const readCols = projectReadColumns(rTool.outputJsonSchema)!;
    expect(readCols.map((c) => c.name)).toEqual(['id', 'state']);
    const rr = await dispatchProjectedTool(rTool, 'wi:rlist', {}, ctx(), DEPS);
    expect((rr.result!.content[0] as { text: string }).text).toBe('format: csv\n[1]\nWI-1,todo');

    // WRITE: the shim reconstructs by the SAME column order, end-to-end.
    const writeCols = projectWriteColumns(wTool.inputSchema as Record<string, unknown>)!;
    expect(writeCols.map((c) => c.name)).toEqual(['id', 'state']);
    expect(reconstructArgs('WI-9,done', writeCols)).toEqual({ ok: true, args: { id: 'WI-9', state: 'done' } });
    const r = await dispatchProjectedTool(wTool, 'wi:wstate', { row: 'WI-9,done' }, ctx(), DEPS);
    expect(r.ok).toBe(true);
    expect(received).toEqual({ id: 'WI-9', state: 'done' });
  });
});

describe('robustness — no collateral damage + graceful failure', () => {
  it('a NON-registry tool is byte-identical with the registry configured (no read/write/advertise change)', async () => {
    // Registry populated with OTHER tools.
    defineSetState('rb:set_state');
    defineTool({
      name: 'rb:plainlist',
      requirePrincipal: false,
      capability: 'test:read',
      args: z.object({}),
      result: z.array(z.object({ id: z.string(), name: z.string() })),
      handler: async () => ({ data: [{ id: '1', name: 'a' }] }),
    });
    configurePrePromptRegistry([
      { name: 'audit:list', read: 'csv' },
      { name: 'rb:set_state', write: 'positional' },
    ]);
    // Read: the non-registry list tool stays TOON-auto (NOT headerless CSV).
    const r = await dispatchProjectedTool(lookupByMcpName('rb:plainlist')!, 'rb:plainlist', {}, ctx(), DEPS);
    const text = (r.result!.content[0] as { text: string }).text;
    expect(text).toMatch(/^format: toon\n/);
    expect(r.result!._meta?.prePrompt).toBeUndefined();
    // Advertise: its args schema is unchanged (not swapped to {row}).
    const listing = listMcpProjections().find((l) => l.name === 'rb:plainlist')!;
    expect(advertisedArgsSchema('rb:plainlist', listing.inputSchema as Record<string, unknown>)).toEqual(listing.inputSchema);
  });

  it('Tier-3 SAFE FALLBACK: a flat-schema read tool whose RUNTIME row has a nested field → TOON, not broken CSV', async () => {
    defineTool({
      name: 'rb:badshape',
      requirePrincipal: false,
      capability: 'test:read',
      args: z.object({}),
      // schema says flat scalar array …
      result: z.array(z.object({ id: z.string(), state: z.string() })),
      // … but the handler returns a row carrying an unexpected nested object.
      handler: async () => ({ data: [{ id: 'a', state: 'todo', extra: { nested: 1 } }] as never }),
    });
    configurePrePromptRegistry([{ name: 'rb:badshape', read: 'csv' }]);
    const r = await dispatchProjectedTool(lookupByMcpName('rb:badshape')!, 'rb:badshape', {}, ctx(), DEPS);
    expect(r.ok).toBe(true);
    const text = (r.result!.content[0] as { text: string }).text;
    // The runtime flatness check declines Tier-3 → safe lossless format, NOT a
    // headerless CSV that would silently drop the nested column.
    expect(text).not.toMatch(/^format: csv\n\[/);
    expect(r.result!._meta?.prePrompt).toBeUndefined();
  });

  it('reconstruct passes the guard but FAILS Zod (.max) → dispatch ok:false, handler not run', async () => {
    let ran = false;
    defineTool({
      name: 'rb:maxcode',
      requirePrincipal: false,
      capability: 'test:write',
      args: z.object({ id: z.string(), code: z.string().max(3) }),
      handler: async () => {
        ran = true;
        return { data: { ok: true } };
      },
    });
    configurePrePromptRegistry([{ name: 'rb:maxcode', write: 'positional' }]);
    const r = await dispatchProjectedTool(lookupByMcpName('rb:maxcode')!, 'rb:maxcode', { row: 'WI-1,toolong' }, ctx(), DEPS);
    expect(r.ok).toBe(false);
    expect(ran).toBe(false);
  });

  it('shim edge inputs: empty row rejected; non-string row falls through to Zod (no crash)', async () => {
    const tool = defineSetState('rb:edge');
    configurePrePromptRegistry([{ name: 'rb:edge', write: 'positional' }]);
    const empty = await dispatchProjectedTool(lookupByMcpName('rb:edge')!, 'rb:edge', { row: '' }, ctx(), DEPS);
    expect(empty.ok).toBe(false); // arity guard
    const nonString = await dispatchProjectedTool(lookupByMcpName('rb:edge')!, 'rb:edge', { row: 123 }, ctx(), DEPS);
    expect(nonString.ok).toBe(false); // shim leaves it; Zod rejects {row:123}
    expect(tool.received()).toBeUndefined();
  });

  it('a MISCONFIGURED registry entry (non-fitting tool marked positional) degrades to keyed safely', async () => {
    let received: unknown;
    defineTool({
      name: 'rb:arrayarg',
      requirePrincipal: false,
      capability: 'test:write',
      args: z.object({ to: z.array(z.string()), note: z.string() }),
      handler: async (args) => {
        received = args;
        return { data: { ok: true } };
      },
    });
    configurePrePromptRegistry([{ name: 'rb:arrayarg', write: 'positional' }]); // not actually positional-fit
    // Advertise stays keyed (projectWriteColumns rejects the array arg).
    const listing = listMcpProjections().find((l) => l.name === 'rb:arrayarg')!;
    const advertised = advertisedArgsSchema('rb:arrayarg', listing.inputSchema as Record<string, unknown>);
    expect((advertised as { properties?: Record<string, unknown> }).properties).toHaveProperty('to');
    // And a keyed call still works (shim sees no derivable cols → passes through).
    const r = await dispatchProjectedTool(lookupByMcpName('rb:arrayarg')!, 'rb:arrayarg', { to: ['x'], note: 'hi' }, ctx(), DEPS);
    expect(r.ok).toBe(true);
    expect(received).toEqual({ to: ['x'], note: 'hi' });
  });

  it('advertisedArgsSchema is idempotent (double application stays {row})', () => {
    defineSetState('rb:idem');
    configurePrePromptRegistry([{ name: 'rb:idem', write: 'positional' }]);
    const listing = listMcpProjections().find((l) => l.name === 'rb:idem')!;
    const once = advertisedArgsSchema('rb:idem', listing.inputSchema as Record<string, unknown>);
    const twice = advertisedArgsSchema('rb:idem', once);
    expect(Object.keys((twice as { properties?: Record<string, unknown> }).properties ?? {})).toEqual(['row']);
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
