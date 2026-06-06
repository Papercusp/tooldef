import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { analyzeSchema } from '@papercusp/result-encoding';
import { serializeToolResponse, formatOptsFromCtx } from './serialize-result';
import type { ToolResponse } from './types';
import type { UnifiedToolContext } from './tool-projection';

const flatRows = [
  { id: 1, name: 'a' },
  { id: 2, name: 'b' },
];

function elig(schema: z.ZodTypeAny) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const js = (z as any).toJSONSchema(schema) as Record<string, unknown>;
  delete js.$schema;
  return analyzeSchema(js);
}

describe('serializeToolResponse — format selection', () => {
  it('MCP transport defaults to compact (toon) for array data', () => {
    const ctx = { transport: 'mcp' } as UnifiedToolContext;
    const r = serializeToolResponse({ data: flatRows }, formatOptsFromCtx(ctx, undefined));
    expect(r.format).toBe('toon');
    expect((r.content[0] as { text: string }).text).toMatch(/^format: toon\n/);
    expect((r.content[0] as { text: string }).text).toContain('[2]{id,name}:');
  });

  it('non-MCP transport defaults to JSON (unmarked, byte-compatible)', () => {
    const ctx = { transport: 'http' } as UnifiedToolContext;
    const r = serializeToolResponse({ data: flatRows }, formatOptsFromCtx(ctx, undefined));
    expect(r.format).toBe('json');
    expect((r.content[0] as { text: string }).text).toBe(JSON.stringify(flatRows));
  });

  it('explicit ?format=json overrides the MCP compact default', () => {
    const ctx = { transport: 'mcp', requestedFormat: 'json' } as UnifiedToolContext;
    const r = serializeToolResponse({ data: flatRows }, formatOptsFromCtx(ctx, undefined));
    expect(r.format).toBe('json');
    expect((r.content[0] as { text: string }).text).toBe(JSON.stringify(flatRows));
  });

  it('explicit csv is honored when the schema proves the data is flat', () => {
    const ctx = { transport: 'mcp', requestedFormat: 'csv' } as UnifiedToolContext;
    const eligibility = elig(z.array(z.object({ id: z.number(), name: z.string() })));
    const r = serializeToolResponse({ data: flatRows }, formatOptsFromCtx(ctx, eligibility));
    expect(r.format).toBe('csv');
    expect((r.content[0] as { text: string }).text).toBe('format: csv\nid,name\n1,a\n2,b');
    expect(r.fallback).toBe(false);
  });

  it('explicit csv on a nested-capable schema falls back to toon (labeled)', () => {
    const ctx = { transport: 'mcp', requestedFormat: 'csv' } as UnifiedToolContext;
    const nested = [{ id: 1, meta: { k: 1 } }];
    const eligibility = elig(z.array(z.object({ id: z.number(), meta: z.object({ k: z.number() }) })));
    const r = serializeToolResponse({ data: nested }, formatOptsFromCtx(ctx, eligibility));
    expect(r.format).toBe('toon');
    expect(r.fallback).toBe(true);
    expect(r._meta.formatFallback).toBe(true);
  });

  it('compact on a non-array schema yields JSON (no false fallback)', () => {
    const ctx = { transport: 'mcp' } as UnifiedToolContext;
    const eligibility = elig(z.object({ slug: z.string(), status: z.string() }));
    const r = serializeToolResponse({ data: { slug: 'x', status: 'ok' } }, formatOptsFromCtx(ctx, eligibility));
    expect(r.format).toBe('json');
    expect(r.fallback).toBe(false);
  });
});

describe('serializeToolResponse — envelope routing', () => {
  it('routes nextCursor/degraded into _meta, out of the body', () => {
    const ctx = { transport: 'mcp' } as UnifiedToolContext;
    const response: ToolResponse = {
      data: flatRows,
      nextCursor: 'CUR',
      degraded: true,
      degradedReasons: ['source-x down'],
    };
    const r = serializeToolResponse(response, formatOptsFromCtx(ctx, undefined));
    expect(r._meta.nextCursor).toBe('CUR');
    expect(r._meta.degraded).toBe(true);
    expect(r._meta.degradedReasons).toEqual(['source-x down']);
    // The cursor must NOT leak into the tabular body.
    expect((r.content[0] as { text: string }).text).not.toContain('CUR');
  });

  it('records the chosen format in _meta', () => {
    const ctx = { transport: 'mcp' } as UnifiedToolContext;
    const r = serializeToolResponse({ data: flatRows }, formatOptsFromCtx(ctx, undefined));
    expect(r._meta.format).toBe('toon');
  });

  it('appends uiResources after the text item', () => {
    const ctx = { transport: 'mcp' } as UnifiedToolContext;
    const ui = { type: 'resource' as const, resource: { uri: 'ui://x', mimeType: 'text/html', text: '<b/>' } };
    const r = serializeToolResponse({ data: flatRows, uiResources: [ui] }, formatOptsFromCtx(ctx, undefined));
    expect(r.content).toHaveLength(2);
    expect(r.content[1]).toEqual(ui);
  });
});
