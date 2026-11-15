import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from './define-tool';
import { dispatchProjectedTool } from './dispatch-projected';
import { dispatchWithToolExecution, type ToolExecutionContract } from './execution-contract';
import { _resetCatalogForTests } from './registry';
import { lookupByMcpName } from './tool-projection';

const budgets = { nowMs: 1000, executionDeadlineMs: 61000, transportResponseBudgetMs: 60000 };
afterEach(() => _resetCatalogForTests());

function fixture() {
  const handler = vi.fn(async (args: { value: number }) => ({
    content: [{ type: 'text' as const, text: 'ok ' + args.value }],
  }));
  const definition = defineTool({
    name: 'execution_contract:bar_probe', description: 'Counted execution-contract BAR fixture',
    capability: 'tasks:read', requirePrincipal: false, agentRoles: ['operator'],
    args: z.object({ value: z.number() }), handler,
  });
  const tool = lookupByMcpName(definition.name);
  if (!tool) throw new Error('Execution-contract BAR fixture was not projected');
  const inline = vi.fn(() => dispatchProjectedTool(tool, definition.name, { value: 7 }, {
    log: () => {}, signal: new AbortController().signal, progress: () => {}, emit: () => {},
    workspaceId: 'execution-contract-bar', role: 'operator', runId: 'execution-contract-bar-run',
  }, {}));
  return { tool, handler, inline };
}

describe('unified execution >', () => {
  describe('R-20 > P-003 >', () => {
    it('control', async () => {
      const { tool, handler, inline } = fixture();
      const result = await dispatchWithToolExecution(tool.execution, { mode: 'sync' }, budgets, { inline });
      expect(result).toMatchObject({
        ok: true, result: { ok: true, result: { content: [{ type: 'text', text: 'ok 7' }] } },
      });
      expect(inline).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('counterexample', async () => {
      const { tool, handler, inline } = fixture();
      const result = await dispatchWithToolExecution(tool.execution, { mode: 'async' }, budgets, { inline });
      expect(result).toMatchObject({ ok: false, error: 'unsupported_execution_mode', supportedModes: ['sync', 'auto'] });
      expect(inline).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('R-21 > P-003 >', () => {
    it('control', async () => {
      const { tool, handler, inline } = fixture();
      const result = await dispatchWithToolExecution(tool.execution, {}, budgets, { inline });
      expect(result).toMatchObject({
        ok: true, selection: { mode: 'auto' },
        result: { ok: true, result: { content: [{ type: 'text', text: 'ok 7' }] } },
      });
      expect(inline).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('counterexample', async () => {
      const { tool, handler, inline } = fixture();
      const changedDefault = { ...tool.execution, defaultMode: 'sync' } as unknown as ToolExecutionContract;
      await expect(dispatchWithToolExecution(changedDefault, {}, budgets, { inline }))
        .rejects.toThrow('default mode must be auto');
      expect(inline).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
