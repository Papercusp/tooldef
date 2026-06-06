import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import {
  analyzeSchema,
  configurePrePromptRegistry,
  clearPrePromptRegistry,
  projectReadColumns,
} from '@papercusp/result-encoding';
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

describe('serializeToolResponse — Tier-3 prompt-declared columns (read, P-004)', () => {
  afterEach(() => clearPrePromptRegistry());

  const schema = z.array(z.object({ id: z.string(), state: z.enum(['todo', 'done']) }));
  const readColumns = projectReadColumns(
    (() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const js = (z as any).toJSONSchema(schema) as Record<string, unknown>;
      delete js.$schema;
      return js;
    })(),
  );
  const rows = [
    { id: 'WI-1', state: 'todo' },
    { id: 'WI-2', state: 'done' },
  ];

  function opts(ctx: UnifiedToolContext) {
    return { ...formatOptsFromCtx(ctx, elig(schema)), toolName: 'work_items:list', readColumns };
  }

  it('registry tool → headerless CSV + [N] guard, no header row', () => {
    configurePrePromptRegistry([{ name: 'work_items:list', read: 'csv' }]);
    const ctx = { transport: 'mcp' } as UnifiedToolContext;
    const r = serializeToolResponse({ data: rows }, opts(ctx));
    expect(r.format).toBe('csv');
    expect(r._meta.prePrompt).toBe(true);
    expect((r.content[0] as { text: string }).text).toBe('format: csv\n[2]\nWI-1,todo\nWI-2,done');
  });

  it('[N] guard reflects the row count (truncation signal)', () => {
    configurePrePromptRegistry([{ name: 'work_items:list', read: 'csv' }]);
    const ctx = { transport: 'mcp' } as UnifiedToolContext;
    const r = serializeToolResponse({ data: [rows[0]] }, opts(ctx));
    expect((r.content[0] as { text: string }).text).toBe('format: csv\n[1]\nWI-1,todo');
  });

  it('envelope still rides in _meta under Tier-3', () => {
    configurePrePromptRegistry([{ name: 'work_items:list', read: 'csv' }]);
    const ctx = { transport: 'mcp' } as UnifiedToolContext;
    const r = serializeToolResponse({ data: rows, nextCursor: 'CUR' }, opts(ctx));
    expect(r._meta.nextCursor).toBe('CUR');
    expect((r.content[0] as { text: string }).text).not.toContain('CUR');
  });

  it('explicit ?format=json opts OUT of Tier-3 (lossless honored)', () => {
    configurePrePromptRegistry([{ name: 'work_items:list', read: 'csv' }]);
    const ctx = { transport: 'mcp', requestedFormat: 'json' } as UnifiedToolContext;
    const r = serializeToolResponse({ data: rows }, opts(ctx));
    expect(r.format).toBe('json');
    expect(r._meta.prePrompt).toBeUndefined();
    expect((r.content[0] as { text: string }).text).toBe(JSON.stringify(rows));
  });

  it('non-registry tool is unaffected (stays TOON-auto)', () => {
    // registry empty
    const ctx = { transport: 'mcp' } as UnifiedToolContext;
    const r = serializeToolResponse({ data: rows }, opts(ctx));
    expect(r.format).toBe('toon');
    expect(r._meta.prePrompt).toBeUndefined();
  });

  it('read:off in the registry leaves the tool on the default path', () => {
    configurePrePromptRegistry([{ name: 'work_items:list', read: 'off' }]);
    const ctx = { transport: 'mcp' } as UnifiedToolContext;
    const r = serializeToolResponse({ data: rows }, opts(ctx));
    expect(r.format).toBe('toon');
  });

  it('read:tsv produces a tab-delimited headerless body', () => {
    configurePrePromptRegistry([{ name: 'work_items:list', read: 'tsv' }]);
    const ctx = { transport: 'mcp' } as UnifiedToolContext;
    const r = serializeToolResponse({ data: rows }, opts(ctx));
    expect(r.format).toBe('tsv');
    expect((r.content[0] as { text: string }).text).toBe('format: tsv\n[2]\nWI-1\ttodo\nWI-2\tdone');
  });

  it('a structured-content request opts OUT of Tier-3 (UI/programmatic consumer keeps lossless)', () => {
    configurePrePromptRegistry([{ name: 'work_items:list', read: 'csv' }]);
    const ctx = { transport: 'mcp', requestedStructured: true } as UnifiedToolContext;
    const r = serializeToolResponse({ data: rows }, opts(ctx));
    expect(r._meta.prePrompt).toBeUndefined();
    expect(r.format).not.toBe('csv'); // not the headerless Tier-3 body
    expect(r.structuredContent).toEqual(rows); // lossless copy attached
  });

  it('empty array under Tier-3 → just the [0] guard (no rows, no crash)', () => {
    configurePrePromptRegistry([{ name: 'work_items:list', read: 'csv' }]);
    const ctx = { transport: 'mcp' } as UnifiedToolContext;
    const r = serializeToolResponse({ data: [] }, opts(ctx));
    expect((r.content[0] as { text: string }).text).toBe('format: csv\n[0]');
  });
});
