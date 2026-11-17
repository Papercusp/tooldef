import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import Ajv2020 from 'ajv/dist/2020';
import {
  BatchEnvelopeError,
  createToolBatchContract,
  normalizeBatchRequest,
  resolveToolBatchDeclaration,
  type ToolBatchDeclaration,
} from './batch';
import { defineTool } from './define-tool';
import { toJsonSchema } from './schema-adapter';
import { standardValidate, type StandardSchemaV1 } from './standard-schema';
import { lookupByMcpName, registerProjectedTool } from './tool-projection';

const operation = z.strictObject({ key: z.string(), ids: z.array(z.string()).optional() });
const contract = (declaration: ToolBatchDeclaration = {}) =>
  createToolBatchContract(operation, toJsonSchema(operation), declaration);
const ajv = () => new Ajv2020({ strict: false });

describe('permanent shallow batch normalization', () => {
  it('keeps marked, unmarked, object-items and singleton operations equivalent', async () => {
    const args = { key: 'a', ids: ['x', 'y'] };
    const normalize = contract().normalize;
    for (const input of [
      args,
      { _batch: 1, items: [{ args }] },
      { items: [{ args }] },
      { _batch: 1, items: { args } },
      { items: { args } },
    ]) {
      const result = await normalize(input);
      expect(result.items).toEqual([{ itemId: 'item-1', args }]);
      expect(result.items[0].args).toBe(args);
      expect(args.ids).toEqual(['x', 'y']);
    }
  });

  it('prefers valid business objects with envelope-like items/args/ids/keys', async () => {
    const business = z.strictObject({
      items: z.object({ args: z.object({ key: z.string() }) }),
      args: z.array(z.string()), ids: z.array(z.string()), keys: z.array(z.string()),
    });
    const input = { items: { args: { key: 'a' } }, args: ['business'], ids: ['same'], keys: ['same'] };
    expect(await normalizeBatchRequest(input, business)).toEqual({
      source: 'singleton', items: [{ itemId: 'item-1', args: input }],
    });
    const collision = z.strictObject({ items: z.array(z.strictObject({ args: operation })) });
    const value = { items: [{ args: { key: 'a' } }] };
    expect((await normalizeBatchRequest(value, collision)).items[0].args).toBe(value);
    expect((await normalizeBatchRequest({ _batch: 1, ...value }, collision)).items[0].args).toBe(value.items[0].args);
  });

  it('reserves later caller IDs and preserves repeated domain keys and input order', async () => {
    const input = { _batch: 1, items: [
      { args: { key: 'same' } },
      { itemId: 'item-1', args: { key: 'same' } },
      { itemId: 'item-3', args: { key: 'same' } },
      { args: { key: 'same' } },
    ] };
    const result = await contract().normalize(input);
    expect(result.items.map((item) => item.itemId)).toEqual(['item-2', 'item-1', 'item-3', 'item-4']);
    expect(result.items.map((item) => item.args.key)).toEqual(['same', 'same', 'same', 'same']);
    expect(input.items[0]).not.toHaveProperty('itemId');
    expect(Object.isFrozen(result.items)).toBe(true);
  });

  it.each([
    { _batch: 0, items: [{ args: { key: 'a' } }] },
    { _batch: 2, key: 'a' },
    { _batch: 1, items: [] },
    { _batch: 1, items: null },
    { _batch: 1, items: [{ args: { key: 'a' } }], maxConcurrency: 20 },
    { _batch: 1, items: [{ args: { key: 'a' }, extra: true }] },
    { _batch: 1, items: [{ args: { key: 'a' }, itemId: '' }] },
    { _batch: 1, items: [{ args: { key: 'a' }, itemId: 'x'.repeat(129) }] },
    { _batch: 1, items: [{ args: { key: 'a' }, itemId: undefined }] },
    { _batch: 1, items: [{ args: { key: 'a' }, itemId: 1 }] },
    { _batch: 1, items: [{ args: [] }] },
    { _batch: 1, items: [{ key: 'a' }] },
    { _batch: 1, items: [{ args: { key: 'a' }, itemId: 'dup' }, { args: { key: 'b' }, itemId: 'dup' }] },
    { items: [{ args: { key: 'a' } }], extra: true },
    { items: [] },
    [], null, 'a',
  ])('rejects invalid outer grammar before any execution: %j', async (input) => {
    await expect(contract().normalize(input)).rejects.toBeInstanceOf(BatchEnvelopeError);
  });

  it('enforces the default ceiling and a lower tool ceiling without client overrides', async () => {
    const items = Array.from({ length: 101 }, () => ({ args: { key: 'a' } }));
    await expect(contract().normalize({ _batch: 1, items })).rejects.toThrow('1–100');
    await expect(contract({ maxItems: 2 }).normalize({ _batch: 1, items: items.slice(0, 3) })).rejects.toThrow('1–2');
    expect((await contract().normalize({ _batch: 1, items: items.slice(0, 100) })).items).toHaveLength(100);
  });

  it('leaves invalid business inputs for the ordinary per-item validator without repairs', async () => {
    for (const args of [{}, { key: 1 }, { key: 'a', typo: true }]) {
      const result = await contract().normalize(args);
      expect(result.items[0].args).toBe(args);
      expect((await standardValidate(operation, result.items[0].args)).ok).toBe(false);
    }
    const result = await contract().normalize({ _batch: 1, items: [
      { args: { key: 'valid' } }, { args: { missing: true } },
    ] });
    expect((await standardValidate(operation, result.items[0].args)).ok).toBe(true);
    expect((await standardValidate(operation, result.items[1].args)).ok).toBe(false);
  });

  it('uses the Standard Schema adapter, including async validators, for grammar selection', async () => {
    const schema: StandardSchemaV1 = { '~standard': {
      version: 1, vendor: 'test',
      validate: async (value) => value && typeof value === 'object' && 'items' in value
        ? { value } : { issues: [{ message: 'items required' }] },
    } };
    const input = { items: [{ args: { key: 'business' } }] };
    expect((await normalizeBatchRequest(input, schema)).source).toBe('singleton');
  });

  it('uses an explicit legacy adapter without recursively normalizing business arrays', async () => {
    const legacy = { schema: z.strictObject({ id: z.string() }), toOperation: (value: unknown) => ({ key: (value as { id: string }).id }) };
    expect(await contract({ legacy }).normalize({ id: 'a' })).toEqual({
      source: 'legacy', items: [{ itemId: 'item-1', args: { key: 'a' } }],
    });
  });
});

