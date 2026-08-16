/**
 * Behavior tests for the `preconditions` dispatch step (`requires:` — the
 * preInvoke mirror of `emits:`; autoloop-pot-operator-rebuild-2026-06-05
 * D-006). Pipeline-surface tests (ordering/enumeration) live in
 * dispatch-stack.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDispatchStack } from './dispatch-stack';
import {
  _resetProjectionRegistryForTests,
  type ProjectedTool,
  type UnifiedToolContext,
} from './tool-projection';
import type { DispatchProjectedDeps } from './dispatch-types';
import type { PreconditionFireRequest, ToolRequireSpec } from './requires';

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

const makeTool = (
  requires: readonly ToolRequireSpec[],
  over: Partial<ProjectedTool> = {},
): ProjectedTool => ({
  pluginName: 'fixture',
  description: 'fixture',
  inputSchema: { type: 'object' },
  capabilities: [],
  expose: { mcp: { name: 'fix.tool' } },
  fn: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
  requires,
  ...over,
});

afterEach(() => _resetProjectionRegistryForTests());

describe('preconditions step — reject path', () => {
  it('passes through when the condition holds (handler runs)', async () => {
    const tool = makeTool([
      { when: { 'args.slug': { exists: true } }, error: 'slug required' },
    ]);
    const res = await runDispatchStack(tool, 'fix.tool', { slug: 'x' }, MAKE_CTX(), {});
    expect(res.ok).toBe(true);
    expect(tool.fn).toHaveBeenCalledTimes(1);
  });

  it('rejects with precondition_failed when the condition fails — handler NOT invoked', async () => {
    const tool = makeTool([
      { id: 'slug-required', when: { 'args.slug': { exists: true } }, error: 'slug required' },
    ]);
    const res = await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), {});
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('precondition_failed');
    expect(res.error?.message).toBe('slug required');
    expect(res.error?.meta).toMatchObject({ tool: 'fix.tool', require: 'slug-required' });
    expect(tool.fn).not.toHaveBeenCalled();
  });

  it('audits the denial with gate "precondition"', async () => {
    const auditAuth = vi.fn();
    const tool = makeTool([
      { id: 'g', when: { 'args.slug': { exists: true } }, error: 'nope' },
    ]);
    await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), { auditAuth });
    expect(auditAuth).toHaveBeenCalledWith(
      expect.objectContaining({ gate: 'precondition', decision: 'deny', tool: 'fix.tool' }),
    );
  });

  it('evaluates over ctx too — `any` combinator over args + ctx', async () => {
    const spec: ToolRequireSpec = {
      when: {
        any: [
          { 'args.harnessSlug': { exists: true } },
          { 'ctx.harnessSlug': { exists: true } },
        ],
      },
      error: 'harness required',
    };
    // ctx carries the slug → passes with no arg.
    const viaCtx = await runDispatchStack(makeTool([spec]), 'fix.tool', {}, MAKE_CTX(), {});
    expect(viaCtx.ok).toBe(true);
    // Neither arg nor ctx → rejects.
    const neither = await runDispatchStack(
      makeTool([spec]),
      'fix.tool',
      {},
      MAKE_CTX({ harnessSlug: undefined }),
      {},
    );
    expect(neither.ok).toBe(false);
    expect(neither.error?.code).toBe('precondition_failed');
  });

  it('evaluates resolved state and fails closed when the resolver throws', async () => {
    const ok = await runDispatchStack(
      makeTool([{ when: { 'state.ready': true }, state: async () => ({ ready: true }) }]),
      'fix.tool',
      {},
      MAKE_CTX(),
      {},
    );
    expect(ok.ok).toBe(true);

    const thrown = await runDispatchStack(
      makeTool([
        {
          id: 'st',
          when: { 'state.ready': true },
          state: async () => {
            throw new Error('pg down');
          },
        },
      ]),
      'fix.tool',
      {},
      MAKE_CTX(),
      {},
    );
    expect(thrown.ok).toBe(false);
    expect(thrown.error?.code).toBe('precondition_failed');
    expect(thrown.error?.message).toContain('pg down');
  });

  it('multiple specs — the first failing spec names itself', async () => {
    const tool = makeTool([
      { id: 'a', when: { 'args.x': { exists: true } } },
      { id: 'b', when: { 'args.y': { exists: true } }, error: 'y missing' },
    ]);
    const res = await runDispatchStack(tool, 'fix.tool', { x: 1 }, MAKE_CTX(), {});
    expect(res.ok).toBe(false);
    expect(res.error?.meta?.require).toBe('b');
    expect(res.error?.message).toBe('y missing');
  });
});

describe('preconditions step — auto-correct path ({ fire, then: "retry" })', () => {
  it('fires the corrective tool, re-resolves state, and proceeds when the retry holds', async () => {
    let resumed = false;
    const fired: PreconditionFireRequest[] = [];
    const deps: DispatchProjectedDeps = {
      firePrecondition: async (req) => {
        fired.push(req);
        resumed = true; // the corrective tool "fixes" the state
      },
      auditAuth: vi.fn(),
    };
    const tool = makeTool([
      {
        id: 'loop-running',
        when: { 'state.running': true },
        state: () => ({ running: resumed }),
        fire: 'autoloop:control',
        render: (ev) => ({ op: 'resume', harness: ev.ctx.harnessSlug }),
        then: 'retry',
        error: 'autoloop not running',
      },
    ]);
    const res = await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), deps);
    expect(res.ok).toBe(true);
    expect(tool.fn).toHaveBeenCalledTimes(1);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      fire: 'autoloop:control',
      args: { op: 'resume', harness: 'sheets' },
      trigger: 'fix.tool',
      requireId: 'loop-running',
    });
    // Visible: the auto-correction is audited as an allow.
    expect(deps.auditAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: 'precondition',
        decision: 'allow',
        reason: expect.stringContaining('auto-corrected via "autoloop:control"'),
      }),
    );
  });

  it('rejects when the condition still fails after the corrective fire', async () => {
    const firePrecondition = vi.fn(async () => {
      /* fires but does not fix anything */
    });
    const tool = makeTool([
      {
        id: 'p',
        when: { 'state.running': true },
        state: () => ({ running: false }),
        fire: 'autoloop:control',
        then: 'retry',
        error: 'not running',
      },
    ]);
    const res = await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), { firePrecondition });
    expect(firePrecondition).toHaveBeenCalledTimes(1); // exactly one retry
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('precondition_failed');
    expect(res.error?.message).toContain('still failing after auto-correct');
    expect(tool.fn).not.toHaveBeenCalled();
  });

  it('fails closed when fire is declared but the host wired no fire port', async () => {
    const tool = makeTool([
      {
        id: 'p',
        when: { 'state.running': true },
        state: () => ({ running: false }),
        fire: 'autoloop:control',
        then: 'retry',
      },
    ]);
    const res = await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), {});
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('precondition_failed');
    expect(res.error?.message).toContain('no firePrecondition port');
    expect(tool.fn).not.toHaveBeenCalled();
  });

  it('fails closed when the corrective fire throws', async () => {
    const tool = makeTool([
      {
        id: 'p',
        when: { 'state.running': true },
        state: () => ({ running: false }),
        fire: 'autoloop:control',
        then: 'retry',
      },
    ]);
    const res = await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), {
      firePrecondition: async () => {
        throw new Error('dispatch refused');
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('precondition_failed');
    expect(res.error?.message).toContain('dispatch refused');
    expect(tool.fn).not.toHaveBeenCalled();
  });

  it('does not fire when the condition already holds', async () => {
    const firePrecondition = vi.fn(async () => {});
    const tool = makeTool([
      {
        when: { 'state.running': true },
        state: () => ({ running: true }),
        fire: 'autoloop:control',
        then: 'retry',
      },
    ]);
    const res = await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), { firePrecondition });
    expect(res.ok).toBe(true);
    expect(firePrecondition).not.toHaveBeenCalled();
  });
});

describe('preconditions step — no requires declared', () => {
  it('is a no-op for tools without requires', async () => {
    const tool: ProjectedTool = {
      pluginName: 'fixture',
      description: 'fixture',
      inputSchema: { type: 'object' },
      capabilities: [],
      expose: { mcp: { name: 'fix.tool' } },
      fn: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
    };
    const res = await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), {});
    expect(res.ok).toBe(true);
  });
});
