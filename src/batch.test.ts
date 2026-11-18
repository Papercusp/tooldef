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
import { listMcpProjections, lookupByMcpName, registerProjectedTool } from './tool-projection';
import { dispatchProjectedTool } from './dispatch-projected';
import type { ProjectedTool, UnifiedToolContext } from './tool-projection';
import type { BatchResult } from './batch';

const operation = z.strictObject({ key: z.string(), ids: z.array(z.string()).optional() });
const contract = (declaration: ToolBatchDeclaration = {}) =>
  createToolBatchContract(operation, toJsonSchema(operation), declaration);
const ajv = () => new Ajv2020({ strict: false });

describe('batch coordinator through ordinary child dispatch', () => {
  const context = (): UnifiedToolContext => ({
    log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
    workspaceId: 'default', harnessSlug: 'batch-fixture', role: 'worker', runId: 'batch-fixture',
  });
  const fixture = (fn: ProjectedTool['fn'], schema: StandardSchemaV1 = operation): ProjectedTool => ({
    pluginName: 'batch-fixture', description: 'batch fixture', inputSchema: toJsonSchema(schema),
    capabilities: [], effect: 'write', expose: { mcp: { name: 'batch-fixture:write' } }, fn,
    batchContract: createToolBatchContract(schema, toJsonSchema(schema)),
  });
  const invoke = async (tool: ProjectedTool, input: unknown, ctx = context()) => {
    const result = await dispatchProjectedTool(tool, 'batch-fixture:write', input, ctx, {});
    expect(result.ok).toBe(true);
    expect(result.result?.structuredContent).toMatchObject({ results: expect.any(Array) });
    return result.result!.structuredContent as unknown as BatchResult;
  };

  it('UTB-singleton-parity preserves equivalent singleton and one-item outputs and effects', async () => {
    const effects: unknown[] = [];
    const tool = fixture(async args => {
      effects.push(args);
      return { content: [{ type: 'text', text: JSON.stringify(args) }] };
    });
    const args = { key: 'a', ids: ['x', 'y'] };
    const flat = await invoke(tool, args);
    const marked = await invoke(tool, { _batch: 1, items: [{ args }] });
    expect(flat.results).toEqual(marked.results);
    expect(flat.counts).toEqual({ ok: 1, failed: 0 });
    expect(effects).toEqual([args, args]);
  });

  it('isolates child failures while running authorization and telemetry per item', async () => {
    const effects: string[] = [];
    const authorize = vi.fn(async ({ input }) => (input as { key: string }).key === 'denied'
      ? { allow: false, reason: 'fixture denial' } : { allow: true });
    const recordInvocation = vi.fn();
    const tool = fixture(async args => {
      const { key } = args as { key: string };
      if (key === 'throws') throw new Error('fixture failure');
      effects.push(key);
      return { content: [] };
    });
    tool.authorize = authorize;
    const result = await dispatchProjectedTool(tool, 'batch-fixture:write', {
      _batch: 1, items: ['denied', 'throws', 'ok'].map(key => ({ itemId: key, args: { key } })),
    }, context(), { recordInvocation });
    const data = result.result!.structuredContent as unknown as BatchResult;
    expect(data.results.map(row => [row.itemId, row.ok])).toEqual([['denied', false], ['throws', false], ['ok', true]]);
    expect(data.counts).toEqual({ ok: 1, failed: 2 });
    expect(effects).toEqual(['ok']);
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(recordInvocation).toHaveBeenCalledTimes(3);
  });

  it('rejects malformed envelope metadata before any child enters dispatch', async () => {
    const fn = vi.fn(async (_args: unknown) => ({ content: [] }));
    const onDispatchStart = vi.fn();
    const result = await dispatchProjectedTool(fixture(fn), 'batch-fixture:write', {
      _batch: 1, items: [{ itemId: 'same', args: { key: 'a' } }, { itemId: 'same', args: { key: 'b' } }],
    }, context(), { onDispatchStart });
    expect(result.error?.code).toBe('invalid_input');
    expect(fn).not.toHaveBeenCalled();
    expect(onDispatchStart).not.toHaveBeenCalled();
  });

  it('UTB-business-array preserves an ambiguous business items array as one operation', async () => {
    const schema = z.strictObject({
      items: z.array(z.strictObject({ args: operation })),
      args: z.string().optional(),
    });
    const fn = vi.fn(async (_args: unknown) => ({ content: [] }));
    const args = { items: [{ args: { key: 'a' } }, { args: { key: 'b' } }], args: 'business metadata' };
    const tool = fixture(fn, schema);
    const flat = await invoke(tool, args);
    const marked = await invoke(tool, { _batch: 1, items: [{ args }] });
    expect(flat.results).toHaveLength(1);
    expect(flat.results).toEqual(marked.results);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls.map(([input]) => input)).toEqual([args, args]);
  });

  it('negotiates an exact operation result independently of singleton or envelope syntax', async () => {
    const output = { content: [{ type: 'text' as const, text: 'raw bytes\n' }],
      _meta: { delta: { mode: 'not_modified', cursor: 'next' } }, isError: true };
    const fn = vi.fn(async (_args: unknown) => output);
    const tool = fixture(fn);
    for (const input of [{ key: 'a' }, { _batch: 1, items: [{ args: { key: 'a' } }] }]) {
      const result = await dispatchProjectedTool(tool, 'batch-fixture:write', input, context(),
        { batchResponseVersion: 'operation-v0' });
      expect(result).toEqual({ ok: true, result: output });
    }
    expect(fn).toHaveBeenCalledTimes(2);
    const canonical = await invoke(tool, { key: 'a' });
    expect(canonical.results[0]).toMatchObject({ ok: false, status: 'failed', output });
  });

  it('refuses multi-item legacy responses before gates or effects instead of dropping siblings', async () => {
    const fn = vi.fn(async (_args: unknown) => ({ content: [] }));
    const onDispatchStart = vi.fn();
    const result = await dispatchProjectedTool(fixture(fn), 'batch-fixture:write', {
      _batch: 1, items: [{ args: { key: 'a' } }, { args: { key: 'b' } }],
    }, context(), { batchResponseVersion: 'operation-v0', onDispatchStart });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(fn).not.toHaveBeenCalled();
    expect(onDispatchStart).not.toHaveBeenCalled();
  });

  it.each([false, true])('runs registered tools through the public canonical path (principal=%s)', async principal => {
    const name = 'batch-fixture:public-' + principal;
    const effects: string[] = [];
    const definition = { name, capability: 'test:write', args: operation,
      handler: async (args: z.infer<typeof operation>) => { effects.push(args.key); return { data: { key: args.key } }; } };
    if (principal) defineTool(definition);
    else defineTool({ ...definition, requirePrincipal: false });
    const tool = lookupByMcpName(name)!;
    const ctx = { ...context(), requestedStructured: true,
      principal: { slug: 'fixture', workspaceId: 'default', capabilities: new Set(['test:write']) } };
    const results = [];
    for (const input of [{ key: 'a' }, { _batch: 1, items: [{ args: { key: 'a' } }] }]) {
      const out = await dispatchProjectedTool(tool, name, input, ctx, {});
      expect(out.ok).toBe(true);
      results.push(out.result!.structuredContent as unknown as BatchResult);
    }
    expect(results[0].results).toEqual(results[1].results);
    expect(results[0].results[0].output?.structuredContent).toEqual({ key: 'a' });
    expect(effects).toEqual(['a', 'a']);
  });

  it('keeps per-item validation failures and complete media/metadata beside successful siblings', async () => {
    defineTool({ name: 'batch-fixture:media', requirePrincipal: false, capability: 'test:write', args: operation,
      handler: async () => ({ content: [{ type: 'image', data: 'fixture', mimeType: 'image/png' }],
        structuredContent: { found: false }, _meta: { nextCursor: 'page-2' } }) });
    const tool = lookupByMcpName('batch-fixture:media')!;
    const out = await dispatchProjectedTool(tool, 'batch-fixture:media', {
      _batch: 1, items: [{ itemId: 'invalid', args: {} }, { itemId: 'media', args: { key: 'a' } }],
    }, context(), {});
    const data = out.result!.structuredContent as unknown as BatchResult;
    expect(data.counts).toEqual({ ok: 1, failed: 1 });
    expect(data.results[0]).toMatchObject({ itemId: 'invalid', ok: false, error: { code: 'invalid_input' } });
    expect(data.results[1]).toMatchObject({ itemId: 'media', ok: true, output: {
      content: [{ type: 'image', data: 'fixture', mimeType: 'image/png' }],
      structuredContent: { found: false }, _meta: { nextCursor: 'page-2' },
    } });
  });

  it.each(['json', 'toon'] as const)('classifies an explicit refusal after %s serialization', async requestedFormat => {
    const name = 'batch-fixture:refusal-' + requestedFormat;
    defineTool({ name, requirePrincipal: false, capability: 'test:write', args: operation,
      handler: async () => ({ data: { ok: false, reason: 'fixture_refusal' } }) });
    const out = await dispatchProjectedTool(lookupByMcpName(name)!, name, { key: 'a' },
      { ...context(), transport: 'mcp', requestedFormat }, {});
    const data = out.result!.structuredContent as unknown as BatchResult;
    expect(data.results[0].output?.structuredContent).toBeUndefined();
    if (requestedFormat === 'toon') expect(data.results[0].output?.content[0])
      .toMatchObject({ type: 'text', text: expect.stringMatching(/^format: toon\n/) });
    expect(data.counts).toEqual({ ok: 0, failed: 1 });
    expect(data.results[0]).toMatchObject({ ok: false, status: 'failed' });
    expect(out.result?.isError).toBe(true);
  });
});

