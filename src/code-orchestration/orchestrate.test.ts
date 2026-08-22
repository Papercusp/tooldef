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

  describe('P-027 explicit final media result', () => {
    it('extracts validated image/audio blocks while preserving the authored summary', async () => {
      const r = await runToolOrchestration(
        `return {
          summary: { rendered: 2, kept: true },
          media: [
            { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            { type: 'audio', data: 'd29ybGQ=', mimeType: 'audio/mpeg' }
          ]
        };`,
        { ctx: MAKE_CTX(), deps: DEPS, tools: [] },
      );

      expect(r.ok).toBe(true);
      expect(r.summary).toEqual({ rendered: 2, kept: true });
      expect(r.media).toEqual([
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        { type: 'audio', data: 'd29ybGQ=', mimeType: 'audio/mpeg' },
      ]);
    });

    it.each([
      ['missing summary', `return { media: [] };`, 'must include a summary field'],
      ['non-array media', `return { summary: true, media: 'nope' };`, 'media must be an array'],
      [
        'invalid base64',
        `return { summary: true, media: [{ type: 'image', data: 'not base64!', mimeType: 'image/png' }] };`,
        'data must be non-empty canonical base64',
      ],
      [
        'mismatched MIME family',
        `return { summary: true, media: [{ type: 'audio', data: 'YQ==', mimeType: 'image/png' }] };`,
        'mimeType must match its audio content type',
      ],
      [
        'unsupported content type',
        `return { summary: true, media: [{ type: 'resource', data: 'YQ==', mimeType: 'text/plain' }] };`,
        'type must be "image" or "audio"',
      ],
    ])('rejects %s instead of emitting it', async (label, script, expectedError) => {
      const r = await runToolOrchestration(script, { ctx: MAKE_CTX(), deps: DEPS, tools: [] });

      expect(r.ok).toBe(false);
      if (label === 'missing summary') expect(r.summary).toBeUndefined();
      else expect(r.summary).toBe(true);
      expect(r.media).toBeUndefined();
      expect(r.error).toContain(expectedError);
    });

    it('does not implicitly emit media returned by an intermediate tool call', async () => {
      const preview = mkTool('assets:preview', 'read', async () => ({
        content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      }));
      const r = await runToolOrchestration(
        `await tools.assets.preview({}); return { inspected: true };`,
        { ctx: MAKE_CTX(), deps: DEPS, tools: [preview] },
      );

      expect(r.ok).toBe(true);
      expect(r.summary).toEqual({ inspected: true });
      expect(r.media).toBeUndefined();
    });

    it('does not reinterpret a legacy summary object without a media field', async () => {
      const r = await runToolOrchestration(
        `return { summary: { still: 'nested' }, count: 1 };`,
        { ctx: MAKE_CTX(), deps: DEPS, tools: [] },
      );

      expect(r.ok).toBe(true);
      expect(r.summary).toEqual({ summary: { still: 'nested' }, count: 1 });
      expect(r.media).toBeUndefined();
    });
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
    expect(r.okFalseMutations).toEqual([]);
    expect(r.partial).toBe(false); // EI-7784: no rejected write ⇒ not partial
  });

  // EI-7669: a write-effect call can dispatch fine (no throw — realDispatch only throws on a
  // dispatch-level failure) yet report its OWN semantic rejection (ok: false in its result body,
  // e.g. work_items:set_state's completion-integrity check). A script that doesn't inspect every
  // individual result (the reported bug: 8 batched set_state calls all rejected ok:false, the
  // script counted all 8 as closed) must still get this surfaced structurally.
  it('a write-effect call that resolves with ok:false (without throwing) is tallied in okFalseMutations', async () => {
    const setState = mkTool('wi:set-state', 'write', async (a) =>
      json({ ok: false, error: 'completion_integrity_required', id: (a as { id: string }).id }),
    );
    const r = await runToolOrchestration(
      `const results = [];
       for (const id of ['A', 'B']) { results.push(await tools.wi.setState({ id })); }
       return { closedCount: results.length };`, // the script never checks .ok — mirrors the reported bug
      { ctx: MAKE_CTX(), deps: DEPS, tools: [setState] },
    );
    expect(r.ok).toBe(true); // the script itself completes normally — no throw
    expect((r.summary as { closedCount: number }).closedCount).toBe(2); // the script's own (wrong) count
    const okFalseMutations = r.okFalseMutations ?? [];
    expect(okFalseMutations).toHaveLength(2); // but the orchestrator caught both rejections
    expect(okFalseMutations.map((m) => m.tool)).toEqual(['wi:set-state', 'wi:set-state']);
    expect(okFalseMutations[0].result).toMatchObject({ ok: false, error: 'completion_integrity_required' });
    // EI-7784: `ok` alone stays misleadingly true (the script didn't throw) — `partial` is the
    // SEPARATE, always-populated signal that a caller checking only `ok` would otherwise miss.
    expect(r.partial).toBe(true);
    expect(r.childFailures).toEqual([
      expect.objectContaining({ tool: 'wi:set-state', kind: 'semantic' }),
      expect.objectContaining({ tool: 'wi:set-state', kind: 'semantic' }),
    ]);
  });

  it('a read call returning ok:false makes an otherwise successful script partial', async () => {
    const read = mkTool('dev:pg-query', 'read', async () => json({ ok: false, error: 'bad_sql' }));
    const r = await runToolOrchestration(
      `await tools.dev.pgQuery({ sql: 'bad' }); return { inspected: true };`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [read] },
    );
    expect(r.ok).toBe(true);
    expect(r.partial).toBe(true);
    expect(r.childFailures).toEqual([
      expect.objectContaining({ tool: 'dev:pg-query', kind: 'semantic' }),
    ]);
  });

  // EI-18664105352441219: the house bulk-envelope contract (_bulk.ts's runBulk/bulkContent)
  // ALWAYS returns a top-level `ok: true` ("the batch ran") even when every individual item
  // failed — `counts.failed` is where per-item truth lives. plans:add-item against a
  // non-existent plan is the reported case: `{ ok:true, results:[{ ok:false, error:'not_found' }],
  // counts:{ ok:0, failed:1 } }`. Without bulk-envelope awareness, isOkFalseResult (top-level
  // `ok` only) never sees this as a failure, so a batched write that failed for every item reads
  // as a clean, fully-landed mutation.
  it('a write-effect call returning a bulk envelope with a per-item failure is tallied in okFalseMutations, even though the envelope\'s own top-level ok is true', async () => {
    const addItem = mkTool('plans:add-item', 'write', async () =>
      json({ ok: true, results: [{ ok: false, slug: 'missing-plan', error: 'not_found' }], counts: { ok: 0, failed: 1 } }),
    );
    const r = await runToolOrchestration(
      `const res = await tools.plans.addItem({ slug: 'missing-plan', phase: 'Phase 1', text: 't', importance: 'normal' });
       return { addItemOk: res.ok };`, // the script's own (misleadingly-true) top-level ok check
      { ctx: MAKE_CTX(), deps: DEPS, tools: [addItem] },
    );
    expect(r.ok).toBe(true);
    expect((r.summary as { addItemOk: boolean }).addItemOk).toBe(true); // the script's own wrong read
    const okFalseMutations = r.okFalseMutations ?? [];
    expect(okFalseMutations).toHaveLength(1);
    expect(okFalseMutations[0]?.tool).toBe('plans:add-item');
    expect(r.partial).toBe(true); // EI-7784: the structural signal a top-level-ok check misses
    expect(r.childFailures).toEqual([
      expect.objectContaining({ tool: 'plans:add-item', kind: 'semantic' }),
    ]);
  });

  it('a bulk envelope with zero per-item failures is NOT tallied as a semantic failure', async () => {
    const addItem = mkTool('plans:add-item', 'write', async () =>
      json({ ok: true, results: [{ ok: true, slug: 's', itemId: 'P-001' }], counts: { ok: 1, failed: 0 } }),
    );
    const r = await runToolOrchestration(
      `await tools.plans.addItem({ slug: 's', phase: 'Phase 1', text: 't', importance: 'normal' }); return 'done';`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [addItem] },
    );
    expect(r.okFalseMutations).toEqual([]);
    expect(r.partial).toBe(false);
  });

  it('dryRun never populates okFalseMutations — write-effect calls are not executed', async () => {
    const setState = mkTool('wi:set-state', 'write', async () => json({ ok: false, error: 'nope' }));
    const r = await runToolOrchestration(
      `await tools.wi.setState({ id: 'A' }); return 'done';`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [setState], dryRun: true },
    );
    expect(r.okFalseMutations).toEqual([]);
    expect(r.partial).toBe(false); // EI-7784: nothing executed under dryRun ⇒ never partial
  });

  // F8 / autonomous-loop-hardening H2 — an unknown tool ref used to fail the WHOLE run at
  // parse-check, before any good call ran, forcing a full re-run. Now the script RUNS, the unknown
  // ref rejects only when CALLED (isolable), and `unknownRefs` is still surfaced as an advisory.
  it('a good call still runs when a SIBLING ref is unknown — unknown rejects per-call (F8/H2)', async () => {
    const listFn = vi.fn(async () => json({ items: [{ id: 1 }] }));
    const list = mkTool('wi:list', 'read', listFn);
    const r = await runToolOrchestration(
      `const l = await tools.wi.list({});
       let badErr = null;
       try { await tools.system.admin({}); } catch (e) { badErr = String((e && e.message) || e); }
       return { items: l.items.length, badErr };`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [list] },
    );
    expect(r.ok).toBe(true);
    expect(listFn).toHaveBeenCalledOnce(); // the good call executed (not nuked before running)
    expect((r.summary as { items: number }).items).toBe(1);
    expect((r.summary as { badErr: string }).badErr).toContain('not available in this sandbox');
    expect(r.unknownRefs).toContain('system.admin'); // still surfaced as an advisory
  });

  it('an unknown ref in an UNREACHED branch is a no-op — the run succeeds (F8)', async () => {
    const list = mkTool('wi:list', 'read', async () => json({ items: [] }));
    const r = await runToolOrchestration(
      `const l = await tools.wi.list({});
       if (l.items.length > 0) { await tools.system.admin({}); }
       return { n: l.items.length };`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [list] },
    );
    expect(r.ok).toBe(true);
    expect((r.summary as { n: number }).n).toBe(0);
    expect(r.unknownRefs).toContain('system.admin');
  });

  it('an UNCAUGHT unknown ref still fails the run, with the advisory to fix it (F8)', async () => {
    const list = mkTool('wi:list', 'read', async () => json({ items: [{ id: 1 }] }));
    const r = await runToolOrchestration(
      `await tools.wi.list({}); await tools.system.admin({}); return 'done';`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [list] },
    );
    expect(r.ok).toBe(false);
    expect(r.unknownRefs).toContain('system.admin');
    expect(r.error).toContain('not available in this sandbox');
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

describe('runToolOrchestration (WI-1411 — wrapDispatch, per-inner-call context rebinding)', () => {
  it('wrapDispatch is invoked for EVERY inner call, with that call\'s own tool/name/args, and its next(callCtx) result is what the script sees', async () => {
    const calls: Array<{ toolName: string; args: unknown; ctxWs: string | undefined }> = [];
    const list = mkTool('wi:list', 'read', async () => json({ items: [{ id: 1 }, { id: 2 }] }));
    const get = mkTool('wi:get', 'read', async (a) => json({ id: (a as { id: number }).id }));
    const r = await runToolOrchestration(
      `const l = await tools.wi.list({});
       const got = [];
       for (const w of l.items) got.push(await tools.wi.get({ id: w.id }));
       return got;`,
      {
        ctx: MAKE_CTX({ workspaceId: 'ws-outer' }),
        deps: DEPS,
        tools: [list, get],
        wrapDispatch: async (tool, toolName, args, ctx, next) => {
          calls.push({ toolName, args, ctxWs: ctx.workspaceId });
          // Rebind: every inner call is redirected to a DIFFERENT (fixture)
          // workspace, proving the hook's `next(callCtx)` — not the original
          // fixed `ctx` — is what actually reaches the dispatcher.
          return next({ ...ctx, workspaceId: `${ctx.workspaceId}-rebound` } as typeof ctx);
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.toolName)).toEqual(['wi:list', 'wi:get', 'wi:get']);
    expect(calls.every((c) => c.ctxWs === 'ws-outer')).toBe(true); // wrapDispatch always sees the ORIGINAL ctx
    expect(r.summary).toEqual([{ id: 1 }, { id: 2 }]); // next(callCtx) result still flows through correctly
  });

  it('a write-effect call under dryRun is recorded WITHOUT reaching wrapDispatch (the dryRun gate short-circuits before dispatch)', async () => {
    const wrapDispatch = vi.fn(async (_tool, _name, _args, ctx, next) => next(ctx));
    const setStatus = mkTool('wi:set-status', 'write', vi.fn());
    const r = await runToolOrchestration(`await tools.wi.setStatus({ id: 1 }); return 'ok';`, {
      ctx: MAKE_CTX(),
      deps: DEPS,
      tools: [setStatus],
      dryRun: true,
      wrapDispatch,
    });
    expect(r.ok).toBe(true);
    expect(r.plannedMutations).toEqual([{ tool: 'wi:set-status', args: { id: 1 } }]);
    expect(wrapDispatch).not.toHaveBeenCalled(); // recorded-not-executed short-circuit precedes wrapDispatch
  });
});

/**
 * P-012 (census double-count): dispatchCount = how many times the script ENTERED the
 * host dispatcher, i.e. the number of inner tool_invocations rows the run produced.
 * The exact-number assertions are the falsifiability control: a counter that always
 * reports 0, or that counts dryRun-skipped writes, fails these cases in opposite
 * directions.
 */
describe('runToolOrchestration → dispatchCount (P-012)', () => {
  it('counts every dispatched call — reads and writes alike', async () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const list = mkTool('wi:list', 'read', async () => json({ items }));
    const get = mkTool('wi:get', 'read', async (a) => json({ id: (a as { id: number }).id }));
    const r = await runToolOrchestration(
      `const l = await tools.wi.list({});
       for (const w of l.items) await tools.wi.get({ id: w.id });
       return l.items.length;`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [list, get] },
    );
    expect(r.ok).toBe(true);
    expect(r.dispatchCount).toBe(4); // 1 list + 3 gets
  });

  it('a pure-compute script (no tool calls) reports 0 — the wrapper row stays countable', async () => {
    const r = await runToolOrchestration(`return 1 + 1;`, {
      ctx: MAKE_CTX(),
      deps: DEPS,
      tools: [],
    });
    expect(r.ok).toBe(true);
    expect(r.dispatchCount).toBe(0);
  });

  it('a dryRun-skipped write is NOT counted (it never dispatched), but reads still are', async () => {
    const list = mkTool('wi:list', 'read', async () => json({ items: [{ id: 1 }] }));
    const setStatus = mkTool('wi:set-status', 'write', vi.fn());
    const r = await runToolOrchestration(
      `const l = await tools.wi.list({});
       for (const w of l.items) await tools.wi.setStatus({ id: w.id });
       return 'ok';`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [list, setStatus], dryRun: true },
    );
    expect(r.ok).toBe(true);
    expect(r.dispatchCount).toBe(1); // the read only — the recorded-not-executed write adds no row
  });

  it('a throwing dispatched call still counts (its row exists, status notwithstanding)', async () => {
    const boom = mkTool('wi:boom', 'read', async () => {
      throw new Error('boom');
    });
    const r = await runToolOrchestration(
      `try { await tools.wi.boom({}); } catch {} return 'survived';`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [boom] },
    );
    expect(r.ok).toBe(true);
    expect(r.dispatchCount).toBe(1);
  });

  it('an unknown-ref stub rejection is NOT counted — the stub throws before the dispatcher', async () => {
    const r = await runToolOrchestration(
      `try { await tools.nope.thing({}); } catch {} return 'survived';`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [] },
    );
    expect(r.ok).toBe(true);
    expect(r.dispatchCount).toBe(0);
  });
});

