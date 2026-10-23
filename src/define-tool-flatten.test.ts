import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { dataConditionSchema } from '@papercusp/rules';
import { defineTool, flattenForOpenAi, toArgsJsonSchema } from './define-tool';
import { listAllProjectedTools, _resetProjectionRegistryForTests } from './tool-projection';

describe('flattenForOpenAi', () => {
  it('does not let a never branch mask the valid resume/successor fields', () => {
    const base = z.object({
      brief: z.string().optional(),
      plan: z.string().optional(),
      resume: z
        .object({ agentId: z.string().optional(), sessionId: z.string().optional() })
        .optional(),
      successor: z
        .object({ agentId: z.string().optional(), sessionId: z.string().optional() })
        .optional(),
    });
    const schema = z.union([
      base.extend({ resume: z.never().optional(), successor: z.never().optional() }),
      base.extend({ plan: z.never().optional() }),
    ]);

    const flattened = flattenForOpenAi(toArgsJsonSchema('test:resume', schema));
    const properties = flattened.properties as Record<string, Record<string, unknown>>;

    expect(properties.resume).toMatchObject({ type: 'object' });
    expect(properties.successor).toMatchObject({ type: 'object' });
    expect(properties.plan).toMatchObject({ type: 'string' });
  });

  it('keeps first-declaration-wins for two satisfiable definitions', () => {
    const flattened = flattenForOpenAi({
      anyOf: [
        { type: 'object', properties: { value: { type: 'string' } } },
        { type: 'object', properties: { value: { type: 'number' } } },
      ],
    });

    expect(flattened.properties).toEqual({ value: { type: 'string' } });
  });

  it('unions a discriminated-union discriminator into an enum instead of collapsing to the first branch', () => {
    // EI-21914494224354098: release:repair-queue's `op: z.discriminatedUnion('op', [get, converge, retire])`
    // flattened to `op: { const: 'get' }` — hiding 'converge'/'retire' from every caller reading the schema.
    const schema = z.discriminatedUnion('op', [
      z.object({ op: z.literal('get') }),
      z.object({ op: z.literal('converge'), confirm: z.boolean().optional() }),
      z.object({ op: z.literal('retire'), reason: z.string() }),
    ]);

    const flattened = flattenForOpenAi(toArgsJsonSchema('test:op', schema));
    const properties = flattened.properties as Record<string, Record<string, unknown>>;

    expect(properties.op).toEqual({ type: 'string', enum: ['get', 'converge', 'retire'] });
    expect(flattened.required).toEqual(['op']);
  });

  it('leaves a single-valued const field alone (no spurious enum wrapping)', () => {
    const schema = z.union([
      z.object({ mode: z.literal('a'), extra: z.string().optional() }),
      z.object({ mode: z.literal('a'), other: z.number().optional() }),
    ]);

    const flattened = flattenForOpenAi(toArgsJsonSchema('test:same-const', schema));
    const properties = flattened.properties as Record<string, Record<string, unknown>>;

    expect(properties.mode).toEqual({ const: 'a', type: 'string' });
  });

  it('does not classify a constrained not schema as never', () => {
    const flattened = flattenForOpenAi({
      anyOf: [
        { type: 'object', properties: { value: { not: { type: 'string' } } } },
        { type: 'object', properties: { value: { type: 'number' } } },
      ],
    });

    expect(flattened.properties).toEqual({ value: { not: { type: 'string' } } });
  });

  it('keeps recursive definitions when flattening a union with a nested lazy schema', () => {
    const raw = toArgsJsonSchema(
      'test:recursive-filter',
      z.union([
        z.object({ pattern: z.string(), payload_filter: dataConditionSchema.optional() }),
        z.object({ pattern: z.string(), predicate: z.string() }),
      ]),
    );
    const flattened = flattenForOpenAi(raw);
    const properties = flattened.properties as Record<string, Record<string, unknown>>;
    const payloadFilter = properties.payload_filter;
    const definitions = flattened.$defs as Record<string, unknown> | undefined;

    expect(payloadFilter?.$ref).toMatch(/^#\/\$defs\//);
    expect(definitions).toBeDefined();
    expect(definitions?.[String(payloadFilter?.$ref).slice('#/$defs/'.length)]).toBeDefined();
  });
});

describe('registered schema factoring', () => {
  afterEach(() => _resetProjectionRegistryForTests());

  it.each([false, true])('factors after flattening and retains full discovery metadata (principal=%s)', (requirePrincipal) => {
    const report = () => z.object({
      title: z.string().min(1).max(200).describe('Human-readable report title.'),
      refs: z.array(z.string().min(1)).max(20).describe('Bounded source references.'),
    }).describe('The complete report, including the evidence references.');
    const args = z.object({ left: report(), right: report() });
    const name = `test:factored_${requirePrincipal}`;
    const definition = {
      name, capability: 'test:read', args,
      agentRoles: ['operator'],
      handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    };
    if (requirePrincipal) defineTool(definition);
    else defineTool({ ...definition, requirePrincipal: false });
    const tool = listAllProjectedTools().find((t) => t.expose.mcp?.name === name)!;
    const raw = toArgsJsonSchema(name, args);
    delete raw.$schema;
    for (const schema of [tool.inputSchema, tool.discoveryInputSchema!]) {
      expect(schema.$defs).toBeDefined();
      expect(schema.required).toEqual(['left', 'right']);
      expect((schema.properties as any).left).toEqual((schema.properties as any).right);
      expect(JSON.stringify(schema)).toContain('The complete report, including the evidence references.');
      expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThan(Buffer.byteLength(JSON.stringify(raw)));
    }
    expect(args.safeParse({ left: { title: 'L', refs: [] }, right: { title: 'R', refs: [] } }).success).toBe(true);
    expect(args.safeParse({ left: { title: '', refs: [] }, right: { title: 'R', refs: [] } }).success).toBe(false);
  });
});
