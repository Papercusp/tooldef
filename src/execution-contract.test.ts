import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchWithToolExecution, resolveToolExecutionContract, selectToolExecution,
  REQUEST_BOUND_EXECUTION,
  type AuditedToolExecutionAdapter, type ToolExecutionDeclaration, type ToolExecutionContract,
} from './execution-contract';
import {
  registerProjectedTool, lookupByMcpName, lookupByHttpPath, listMcpProjections,
  _resetProjectionRegistryForTests, type ProjectedTool,
} from './tool-projection';

const budgets = { nowMs: 1000, executionDeadlineMs: 601000, transportResponseBudgetMs: 600000 };
const adapter: AuditedToolExecutionAdapter = {
  id: 'owned-task', auditRef: 'fixture:audit:owned-task', ownsExecution: true,
  transactionScope: 'independent', outcome: 'business', durability: 'session',
  cancellation: 'owner-managed', progress: 'measured',
};
const independent: ToolExecutionDeclaration = { lifecycle: 'independent', adapter };
afterEach(() => _resetProjectionRegistryForTests());

it('EXEC-P003 control', async () => {
  const handler = vi.fn(async () => 'terminal');
  const result = await dispatchWithToolExecution(undefined, {}, budgets, { inline: handler });
  expect(result).toMatchObject({ ok: true, result: 'terminal', selection: { mode: 'auto', lifecycle: 'request-bound', autoYieldAfterMs: null } });
  expect(handler).toHaveBeenCalledTimes(1);
});

it('EXEC-P003 counterexample', async () => {
  const handler = vi.fn(async () => 'must not start');
  const result = await dispatchWithToolExecution(undefined, { mode: 'async' }, budgets, { inline: handler });
  expect(result).toMatchObject({ ok: false, error: 'unsupported_execution_mode', supportedModes: ['sync', 'auto'] });
  expect(handler).not.toHaveBeenCalled();
});

describe('execution classification', () => {
  it('derives one restrictive default for undeclared tools', () => {
    expect(resolveToolExecutionContract()).toBe(REQUEST_BOUND_EXECUTION);
    expect(resolveToolExecutionContract()).toEqual({
      defaultMode: 'auto', supportedModes: ['sync', 'auto'], lifecycle: 'request-bound',
      durability: 'none', cancellation: 'cooperative', progress: 'none', liveInteraction: false,
    });
    expect(Object.isFrozen(REQUEST_BOUND_EXECUTION.supportedModes)).toBe(true);
  });

  it('preserves separate durability, cancellation, progress and lifetime capabilities', () => {
    expect(resolveToolExecutionContract(independent)).toMatchObject({
      lifecycle: 'independent', durability: 'session', cancellation: 'owner-managed',
      progress: 'measured', supportedModes: ['sync', 'async', 'auto'],
    });
    expect(resolveToolExecutionContract({ lifecycle: 'independent', adapter: { ...adapter, durability: 'restart', progress: 'reported' } }))
      .toMatchObject({ durability: 'restart', progress: 'reported' });
  });

  it('rejects live interaction detachment, borrowed transactions and wrapper outcomes', () => {
    const invalid = [
      { lifecycle: 'independent', adapter, liveInteraction: true },
      { lifecycle: 'independent', adapter: { ...adapter, transactionScope: 'request' } },
      { lifecycle: 'independent', adapter: { ...adapter, outcome: 'launcher' } },
      { lifecycle: 'independent', adapter: { ...adapter, auditRef: '' } },
      { lifecycle: 'request-bound', durability: 'restart' },
    ];
    for (const declaration of invalid) {
      expect(() => resolveToolExecutionContract(declaration as unknown as ToolExecutionDeclaration)).toThrow('Invalid tool execution contract');
    }
  });

  it('publishes only declared public adapter fields and preserves complete identities', () => {
    const id = 'adapter-' + 'x'.repeat(10000);
    const contract = resolveToolExecutionContract({ lifecycle: 'independent', adapter: { ...adapter, id, credential: 'private-adapter-secret' } } as ToolExecutionDeclaration);
    expect(contract.adapter?.id).toBe(id);
    expect(JSON.stringify(contract)).not.toContain('private-adapter-secret');
  });

  it('rejects forged supported modes and explicit invalid modes', () => {
    expect(() => resolveToolExecutionContract({ ...REQUEST_BOUND_EXECUTION, supportedModes: ['sync', 'async', 'auto'] })).toThrow('supported modes');
    expect(selectToolExecution(undefined, { mode: null as unknown as 'auto' }, budgets)).toMatchObject({ ok: false, error: 'unsupported_execution_mode' });
  });
});

