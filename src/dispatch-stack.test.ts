/**
 * Tests for the dispatch-stack pipeline surface — enumeration, ordering,
 * customization. Behavior tests live in dispatch-projected.test.ts (40
 * tests) and exercise the same code through the public entrypoints.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DISPATCH_STACK,
  SOFT_FAILURE_REASON_MAX,
  extractSoftFailureOutcome,
  withReplacedStep,
  runDispatchStack,
  type DispatchStepName,
} from './dispatch-stack';
import { z } from 'zod';
import { clearEntityResolvers, entityRef, setEntityResolver } from './entity-ref';
import {
  _resetProjectionRegistryForTests,
  type ProjectedTool,
  type UnifiedToolContext,
} from './tool-projection';

const MAKE_CTX = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'default',
  harnessSlug: 'sheets',
  role: 'worker',
  featureId: 'F-AUTH-003',
  chunkId: 'ck_X',
  runId: 'run_X',
  spawnId: 'spw_X',
  parentSpawnId: null,
  ...over,
});

const makeTool = (over: Partial<ProjectedTool> = {}): ProjectedTool => ({
  pluginName: 'fixture',
  description: 'fixture',
  inputSchema: { type: 'object' },
  capabilities: [],
  expose: { mcp: { name: 'fix.tool' } },
  fn: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  ...over,
});

afterEach(() => _resetProjectionRegistryForTests());

describe('DEFAULT_DISPATCH_STACK — enumeration', () => {
  it('runs steps in this exact order: gates → timeout → idle → buffer → bindings → invoke', () => {
    const expected: DispatchStepName[] = [
      'kernel-preflight',
      'default-deny',
      'role-allowlist',
      'capability-check',
      'capability-envelope',
      'role-requirement',
      'harness-check',
      'quota',
      'authorize',
      'preconditions',
      'entity-check',
      'timeout',
      'idle-watchdog',
      'replay-buffer',
      'ctx-bindings',
      'kernel-enforce',
      'invoke',
    ];
    expect(DEFAULT_DISPATCH_STACK.map((s) => s.name)).toEqual(expected);
  });

  it('is frozen — production callers cannot mutate it in place', () => {
    expect(Object.isFrozen(DEFAULT_DISPATCH_STACK)).toBe(true);
  });

  it('has a unique name per step', () => {
    const names = DEFAULT_DISPATCH_STACK.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gates run before invoke', () => {
    const names = DEFAULT_DISPATCH_STACK.map((s) => s.name);
    const invokeIdx = names.indexOf('invoke');
    for (const gate of ['role-allowlist', 'capability-check', 'quota'] as DispatchStepName[]) {
      expect(names.indexOf(gate)).toBeLessThan(invokeIdx);
    }
  });

  it('timeout arms before idle-watchdog (idle races against the same controller)', () => {
    const names = DEFAULT_DISPATCH_STACK.map((s) => s.name);
    expect(names.indexOf('timeout')).toBeLessThan(names.indexOf('idle-watchdog'));
  });

  it('replay-buffer + ctx-bindings run before invoke (handler emits go through wrapper)', () => {
    const names = DEFAULT_DISPATCH_STACK.map((s) => s.name);
    const invokeIdx = names.indexOf('invoke');
    expect(names.indexOf('replay-buffer')).toBeLessThan(invokeIdx);
    expect(names.indexOf('ctx-bindings')).toBeLessThan(invokeIdx);
  });
});

describe('workspace transaction contract (EI-18808330244321407)', () => {
  const txNameTool = (over: Partial<ProjectedTool> = {}) =>
    makeTool({
      fn: async (_input, ctx) => {
        try {
          return { content: [{ type: 'text', text: String(ctx.tx) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: (error as Error).name }] };
        }
      },
      ...over,
    });

  it('hides even an accidentally supplied ambient tx from an undeclared tool', async () => {
    const result = await runDispatchStack(
      txNameTool(),
      'fix.tool',
      {},
      MAKE_CTX({ tx: 'ambient-tx' }),
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.result?.content[0]).toMatchObject({ text: 'WorkspaceTxNotDeclaredError' });
  });

  it('preserves a real host-bound tx for a declared consumer', async () => {
    const result = await runDispatchStack(
      txNameTool({ needsWorkspaceTx: true }),
      'fix.tool',
      {},
      MAKE_CTX({ tx: 'workspace-tx' }),
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.result?.content[0]).toMatchObject({ text: 'workspace-tx' });
  });

  it('throws a distinct named error when a declared consumer has no bound tx', async () => {
    const result = await runDispatchStack(
      txNameTool({ needsWorkspaceTx: true }),
      'fix.tool',
      {},
      MAKE_CTX(),
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.result?.content[0]).toMatchObject({ text: 'WorkspaceTxUnavailableError' });
  });
});

describe('withReplacedStep', () => {
  it('replaces a step by name; other entries unchanged', () => {
    const custom = withReplacedStep(DEFAULT_DISPATCH_STACK, 'quota', async () => null);
    expect(custom.map((s) => s.name)).toEqual(DEFAULT_DISPATCH_STACK.map((s) => s.name));
    const quotaIdx = custom.findIndex((s) => s.name === 'quota');
    expect(custom[quotaIdx].run).not.toBe(DEFAULT_DISPATCH_STACK[quotaIdx].run);
    // Untouched entries should be reference-equal.
    expect(custom[0]).toBe(DEFAULT_DISPATCH_STACK[0]);
  });

  it('throws when the named step is missing', () => {
    // @ts-expect-error — intentionally bad name to exercise the throw
    expect(() => withReplacedStep(DEFAULT_DISPATCH_STACK, 'nonexistent', async () => null)).toThrow(
      /no step named/,
    );
  });

  it('does not mutate the input stack', () => {
    const before = DEFAULT_DISPATCH_STACK.map((s) => s.name);
    withReplacedStep(DEFAULT_DISPATCH_STACK, 'invoke', async () => null);
    expect(DEFAULT_DISPATCH_STACK.map((s) => s.name)).toEqual(before);
  });
});

describe('runDispatchStack — custom stack', () => {
  it('notifies the host before a handler starts and while it remains in flight', async () => {
    const activeDispatches = new Set<string>();
    let handlerStarted = false;
    let releaseHandler!: () => void;
    const handlerCanFinish = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    const pending = runDispatchStack(
      makeTool({
        fn: async () => {
          handlerStarted = true;
          expect(activeDispatches.has('fix.tool')).toBe(true);
          await handlerCanFinish;
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      }),
      'fix.tool',
      { probe: true },
      MAKE_CTX(),
      {
        onDispatchStart: ({ toolName }) => {
          expect(handlerStarted).toBe(false);
          activeDispatches.add(toolName);
        },
        postInvoke: ({ toolName }) => {
          activeDispatches.delete(toolName);
        },
      },
    );

    await vi.waitFor(() => expect(handlerStarted).toBe(true));
    expect(activeDispatches.has('fix.tool')).toBe(true);
    releaseHandler();
    expect((await pending).ok).toBe(true);
    expect(activeDispatches.has('fix.tool')).toBe(false);
  });

  it('accepts a customized stack and routes through it', async () => {
    let quotaRan = false;
    const custom = withReplacedStep(DEFAULT_DISPATCH_STACK, 'quota', async () => {
      quotaRan = true;
      return null;
    });
    const r = await runDispatchStack(
      makeTool(),
      'fix.tool',
      {},
      MAKE_CTX(),
      {},
      custom,
    );
    expect(r.ok).toBe(true);
    expect(quotaRan).toBe(true);
  });

  it('short-circuits at the first step that returns a result', async () => {
    let invoked = false;
    const tool = makeTool({
      fn: async () => {
        invoked = true;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    const denyAll = withReplacedStep(DEFAULT_DISPATCH_STACK, 'role-allowlist', async () => ({
      ok: false,
      error: { code: 'role_not_allowed', message: 'always-deny' },
    }));
    const r = await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), {}, denyAll);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('role_not_allowed');
    expect(invoked).toBe(false);
  });

  it('runs telemetry even on short-circuit', async () => {
    const recorded: string[] = [];
    const denyAll = withReplacedStep(DEFAULT_DISPATCH_STACK, 'capability-check', async () => ({
      ok: false,
      error: { code: 'missing_capability', message: 'denied' },
    }));
    await runDispatchStack(
      makeTool(),
      'fix.tool',
      {},
      MAKE_CTX({
        principal: {
          slug: 'test',
          workspaceId: 'default',
          capabilities: new Set(),
        },
      }),
      {
        recordInvocation: vi.fn(async (i) => {
          recorded.push(i.status);
        }),
      },
      denyAll,
    );
    expect(recorded).toEqual(['role-not-allowed']);
  });

  it('extracts a bounded top-level soft failure, preferring structuredContent over conflicting text', () => {
    const longReason = `  ${'x'.repeat(SOFT_FAILURE_REASON_MAX + 40)}  `;
    expect(extractSoftFailureOutcome({
      structuredContent: { ok: false, reason: longReason },
      content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'text-loses' }) }],
    })).toEqual({
      resultOutcome: 'soft-failure',
      softFailureReason: 'x'.repeat(SOFT_FAILURE_REASON_MAX),
    });
  });

  it('falls back to the first JSON text result and rejects lookalike/nested/blank shapes', () => {
    expect(extractSoftFailureOutcome({
      content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'transcript_not_found' }) }],
    })).toEqual({ resultOutcome: 'soft-failure', softFailureReason: 'transcript_not_found' });

    for (const value of [
      { ok: true, reason: 'no' },
      { ok: 0, reason: 'no' },
      { ok: false, reason: '   ' },
      { data: { ok: false, reason: 'nested' } },
      ['not', 'an', 'object'],
    ]) {
      expect(extractSoftFailureOutcome({
        content: [{ type: 'text', text: JSON.stringify(value) }],
      })).toBeNull();
    }
    expect(extractSoftFailureOutcome({ content: [{ type: 'text', text: 'not json' }] })).toBeNull();
  });

  it('records soft-failure outcome metadata after handler metadata without changing call-level status', async () => {
    let captured: {
      status?: string;
      metadataJson?: Record<string, unknown> | null;
      errorCode?: string | null;
      errorMessage?: string | null;
    } | undefined;
    const tool = makeTool({
      fn: async (_input, ctx) => {
        ctx.metadata?.({ resultOutcome: 'handler-claim', softFailureReason: 'handler-claim', marker: 1 });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'no_assistant_turn' }) }] };
      },
    });
    await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), {
      computeQuotaWindow: () => ({ key: 'w', limit: 0 }),
      recordInvocation: vi.fn(async (input) => { captured = input; }),
    });
    expect(captured).toMatchObject({
      status: 'ok',
      metadataJson: {
        marker: 1,
        resultOutcome: 'soft-failure',
        softFailureReason: 'no_assistant_turn',
      },
    });
    expect(captured?.errorCode).toBeUndefined();
    expect(captured?.errorMessage).toBeUndefined();
  });

  it('captures the served result _meta.format into recorded metadata_json (usage-insights P-002)', async () => {
    let capturedMeta: Record<string, unknown> | null | undefined;
    const tool = makeTool({
      fn: async () => ({ content: [{ type: 'text', text: 'format: toon\n[1]{a}:\n1' }], _meta: { format: 'toon' } }),
    });
    await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), {
      computeQuotaWindow: () => ({ key: 'w', limit: 0 }),
      recordInvocation: vi.fn(async (i) => {
        capturedMeta = i.metadataJson;
      }),
    });
    expect(capturedMeta?.format).toBe('toon');
  });

  it('records NO format key when the result carries no _meta.format', async () => {
    let captured: Record<string, unknown> | null | undefined = { sentinel: 1 };
    const tool = makeTool({ fn: async () => ({ content: [{ type: 'text', text: 'x' }] }) });
    await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), {
      computeQuotaWindow: () => ({ key: 'w', limit: 0 }),
      recordInvocation: vi.fn(async (i) => {
        captured = i.metadataJson;
      }),
    });
    expect((captured ?? {}).format).toBeUndefined();
  });

  // The negotiated freshness mode → metadata_json.deltaMode (delta-rollout telemetry,
  // agent-tool-delta-client-rollout P-005). The capture is mode-agnostic (any string mode),
  // so a SEMANTIC delta (mode:'delta', the risky merge) is the same single GROUP BY signal as
  // the Lane-B modes. These pin all three served modes + the absent-negotiation default.
  it("captures a served _meta.delta.mode:'delta' into recorded metadata_json.deltaMode (P-005)", async () => {
    let capturedMeta: Record<string, unknown> | null | undefined;
    const tool = makeTool({
      fn: async () => ({ content: [{ type: 'text', text: '[]' }], _meta: { delta: { mode: 'delta', cursor: 'c1' } } }),
    });
    await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), {
      computeQuotaWindow: () => ({ key: 'w', limit: 0 }),
      recordInvocation: vi.fn(async (i) => {
        capturedMeta = i.metadataJson;
      }),
    });
    expect(capturedMeta?.deltaMode).toBe('delta');
  });

  it("captures _meta.delta.mode:'not_modified' into recorded metadata_json.deltaMode", async () => {
    let capturedMeta: Record<string, unknown> | null | undefined;
    const tool = makeTool({
      fn: async () => ({ content: [{ type: 'text', text: '' }], _meta: { delta: { mode: 'not_modified', cursor: 'c2' } } }),
    });
    await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), {
      computeQuotaWindow: () => ({ key: 'w', limit: 0 }),
      recordInvocation: vi.fn(async (i) => {
        capturedMeta = i.metadataJson;
      }),
    });
    expect(capturedMeta?.deltaMode).toBe('not_modified');
  });

  it('records NO deltaMode key when the result carries no _meta.delta (un-negotiated call)', async () => {
    let captured: Record<string, unknown> | null | undefined = { sentinel: 1 };
    const tool = makeTool({ fn: async () => ({ content: [{ type: 'text', text: 'x' }], _meta: { format: 'json' } }) });
    await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), {
      computeQuotaWindow: () => ({ key: 'w', limit: 0 }),
      recordInvocation: vi.fn(async (i) => {
        captured = i.metadataJson;
      }),
    });
    expect((captured ?? {}).deltaMode).toBeUndefined();
  });

  // EI-9130: a generic, queryable "was this response served as a delta?" breadcrumb —
  // derived from the formal protocol's mode when present, or preserved verbatim when a
  // handler already stamped it itself via ctx.metadata({ deltaServed }) (e.g. coord:orient's
  // bespoke fleetDelta/planEvents/fleetCatchUp cursors, which don't ride `_meta.delta`).
  it("derives deltaServed:true from a served _meta.delta.mode:'delta'", async () => {
    let capturedMeta: Record<string, unknown> | null | undefined;
    const tool = makeTool({
      fn: async () => ({ content: [{ type: 'text', text: '[]' }], _meta: { delta: { mode: 'delta', cursor: 'c1' } } }),
    });
    await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), {
      computeQuotaWindow: () => ({ key: 'w', limit: 0 }),
      recordInvocation: vi.fn(async (i) => {
        capturedMeta = i.metadataJson;
      }),
    });
    expect(capturedMeta?.deltaServed).toBe(true);
  });

  it("derives deltaServed:true from a served _meta.delta.mode:'not_modified'", async () => {
    let capturedMeta: Record<string, unknown> | null | undefined;
    const tool = makeTool({
      fn: async () => ({ content: [{ type: 'text', text: '' }], _meta: { delta: { mode: 'not_modified', cursor: 'c2' } } }),
    });
    await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), {
      computeQuotaWindow: () => ({ key: 'w', limit: 0 }),
      recordInvocation: vi.fn(async (i) => {
        capturedMeta = i.metadataJson;
      }),
    });
    expect(capturedMeta?.deltaServed).toBe(true);
  });

  it("derives deltaServed:false from a served _meta.delta.mode:'full' (negotiated but not narrowed)", async () => {
    let capturedMeta: Record<string, unknown> | null | undefined;
    const tool = makeTool({
      fn: async () => ({ content: [{ type: 'text', text: '[]' }], _meta: { delta: { mode: 'full', cursor: 'c3' } } }),
    });
    await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), {
      computeQuotaWindow: () => ({ key: 'w', limit: 0 }),
      recordInvocation: vi.fn(async (i) => {
        capturedMeta = i.metadataJson;
      }),
    });
    expect(capturedMeta?.deltaServed).toBe(false);
  });

  it('records NO deltaServed key when the result carries no _meta.delta and the handler stamped none', async () => {
    let captured: Record<string, unknown> | null | undefined = { sentinel: 1 };
    const tool = makeTool({ fn: async () => ({ content: [{ type: 'text', text: 'x' }] }) });
    await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), {
      computeQuotaWindow: () => ({ key: 'w', limit: 0 }),
      recordInvocation: vi.fn(async (i) => {
        captured = i.metadataJson;
      }),
    });
    expect((captured ?? {}).deltaServed).toBeUndefined();
  });

  it("preserves a handler's own explicit ctx.metadata({ deltaServed }) stamp verbatim, even with no _meta.delta (coord:orient's bespoke cursor-delta shape)", async () => {
    let capturedMeta: Record<string, unknown> | null | undefined;
    const tool = makeTool({
      fn: async (_input, ctx) => {
        ctx.metadata?.({ deltaServed: true });
        return { content: [{ type: 'text', text: 'x' }] };
      },
    });
    await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), {
      computeQuotaWindow: () => ({ key: 'w', limit: 0 }),
      recordInvocation: vi.fn(async (i) => {
        capturedMeta = i.metadataJson;
      }),
    });
    expect(capturedMeta?.deltaServed).toBe(true);
  });

  it("a handler's explicit deltaServed:false stamp wins over a formal _meta.delta.mode present on the SAME call", async () => {
    let capturedMeta: Record<string, unknown> | null | undefined;
    const tool = makeTool({
      fn: async (_input, ctx) => {
        ctx.metadata?.({ deltaServed: false });
        return { content: [{ type: 'text', text: '[]' }], _meta: { delta: { mode: 'delta', cursor: 'c4' } } };
      },
    });
    await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), {
      computeQuotaWindow: () => ({ key: 'w', limit: 0 }),
      recordInvocation: vi.fn(async (i) => {
        capturedMeta = i.metadataJson;
      }),
    });
    expect(capturedMeta?.deltaServed).toBe(false);
  });
});

describe('P-041 kernel enforcement seats', () => {
  const applied = { specificationRevision: 'spec-applied', stateRevision: 'state-7' };

  it('runs preflight before decorators and refuses before the handler on an explicit deny', async () => {
    const order: string[] = [];
    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'should-not-run' }] }));
    const result = await runDispatchStack(
      makeTool({ fn: handler }),
      'fixture:write',
      { id: 'x' },
      MAKE_CTX(),
      {
        kernelEnforcement: async (request) => {
          order.push(request.phase);
          return { decision: 'deny', code: 'revoked', reason: 'revoked by owner' };
        },
      },
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'authorization_denied' } });
    expect(result.error?.message).toContain('revoked by owner');
    expect(order).toEqual(['preflight']);
    expect(handler).not.toHaveBeenCalled();
  });

  it('re-checks immediately before invoke and stamps only an applied revision', async () => {
    const phases: string[] = [];
    let handlerContext: UnifiedToolContext | undefined;
    let recorded: { executionRevision?: unknown } | undefined;
    let observed: { executionRevision?: unknown } | undefined;
    const result = await runDispatchStack(
      makeTool({
        capabilities: ['fixture:write'],
        fn: async (_input, ctx) => {
          handlerContext = ctx;
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      }),
      'fixture:write',
      {},
      MAKE_CTX({ requestedExecutionRevision: applied }),
      {
        kernelEnforcement: async (request) => {
          phases.push(request.phase);
          if (request.phase === 'preflight') {
            return { decision: 'allow', availability: 'available', applied: false };
          }
          return {
            decision: 'allow',
            availability: 'available',
            applied: true,
            executionRevision: applied,
            revisionSource: 'applied',
          };
        },
        recordInvocation: async (input) => {
          recorded = input;
        },
        postInvoke: (event) => {
          observed = event;
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(phases).toEqual(['preflight', 'enforce']);
    expect(handlerContext?.executionRevision).toEqual(applied);
    expect(recorded?.executionRevision).toEqual(applied);
    expect(observed?.executionRevision).toEqual(applied);
    expect(observed?.ctx.executionRevision).toEqual(applied);
    expect(observed?.kernelPreflight).toMatchObject({ decision: 'allow' });
    expect(observed?.kernelEnforcement).toMatchObject({ decision: 'allow', revisionSource: 'applied' });
  });

  it('honors a revocation that appears between preflight and final enforce', async () => {
    const phases: string[] = [];
    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'must-not-run' }] }));
    const result = await runDispatchStack(
      makeTool({ fn: handler }),
      'fixture:write',
      {},
      MAKE_CTX(),
      {
        kernelEnforcement: async (request) => {
          phases.push(request.phase);
          return request.phase === 'preflight'
            ? { decision: 'allow', availability: 'available', applied: true }
            : { decision: 'deny', code: 'revoked', reason: 'revoked while preparing call' };
        },
      },
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'authorization_denied' } });
    expect(result.error?.message).toContain('revoked while preparing call');
    expect(phases).toEqual(['preflight', 'enforce']);
    expect(handler).not.toHaveBeenCalled();
  });

  it('labels reaction and indirect calls at the shared kernel seat', async () => {
    const boundaries: string[] = [];
    await runDispatchStack(
      makeTool(),
      'fixture:reaction',
      {},
      MAKE_CTX({ reactionCause: { depth: 1, chain: ['r-1'], ruleId: 'r-1' } }),
      { kernelEnforcement: (request) => { boundaries.push(request.boundary); return { decision: 'allow' }; } },
    );
    expect(boundaries).toEqual(['reaction', 'reaction']);
  });

  it('does not attribute a desired/prepared revision as execution truth', async () => {
    let captured: { executionRevision?: unknown } | undefined;
    const result = await runDispatchStack(
      makeTool({ fn: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }),
      'fixture:read',
      {},
      MAKE_CTX(),
      {
        kernelEnforcement: async (request) => request.phase === 'preflight'
          ? { decision: 'allow', availability: 'available', applied: false }
          : {
              decision: 'allow',
              availability: 'available',
              applied: false,
              executionRevision: applied,
              revisionSource: 'prepared',
            },
        recordInvocation: async (input) => { captured = input; },
      },
    );
    expect(result.ok).toBe(true);
    expect(captured?.executionRevision).toBeNull();
  });
});

/**
 * entity-check step (tool-arg-referential-integrity-2026-07-19 P-002).
 * The gate that stops an agent inventing an entity id that never existed.
 */
