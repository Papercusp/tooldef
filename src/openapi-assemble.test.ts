import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assembleOpenApiDocument, toolOperationName } from './openapi-assemble';
import type { ProjectedTool } from './tool-projection';

const makeTool = (over: Partial<ProjectedTool> = {}): ProjectedTool => ({
  pluginName: 'fixture',
  description: 'fixture tool',
  inputSchema: { type: 'object' },
  capabilities: [],
  expose: { mcp: { name: 'fix.tool' } },
  fn: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  ...over,
});

describe('toolOperationName', () => {
  it('prefers the MCP dotted name', () => {
    expect(toolOperationName(makeTool({ expose: { mcp: { name: 'a.b' } } }))).toBe('a.b');
  });

  it('falls back to the HTTP path with slashes → dots', () => {
    expect(
      toolOperationName(makeTool({ expose: { http: { path: '/plugins/repomix/pack' } } })),
    ).toBe('plugins.repomix.pack');
  });

  it('returns null when neither exposure is set', () => {
    expect(toolOperationName(makeTool({ expose: {} as ProjectedTool['expose'] }))).toBeNull();
  });
});

describe('assembleOpenApiDocument', () => {
  it('emits a valid 3.1.0 envelope', () => {
    const doc = assembleOpenApiDocument([makeTool()]);
    expect(doc.openapi).toBe('3.1.0');
    expect((doc.info as { title: string }).title).toBe('Papercusp Tool API');
  });

  it('honors custom info options', () => {
    const doc = assembleOpenApiDocument([], {
      title: 'Custom',
      version: '9.9.9',
      description: 'desc',
    });
    expect(doc.info).toMatchObject({ title: 'Custom', version: '9.9.9', description: 'desc' });
  });

  it('emits one path per tool under .post', () => {
    const doc = assembleOpenApiDocument([
      makeTool({ expose: { mcp: { name: 'one.tool' } } }),
      makeTool({ expose: { mcp: { name: 'two.tool' } } }),
    ]);
    const paths = doc.paths as Record<string, unknown>;
    expect(Object.keys(paths)).toEqual(['/api/one.tool', '/api/two.tool']);
    expect((paths['/api/one.tool'] as { post: unknown }).post).toBeDefined();
  });

  it('sorts paths by operation name for byte-stable output', () => {
    const doc = assembleOpenApiDocument([
      makeTool({ expose: { mcp: { name: 'zebra.tool' } } }),
      makeTool({ expose: { mcp: { name: 'alpha.tool' } } }),
    ]);
    expect(Object.keys(doc.paths as Record<string, unknown>)).toEqual([
      '/api/alpha.tool',
      '/api/zebra.tool',
    ]);
  });

  it('merges each tool schemas into components.schemas', () => {
    const doc = assembleOpenApiDocument([
      makeTool({ expose: { mcp: { name: 'one.tool' } } }),
      makeTool({
        expose: { mcp: { name: 'two.tool' } },
        events: { tick: z.object({ n: z.number() }) },
      }),
    ]);
    const schemas = (doc.components as { schemas: Record<string, unknown> }).schemas;
    expect(schemas['one.tool.Input']).toBeDefined();
    expect(schemas['two.tool.Event.tick']).toBeDefined();
  });

  it('registers a bearerAuth security scheme + the 7 response components', () => {
    const doc = assembleOpenApiDocument([makeTool()]);
    const components = doc.components as {
      securitySchemes: Record<string, unknown>;
      responses: Record<string, unknown>;
    };
    expect(components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(Object.keys(components.responses)).toHaveLength(7);
  });

  it('throws on a path collision', () => {
    // Two tools, same operation name → same path.
    expect(() =>
      assembleOpenApiDocument([
        makeTool({ expose: { mcp: { name: 'dup.tool' } } }),
        makeTool({ expose: { mcp: { name: 'dup.tool' } } }),
      ]),
    ).toThrow(/collision on/);
  });

  it('skips tools with no exposure (no mcp + no http)', () => {
    const doc = assembleOpenApiDocument([
      makeTool({ expose: {} as ProjectedTool['expose'] }),
      makeTool({ expose: { mcp: { name: 'real.tool' } } }),
    ]);
    expect(Object.keys(doc.paths as Record<string, unknown>)).toEqual(['/api/real.tool']);
  });

  it('omits servers when not provided, includes them when set', () => {
    const without = assembleOpenApiDocument([makeTool()]);
    expect(without.servers).toBeUndefined();
    const withServers = assembleOpenApiDocument([makeTool()], {
      servers: [{ url: 'http://127.0.0.1:3070' }],
    });
    expect(withServers.servers).toEqual([{ url: 'http://127.0.0.1:3070' }]);
  });

  it('produces identical output across runs (byte-stable)', () => {
    const tools = [
      makeTool({ expose: { mcp: { name: 'b.tool' } } }),
      makeTool({ expose: { mcp: { name: 'a.tool' } } }),
    ];
    const a = JSON.stringify(assembleOpenApiDocument(tools));
    const b = JSON.stringify(assembleOpenApiDocument(tools));
    expect(a).toBe(b);
  });
});
