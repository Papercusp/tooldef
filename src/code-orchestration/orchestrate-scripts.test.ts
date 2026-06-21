/**
 * code-execution-tool-orchestration — FUNCTIONAL ACCEPTANCE SUITE.
 *
 * "Create a bunch of scripts; make sure they actually run like they're supposed to." This file is
 * the realistic-agent-workflow acceptance suite for `code:run`: each test is a script an agent would
 * plausibly write, run end-to-end through `runToolOrchestration` against the REAL dispatcher binding
 * (B-CX-DEPS) with fixture tools, asserting the FEATURE's contract — not the engine internals
 * (those have focused unit coverage in orchestrate.test.ts / run-script.test.ts / parse-check.test.ts).
 *
 * The three invariants every test pins:
 *   1. CONTROL FLOW WORKS — loops / branches / filters / retries / fan-out over N items run in ONE call.
 *   2. ONLY THE SUMMARY RETURNS — large intermediate payloads stay in the runtime; the returned value
 *      is the compact thing the agent asked for (the token win the whole feature exists for).
 *   3. WRITES ARE GATED — dryRun records effect:'write' calls (plannedMutations) without executing;
 *      a committing run executes them, in order.
 */
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
    harnessSlug: 'papercusp',
    role: 'worker',
    runId: 'run_scripts',
    ...over,
  }) as unknown as UnifiedToolContext;

const DEPS: DispatchProjectedDeps = {};
const json = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

const mkTool = (name: string, effect: 'read' | 'write', fn: ProjectedTool['fn']): ProjectedTool =>
  ({
    pluginName: 'fix',
    description: name,
    inputSchema: { type: 'object' },
    capabilities: [],
    effect,
    expose: { mcp: { name } },
    fn,
  }) as unknown as ProjectedTool;