describe('native execution at the validated host continuation', () => {
  const context = (): UnifiedToolContext => ({
    log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
    workspaceId: 'default', harnessSlug: 'native-fixture', role: 'worker', runId: 'native-fixture',
    requestedStructured: true,
    principal: { kind: 'system', slug: 'native-fixture', workspaceId: 'default',
      authMethod: 'process-internal', trust: 'trusted', capabilities: new Set(['test:read']) },
  });
  let ordinal = 0;
  const register = (batch: ToolBatchDeclaration<{ key: string }>, principal = false) => {
    const name = 'batch-fixture:native-' + ++ordinal;
    const handler = vi.fn(async (args: { key: string }) => ({ data: { key: args.key } }));
    const definition = { name, capability: 'test:read', effect: 'read' as const,
      args: z.strictObject({ key: z.string().trim().min(1) }), batch, handler };
    if (principal) defineTool(definition);
    else defineTool({ ...definition, requirePrincipal: false });
    return { name, handler, tool: lookupByMcpName(name)! };
  };
  const dispatch = async (tool: ProjectedTool, name: string, input: unknown,
    deps: Parameters<typeof dispatchProjectedTool>[4] = {}, ctx = context()) => {
    const result = await dispatchProjectedTool(tool, name, input, ctx, deps);
    expect(result.ok).toBe(true);
    return { wire: result.result!, data: result.result!.structuredContent as unknown as BatchResult };
  };

  it.each([false, true])('uses the same validation/result adapter for native and fallback (principal=%s)', async principal => {
    const execute = vi.fn<NonNullable<ToolBatchDeclaration['execute']>>(async items => {
      expect(Object.isFrozen(items)).toBe(true);
      expect(items.every(item => Object.isFrozen(item) && item.callId && item.signal === item.ctx.signal)).toBe(true);
      return [...items].reverse().map(item => ({ itemId: item.itemId, response: { data: { key: (item.args as { key: string }).key } } }));
    });
    const result = vi.fn((response, args) => ({ data: { ...response.data, adapted: args.key } }));
    const { tool, name, handler } = register({ execute, result }, principal);
    for (const input of [{ key: ' a ' }, { _batch: 1, items: [{ args: { key: ' a ' } }] }]) {
      const { data } = await dispatch(tool, name, input);
      expect(data.results[0].output?.structuredContent).toEqual({ key: 'a', adapted: 'a' });
    }
    const { data } = await dispatch(tool, name, { _batch: 1, items: [
      { itemId: 'a', args: { key: ' a ' } }, { itemId: 'b', args: { key: 'b' } },
    ] });
    expect(data.results.map(item => item.output?.structuredContent)).toEqual([
      { key: 'a', adapted: 'a' }, { key: 'b', adapted: 'b' },
    ]);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[2][0]).toHaveLength(2);
    expect(handler).not.toHaveBeenCalled();
    const fallback = { ...tool, batch: { ...tool.batch, execute: undefined } };
    const control = await dispatch(fallback, name, { key: ' a ' });
    expect(control.data.results[0].output?.structuredContent).toEqual({ key: 'a', adapted: 'a' });
    expect(handler).toHaveBeenCalledOnce();
    expect(result).toHaveBeenCalledTimes(5);
  });

  it('waits for slow host continuations and excludes invalid and refused children', async () => {
    const execute = vi.fn<NonNullable<ToolBatchDeclaration['execute']>>(async items => items.map(item => ({
      itemId: item.itemId, response: { data: { key: (item.args as { key: string }).key } },
    })));
    const { tool, name, handler } = register({ execute });
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const entered: string[] = [];
    const recordInvocation = vi.fn();
    const pending = dispatch(tool, name, { _batch: 1, items: [
      { itemId: 'a', args: { key: 'a' } }, { itemId: 'slow', args: { key: 'slow' } },
      { itemId: 'denied', args: { key: 'denied' } }, { itemId: 'invalid', args: { key: 42 } },
    ] }, { recordInvocation, aroundInvoke: async ({ input, invoke }) => {
      const key = (input as { key: string }).key;
      entered.push(key);
      if (key === 'denied') return { isError: true, content: [] };
      if (key === 'slow') await barrier;
      const [first, repeated] = await Promise.all([invoke(), invoke()]);
      expect(repeated).toBe(first);
      return first;
    } });
    await vi.waitFor(() => expect(entered).toHaveLength(4));
    expect(execute).not.toHaveBeenCalled();
    release();
    const { data } = await pending;
    expect(execute.mock.calls[0][0].map(item => item.itemId)).toEqual(['a', 'slow']);
    expect(data.results.map(item => [item.itemId, item.ok])).toEqual([
      ['a', true], ['slow', true], ['denied', false], ['invalid', false],
    ]);
    expect(data.results[3].error).toMatchObject({ code: 'invalid_input' });
    expect(recordInvocation).toHaveBeenCalledTimes(4);
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves known successes and reports missing, duplicate and foreign native IDs without replay', async () => {
    const execute = vi.fn<NonNullable<ToolBatchDeclaration['execute']>>(async () => [
      { itemId: 'a', response: { data: { key: 'a' } } },
      { itemId: 'dup', response: { data: { key: 'dup' } } },
      { itemId: 'dup', error: 'duplicate' }, { itemId: 'foreign', error: 'foreign' },
    ]);
    const { tool, name, handler } = register({ execute });
    const { wire, data } = await dispatch(tool, name, { _batch: 1, items:
      ['a', 'dup', 'missing'].map(itemId => ({ itemId, args: { key: itemId } })) });
    expect(data.results.map(item => item.ok)).toEqual([true, false, false]);
    expect(data.results[0].output?.structuredContent).toEqual({ key: 'a' });
    expect(wire._meta).toMatchObject({ nativeBatch: { protocolErrors: expect.any(Array) } });
    expect(wire.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('chooses sequential fallback before admission for a two-child one-slot quota', async () => {
    const execute = vi.fn<NonNullable<ToolBatchDeclaration['execute']>>(async () => []);
    const { tool, name, handler } = register({ execute });
    tool.rolesQuota = { worker: { perRun: 1 } };
    let used = 0;
    handler.mockImplementation(async args => { used++; return { data: { key: args.key } }; });
    const { data } = await dispatch(tool, name, { _batch: 1, items: [
      { args: { key: 'a' } }, { args: { key: 'b' } },
    ] }, { readQuotaState: async () => ({ count: used }) });
    expect(execute).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
    expect(data.results.map(item => item.ok)).toEqual([true, false]);
    expect(data.results[1].error).toMatchObject({ code: 'quota_exceeded' });
  });

  it('UTB-atomic-quota reserves the final slot across simultaneous parents', async () => {
    const { tool, name, handler } = register({});
    tool.rolesQuota = { worker: { perRun: 1 } };
    let held = 0;
    const settlements = vi.fn();
    const reserveQuota = vi.fn(async () => {
      if (held === 1) return { allowed: false as const, count: held };
      held++;
      await Promise.resolve();
      return { allowed: true as const, settle: settlements };
    });
    const deps = { readQuotaState: async () => ({ count: 0 }), reserveQuota };
    const results = await Promise.all(['a', 'b'].map(key => dispatch(tool, name, { key }, deps)));
    expect(handler).toHaveBeenCalledOnce();
    expect(results.flatMap(result => result.data.results).map(item => item.ok).sort()).toEqual([false, true]);
    expect(reserveQuota).toHaveBeenCalledTimes(2);
    expect(settlements.mock.calls).toEqual([['commit']]);
  });

  it('releases only a refused child reservation and commits its admitted sibling', async () => {
    const { tool, name, handler } = register({});
    tool.rolesQuota = { worker: { perRun: 2 } };
    tool.authorize = async ({ input }) => ({ allow: (input as { key: string }).key !== 'denied' });
    const settlements: string[] = [];
    const reserveQuota = vi.fn(async ({ callId }: { callId: string }) => ({ allowed: true as const,
      settle: async (outcome: string) => { settlements.push(callId + ':' + outcome); } }));
    const { data } = await dispatch(tool, name, { _batch: 1, items: [
      { args: { key: 'denied' } }, { args: { key: 'ok' } },
    ] }, { readQuotaState: async () => ({ count: 0 }), reserveQuota });
    expect(handler).toHaveBeenCalledOnce();
    expect(data.results.map(item => item.ok)).toEqual([false, true]);
    const ids = reserveQuota.mock.calls.map(([request]) => request.callId);
    expect(new Set(ids).size).toBe(2);
    expect(settlements).toEqual([ids[0] + ':release', ids[1] + ':commit']);
  });

  it('fails closed when atomic quota admission is unavailable', async () => {
    const { tool, name, handler } = register({});
    tool.rolesQuota = { worker: { perRun: 1 } };
    const { data } = await dispatch(tool, name, { key: 'a' }, {
      reserveQuota: async () => { throw new Error('quota store unavailable'); },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(data.results[0]).toMatchObject({ ok: false, error: { code: 'quota_exceeded' } });
  });

  it('releases a late reservation once when cancellation wins quota admission', async () => {
    const { tool, name, handler } = register({});
    tool.rolesQuota = { worker: { perRun: 1 } };
    const abort = new AbortController();
    const settle = vi.fn(async () => {});
    let resolve!: (value: { allowed: true; settle: typeof settle }) => void;
    let entered!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    const pending = dispatch(tool, name, { key: 'a' }, { reserveQuota: () => {
      entered(); return new Promise(done => { resolve = done; });
    } }, { ...context(), signal: abort.signal });
    // Before the reservation port exists the handler completes instead of waiting.
    await Promise.race([started, pending]);
    abort.abort();
    await pending;
    resolve?.({ allowed: true, settle });
    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce());
    expect(settle).toHaveBeenCalledWith('release');
    expect(handler).not.toHaveBeenCalled();
  });

  it('uses atomic quota reservations for finite native groups without replaying refused items', async () => {
    const execute = vi.fn<NonNullable<ToolBatchDeclaration['execute']>>(async items => items.map(item => ({
      itemId: item.itemId, response: { data: item.args },
    })));
    const { tool, name, handler } = register({ execute, maxConcurrency: 3, independent: true });
    tool.rolesQuota = { worker: { perRun: 2 } };
    let held = 0;
    const settle = vi.fn(async () => {});
    const { data } = await dispatch(tool, name, { _batch: 1,
      items: ['a', 'b', 'c'].map(key => ({ itemId: key, args: { key } })),
    }, { reserveQuota: async () => held++ < 2
      ? { allowed: true, settle } : { allowed: false, count: 2 } });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0].map(item => item.itemId)).toEqual(['a', 'b']);
    expect(handler).not.toHaveBeenCalled();
    expect(data.results.map(item => item.ok)).toEqual([true, true, false]);
    expect(settle.mock.calls).toEqual([['commit'], ['commit']]);
  });

  it('consumes the started child slot even when its handler fails', async () => {
    const { tool, name, handler } = register({});
    tool.rolesQuota = { worker: { perRun: 1 } };
    handler.mockRejectedValueOnce(new Error('effect outcome uncertain'));
    const settle = vi.fn(async () => {});
    const { data } = await dispatch(tool, name, { key: 'a' }, {
      reserveQuota: async () => ({ allowed: true, settle }),
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(data.results[0].ok).toBe(false);
    expect(settle.mock.calls).toEqual([['commit']]);
  });

  it('preserves completed effects and sibling results when quota settlement fails', async () => {
    const { tool, name, handler } = register({});
    tool.rolesQuota = { worker: { perRun: 2 } };
    let admitted = 0;
    const { data } = await dispatch(tool, name, { _batch: 1,
      items: ['a', 'b'].map(key => ({ itemId: key, args: { key } })),
    }, { reserveQuota: async () => {
      const index = admitted++;
      return { allowed: true, invocationRef: 'tool-invocation:quota-' + index,
        settle: async () => { if (index === 0) throw new Error('settlement unavailable'); } };
    } });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(data.results.map(item => [item.itemId, item.ok])).toEqual([['a', true], ['b', true]]);
    expect(data.results[0].output?.structuredContent).toEqual({ key: 'a' });
    expect(data.results[0].output?._meta?.quotaSettlement).toMatchObject({
      state: 'unconfirmed', invocationRef: 'tool-invocation:quota-0', retrySafe: false,
    });
    expect(data.results[1].output?._meta?.quotaSettlement).toBeUndefined();
  });

  it('never replays a throwing native executor through singleton handlers', async () => {
    const execute = vi.fn<NonNullable<ToolBatchDeclaration['execute']>>(async () => { throw new Error('native failed'); });
    const { tool, name, handler } = register({ execute });
    const { data } = await dispatch(tool, name, { _batch: 1, items: [
      { args: { key: 'a' } }, { args: { key: 'b' } },
    ] });
    expect(data.counts).toEqual({ ok: 0, failed: 2 });
    expect(execute).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });

  it('rechecks revocation after participants wait and excludes the revoked item', async () => {
    const execute = vi.fn<NonNullable<ToolBatchDeclaration['execute']>>(async items => items.map(item => ({
      itemId: item.itemId, response: { data: { key: (item.args as { key: string }).key } },
    })));
    const { tool, name, handler } = register({ execute });
    const enforcements = new Map<string, number>();
    const { data } = await dispatch(tool, name, { _batch: 1, items: [
      { itemId: 'revoked', args: { key: 'revoked' } }, { itemId: 'ok', args: { key: 'ok' } },
    ] }, { kernelEnforcement: request => {
      if (request.phase === 'enforce') {
        const key = (request.args as { key: string }).key;
        const count = (enforcements.get(key) ?? 0) + 1;
        enforcements.set(key, count);
        if (key === 'revoked' && count === 2) return { decision: 'deny', reason: 'fixture revocation' };
      }
      return { decision: 'allow' };
    } });
    expect(execute.mock.calls[0][0].map(item => item.itemId)).toEqual(['ok']);
    expect(data.results[0]).toMatchObject({ itemId: 'revoked', ok: false,
      error: { code: 'authorization_denied' } });
    expect(data.results[1].ok).toBe(true);
    expect(enforcements.get('revoked')).toBe(2);
    expect(handler).not.toHaveBeenCalled();
  });

  it('cancels an uncooperative native read without replay or a new execution budget', async () => {
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const execute = vi.fn<NonNullable<ToolBatchDeclaration['execute']>>((_items, parent) => {
      expect(parent.signal.aborted).toBe(false);
      started();
      return new Promise(() => {});
    });
    const { tool, name, handler } = register({ execute });
    const abort = new AbortController();
    const pending = dispatch(tool, name, { _batch: 1, items: [
      { args: { key: 'a' } }, { args: { key: 'b' } },
    ] }, {}, { ...context(), signal: abort.signal });
    await entered;
    abort.abort();
    const { data } = await pending;
    expect(data.counts).toEqual({ ok: 0, failed: 2 });
    expect(data.results.every(item => item.status === 'cancelled')).toBe(true);
    expect(execute.mock.calls[0][1].signal.aborted).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('selects fallback for mutation and stream declarations before calling the native hook', async () => {
    const execute = vi.fn<NonNullable<ToolBatchDeclaration['execute']>>(async () => []);
    const { tool, name, handler } = register({ execute });
    for (const declaration of [{ ...tool, effect: 'write' as const }, { ...tool, events: {} }]) {
      const { data } = await dispatch(declaration, name, { key: 'a' });
      expect(data.counts).toEqual({ ok: 1, failed: 0 });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('permanent shallow batch normalization', () => {
  it('enforces the complete UTF-8 input budget before operation validation', async () => {
    const validate = vi.fn((input: unknown) => ({ value: input }));
    const operation: StandardSchemaV1 = { '~standard': { version: 1, vendor: 'byte-budget', validate } };
    for (const input of [{ key: 'éé' }, { _batch: 1, items: [{ args: { key: 'éé' } }] }]) {
      const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
      await expect(normalizeBatchRequest(input, operation, { maxInputBytes: bytes })).resolves.toBeDefined();
      validate.mockClear();
      await expect(normalizeBatchRequest(input, operation, { maxInputBytes: bytes - 1 }))
        .rejects.toThrow(/input.*byte/i);
      expect(validate).not.toHaveBeenCalled();
    }
  });

  it.each([0, -1, 1.5, Infinity, 4 * 1024 * 1024 + 1])('rejects invalid batch input-byte ceiling %s', maxInputBytes => {
    expect(() => resolveToolBatchDeclaration({ maxInputBytes })).toThrow(/maxInputBytes/);
  });

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

  it.each([false, true])('publishes batch and permanent operation inputs with exact MCP limits (principal=%s)', (principal) => {
    const name = 'batch-test:published-' + principal;
    const args = z.strictObject({ key: z.string(), items: z.array(z.string()).optional() });
    const definition = { name, capability: 'test:read', args, batch: { maxItems: 2 },
      handler: async () => ({ data: { key: 'business-output' } }) };
    if (principal) defineTool(definition);
    else defineTool({ ...definition, requirePrincipal: false });
    const tool = lookupByMcpName(name)!;
    const listing = listMcpProjections().find(row => row.name === name)!;
    const singleton = { key: 'a', items: ['business'] };
    const item = { itemId: 'a', args: singleton };
    for (const schema of [tool.inputSchema, tool.discoveryInputSchema!, listing.inputSchema]) {
      const validate = ajv().compile(schema);
      expect(validate(singleton)).toBe(true);
      expect(validate({ _batch: 1, items: [item] })).toBe(true);
      expect(validate({ _batch: 1, items: item })).toBe(true);
    }
    const exact = ajv().compile(listing.inputSchema);
    for (const input of [{ _batch: 2, items: [item] }, { _batch: 1, items: [] },
      { _batch: 1, items: [item, item, item] }, { _batch: 1, items: [item], extra: true }]) {
      expect(exact(input)).toBe(false);
    }
    expect(listing.outputSchema).toEqual(tool.batchContract!.resultJsonSchema);
    expect(tool.inputSchema.anyOf).toBeUndefined();
    expect(tool.inputSchema.allOf).toBeUndefined();
    expect((tool.inputSchema.properties as any).key).toBeDefined();
  });

  it('publishes nested recursive operation refs without losing singleton validation', () => {
    const node: z.ZodType = z.lazy(() => z.strictObject({ key: z.string(), children: z.array(node).optional() }));
    const args = z.strictObject({ tree: node });
    defineTool({ name: 'batch-test:published-recursive', requirePrincipal: false, capability: 'test:read', args,
      handler: async () => ({ content: [] }) });
    const tool = lookupByMcpName('batch-test:published-recursive')!;
    for (const schema of [tool.inputSchema, tool.discoveryInputSchema!]) {
      const validate = ajv().compile(schema);
      const value = { tree: { key: 'parent', children: [{ key: 'child' }] } };
      expect(validate(value)).toBe(true);
      expect(validate({ _batch: 1, items: [{ args: value }] })).toBe(true);
      expect(validate({ _batch: 1, items: [{ args: { tree: { key: 3 } } }] })).toBe(false);
    }
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
