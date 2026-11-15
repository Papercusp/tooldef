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
  }, deps));
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
      const aroundInvoke = vi.fn(async ({ invoke }: Parameters<NonNullable<DispatchProjectedDeps['aroundInvoke']>>[0]) => {
        await invoke();
        return invoke();
      });
      const result = await inline({ mode: 'async', responseWindowMs: 5000 }, { aroundInvoke,
        executionAdapter: ({ invoke, ctx }) => ({ id: adapter.id, verifyAdmission,
          dispatch: async () => {
            expect(ctx.uiClientId).toBe(admission.ownerId);
            return { result: await invoke(), admission };
          } }),
      });
      expect(handler).toHaveBeenCalledOnce();
      expect(aroundInvoke).toHaveBeenCalledOnce();
      expect(verifyAdmission).toHaveBeenCalledOnce();
      if (accepted) expect(result).toMatchObject({ ok: true, result: { _meta: { toolExecution: {
        handle: admission.handle, ownerId: admission.ownerId, terminal: false,
        state: 'accepted', responseWindowMs: 5000, executionDeadlineMs: expect.any(Number),
      } } } });
      else expect(result).toMatchObject({ ok: false, error: { code: 'execution_receipt_invalid' } });
    });
  });
});