/** Shorthand: run a script with a tool set + options, return the OrchestrateResult. */
const run = (
  script: string,
  tools: ProjectedTool[],
  opts: { dryRun?: boolean; timeoutMs?: number; ctx?: Partial<UnifiedToolContext>; deps?: DispatchProjectedDeps } = {},
) =>
  runToolOrchestration(script, {
    ctx: MAKE_CTX(opts.ctx),
    deps: opts.deps ?? DEPS,
    tools,
    ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

// ───────────────────────────────────────────────────────────────────────────
// 1. The canonical "list then act per item" loop — the headline use case.
// ───────────────────────────────────────────────────────────────────────────
describe('code:run acceptance — list-then-act-per-item loops', () => {
  it('"scan every open work item, return only the blocked ids" (loop + filter + compact return)', async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ id: `WI-${i}` }));
    const calls: string[] = [];
    const list = mkTool('work_items:list', 'read', async () => {
      calls.push('list');
      return json({ items });
    });
    const get = mkTool('work_items:get', 'read', async (a) => {
      const id = (a as { id: string }).id;
      calls.push(`get:${id}`);
      const n = Number(id.split('-')[1]);
      return json({ id, state: n % 4 === 0 ? 'blocked' : 'open' });
    });
    const r = await run(
      `const l = await tools.work_items.list({ status: 'open' });
       const blocked = [];
       for (const w of l.items) {
         const d = await tools.work_items.get({ id: w.id });
         if (d.state === 'blocked') blocked.push(d.id);
       }
       return { scanned: l.items.length, blocked };`,
      [list, get],
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({ scanned: 12, blocked: ['WI-0', 'WI-4', 'WI-8'] });
    // 1 list + 12 gets = 13 real tool calls, all in ONE code:run (1 inference round-trip vs 13).
    expect(calls).toHaveLength(13);
  });

  it('per-item try/catch — one failing item does not abort the rest', async () => {
    const items = [{ id: 'a' }, { id: 'BOOM' }, { id: 'c' }];
    const list = mkTool('work_items:list', 'read', async () => json({ items }));
    const get = mkTool('work_items:get', 'read', async (a) => {
      const id = (a as { id: string }).id;
      if (id === 'BOOM') throw new Error('synthetic per-item failure');
      return json({ id, ok: true });
    });
    const r = await run(
      `const l = await tools.work_items.list({});
       const ok = []; const failed = [];
       for (const w of l.items) {
         try { const d = await tools.work_items.get({ id: w.id }); ok.push(d.id); }
         catch (e) { failed.push({ id: w.id, err: String(e.message || e) }); }
       }
       return { ok, failed };`,
      [list, get],
    );
    expect(r.ok).toBe(true);
    const s = r.summary as { ok: string[]; failed: Array<{ id: string; err: string }> };
    expect(s.ok).toEqual(['a', 'c']);
    expect(s.failed).toHaveLength(1);
    expect(s.failed[0].id).toBe('BOOM');
    expect(s.failed[0].err).toContain('synthetic per-item failure');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. The token win: large intermediate data stays in the runtime.
// ───────────────────────────────────────────────────────────────────────────
describe('code:run acceptance — only the summary re-enters context', () => {
  it('a 10k-row fetch is aggregated to a tiny summary; the rows never appear in the result', async () => {
    const fetch = mkTool('db:fetch', 'read', async () =>
      json({ rows: Array.from({ length: 10_000 }, (_, i) => ({ i, v: i * 2 })) }),
    );
    const r = await run(
      `const data = await tools.db.fetch({});
       let sum = 0; for (const row of data.rows) sum += row.v;
       return { count: data.rows.length, sum, max: data.rows[data.rows.length - 1].v };`,
      [fetch],
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({ count: 10_000, sum: 99_990_000, max: 19_998 });
    // The 10k-row payload must NOT leak into the returned summary (the whole point).
    expect(JSON.stringify(r.summary).length).toBeLessThan(120);
  });

  it('fan-out reads build a compact map keyed by id (not the full objects)', async () => {
    const ids = ['p1', 'p2', 'p3', 'p4'];
    const get = mkTool('plans:get', 'read', async (a) => {
      const slug = (a as { slug: string }).slug;
      return json({ slug, bigBody: 'x'.repeat(5000), status: slug === 'p2' ? 'shipped' : 'active' });
    });
    const r = await run(
      `const ids = ${JSON.stringify(ids)};
       const statusBySlug = {};
       for (const slug of ids) { const p = await tools.plans.get({ slug }); statusBySlug[slug] = p.status; }
       return statusBySlug;`,
      [get],
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({ p1: 'active', p2: 'shipped', p3: 'active', p4: 'active' });
    expect(JSON.stringify(r.summary)).not.toContain('xxxxx'); // the 5k bodies stayed in-runtime
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Branch / conditional / retry-until — non-linear control flow.
// ───────────────────────────────────────────────────────────────────────────
describe('code:run acceptance — branching and retry control flow', () => {
  it('branches on a count threshold and only does the expensive path when warranted', async () => {
    const list = mkTool('issues:list', 'read', async () => json({ items: [{ id: 1 }, { id: 2 }] }));
    const escalate = mkTool('coord:escalate', 'write', vi.fn(async () => json({ ok: true })));
    const r = await run(
      `const l = await tools.issues.list({});
       if (l.items.length > 5) { await tools.coord.escalate({ summary: 'too many' }); return { escalated: true, n: l.items.length }; }
       return { escalated: false, n: l.items.length };`,
      [list, escalate],
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({ escalated: false, n: 2 });
    expect(r.plannedMutations).toEqual([]); // the write branch was not taken
  });

  it('retry-until: polls until a condition is met, capped, returning the attempt count', async () => {
    let n = 0;
    const probe = mkTool('dev:probe', 'read', async () => {
      n++;
      return json({ ready: n >= 3 });
    });
    const r = await run(
      `let attempts = 0; let ready = false;
       while (attempts < 10 && !ready) { attempts++; const p = await tools.dev.probe({}); ready = p.ready; }
       return { attempts, ready };`,
      [probe],
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({ attempts: 3, ready: true });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Facade surface — escape hatch + hyphenated-verb camelCasing.
// ───────────────────────────────────────────────────────────────────────────
describe('code:run acceptance — facade surface', () => {
  it('tools.call("ns:verb") escape hatch dispatches the same as tools.ns.verb', async () => {
    const fn = vi.fn(async (a) => json({ echoed: a }));
    const tool = mkTool('plans:set-now', 'write', fn);
    const r = await run(
      `const viaCall = await tools.call('plans:set-now', { slug: 's', state: 'x' });
       return { viaCall };`,
      [tool],
      { dryRun: true },
    );
    expect(r.ok).toBe(true);
    expect(r.plannedMutations).toEqual([{ tool: 'plans:set-now', args: { slug: 's', state: 'x' } }]);
  });

  it('hyphenated verbs are reachable camelCased (coord:wake-queue → tools.coord.wakeQueue)', async () => {
    const fn = vi.fn(async () => json({ staged: [] }));
    const tool = mkTool('coord:wake-queue', 'read', fn);
    const r = await run(`const q = await tools.coord.wakeQueue({ action: 'list' }); return q;`, [tool]);
    expect(r.ok).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
    expect(r.summary).toEqual({ staged: [] });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. The dry-run / commit write gate — mixed read+write scripts.
// ───────────────────────────────────────────────────────────────────────────
describe('code:run acceptance — dry-run write gate', () => {
  it('dryRun: reads execute, writes are RECORDED in order but NOT executed', async () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const readFn = vi.fn(async () => json({ items }));
    const writeFn = vi.fn(async () => json({ ok: true }));
    const list = mkTool('work_items:list', 'read', readFn);
    const setState = mkTool('work_items:set_state', 'write', writeFn);
    const r = await run(
      `const l = await tools.work_items.list({});
       for (const w of l.items) await tools.work_items.setState({ id: w.id, state: 'done' });
       return { wouldUpdate: l.items.length };`,
      [list, setState],
      { dryRun: true },
    );
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(readFn).toHaveBeenCalledOnce(); // read ran
    expect(writeFn).not.toHaveBeenCalled(); // writes did NOT run
    expect(r.plannedMutations).toEqual([
      { tool: 'work_items:set_state', args: { id: 'a', state: 'done' } },
      { tool: 'work_items:set_state', args: { id: 'b', state: 'done' } },
      { tool: 'work_items:set_state', args: { id: 'c', state: 'done' } },
    ]);
  });

  it('committing run: the SAME script now executes every write, still recording them for audit', async () => {
    const items = [{ id: 'a' }, { id: 'b' }];
    const writeFn = vi.fn(async () => json({ ok: true }));
    const list = mkTool('work_items:list', 'read', async () => json({ items }));
    const setState = mkTool('work_items:set_state', 'write', writeFn);
    const r = await run(
      `const l = await tools.work_items.list({});
       for (const w of l.items) await tools.work_items.setState({ id: w.id, state: 'done' });
       return { updated: l.items.length };`,
      [list, setState],
      { dryRun: false },
    );
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(false);
    expect(writeFn).toHaveBeenCalledTimes(2);
    expect(r.plannedMutations).toHaveLength(2); // recorded even on a committing run
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 6. Safety boundaries — the whitelist + parse-check (the security model).
// ───────────────────────────────────────────────────────────────────────────
describe('code:run acceptance — safety boundaries', () => {
  it('parse-check rejects a disallowed tool reference before ANY tool runs', async () => {
    const safeFn = vi.fn(async () => json({ ok: true }));
    const safe = mkTool('work_items:list', 'read', safeFn);
    const r = await run(`await tools.work_items.list({}); await tools.system.admin({});`, [safe]);
    expect(r.ok).toBe(false);
    expect(r.unknownRefs).toContain('system.admin');
    expect(safeFn).not.toHaveBeenCalled(); // fast-fail: nothing executed, even the allowed call
  });

  it('parse-check sees through an aliasing obfuscation to a disallowed tool', async () => {
    const safe = mkTool('work_items:list', 'read', vi.fn());
    const r = await run(
      `const t = tools; const sys = t.system; await sys.admin({});`,
      [safe],
    );
    expect(r.ok).toBe(false);
    expect(r.unknownRefs).toContain('system.admin');
  });

  it('the whitelist is the runtime boundary: a tool outside the allowed set is absent / throws', async () => {
    const allowedFn = vi.fn(async () => json({ ok: true }));
    const a = mkTool('work_items:list', 'read', allowedFn);
    const b = mkTool('secrets:exfiltrate', 'read', vi.fn());
    // `allowed` excludes secrets:exfiltrate; a dynamic call (parse-check can't resolve) hits the runtime wall.
    const r = await runToolOrchestration(
      `const name = ['secrets', 'exfiltrate'].join(':');
       try { await tools.call(name, {}); return { reached: true }; }
       catch (e) { return { reached: false, msg: String(e.message || e) }; }`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [a, b], allowed: new Set(['work_items:list']) },
    );
    expect(r.ok).toBe(true);
    const s = r.summary as { reached: boolean; msg: string };
    expect(s.reached).toBe(false);
    expect(s.msg).toMatch(/not available/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 7. Robustness — timeout kill + non-serializable guard.
// ───────────────────────────────────────────────────────────────────────────
describe('code:run acceptance — robustness', () => {
  it('a runaway synchronous loop is killed at the timeout (the host is never frozen)', async () => {
    const start = Date.now();
    const r = await run(`while (true) {}`, [], { timeoutMs: 300 });
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/script_timeout/);
    expect(elapsed).toBeLessThan(3000); // terminated near the bound, not hung
  });

  it('an uncaught error from a tool fails the run with the message (no silent swallow)', async () => {
    const boom = mkTool('svc:go', 'read', async () => {
      throw new Error('downstream 500');
    });
    const r = await run(`return await tools.svc.go({});`, [boom]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/downstream 500/);
  });
});
