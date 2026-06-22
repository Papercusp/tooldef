/**
 * End-to-end format-selection through the real defineTool → projected
 * dispatcher path (token-efficient-tool-result-formats P-005..P-010). Verifies
 * the WIRING — eligibility computed at registration, the projectedFn delegating
 * to the shared serializer, ctx.transport/requestedFormat driving the choice —
 * not just the serializer in isolation.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { decode } from '@papercusp/result-encoding';
import { defineTool } from './define-tool';
import { dispatchProjectedTool, type DispatchProjectedDeps } from './dispatch-projected';
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
  ...over,
});

const ROWS = [
  { id: 1, name: 'a' },
  { id: 2, name: 'b' },
];

function defineListTool(name: string, opts: { result?: z.ZodTypeAny; data?: unknown } = {}): void {
  defineTool({
    name,
    requirePrincipal: false,
    capability: 'test:read',
    args: z.object({}),
    result: opts.result,
    handler: async () => ({ data: opts.data ?? ROWS }),
  });
}

async function call(name: string, over: Partial<UnifiedToolContext> = {}) {
  const tool = lookupByMcpName(name)!;
  const r = await dispatchProjectedTool(tool, name, {}, ctx(over), DEPS);
  if (!r.ok) throw new Error(`dispatch failed: ${r.error?.code}`);
  const result = r.result!;
  const text = (result.content[0] as { text: string }).text;
  return { result, text, meta: result._meta ?? {} };
}

afterEach(() => _resetProjectionRegistryForTests());

describe('end-to-end format selection through defineTool', () => {
  it('MCP transport delivers compact TOON for an array result (no schema needed)', async () => {
    defineListTool('fmt:nochema');
    const { text, meta } = await call('fmt:nochema', { transport: 'mcp' });
    expect(text).toMatch(/^format: toon\n/);
    expect(text).toContain('[2]{id,name}:');
    expect(meta.format).toBe('toon');
  });

  it('non-MCP transport stays lossless JSON (byte-compatible with the legacy path)', async () => {
    defineListTool('fmt:http');
    const { text, meta } = await call('fmt:http', { transport: 'http' });
    expect(text).toBe(JSON.stringify(ROWS));
    expect(meta.format).toBe('json');
  });

  it('explicit _meta.format=json overrides the MCP compact default', async () => {
    defineListTool('fmt:jsonoverride');
    const { text } = await call('fmt:jsonoverride', { transport: 'mcp', requestedFormat: 'json' });
    expect(text).toBe(JSON.stringify(ROWS));
  });

  it('a flat-array output schema unlocks an explicit CSV request', async () => {
    defineListTool('fmt:csv', { result: z.array(z.object({ id: z.number(), name: z.string() })) });
    const { text, meta } = await call('fmt:csv', { transport: 'mcp', requestedFormat: 'csv' });
    expect(text).toBe('format: csv\nid,name\n1,a\n2,b');
    expect(meta.format).toBe('csv');
    expect(meta.formatFallback).toBeUndefined();
  });

  it('a nested-array schema cannot serve CSV → labeled fallback to TOON', async () => {
    defineListTool('fmt:nested', {
      result: z.array(z.object({ id: z.number(), meta: z.object({ k: z.number() }) })),
      data: [{ id: 1, meta: { k: 1 } }],
    });
    const { meta } = await call('fmt:nested', { transport: 'mcp', requestedFormat: 'csv' });
    expect(meta.format).toBe('toon');
    expect(meta.formatFallback).toBe(true);
  });

  it('routes the pagination/degraded envelope into _meta, not the body', async () => {
    defineTool({
      name: 'fmt:envelope',
      requirePrincipal: false,
      capability: 'test:read',
      args: z.object({}),
      result: z.array(z.object({ id: z.number(), name: z.string() })),
      handler: async () => ({ data: ROWS, nextCursor: 'CUR', degraded: true, degradedReasons: ['x down'] }),
    });
    const { text, meta } = await call('fmt:envelope', { transport: 'mcp' });
    expect(meta.nextCursor).toBe('CUR');
    expect(meta.degraded).toBe(true);
    expect(meta.degradedReasons).toEqual(['x down']);
    expect(text).not.toContain('CUR');
  });

  it('the output schema is advertised + the capability set is precomputed (P-010)', () => {
    defineListTool('fmt:advertise', { result: z.array(z.object({ id: z.number(), name: z.string() })) });
    const tool = lookupByMcpName('fmt:advertise')!;
    expect(tool.outputJsonSchema).toBeTruthy();
    expect([...(tool.resultEligibility?.capabilities ?? [])].sort()).toEqual(['csv', 'json', 'md', 'toon', 'tsv']);
  });

  it('tools/list advertises resultFormats always but outputSchema ONLY for object-rooted shapes', () => {
    // MCP `outputSchema` must be an object-typed JSON Schema (the SDK rejects a
    // tools/list otherwise). A bare-array list tool must therefore advertise its
    // capability via resultFormats but NOT emit an array-rooted outputSchema.
    defineListTool('fmt:arrlist', { result: z.array(z.object({ id: z.number(), name: z.string() })) });
    defineTool({
      name: 'fmt:objtool',
      requirePrincipal: false,
      capability: 'test:read',
      args: z.object({}),
      result: z.object({ slug: z.string(), status: z.string() }),
      handler: async () => ({ data: { slug: 'x', status: 'ok' } }),
    });
    const listings = listMcpProjections();
    const arr = listings.find((l) => l.name === 'fmt:arrlist')!;
    const obj = listings.find((l) => l.name === 'fmt:objtool')!;
    // Array list tool: no outputSchema (would be array-rooted), but resultFormats present.
    expect(arr.outputSchema).toBeUndefined();
    expect(arr.resultFormats).toEqual(['json', 'toon', 'csv', 'tsv', 'md']);
    // Mirrored onto _meta so it survives strict SDK validation.
    expect(arr._meta?.['papercusp/resultFormats']).toEqual(['json', 'toon', 'csv', 'tsv', 'md']);
    // Object tool: object-rooted outputSchema IS advertised.
    expect(obj.outputSchema?.type).toBe('object');
    expect(obj.resultFormats).toEqual(['json']);
  });

  it('opt-in structuredContent attaches lossless JSON alongside the compact text (P-010)', async () => {
    defineListTool('fmt:structured', { result: z.array(z.object({ id: z.number(), name: z.string() })) });
    const { result, text } = await call('fmt:structured', { transport: 'mcp', requestedStructured: true });
    expect(text).toMatch(/^format: toon\n/);
    expect(result.structuredContent).toEqual(ROWS);
  });

  it('a handler that returns a raw ToolResult is passed through untouched', async () => {
    defineTool({
      name: 'fmt:raw',
      requirePrincipal: false,
      capability: 'test:read',
      args: z.object({}),
      handler: async () => ({ content: [{ type: 'text', text: 'RAW' }] }),
    });
    const { text } = await call('fmt:raw', { transport: 'mcp' });
    expect(text).toBe('RAW');
  });
});

describe('raw-ToolResult re-encode on the MCP transport (definetool-token-optimization-adoption P-002)', () => {
  const ENVELOPE = { ok: true, results: [{ id: 'm1', memory: 'fact' }, { id: 'm2', memory: 'two' }], counts: { ok: 2, failed: 0 } };

  function definePrincipalRaw(name: string, text: string): void {
    defineTool({
      name,
      capability: 'test:read',
      args: z.object({}),
      handler: async () => ({ content: [{ type: 'text', text }] }),
    });
  }

  async function callPrincipal(name: string, transport: string) {
    const tool = lookupByMcpName(name)!;
    const r = await dispatchProjectedTool(
      tool,
      name,
      {},
      ctx({
        transport,
        principal: { slug: 'u', workspaceId: 'w', capabilities: new Set(['test:read']) },
        tx: {},
      } as unknown as Partial<UnifiedToolContext>),
      DEPS,
    );
    if (!r.ok) throw new Error(`dispatch failed: ${r.error?.code}`);
    return { text: (r.result!.content[0] as { text: string }).text, meta: r.result!._meta ?? {} };
  }

  it('an object-with-array-field JSON body IS re-encoded to compact TOON on mcp (the inliner win, lossless)', async () => {
    definePrincipalRaw('fmt:rawbulk-mcp', JSON.stringify(ENVELOPE));
    const { text, meta } = await callPrincipal('fmt:rawbulk-mcp', 'mcp');
    expect(meta.format).toBe('toon');
    expect(text).toMatch(/^format: toon\n/);
    // Lossless: decoding the TOON body recovers the exact handler payload.
    expect(decode(text.replace(/^format: toon\n/, ''), 'toon')).toEqual(ENVELOPE);
  });

  it('the SAME raw body passes through VERBATIM on a non-mcp transport (memory:* / TUI contract, P-006)', async () => {
    // The TUI Memory tab + every in-process compound read content[0].text as the
    // handler's own JSON over a non-mcp transport — they must see exact bytes.
    definePrincipalRaw('fmt:rawbulk-http', JSON.stringify(ENVELOPE));
    const { text, meta } = await callPrincipal('fmt:rawbulk-http', 'http');
    expect(text).toBe(JSON.stringify(ENVELOPE));
    expect(meta.format).toBeUndefined();
  });

  it('a plain-object JSON body (no array field) is left untouched even on mcp (no TOON win)', async () => {
    const obj = { ok: true, slug: 'x', status: 'done' };
    definePrincipalRaw('fmt:rawobj-mcp', JSON.stringify(obj));
    const { text, meta } = await callPrincipal('fmt:rawobj-mcp', 'mcp');
    expect(text).toBe(JSON.stringify(obj));
    expect(meta.format).toBeUndefined();
  });

  it('a non-JSON text body passes through untouched on mcp', async () => {
    definePrincipalRaw('fmt:rawtext-mcp', 'just a human message');
    const { text } = await callPrincipal('fmt:rawtext-mcp', 'mcp');
    expect(text).toBe('just a human message');
  });
});
