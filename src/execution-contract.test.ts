import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchWithToolExecution, parseToolExecutionReceipt, resolveToolExecutionContract, selectToolExecution,
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

describe('execution receipt codec', () => {
  const original = () => ({
    schemaVersion: 'tool-execution-receipt-v2',
    invocationRef: 'invocation:original', lifecycle: 'request-bound', durability: 'none',
    mode: 'auto', responseWindowMs: 5000, executionDeadlineMs: 601000,
    authority: { bindingRef: 'authority:original', fingerprint: 'original-fingerprint' },
    observation: { response: 'request-expired', outcome: 'unknown', observedAtMs: 6001, evidenceRef: null },
    terminal: false,
  });

  const child = () => ({
    jobId: 'child:original', parentJobId: 'parent:original', rootJobId: 'root:original',
    summary: { text: 'Processed the first batch', omittedChars: 20, fullRef: 'child:original:summary' },
    phase: 'processing',
    started: { atMs: 1000, sourceKind: 'child-runtime', evidenceRef: 'child:original:start' },
    updated: { atMs: 2000, sourceKind: 'child-runtime', evidenceRef: 'child:original:update' },
    lastActivity: { atMs: 1900, sourceKind: 'child-runtime', evidenceRef: 'child:original:activity' },
    resultRef: null, logRef: 'child:original:log',
    measurement: { kind: 'measured', quantity: 12, units: 'records', writer: 'child:original:counter',
      observedAtMs: 2000, evidenceRef: 'child:original:counter:revision:12' },
  });

  it('round trips child evidence while wrapper settlement leaves the child phase unchanged', () => {
    const input = { ...original(), observation: { response: 'returned', outcome: 'succeeded',
      observedAtMs: 2100, evidenceRef: 'wrapper:settlement' }, terminal: true, progress: child() };
    const receipt = parseToolExecutionReceipt(JSON.parse(JSON.stringify(input)));
    expect(receipt).toEqual(input);
    expect(receipt.progress).toMatchObject({ jobId: 'child:original', phase: 'processing',
      resultRef: null, measurement: { quantity: 12, units: 'records' } });
    expect(Object.isFrozen(receipt.progress)).toBe(true);
    expect(Object.isFrozen(receipt.progress?.measurement)).toBe(true);
    input.progress.measurement.quantity = 99;
    input.progress.summary.text = 'changed later';
    expect(receipt.progress?.measurement).toMatchObject({ quantity: 12 });
    expect(receipt.progress?.summary.text).toBe('Processed the first batch');
    expect(parseToolExecutionReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
  });

  it.each(['jobId', 'parentJobId', 'rootJobId', 'phase', 'started', 'updated', 'lastActivity', 'measurement'])(
    'rejects missing child %s even when the wrapper succeeded', field => {
      const progress = { ...child() } as Record<string, unknown>;
      delete progress[field];
      expect(() => parseToolExecutionReceipt({ ...original(), progress,
        observation: { response: 'returned', outcome: 'succeeded', observedAtMs: 2100,
          evidenceRef: 'wrapper:settlement' }, terminal: true })).toThrow('Invalid tool execution receipt');
      expect(parseToolExecutionReceipt({ ...original(), progress: child() }).progress).toEqual(child());
    });

  it.each(['quantity', 'units', 'writer', 'observedAtMs', 'evidenceRef'])(
    'rejects missing instrumented %s without inventing zero progress', field => {
      const progress = child();
      delete (progress.measurement as Record<string, unknown>)[field];
      expect(() => parseToolExecutionReceipt({ ...original(), progress })).toThrow('Invalid tool execution receipt');
    });

  it('keeps unknown measurement and activity explicit without treating liveness as quantity', () => {
    const progress = { ...child(),
      measurement: { kind: 'unknown', reason: 'This child has no quantity instrument' },
      lastActivity: { atMs: null, sourceKind: 'unknown', evidenceRef: null } };
    expect(parseToolExecutionReceipt({ ...original(), progress }).progress).toEqual(progress);
    expect(() => parseToolExecutionReceipt({ ...original(), progress: { ...progress,
      measurement: { ...progress.measurement, quantity: 0 } } })).toThrow('Invalid tool execution receipt');
    expect(() => parseToolExecutionReceipt({ ...original(), progress: { ...progress,
      lastActivity: { atMs: 1900, sourceKind: 'unknown', evidenceRef: null } } }))
      .toThrow('Invalid tool execution receipt');
  });

  it.each([1999, 2000, 2001])('preserves complete child identity and recovery references at length %i', length => {
    const progress = { ...child(), jobId: 'j'.repeat(length),
      summary: { text: 'Preview', omittedChars: length, fullRef: 'source:' + 's'.repeat(length) } };
    expect(parseToolExecutionReceipt(JSON.parse(JSON.stringify({ ...original(), progress }))).progress)
      .toEqual(progress);
  });

  it.each([NaN, Infinity, -Infinity])('rejects a nonfinite measured quantity %s', quantity => {
    const progress = child();
    progress.measurement.quantity = quantity;
    expect(() => parseToolExecutionReceipt({ ...original(), progress })).toThrow('Invalid tool execution receipt');
  });

  it('requires explicit recoverable summary omissions and timestamp provenance', () => {
    for (const summary of [{ text: 'Preview', omittedChars: 1 }, { text: 'Preview', omittedChars: -1, fullRef: 'source' },
      { text: 'Preview', omittedChars: 0.5, fullRef: 'source' }]) {
      expect(() => parseToolExecutionReceipt({ ...original(), progress: { ...child(), summary } }))
        .toThrow('Invalid tool execution receipt');
    }
    expect(() => parseToolExecutionReceipt({ ...original(), progress: { ...child(),
      updated: { atMs: 2000, sourceKind: 'child-runtime', evidenceRef: null } } }))
      .toThrow('Invalid tool execution receipt');
  });

  it('round trips an expired request without inventing a handle or business outcome', () => {
    const receipt = parseToolExecutionReceipt(JSON.parse(JSON.stringify(original())));
    expect(receipt).toEqual(original());
    expect(receipt).not.toHaveProperty('handle');
    expect(receipt).not.toHaveProperty('ownerId');
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.authority)).toBe(true);
    expect(Object.isFrozen(receipt.observation)).toBe(true);
  });

  it('keeps response loss separate from a witnessed original business settlement', () => {
    const receipt = parseToolExecutionReceipt({ ...original(), lifecycle: 'independent',
      durability: 'restart', handle: 'runtime:original', ownerId: 'original-owner', adapterId: adapter.id,
      observation: { response: 'response-lost', outcome: 'succeeded', observedAtMs: 7000,
        evidenceRef: 'runtime:original:settlement' }, terminal: true,
      resultRef: 'runtime:original:result', logRef: 'runtime:original:log' });
    expect(receipt).toMatchObject({ lifecycle: 'independent', terminal: true, handle: 'runtime:original',
      observation: { response: 'response-lost', outcome: 'succeeded' }, executionDeadlineMs: 601000 });
    expect(parseToolExecutionReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
  });

  it.each([
    { handle: 'forged-handle' }, { ownerId: 'forged-owner' }, { adapterId: adapter.id },
    { durability: 'restart' }, { mode: 'async' }, { terminal: true },
    { authority: undefined }, { authority: { bindingRef: 'authority:original' } },
    { authority: { bindingRef: '', fingerprint: 'original-fingerprint' } },
    { responseWindowMs: 0 }, { executionDeadlineMs: Infinity },
    { observation: { response: 'timed-out', outcome: 'unknown', observedAtMs: 6001, evidenceRef: null } },
    { observation: { response: 'response-lost', outcome: 'succeeded', observedAtMs: 6001, evidenceRef: null }, terminal: true },
  ])('rejects an unsafe single-boundary mutation: %j', mutation => {
    expect(() => parseToolExecutionReceipt({ ...original(), ...mutation })).toThrow('Invalid tool execution receipt');
    expect(parseToolExecutionReceipt(original())).toEqual(original());
  });

  it.each(['handle', 'ownerId', 'adapterId'])('requires the complete independent %s identity', field => {
    const receipt: Record<string, unknown> = { ...original(), lifecycle: 'independent', durability: 'session',
      handle: 'runtime:original', ownerId: 'original-owner', adapterId: adapter.id };
    expect(parseToolExecutionReceipt(receipt)).toMatchObject({ handle: 'runtime:original', ownerId: 'original-owner' });
    delete receipt[field];
    expect(() => parseToolExecutionReceipt(receipt)).toThrow('Invalid tool execution receipt');
  });

  it('copies nested observations and preserves complete references without a size cap', () => {
    const input = original();
    input.invocationRef = 'invocation:' + 'x'.repeat(10000);
    input.authority.bindingRef = 'authority:' + 'y'.repeat(10000);
    const receipt = parseToolExecutionReceipt(input);
    input.authority.bindingRef = 'substituted';
    input.observation.outcome = 'succeeded';
    expect(receipt.invocationRef).toBe(input.invocationRef);
    expect(receipt.authority.bindingRef).toBe('authority:' + 'y'.repeat(10000));
    expect(receipt.observation.outcome).toBe('unknown');
    expect(receipt.terminal).toBe(false);
  });

  it('does not upgrade legacy receipts or expose rejected payload values', () => {
    expect(() => parseToolExecutionReceipt({ schemaVersion: 'tool-execution-receipt-v1',
      handle: 'old-handle', ownerId: 'old-owner', state: 'running', terminal: false,
      mode: 'auto', responseWindowMs: 5000, executionDeadlineMs: 601000 })).toThrow('Invalid tool execution receipt');
    for (const receipt of [{ ...original(), result: 'synthetic-private-value' },
      { ...original(), authority: { ...original().authority, credential: 'synthetic-private-value' } }]) {
      expect(() => parseToolExecutionReceipt(receipt)).toThrow('Invalid tool execution receipt');
      try { parseToolExecutionReceipt(receipt); } catch (error) {
        expect(String(error)).not.toContain('synthetic-private-value');
      }
    }
  });
});

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

