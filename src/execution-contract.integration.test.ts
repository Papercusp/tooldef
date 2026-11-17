import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from './define-tool';
import { dispatchProjectedTool } from './dispatch-projected';
import { type ToolExecutionContract, type ToolExecutionRequest, type ToolExecutionDeclaration, type ToolExecutionAdmission } from './execution-contract';
import type { DispatchProjectedDeps } from './dispatch-types';
import { _resetCatalogForTests } from './registry';
import { lookupByMcpName } from './tool-projection';

const budgets = { nowMs: 1000, executionDeadlineMs: 61000, transportResponseBudgetMs: 60000 };
afterEach(() => _resetCatalogForTests());

describe('original invocation observation', () => {
  function observer() {
    return {
      begin: vi.fn<NonNullable<DispatchProjectedDeps['invocationObserver']>['begin']>(async () => 'tool-invocation:original'),
      settle: vi.fn<NonNullable<DispatchProjectedDeps['invocationObserver']>['settle']>(async () => {}),
    };
  }

  it('persists begin before effects and settles the same original reference once', async () => {
    const { inline, handler } = fixture();
    const observation = observer();
    let release!: () => void;
    const pending = new Promise<string>(resolve => { release = () => resolve('tool-invocation:original'); });
    observation.begin.mockReturnValue(pending);
    const recordInvocation = vi.fn();
    const attempt = inline({}, { invocationObserver: observation, recordInvocation });
    await vi.waitFor(() => expect(observation.begin).toHaveBeenCalledOnce());
    expect(handler).not.toHaveBeenCalled();
    expect(observation.settle).not.toHaveBeenCalled();
    release();
    expect(await attempt).toMatchObject({ ok: true, result: { _meta: { toolInvocationRef: 'tool-invocation:original' } } });
    expect(handler).toHaveBeenCalledOnce();
    expect(observation.settle).toHaveBeenCalledOnce();
    expect(observation.settle.mock.calls[0][0]).toMatchObject({
      invocationRef: 'tool-invocation:original', callId: observation.begin.mock.calls[0][0].callId,
      result: { content: [{ type: 'text', text: 'ok 7' }] }, error: null,
      receipt: null,
    });
    expect(recordInvocation).toHaveBeenCalledWith(expect.objectContaining({
      invocationRef: 'tool-invocation:original', callId: observation.begin.mock.calls[0][0].callId,
    }));
  });

  for (const invalid of [null, '', '   ']) it('refuses an invalid persisted reference before effects: ' + String(invalid), async () => {
    const { inline, handler } = fixture();
    const observation = observer();
    // Deliberately invalid persisted references: the cast names the real resolved type.
    observation.begin.mockResolvedValue(invalid as unknown as Awaited<ReturnType<NonNullable<DispatchProjectedDeps['invocationObserver']>['begin']>>);
    expect(await inline({}, { invocationObserver: observation })).toMatchObject({
      ok: false, error: { code: 'execution_observation_unavailable' },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(observation.settle).not.toHaveBeenCalled();
  });

  it('refuses a failed begin without admitting runtime or handler work', async () => {
    const { inline, handler } = fixture();
    const observation = observer();
    observation.begin.mockRejectedValue(new Error('synthetic-private-db-detail'));
    const adapter = vi.fn();
    const result = await inline({}, { invocationObserver: observation, executionAdapter: adapter });
    expect(result).toMatchObject({ ok: false, error: { code: 'execution_observation_unavailable' } });
    expect(JSON.stringify(result)).not.toContain('synthetic-private-db-detail');
    expect(handler).not.toHaveBeenCalled();
    expect(adapter).not.toHaveBeenCalled();
  });

  it('reports failed settlement as unknown with the original reference and never repeats effects', async () => {
    const { inline, handler } = fixture();
    const observation = observer();
    observation.settle.mockRejectedValue(new Error('synthetic-private-db-detail'));
    const result = await inline({}, { invocationObserver: observation });
    expect(result).toMatchObject({ ok: false, error: { code: 'execution_observation_unavailable', meta: {
      invocationRef: 'tool-invocation:original', outcome: 'unknown', retrySafe: false,
    } } });
    expect(JSON.stringify(result)).not.toContain('synthetic-private-db-detail');
    expect(handler).toHaveBeenCalledOnce();
    expect(observation.begin).toHaveBeenCalledOnce();
    expect(observation.settle).toHaveBeenCalledOnce();
  });

  it('does not create an admitted observation when the host refuses invocation', async () => {
    const { inline, handler } = fixture();
    const observation = observer();
    expect(await inline({}, { invocationObserver: observation,
      aroundInvoke: async () => ({ isError: true, content: [] }),
    })).toMatchObject({ ok: true, result: { isError: true } });
    expect(observation.begin).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('records a thrown execution once without interpreting the exception as termination', async () => {
    const { inline, handler } = fixture();
    const observation = observer();
    const failure = new Error('handler failed');
    handler.mockRejectedValue(failure);
    expect(await inline({}, { invocationObserver: observation })).toMatchObject({ ok: false });
    expect(observation.settle).toHaveBeenCalledOnce();
    expect(observation.settle.mock.calls[0][0]).toMatchObject({
      invocationRef: 'tool-invocation:original', result: null, error: failure,
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('keeps the original observer through a host replacement and preserves an intact long reference', async () => {
    const { inline, handler } = fixture();
    const original = observer();
    const replacement = observer();
    const ref = 'tool-invocation:' + 'x'.repeat(10000);
    const deps: DispatchProjectedDeps = { invocationObserver: original };
    original.begin.mockImplementation(async () => {
      deps.invocationObserver = replacement;
      return ref;
    });
    expect(await inline({}, deps)).toMatchObject({ ok: true, result: { _meta: { toolInvocationRef: ref } } });
    expect(original.settle).toHaveBeenCalledOnce();
    expect(original.settle.mock.calls[0][0].invocationRef).toBe(ref);
    expect(replacement.begin).not.toHaveBeenCalled();
    expect(replacement.settle).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('memoizes observation and effects when the host invokes its continuation twice', async () => {
    const { inline, handler } = fixture();
    const observation = observer();
    const result = await inline({}, { invocationObserver: observation, aroundInvoke: async ({ invoke }) => {
      const [first, second] = await Promise.all([invoke(), invoke()]);
      expect(second).toBe(first);
      return second;
    } });
    expect(result).toMatchObject({ ok: true });
    expect(observation.begin).toHaveBeenCalledOnce();
    expect(observation.settle).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });
});

function fixture(declaration?: ToolExecutionDeclaration) {
  const handler = vi.fn(async (args: { value: number }) => ({
    content: [{ type: 'text' as const, text: 'ok ' + args.value }],
  }));
  const definition = defineTool({
    name: 'execution_contract:bar_probe', description: 'Counted execution-contract BAR fixture',
    capability: 'tasks:read', requirePrincipal: false, agentRoles: ['operator'],
    args: z.object({ value: z.number() }), handler, execution: declaration,
  });
  const tool = lookupByMcpName(definition.name);
  if (!tool) throw new Error('Execution-contract BAR fixture was not projected');
  const inline = vi.fn((request: ToolExecutionRequest = {}, deps: DispatchProjectedDeps = {}) => dispatchProjectedTool(tool, definition.name, { value: 7 }, {
    log: () => {}, signal: new AbortController().signal, progress: () => {}, emit: () => {},
    workspaceId: 'execution-contract-bar', role: 'operator', runId: 'execution-contract-bar-run',
    uiClientId: 'original-owner', toolExecution: request,
    executionDeadlineAtMs: budgets.executionDeadlineMs + Date.now(),
    transportResponseDeadlineAtMs: Date.now() + budgets.transportResponseBudgetMs,
  }, { batchResponseVersion: 'operation-v0', ...deps }));
  return { tool, handler, inline };
}

describe('unified execution', () => {
  describe('R-20 > P-003', () => {
    it('control', async () => {
      const { tool, handler, inline } = fixture();
      const result = await inline({ mode: 'sync' });
      expect(result).toMatchObject({
        ok: true, result: { content: [{ type: 'text', text: 'ok 7' }] },
      });
      expect(inline).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('counterexample', async () => {
      const { tool, handler, inline } = fixture();
      const result = await inline({ mode: 'async' });
      expect(result).toMatchObject({ ok: false, error: { code: 'unsupported_execution_mode', meta: { supportedModes: ['sync', 'auto'] } } });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('R-21 > P-003', () => {
    it('control', async () => {
      const { tool, handler, inline } = fixture();
      const result = await inline();
      expect(result).toMatchObject({
        ok: true, result: { content: [{ type: 'text', text: 'ok 7' }] },
      });
      expect(inline).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('counterexample', async () => {
      const { tool, handler, inline } = fixture();
      const changedDefault = { ...tool.execution, defaultMode: 'sync' } as unknown as ToolExecutionContract;
      tool.execution = changedDefault;
      expect(await inline()).toMatchObject({ ok: false, error: { code: 'handler_error', message: expect.stringContaining('default mode must be auto') } });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('R-22 > P-003', () => {
    const adapter = { id: 'existing-runtime-fixture', auditRef: 'D-031:fixture', ownsExecution: true as const,
      transactionScope: 'independent' as const, outcome: 'business' as const, durability: 'session' as const,
      cancellation: 'owner-managed' as const, progress: 'reported' as const };
    it('host refusal prevents independent runtime admission before any adapter or handler effect', async () => {
      const { inline, handler } = fixture({ lifecycle: 'independent', adapter });
      const dispatch = vi.fn();
      const resolveAdapter = vi.fn(() => ({ id: adapter.id, dispatch, verifyAdmission: vi.fn() }));
      const result = await inline({ mode: 'async' }, { executionAdapter: resolveAdapter,
        aroundInvoke: async () => ({ isError: true, content: [{ type: 'text', text: 'host authorization refused' }] }),
      });
      expect(result).toMatchObject({ ok: true, result: { isError: true } });
      expect(resolveAdapter).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });
    for (const accepted of [true, false]) it(accepted ? 'control' : 'counterexample', async () => {
      const { inline, handler } = fixture({ lifecycle: 'independent', adapter });
      const admission: ToolExecutionAdmission = { handle: 'runtime-original-handle', ownerId: 'original-owner', state: 'accepted' };
      const verifyAdmission = vi.fn(async () => accepted);
      const settle = vi.fn<NonNullable<DispatchProjectedDeps['invocationObserver']>['settle']>(async () => {});
      const aroundInvoke = vi.fn(async ({ invoke }: Parameters<NonNullable<DispatchProjectedDeps['aroundInvoke']>>[0]) => {
        await invoke();
        return invoke();
      });
      const result = await inline({ mode: 'async', responseWindowMs: 5000 }, { aroundInvoke,
        invocationObserver: { begin: async () => 'invocation:original', settle },
        executionAdapter: ({ invoke, ctx }) => ({ id: adapter.id, verifyAdmission,
          dispatch: async () => {
            expect(ctx.uiClientId).toBe(admission.ownerId);
            return { result: await invoke(), admission };
          } }),
      });
      expect(handler).toHaveBeenCalledOnce();
      expect(aroundInvoke).toHaveBeenCalledOnce();
      expect(verifyAdmission).toHaveBeenCalledOnce();
      expect(settle).toHaveBeenCalledOnce();
      expect(settle.mock.calls[0][0].receipt).toEqual(accepted
        ? expect.objectContaining({ handle: admission.handle, state: 'accepted' }) : null);
      if (accepted) expect(result).toMatchObject({ ok: true, result: { _meta: { toolExecution: {
        handle: admission.handle, ownerId: admission.ownerId, terminal: false,
        state: 'accepted', responseWindowMs: 5000, executionDeadlineMs: expect.any(Number),
      } } } });
      else expect(result).toMatchObject({ ok: false, error: { code: 'execution_receipt_invalid' } });
    });
  });
});
