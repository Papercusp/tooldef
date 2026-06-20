import { describe, it, expect, vi } from 'vitest';
import { runToolOrchestration } from './orchestrate';
import type { ProjectedTool, UnifiedToolContext } from '../tool-projection';
import type { DispatchProjectedDeps } from '../dispatch-types';
import type { ToolResult } from '../wire';

const MAKE_CTX = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    emit: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'h',
    role: 'worker',
    runId: 'run_X',
    ...over,
  }) as unknown as UnifiedToolContext;

const DEPS: DispatchProjectedDeps = {};
const json = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

const mkTool = (
  name: string,
  effect: 'read' | 'write',
  fn: ProjectedTool['fn'],
): ProjectedTool =>
  ({
    pluginName: 'fix',
    description: name,
    inputSchema: { type: 'object' },
    capabilities: [],
    effect,
    expose: { mcp: { name } },
    fn,
  }) as unknown as ProjectedTool;

describe('runToolOrchestration (B-CX-2A — code:run core, real dispatcher)', () => {
  it('runs a multi-step script through the REAL dispatcher and returns only the summary', async () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const list = mkTool('wi:list', 'read', async () => json({ items }));
    const get = mkTool('wi:get', 'read', async (a) =>
      json({ id: (a as { id: number }).id, ok: (a as { id: number }).id !== 2 }),
    );
    const r = await runToolOrchestration(
      `const l = await tools.wi.list({});
       const bad = [];
       for (const w of l.items) { const d = await tools.wi.get({ id: w.id }); if (!d.ok) bad.push(d.id); }
       return { scanned: l.items.length, bad };`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [list, get] },
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({ scanned: 3, bad: [2] }); // 4 tool calls collapsed into ONE code:run
  });

  it('dryRun RECORDS write-effect calls without executing them; reads still run', async () => {
    const readFn = vi.fn(async () => json({ items: [{ id: 1 }] }));
    const writeFn = vi.fn(async () => json({ ok: true }));
    const list = mkTool('wi:list', 'read', readFn);
    const setStatus = mkTool('wi:set-status', 'write', writeFn);
    const r = await runToolOrchestration(
      `const l = await tools.wi.list({});
       for (const w of l.items) await tools.wi.setStatus({ id: w.id, status: 'done' });
       return { processed: l.items.length };`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [list, setStatus], dryRun: true },
    );
    expect(r.ok).toBe(true);
    expect(readFn).toHaveBeenCalledOnce(); // read executed
    expect(writeFn).not.toHaveBeenCalled(); // write NOT executed under dryRun
    expect(r.plannedMutations).toEqual([{ tool: 'wi:set-status', args: { id: 1, status: 'done' } }]);
  });

  it('without dryRun, write-effect calls execute (and are still recorded for audit)', async () => {
    const writeFn = vi.fn(async () => json({ ok: true }));
    const setStatus = mkTool('wi:set-status', 'write', writeFn);
    const r = await runToolOrchestration(
      `await tools.wi.setStatus({ id: 1 }); return 'done';`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [setStatus] },
    );
    expect(r.ok).toBe(true);
    expect(writeFn).toHaveBeenCalledOnce();
    expect(r.plannedMutations).toEqual([{ tool: 'wi:set-status', args: { id: 1 } }]);
  });

  it('parse-check rejects a script referencing an unavailable tool before running anything', async () => {
    const list = mkTool('wi:list', 'read', vi.fn());
    const r = await runToolOrchestration(`await tools.system.admin({});`, {
      ctx: MAKE_CTX(),
      deps: DEPS,
      tools: [list],
    });
    expect(r.ok).toBe(false);
    expect(r.unknownRefs).toContain('system.admin');
  });
});

describe('runToolOrchestration (B-CX-DEPS — host deps threaded into inner calls)', () => {
  it('records EACH inner tool call via deps.recordInvocation (inner calls are visible to spend/telemetry)', async () => {
    const recorded: Array<{ toolName: string; status: string; windowKey: string }> = [];
    const deps: DispatchProjectedDeps = {
      recordInvocation: async (input) => {
        recorded.push({ toolName: input.toolName, status: input.status, windowKey: input.windowKey });
      },
    };
    const items = [{ id: 1 }, { id: 2 }];
    const list = mkTool('wi:list', 'read', async () => json({ items }));
    const get = mkTool('wi:get', 'read', async (a) => json({ id: (a as { id: number }).id }));
    const r = await runToolOrchestration(
      `const l = await tools.wi.list({});
       for (const w of l.items) await tools.wi.get({ id: w.id });
       return { scanned: l.items.length };`,
      { ctx: MAKE_CTX({ runId: 'run_DEPS' }), deps, tools: [list, get] },
    );
    expect(r.ok).toBe(true);
    // 1 list + 2 gets = 3 inner dispatches, every one telemetry-logged with status 'ok'
    // and the ctx-derived window key — NOT invisible like the old deps:{} path.
    expect(recorded.filter((x) => x.toolName === 'wi:list')).toHaveLength(1);
    expect(recorded.filter((x) => x.toolName === 'wi:get')).toHaveLength(2);
    expect(recorded.every((x) => x.status === 'ok')).toBe(true);
    expect(recorded.every((x) => x.windowKey === 'run:run_DEPS')).toBe(true);
  });

  it('an envelope-DENIED tool throws inside the script (and its handler never runs)', async () => {
    const allowedFn = vi.fn(async () => json({ ok: true }));
    const deniedFn = vi.fn(async () => json({ shouldNotRun: true }));
    const allowed = mkTool('wi:list', 'read', allowedFn);
    const denied = mkTool('wi:danger', 'read', deniedFn);
    const deps: DispatchProjectedDeps = {
      checkCapabilityEnvelope: ({ toolName }) =>
        toolName === 'wi:danger'
          ? { decision: 'deny', posture: 'rejected', applied: true, reason: 'outside envelope (test)' }
          : { decision: 'allow', posture: 'auto', applied: true },
    };
    // The denied inner call throws; the script catches it, proving it surfaces INSIDE the runtime.
    const r = await runToolOrchestration(
      `await tools.wi.list({});
       try { await tools.wi.danger({}); return { threw: false }; }
       catch (e) { return { threw: true, msg: String(e && e.message || e) }; }`,
      { ctx: MAKE_CTX(), deps, tools: [allowed, denied] },
    );
    expect(r.ok).toBe(true);
    const summary = r.summary as { threw: boolean; msg: string };
    expect(summary.threw).toBe(true);
    expect(summary.msg).toContain('capability_denied');
    expect(allowedFn).toHaveBeenCalledOnce(); // allowed tool ran
    expect(deniedFn).not.toHaveBeenCalled(); // envelope short-circuited before invoke
  });

  it('an UNCAUGHT envelope denial fails the whole run (no silent pass-through)', async () => {
    const denied = mkTool('wi:danger', 'read', vi.fn());
    const deps: DispatchProjectedDeps = {
      checkCapabilityEnvelope: () => ({
        decision: 'deny',
        posture: 'rejected',
        applied: true,
        reason: 'outside envelope (test)',
      }),
    };
    const r = await runToolOrchestration(`await tools.wi.danger({}); return 'unreachable';`, {
      ctx: MAKE_CTX(),
      deps,
      tools: [denied],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('capability_denied');
  });
});
