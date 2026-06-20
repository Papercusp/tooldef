import { describe, it, expect, vi } from 'vitest';
import { runToolOrchestration } from './orchestrate';
import type { ProjectedTool, UnifiedToolContext } from '../tool-projection';
import type { DispatchProjectedDeps } from '../dispatch-types';

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
const json = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

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