describe('operation-derived batch schemas and registration', () => {
  it('advertises canonical arrays, both singleton forms, and valid business arrays', () => {
    const validate = ajv().compile(contract().requestJsonSchema);
    for (const input of [
      { key: 'a', ids: ['b', 'c'] },
      { _batch: 1, items: [{ args: { key: 'a' } }] },
      { items: [{ args: { key: 'a' } }] },
      { _batch: 1, items: { itemId: 'a', args: { key: 'a' } } },
      { items: { args: { key: 'a' } } },
    ]) expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
    for (const input of [
      { _batch: 2, items: [{ args: { key: 'a' } }] },
      { _batch: 1, items: [] },
      { _batch: 1, items: [{ args: { key: 1 } }] },
      { _batch: 1, items: [{ args: { key: 'a' }, extra: true }] },
      { _batch: 1, items: [{ args: { key: 'a' } }], extra: true },
    ]) expect(validate(input)).toBe(false);
  });

  it('preserves local recursive refs in nested operation schemas and caller schemas', () => {
    const json = { type: 'object', properties: {
      key: { $ref: '#/$defs/key' }, child: { $ref: '#' },
    }, required: ['key'], additionalProperties: false, $defs: { key: { type: 'string' } } };
    const before = JSON.stringify(json);
    const generated = createToolBatchContract(operation, json).requestJsonSchema;
    const validate = ajv().compile(generated);
    expect(validate({ _batch: 1, items: [{ args: { key: 'a', child: { key: 'b' } } }] })).toBe(true);
    expect(validate({ _batch: 1, items: [{ args: { key: 'a', child: { key: 1 } } }] })).toBe(false);
    expect(JSON.stringify(json)).toBe(before);
  });

  it('advertises exactly the common keyed disposition spine and preserves child output/media', () => {
    const validate = ajv().compile(contract().resultJsonSchema);
    const output = { content: [{ type: 'image', data: 'unchanged', mimeType: 'image/png' }], structuredContent: { found: false } };
    expect(validate({ ok: true, batchId: 'b', results: [{ itemId: 'a', ok: true, status: 'completed', output }], counts: { ok: 1, failed: 0 } })).toBe(true);
    for (const status of ['completed', 'failed', 'cancelled', 'not-started', 'unknown-effect']) {
      expect(validate({ ok: false, batchId: 'b', results: [{ itemId: 'a', ok: false, status }], counts: { ok: 0, failed: 1 } })).toBe(true);
    }
    expect(validate({ ok: true, batchId: 'b', results: [{ ok: true, status: 'completed' }], counts: { ok: 1, failed: 0 } })).toBe(false);
  });

  it('retains independent schema resources and literal metadata when embedding schemas', () => {
    const json = {
      $id: 'https://example.test/operation', type: 'object',
      properties: { key: { $ref: '#/$defs/key' } }, required: ['key'],
      $defs: { key: { type: 'string' } },
    };
    const validate = ajv().compile(createToolBatchContract(operation, json).requestJsonSchema);
    expect(validate({ _batch: 1, items: [{ args: { key: 'a' } }] })).toBe(true);
    expect(validate({ _batch: 1, items: [{ args: { key: 1 } }] })).toBe(false);
    const literals = { default: { $ref: '#/literal' }, examples: [{ $ref: '#/example' }], const: { $ref: '#/value' } };
    const generated = createToolBatchContract(operation, {
      type: 'object', properties: { key: { type: 'string' }, data: literals },
    }).requestJsonSchema as { $defs: { operation: { properties: { data: unknown } } } };
    expect(generated.$defs.operation.properties.data).toEqual(literals);
  });

  it('derives lower discovery limits and explicit legacy syntax from the same contract', () => {
    const legacy = z.strictObject({ id: z.string() });
    const generated = createToolBatchContract(operation, toJsonSchema(operation), {
      maxItems: 2,
      legacy: { schema: legacy, toOperation: (value: unknown) => ({ key: (value as { id: string }).id }) },
    }, toJsonSchema(legacy));
    const validate = ajv().compile(generated.requestJsonSchema);
    expect(validate({ id: 'a' })).toBe(true);
    expect(validate({ _batch: 1, items: [{ args: { key: 'a' } }, { args: { key: 'b' } }] })).toBe(true);
    expect(validate({ _batch: 1, items: Array.from({ length: 3 }, () => ({ args: { key: 'a' } })) })).toBe(false);
  });

  it('rejects root marker declarations through unions and refs, allowing nested business markers', () => {
    for (const schema of [
      { type: 'object', properties: { _batch: { type: 'string' } } },
      { anyOf: [{ type: 'object' }, { type: 'object', properties: { _batch: {} } }] },
      { $ref: '#/$defs/root', $defs: { root: { properties: { _batch: {} } } } },
    ]) expect(() => createToolBatchContract(operation, schema)).toThrow(/reserved/);
    expect(() => createToolBatchContract(operation, { type: 'object', properties: { nested: { properties: { _batch: {} } } } })).not.toThrow();
  });

  it('defaults to bounded sequential execution and requires declared independence', () => {
    expect(resolveToolBatchDeclaration()).toMatchObject({ maxItems: 100, maxConcurrency: 1, independent: false });
    for (const declaration of [{ maxItems: 0 }, { maxItems: 101 }, { maxItems: 1.5 }, { maxConcurrency: 0 }, { maxConcurrency: 2 }, { maxConcurrency: Infinity }, { maxItems: 1, maxConcurrency: 2, independent: true }]) {
      expect(() => resolveToolBatchDeclaration(declaration)).toThrow();
    }
    expect(resolveToolBatchDeclaration({ maxConcurrency: 3, independent: true }).maxConcurrency).toBe(3);
  });

  it.each([false, true])('threads declarations and contracts through principal/role registration: role=%s', async (role) => {
    const name = 'batch-test:' + (role ? 'role' : 'principal');
    const execute = vi.fn(async () => []);
    const definition = defineTool({
      name, ...(role ? { requirePrincipal: false as const } : {}),
      capability: 'test:read', args: operation,
      batch: { maxItems: 4, execute },
      handler: async () => ({ content: [] }),
    });
    const projected = lookupByMcpName(name)!;
    expect(definition.batch).toMatchObject({ maxItems: 4, maxConcurrency: 1 });
    expect(projected.batch?.execute).toBe(execute);
    const request = { _batch: 1, items: [{ args: { key: 'a' } }] };
    expect((await projected.batchContract!.normalize(request)).items).toHaveLength(1);
    expect(ajv().compile(projected.batchContract!.requestJsonSchema)(request)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('adds sequential policy to direct/plugin registrations and rejects undeclared parallelism', () => {
    const tool = {
      pluginName: 'batch-test', description: 'test', inputSchema: { type: 'object' }, capabilities: [],
      expose: { mcp: { name: 'batch-test:plugin' } }, fn: async () => ({ content: [] }),
    };
    registerProjectedTool(tool);
    expect(lookupByMcpName('batch-test:plugin')?.batch).toMatchObject({ maxItems: 100, maxConcurrency: 1 });
    expect(() => registerProjectedTool({ ...tool, batch: { maxConcurrency: 2 } })).toThrow(/independent/);
  });

  it('rejects scalar-only registration before polluting either catalog and names the tool', () => {
    expect(() => defineTool({
      name: 'batch-test:scalar', requirePrincipal: false, capability: 'test:read',
      args: z.string(), handler: async () => ({ content: [] }),
    })).toThrow(/batch-test:scalar.*object args schema/);
    expect(lookupByMcpName('batch-test:scalar')).toBeUndefined();
    expect(() => registerProjectedTool({
      pluginName: 'batch-test', description: 'test', inputSchema: { type: 'array', items: { type: 'string' } },
      capabilities: [], expose: { mcp: { name: 'batch-test:scalar-plugin' } }, fn: async () => ({ content: [] }),
    })).toThrow(/batch-test:scalar-plugin.*object args schema/);
    expect(lookupByMcpName('batch-test:scalar-plugin')).toBeUndefined();
  });

  it('permits an explicit object operation adapter for legacy scalar business input', async () => {
    defineTool({
      name: 'batch-test:adapted', requirePrincipal: false, capability: 'test:read', args: z.string(),
      batch: {
        operation: z.strictObject({ key: z.string() }),
        toHandlerArgs: (args) => (args as { key: string }).key,
      },
      handler: async () => ({ content: [] }),
    });
    const projected = lookupByMcpName('batch-test:adapted')!;
    const input = { _batch: 1, items: [{ args: { key: 'a' } }] };
    expect(ajv().compile(projected.batchContract!.requestJsonSchema)(input)).toBe(true);
    const normalized = await projected.batchContract!.normalize(input);
    expect(projected.batch!.toHandlerArgs!(normalized.items[0].args)).toBe('a');
  });
});
