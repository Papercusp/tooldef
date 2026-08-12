/**
 * P-020 (fleet-leadership-continuity-and-actuation-2026-08-01) — `detectStrandedWrites`.
 *
 * A thrown call unwinds the vm, so every call written after it never dispatches. Those are
 * invisible to plannedMutations/rejected/uncertain (all recorded AT dispatch), so the result
 * can truthfully say "nothing was written" while omitting that a trailing
 * `work_items:checkpoint` never happened.
 *
 * The contract under test is deliberately CONSERVATIVE: report only what is provable. The
 * neighbouring warning had to be de-cry-wolfed once already (EI-10951) for claiming more than
 * it knew; the negative cases below are what keep this one from repeating that.
 *
 * PURE — no vm, no PG, no dispatcher.
 */
import { describe, expect, it, vi } from 'vitest';
import { detectStrandedWrites, runToolOrchestration } from './orchestrate';
import type { StaticToolCall } from './parse-check';
import type { ProjectedTool, UnifiedToolContext } from '../tool-projection';
import type { DispatchProjectedDeps } from '../dispatch-types';
import type { ToolResult } from '../wire';

const DEPS: DispatchProjectedDeps = {};

// Uses the REAL ProjectedTool shape (`expose.mcp.name`) — deliberately, not a `{ name }`
// convenience fixture. The first version of this file invented a top-level `name`, so the unit
// tests passed against a tool shape that does not exist while the detector was a no-op in
// production. A fixture that is easier to write than the real thing is how that ships green.
const tool = (name: string, effect: 'read' | 'write'): ProjectedTool =>
  ({ expose: { mcp: { name } }, effect }) as unknown as ProjectedTool;

const TOOLS: ProjectedTool[] = [
  tool('sessions:read', 'read'),
  tool('work_items:list', 'read'),
  tool('work_items:checkpoint', 'write'),
  tool('facts:assert', 'write'),
  tool('work_items:complete', 'write'),
];

const calls = (...names: string[]): StaticToolCall[] =>
  names.map((n) => ({ tool: n, args: null, dynamicArgs: false }));

describe('detectStrandedWrites (P-020)', () => {
  it('names a write that was ordered but never dispatched — the motivating case', () => {
    // Script: a read throws on an arg typo, so the checkpoint written after it never runs.
    const stranded = detectStrandedWrites(
      calls('sessions:read', 'work_items:checkpoint'),
      TOOLS,
      [], // nothing dispatched: the read threw first
    );
    expect(stranded).toEqual(['work_items:checkpoint']);
  });

  it('ignores READS that never ran — re-running a read costs nothing', () => {
    const stranded = detectStrandedWrites(calls('sessions:read', 'work_items:list'), TOOLS, []);
    expect(stranded).toEqual([]);
  });

  it('omits a write that dispatched at least once (a loop/branch may have run only some)', () => {
    const stranded = detectStrandedWrites(
      calls('work_items:checkpoint', 'facts:assert'),
      TOOLS,
      ['work_items:checkpoint'],
    );
    expect(stranded).toEqual(['facts:assert']);
  });

  it('reports several stranded writes in SOURCE order', () => {
    const stranded = detectStrandedWrites(
      calls('sessions:read', 'facts:assert', 'work_items:checkpoint'),
      TOOLS,
      [],
    );
    expect(stranded).toEqual(['facts:assert', 'work_items:checkpoint']);
  });

  it('dedupes a write called from several source sites', () => {
    const stranded = detectStrandedWrites(
      calls('facts:assert', 'facts:assert', 'facts:assert'),
      TOOLS,
      [],
    );
    expect(stranded).toEqual(['facts:assert']);
  });

  it('claims nothing when every ordered write dispatched', () => {
    const stranded = detectStrandedWrites(
      calls('work_items:checkpoint', 'facts:assert'),
      TOOLS,
      ['work_items:checkpoint', 'facts:assert'],
    );
    expect(stranded).toEqual([]);
  });

  it('ignores a tool absent from the projected catalog (unknown ref / dynamic dispatch)', () => {
    // `tools.call(someVariable)` is invisible to the static parse; never claim about it.
    const stranded = detectStrandedWrites(calls('nope:missing'), TOOLS, []);
    expect(stranded).toEqual([]);
  });

  it('returns empty for an empty script', () => {
    expect(detectStrandedWrites([], TOOLS, [])).toEqual([]);
  });
});