describe('original execution and derived transport budgets', () => {
  for (const ceiling of [50000, 120000, 600000]) {
    it.each([-1, 0, 1])('strict sync at ' + ceiling + ' plus %i milliseconds admits only the safe side', async delta => {
      const handler = vi.fn(async () => 'done');
      const result = await dispatchWithToolExecution(undefined, { mode: 'sync', responseWindowMs: ceiling + delta },
        { nowMs: 1000, executionDeadlineMs: ceiling + 11000, transportResponseBudgetMs: ceiling }, { inline: handler });
      expect(result.ok).toBe(delta <= 0);
      expect(handler).toHaveBeenCalledTimes(delta <= 0 ? 1 : 0);
      if (!result.ok) expect(result.error).toBe('execution_budget_exceeded');
    });
  }

  it('keeps request-bound auto inline at 5001ms and preserves its original deadline', async () => {
    const handler = vi.fn(async () => 'terminal');
    const result = await dispatchWithToolExecution(undefined, {}, { ...budgets, nowMs: 5001 }, { inline: handler });
    expect(result).toMatchObject({ ok: true, result: 'terminal', selection: { autoYieldAfterMs: null, executionDeadlineMs: 601000 } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('uses no invented finite ceiling when transport and execution caps are disabled', () => {
    expect(selectToolExecution(undefined, { mode: 'sync', responseWindowMs: 1000000000 },
      { nowMs: 1000, executionDeadlineMs: null, transportResponseBudgetMs: null }))
      .toMatchObject({ ok: true, responseWindowMs: 1000000000, executionDeadlineMs: null });
    expect(selectToolExecution(undefined, {}, { nowMs: 1000, executionDeadlineMs: null, transportResponseBudgetMs: null }))
      .toMatchObject({ ok: true, responseWindowMs: null });
  });

  it('still enforces the original execution budget when the transport cap is disabled', async () => {
    const handler = vi.fn(async () => 'done');
    const result = await dispatchWithToolExecution(undefined, { mode: 'sync', responseWindowMs: 600001 },
      { ...budgets, transportResponseBudgetMs: null }, { inline: handler });
    expect(result).toMatchObject({ ok: false, error: 'execution_budget_exceeded' });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([{ requestAborted: true }, { nowMs: 601000 }, { transportResponseBudgetMs: 0 }])('refuses expired original context %j before effects', async overrides => {
    const handler = vi.fn(async () => 'done');
    expect(await dispatchWithToolExecution(undefined, {}, { ...budgets, ...overrides }, { inline: handler }))
      .toMatchObject({ ok: false, error: 'request_expired' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('binds an independently owned adapter and never substitutes the inline handler', async () => {
    const inline = vi.fn(async () => ({ executionId: 'wrong' }));
    const dispatch = vi.fn(async () => ({ executionId: 'original' }));
    const result = await dispatchWithToolExecution(independent, { mode: 'async' }, budgets, { inline, adapter: { id: adapter.id, dispatch } });
    expect(result).toMatchObject({ ok: true, result: { executionId: 'original' }, selection: { executionDeadlineMs: 601000 } });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(inline).not.toHaveBeenCalled();
    expect(selectToolExecution(independent, {}, budgets)).toMatchObject({ ok: true, autoYieldAfterMs: 5000 });
    expect(await dispatchWithToolExecution(independent, { mode: 'async' }, budgets, { inline }))
      .toMatchObject({ ok: false, error: 'execution_adapter_unavailable' });
    expect(inline).not.toHaveBeenCalled();
  });
});

describe('shared execution projection', () => {
  it.each([undefined, independent])('agrees across MCP, HTTP and in-process registration for %j', declaration => {
    const fn: ProjectedTool['fn'] = async () => ({ content: [{ type: 'text', text: 'ok' }] });
    registerProjectedTool({
      pluginName: 'execution-fixture', description: 'execution fixture', inputSchema: { type: 'object' },
      capabilities: [], expose: { mcp: { name: 'execution.fixture' }, http: { path: '/execution-fixture', methods: ['POST'] } },
      execution: declaration, fn,
    });
    const expected = resolveToolExecutionContract(declaration);
    expect(lookupByMcpName('execution.fixture')?.execution).toEqual(expected);
    expect(lookupByHttpPath('/execution-fixture')?.execution).toEqual(expected);
    expect(listMcpProjections().find(tool => tool.name === 'execution.fixture')?._meta?.['papercusp/execution']).toEqual(expected);
  });
});

describe('unified execution >', () => {
  describe('R-20 > P-003 >', () => {
    it('control', async () => {
      const handler = vi.fn(async () => ({ value: 7 }));
      const result = await dispatchWithToolExecution(undefined, { mode: 'sync' }, budgets, { inline: handler });
      expect(result).toMatchObject({ ok: true, result: { value: 7 } });
      expect(handler).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mode: 'sync' }));
    });

    it('counterexample', async () => {
      const handler = vi.fn(async () => ({ value: 7 }));
      const result = await dispatchWithToolExecution(undefined, { mode: 'async' }, budgets, { inline: handler });
      expect(result).toMatchObject({ ok: false, error: 'unsupported_execution_mode', supportedModes: ['sync', 'auto'] });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('R-21 > P-003 >', () => {
    it('control', async () => {
      const handler = vi.fn(async () => ({ value: 7 }));
      const result = await dispatchWithToolExecution(undefined, {}, budgets, { inline: handler });
      expect(result).toMatchObject({ ok: true, result: { value: 7 }, selection: { mode: 'auto' } });
      expect(handler).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mode: 'auto' }));
    });

    it('counterexample', async () => {
      const handler = vi.fn(async () => ({ value: 7 }));
      const changedDefault = { ...REQUEST_BOUND_EXECUTION, defaultMode: 'sync' } as unknown as ToolExecutionContract;
      await expect(dispatchWithToolExecution(changedDefault, {}, budgets, { inline: handler }))
        .rejects.toThrow('default mode must be auto');
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