describe('runToolOrchestration → callRecords (P-013)', () => {
  it('records only secret-free call identity, disposition, and validated output references', async () => {
    const referenced = mkTool('assets:render', 'read', async () =>
      json({
        ok: true,
        credential: 'must-not-enter-the-trace',
        output: {
          kind: 'reference',
          uri: 'papercusp://results/run-1/output.json',
          byteCount: 42,
          sha256: 'a'.repeat(64),
          preview: 'sensitive preview text',
          owner: 'su-ephemeral',
          audience: 'workspace',
        },
      }),
    );

    const r = await runToolOrchestration(
      `await tools.assets.render({ apiKey: 'must-not-enter-the-trace' }); return 'ok';`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [referenced] },
    );

    expect(r.callRecords).toEqual([
      {
        ordinal: 0,
        tool: 'assets:render',
        effect: 'read',
        disposition: 'settled',
        outputReferences: [
          {
            uri: 'papercusp://results/run-1/output.json',
            byteCount: 42,
            sha256: 'a'.repeat(64),
            audience: 'workspace',
          },
        ],
      },
    ]);
    expect(JSON.stringify(r.callRecords)).not.toContain('apiKey');
    expect(JSON.stringify(r.callRecords)).not.toContain('credential');
    expect(JSON.stringify(r.callRecords)).not.toContain('preview');
    expect(JSON.stringify(r.callRecords)).not.toContain('owner');
  });

  it('preserves actual dispatch order and truthful dry-run/semantic/throw dispositions', async () => {
    const read = mkTool('wi:list', 'read', async () => json({ ok: true }));
    const reject = mkTool('wi:set-status', 'write', async () => json({ ok: false, reason: 'denied' }));
    const boom = mkTool('wi:boom', 'read', async () => {
      throw new Error('boom');
    });

    const dry = await runToolOrchestration(
      `await tools.wi.list({}); await tools.wi.setStatus({ id: 'WI-1' }); return 'preview';`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [read, reject], dryRun: true },
    );
    expect(dry.callRecords?.map(({ ordinal, tool, disposition }) => ({ ordinal, tool, disposition }))).toEqual([
      { ordinal: 0, tool: 'wi:list', disposition: 'settled' },
      { ordinal: 1, tool: 'wi:set-status', disposition: 'planned' },
    ]);

    const live = await runToolOrchestration(
      `await tools.wi.setStatus({ id: 'WI-1' }); try { await tools.wi.boom({}); } catch {} return 'done';`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [reject, boom] },
    );
    expect(live.callRecords?.map(({ ordinal, tool, disposition }) => ({ ordinal, tool, disposition }))).toEqual([
      { ordinal: 0, tool: 'wi:set-status', disposition: 'semantic_rejected' },
      { ordinal: 1, tool: 'wi:boom', disposition: 'uncertain' },
    ]);
  });
});