/**
 * The detector being correct proves nothing about the RESULT carrying it. These drive the real
 * `runToolOrchestration` path (parse-check → vm → dispatch → result), because a pure-unit pass
 * plus dead wiring is precisely how a fix ships green and does nothing — the failure mode
 * called out in define-tool.ts's ctx-threading warning.
 */
const MAKE_CTX = (): UnifiedToolContext =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    emit: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'h',
    role: 'worker',
    runId: 'run_X',
  }) as unknown as UnifiedToolContext;

const json = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});

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

describe('P-020 end-to-end: a real aborted run reports its stranded writes', () => {
  it('surfaces the checkpoint that never dispatched when an earlier READ throws', async () => {
    const readFn = vi.fn(async () => {
      throw new Error('invalid_args: Unrecognized key(s) in object: "oops"');
    });
    const writeFn = vi.fn(async () => json({ ok: true }));
    const read = mkTool('wi:list', 'read', readFn);
    const checkpoint = mkTool('wi:checkpoint', 'write', writeFn);

    const r = await runToolOrchestration(
      `const l = await tools.wi.list({ oops: 1 });
       await tools.wi.checkpoint({ id: 'WI-1', checkpoint: 'state I believed was saved' });
       return { done: true };`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [read, checkpoint] },
    );

    expect(r.ok).toBe(false);
    // The write genuinely never ran...
    expect(writeFn).not.toHaveBeenCalled();
    // ...and every dispatch-recorded surface is therefore silent about it.
    expect(r.plannedMutations).toEqual([]);
    expect(r.rejectedMutations ?? []).toEqual([]);
    expect(r.uncertainMutations ?? []).toEqual([]);
    // Which is exactly why this field has to exist.
    expect(r.strandedWrites).toEqual(['wi:checkpoint']);
    // The compatibility string list is paired with an explicit disposition so callers do not
    // have to infer whether "stranded" means attempted, partial, or never dispatched.
    expect(r.notDispatchedWrites).toEqual([{ tool: 'wi:checkpoint', executed: false }]);
  });

  it('reports nothing when the script completes (an untaken branch is not a stranding)', async () => {
    const read = mkTool('wi:list', 'read', async () => json({ items: [] }));
    const write = mkTool('wi:checkpoint', 'write', async () => json({ ok: true }));
    const r = await runToolOrchestration(
      `const l = await tools.wi.list({});
       if (l.items.length > 0) await tools.wi.checkpoint({ id: 'WI-1' });
       return { done: true };`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [read, write] },
    );
    expect(r.ok).toBe(true);
    expect(r.strandedWrites).toBeUndefined();
  });

  it('does not claim a write that already dispatched before the failure', async () => {
    const write = mkTool('wi:checkpoint', 'write', async () => json({ ok: true }));
    const boom = mkTool('wi:list', 'read', async () => {
      throw new Error('nope');
    });
    const r = await runToolOrchestration(
      `await tools.wi.checkpoint({ id: 'WI-1' });
       await tools.wi.list({});
       return { done: true };`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [write, boom] },
    );
    expect(r.ok).toBe(false);
    expect(r.plannedMutations.map((m) => m.tool)).toEqual(['wi:checkpoint']);
    // It landed — reporting it as stranded would be the cry-wolf failure EI-10951 fixed.
    expect(r.strandedWrites).toBeUndefined();
  });

  it('reports an exact settled prefix and an in-flight write when timeout wins the host dispatch race', async () => {
    let releaseSecond!: () => void;
    const secondPending = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const writeFn = vi.fn(async (args: unknown) => {
      const n = (args as { n: number }).n;
      if (n === 2) await secondPending;
      return json({ ok: true, n });
    });
    const write = mkTool('wi:checkpoint', 'write', writeFn);

    const r = await runToolOrchestration(
      `await tools.wi.checkpoint({ n: 1 });
       await tools.wi.checkpoint({ n: 2 });
       await tools.wi.checkpoint({ n: 3 });
       return { done: true };`,
      { ctx: MAKE_CTX(), deps: DEPS, tools: [write], timeoutMs: 200 },
    );

    expect(r.ok).toBe(false);
    expect(r.error).toContain('script_timeout');
    expect(writeFn).toHaveBeenCalledTimes(2);
    expect(r.writeAttempts).toEqual([
      { index: 0, tool: 'wi:checkpoint', disposition: 'settled' },
      { index: 1, tool: 'wi:checkpoint', disposition: 'in_flight' },
    ]);
    expect(r.strandedWrites).toBeUndefined();

    // Do not leave a deliberately pending host dispatch behind for the test process.
    releaseSecond();
  });
});