describe('unified execution', () => {
  describe('R-23 > P-003', () => {
    it('D013 default window control', () => {
      for (const ceiling of [600000, 4000, null]) {
        expect(selectToolExecution(independent, {}, { ...budgets, transportResponseBudgetMs: ceiling }))
          .toMatchObject({ ok: true, responseWindowMs: ceiling === null ? 5000 : Math.min(5000, ceiling),
            autoYieldAfterMs: ceiling === null ? 5000 : Math.min(5000, ceiling), executionDeadlineMs: 601000 });
      }
    });

    it('D013 default window drift counterexample', () => {
      const original = selectToolExecution(independent, {}, budgets);
      if (!original.ok) throw new Error('Original selection refused');
      const mutated = { ...original, responseWindowMs: 5001, autoYieldAfterMs: 5001 };
      expect(() => expect(mutated).toMatchObject({ responseWindowMs: 5000, autoYieldAfterMs: 5000 })).toThrow();
    });

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

  // Unit-level host simulation: only the host-provided response ceiling changes
  // in a mutation. The native integration pair uses the real MCP deadline race.
  for (const requirement of ['R-23', 'R-26']) describe(requirement + ' > P-003', () => {
    const safe = async (ceiling: number | null, requested: number, originalRemaining = 600000) => {
      const handler = vi.fn(async () => 'business result');
      const result = await dispatchWithToolExecution(undefined, { mode: 'sync', responseWindowMs: requested }, {
        nowMs: 1000, executionDeadlineMs: originalRemaining + 1000, transportResponseBudgetMs: ceiling,
      }, { inline: handler });
      return { result, handler };
    };
    const longRequest = async (disabled: boolean, corrupt: boolean) => {
      vi.useFakeTimers(); vi.setSystemTime(1000);
      let selection: ToolExecutionSelection | undefined;
      let responseExpired = false;
      let handlerSettled = false;
      const ceiling = corrupt ? 45000 : disabled ? null : 120000;
      const handler = vi.fn(async (selected: ToolExecutionSelection) => {
        selection = selected;
        // Model the request owner's response race; this never detaches the handler.
        if (selected.responseWindowMs !== null) setTimeout(() => { responseExpired = true; }, selected.responseWindowMs);
        await new Promise(resolve => setTimeout(resolve, 80000));
        handlerSettled = true;
        return 'original result';
      });
      const pending = dispatchWithToolExecution(undefined, {}, {
        nowMs: 1000, executionDeadlineMs: 121000, transportResponseBudgetMs: ceiling,
      }, { inline: handler });
      await vi.advanceTimersByTimeAsync(45001);
      const assertRequestLive = () => {
        expect(responseExpired).toBe(false);
        expect(handlerSettled).toBe(false);
        expect(selection).toMatchObject({ mode: 'auto', lifecycle: 'request-bound', autoYieldAfterMs: null,
          responseWindowMs: 120000, executionDeadlineMs: 121000 });
        expect(handler).toHaveBeenCalledOnce();
      };
      if (corrupt) expect(assertRequestLive).toThrow(); else assertRequestLive();
      await vi.advanceTimersByTimeAsync(34999);
      expect(await pending).toMatchObject({ ok: true, result: 'original result' });
      expect(handler).toHaveBeenCalledOnce();
    };
    it('D013 long declared timeout control', async () => { await longRequest(false, false); });
    it('D013 fixed ceiling counterexample', async () => {
      await longRequest(false, true);
      await longRequest(false, false); // repair the same boundary, fixture and clock
    });
    it('D013 strict sync supported budget control', async () => {
      for (const requested of [119999, 120000]) {
        const { result, handler } = await safe(120000, requested, 120000);
        expect(result).toMatchObject({ ok: true, result: 'business result',
          selection: { responseWindowMs: requested, executionDeadlineMs: 121000 } });
        expect(handler).toHaveBeenCalledOnce();
      }
    });
    it('D013 strict sync over-budget counterexample', async () => {
      // Cross each bound independently: transport, then original execution.
      for (const [ceiling, requested, remaining] of [[120000, 120001, 130000], [130000, 120001, 120000]]) {
        const { result, handler } = await safe(ceiling!, requested!, remaining!);
        expect(result).toMatchObject({ ok: false, error: 'execution_budget_exceeded' });
        expect(handler).not.toHaveBeenCalled();
      }
    });
    it('D013 disabled transport deadline control', async () => {
      await longRequest(true, false);
      // Disabling transport never disables the original execution deadline.
      const beyond = await safe(null, 120001, 120000);
      expect(beyond.result).toMatchObject({ ok: false, error: 'execution_budget_exceeded' });
      expect(beyond.handler).not.toHaveBeenCalled();
      const handler = vi.fn();
      expect(await dispatchWithToolExecution(undefined, {}, { ...budgets, transportResponseBudgetMs: null,
        requestAborted: true }, { inline: handler })).toMatchObject({ ok: false, error: 'request_expired' });
      expect(handler).not.toHaveBeenCalled();
    });
    it('D013 disabled cap counterexample', async () => {
      await longRequest(true, true);
      await longRequest(true, false);
    });
  });

  describe('R-26 > P-003', () => {
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

  describe('R-20 > P-003', () => {
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

  describe('R-21 > P-003', () => {
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
