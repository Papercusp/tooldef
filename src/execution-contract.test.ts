import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchWithToolExecution, resolveToolExecutionContract, selectToolExecution,
  REQUEST_BOUND_EXECUTION,
  type AuditedToolExecutionAdapter, type ToolExecutionDeclaration, type ToolExecutionContract, type ToolExecutionSelection,
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
afterEach(() => { vi.useRealTimers(); _resetProjectionRegistryForTests(); });

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
    const admission = { handle: 'original', ownerId: 'caller', state: 'accepted' as const };
    const dispatch = vi.fn(async () => ({ result: { executionId: 'original' }, admission }));
    const result = await dispatchWithToolExecution(independent, { mode: 'async' }, budgets, {
      ownerId: 'caller', inline, adapter: { id: adapter.id, dispatch, verifyAdmission: async a => a.handle === admission.handle && a.ownerId === admission.ownerId },
    });
    expect(result).toMatchObject({ ok: true, result: { executionId: 'original' }, selection: { executionDeadlineMs: 601000 } });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(inline).not.toHaveBeenCalled();
    expect(selectToolExecution(independent, {}, budgets)).toMatchObject({ ok: true, autoYieldAfterMs: 5000 });
    expect(await dispatchWithToolExecution(independent, { mode: 'async' }, budgets, { inline }))
      .toMatchObject({ ok: false, error: 'execution_adapter_unavailable' });
    expect(inline).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unaccepted', 'foreign-owner', 'wrapper-state'])('rejects a %s admission instead of treating an id as acceptance', async kind => {
    const admission = { handle: kind === 'missing' ? '' : 'original',
      ownerId: kind === 'foreign-owner' ? 'other' : 'caller',
      state: kind === 'wrapper-state' ? 'timed_out' : 'accepted' };
    const dispatch = vi.fn(async () => ({ result: 'receipt', admission: admission as never }));
    const result = await dispatchWithToolExecution(independent, { mode: 'async' }, budgets, {
      ownerId: 'caller', inline: vi.fn(), adapter: { id: adapter.id, dispatch,
        verifyAdmission: async () => kind !== 'unaccepted' },
    });
    expect(result).toMatchObject({ ok: false, error: 'execution_receipt_invalid' });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('keeps a confirmed continuation nonterminal and records separate original budgets', async () => {
    const admission = { handle: 'original', ownerId: 'caller', state: 'running' as const };
    const result = await dispatchWithToolExecution(independent, { responseWindowMs: 5000 }, budgets, {
      ownerId: 'caller', inline: vi.fn(), adapter: { id: adapter.id,
        dispatch: async () => ({ result: 'still running', admission }), verifyAdmission: async () => true },
    });
    expect(result).toMatchObject({ ok: true, receipt: { handle: 'original', ownerId: 'caller',
      state: 'running', terminal: false, responseWindowMs: 5000, executionDeadlineMs: 601000 } });
  });

  it('detaches and freezes the verified admission and original budget snapshots', async () => {
    const admission = { handle: 'original', ownerId: 'caller', state: 'accepted' as const };
    const result = await dispatchWithToolExecution(independent, {}, budgets, {
      ownerId: 'caller', inline: vi.fn(), adapter: { id: adapter.id,
        dispatch: async selection => {
          expect(Object.isFrozen(selection)).toBe(true);
          return { result: 'accepted', admission };
        }, verifyAdmission: async snapshot => {
          expect(Object.isFrozen(snapshot)).toBe(true);
          admission.handle = 'substituted';
          admission.ownerId = 'foreign';
          return snapshot.handle === 'original' && snapshot.ownerId === 'caller';
        } },
    });
    expect(result).toMatchObject({ ok: true, receipt: { handle: 'original', ownerId: 'caller', executionDeadlineMs: 601000 } });
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
  describe('R-23 > P-003 >', () => {
    for (const [title, duration] of [
      ['request-bound 4999 inline control', 4999],
      ['request-bound 5001 inline control', 5001],
    ] as const) it(title, async () => {
      vi.useFakeTimers();
      const handler = vi.fn(() => new Promise<string>(resolve => setTimeout(() => resolve('original result'), duration)));
      let settled = false;
      const pending = dispatchWithToolExecution(undefined, {}, budgets, { inline: handler })
        .then(result => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(duration - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ ok: true, result: 'original result',
        selection: { lifecycle: 'request-bound', autoYieldAfterMs: null, executionDeadlineMs: 601000 } });
      expect(handler).toHaveBeenCalledOnce();
    });

    it('request-bound unsafe yield counterexample', async () => {
      const handler = vi.fn();
      const detached = vi.fn();
      expect(await dispatchWithToolExecution(undefined, { mode: 'async' }, budgets, {
        inline: handler, ownerId: 'caller', adapter: { id: adapter.id, dispatch: detached, verifyAdmission: async () => true },
      })).toMatchObject({ ok: false, error: 'unsupported_execution_mode' });
      expect(handler).not.toHaveBeenCalled();
      expect(detached).not.toHaveBeenCalled();
    });

    it('D013 original deadline control', async () => {
      const handler = vi.fn(async () => 'original result');
      const result = await dispatchWithToolExecution(undefined, { responseWindowMs: 5000 }, budgets, { inline: handler });
      expect(result).toMatchObject({ ok: true, selection: { responseWindowMs: 5000, executionDeadlineMs: 601000 } });
      expect(handler).toHaveBeenCalledOnce();
    });

    it('D013 changed deadline counterexample', async () => {
      const dispatch = vi.fn(async (selection: ToolExecutionSelection) => {
        expect(() => { (selection as { executionDeadlineMs: number }).executionDeadlineMs = 999999; }).toThrow(TypeError);
        return { result: 'original result', admission: { handle: 'original', ownerId: 'caller', state: 'running' as const } };
      });
      const result = await dispatchWithToolExecution(independent, {}, budgets, { ownerId: 'caller', inline: vi.fn(),
        adapter: { id: adapter.id, dispatch, verifyAdmission: async () => true } });
      expect(result).toMatchObject({ ok: true, receipt: { executionDeadlineMs: 601000 } });
      expect(dispatch).toHaveBeenCalledOnce();
    });

    it('live interaction inline control', async () => {
      const handler = vi.fn(async () => 'interactive result');
      expect(await dispatchWithToolExecution({ liveInteraction: true }, {}, budgets, { inline: handler }))
        .toMatchObject({ ok: true, result: 'interactive result', selection: { autoYieldAfterMs: null } });
      expect(handler).toHaveBeenCalledOnce();
    });

    it('live interaction detach refusal counterexample', async () => {
      const handler = vi.fn();
      expect(await dispatchWithToolExecution({ liveInteraction: true }, { mode: 'async' }, budgets, { inline: handler }))
        .toMatchObject({ ok: false, error: 'unsupported_execution_mode' });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // Each selector is conserved from rubric revision 10. This unit layer consumes
  // the host's budget; registered transport tests cover how that budget is loaded.
  for (const requirement of ['R-23', 'R-26']) describe(requirement + ' > P-003 >', () => {
    const safe = async (ceiling: number | null, requested: number, originalRemaining = 600000) => {
      const handler = vi.fn(async () => 'business result');
      const result = await dispatchWithToolExecution(undefined, { mode: 'sync', responseWindowMs: requested }, {
        nowMs: 1000, executionDeadlineMs: originalRemaining + 1000, transportResponseBudgetMs: ceiling,
      }, { inline: handler });
      return { result, handler };
    };
    for (const title of ['D013 long declared timeout control', 'D013 strict sync supported budget control']) {
      it(title, async () => {
        const { result, handler } = await safe(600000, 590000);
        expect(result).toMatchObject({ ok: true, result: 'business result',
          selection: { responseWindowMs: 590000, executionDeadlineMs: 601000 } });
        expect(handler).toHaveBeenCalledOnce();
      });
    }
    it('D013 fixed ceiling counterexample', async () => {
      const { result, handler } = await safe(45000, 590000);
      expect(result).toMatchObject({ ok: false, error: 'execution_budget_exceeded' });
      expect(handler).not.toHaveBeenCalled();
    });
    it('D013 strict sync over-budget counterexample', async () => {
      const { result, handler } = await safe(600000, 600001);
      expect(result).toMatchObject({ ok: false, error: 'execution_budget_exceeded' });
      expect(handler).not.toHaveBeenCalled();
    });
    it('D013 disabled transport deadline control', async () => {
      const { result, handler } = await safe(null, 590000);
      expect(result).toMatchObject({ ok: true, selection: { responseWindowMs: 590000 } });
      expect(handler).toHaveBeenCalledOnce();
      // Disabling transport never disables the original execution deadline.
      const beyond = await safe(null, 600001);
      expect(beyond.result).toMatchObject({ ok: false, error: 'execution_budget_exceeded' });
      expect(beyond.handler).not.toHaveBeenCalled();
    });
    it('D013 disabled cap counterexample', async () => {
      const { result, handler } = await safe(45000, 590000);
      expect(result).toMatchObject({ ok: false, error: 'execution_budget_exceeded' });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('R-26 > P-003 >', () => {
    for (const title of ['control', 'D013 safe ceiling control', 'D013 loaded cap derivation control']) it(title, async () => {
      for (const ceiling of [50000, 145000, 600000]) {
        for (const delta of [-1, 0]) {
          const handler = vi.fn(async () => 'original result');
          expect(await dispatchWithToolExecution(undefined, { mode: 'sync', responseWindowMs: ceiling + delta }, {
            nowMs: 1000, executionDeadlineMs: ceiling + 11000, transportResponseBudgetMs: ceiling,
          }, { inline: handler })).toMatchObject({ ok: true, result: 'original result' });
          expect(handler).toHaveBeenCalledOnce();
        }
      }
    });
    for (const title of ['counterexample', 'D013 above ceiling counterexample', 'D013 stale ceiling counterexample']) it(title, async () => {
      for (const ceiling of [50000, 145000, 600000]) {
        const handler = vi.fn();
        expect(await dispatchWithToolExecution(undefined, { mode: 'sync', responseWindowMs: ceiling + 1 }, {
          nowMs: 1000, executionDeadlineMs: ceiling + 11000, transportResponseBudgetMs: ceiling,
        }, { inline: handler })).toMatchObject({ ok: false, error: 'execution_budget_exceeded' });
        expect(handler).not.toHaveBeenCalled();
      }
    });
  });

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