describe('entity-check step — referential integrity for entityRef args', () => {
  afterEach(() => clearEntityResolvers());

  const potTool = (over: Partial<ProjectedTool> = {}) =>
    makeTool({ args: z.object({ pot: entityRef('pot') }), ...over } as Partial<ProjectedTool>);

  it('rejects an unknown entity BEFORE the handler runs', async () => {
    setEntityResolver('pot', async (v) => ({ unknown: v.filter((x) => x !== 'papercusp') }));
    let invoked = false;
    const tool = potTool({
      fn: async () => {
        invoked = true;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    const r = await runDispatchStack(tool, 'fix.tool', { pot: 'made-up' }, MAKE_CTX(), {});
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('invalid_input');
    expect(r.error?.message).toContain('unknown pot "made-up"');
    // The whole point: a bad reference never reaches a handler that would persist it.
    expect(invoked).toBe(false);
  });

  it('lets a value that exists through to the handler', async () => {
    setEntityResolver('pot', async (v) => ({ unknown: v.filter((x) => x !== 'papercusp') }));
    const r = await runDispatchStack(potTool(), 'fix.tool', { pot: 'papercusp' }, MAKE_CTX(), {});
    expect(r.ok).toBe(true);
  });

  it('surfaces the nearest match in the denial (the --model UX, generalized)', async () => {
    setEntityResolver('pot', async (v) => ({ unknown: v, suggestions: { papercsp: ['papercusp'] } }));
    const r = await runDispatchStack(potTool(), 'fix.tool', { pot: 'papercsp' }, MAKE_CTX(), {});
    expect(r.error?.message).toContain('did you mean `papercusp`');
  });

  // Fail-open contract — the DB's foreign keys are the authoritative backstop,
  // so a lookup outage must never take down every tool that names an entity.
  it('FAILS OPEN when the resolver throws', async () => {
    setEntityResolver('pot', async () => {
      throw new Error('pg down');
    });
    const r = await runDispatchStack(potTool(), 'fix.tool', { pot: 'anything' }, MAKE_CTX(), {});
    expect(r.ok).toBe(true);
  });

  it('FAILS OPEN when the kind has no registered resolver', async () => {
    const r = await runDispatchStack(potTool(), 'fix.tool', { pot: 'anything' }, MAKE_CTX(), {});
    expect(r.ok).toBe(true);
  });

  it('a soft ref warns rather than rejecting (staged rollout)', async () => {
    setEntityResolver('pot', async (v) => ({ unknown: v }));
    const tool = makeTool({
      args: z.object({ pot: entityRef('pot', { soft: true }) }),
    } as Partial<ProjectedTool>);
    const log = vi.fn();
    const r = await runDispatchStack(tool, 'fix.tool', { pot: 'nope' }, MAKE_CTX({ log }), {});
    expect(r.ok).toBe(true);
    // A soft violation nobody can SEE makes the staged rollout unmeasurable —
    // it must be observable, otherwise flipping the ref hard is a guess.
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unknown pot "nope"'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('soft'));
  });

  it('is a no-op for a tool with no entity refs', async () => {
    const fn = vi.fn(async (v: readonly string[]) => ({ unknown: [...v] }));
    setEntityResolver('pot', fn);
    const tool = makeTool({ args: z.object({ n: z.number() }) } as Partial<ProjectedTool>);
    const r = await runDispatchStack(tool, 'fix.tool', { n: 1 }, MAKE_CTX(), {});
    expect(r.ok).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });
});
