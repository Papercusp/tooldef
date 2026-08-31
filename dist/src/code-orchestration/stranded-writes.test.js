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
const DEPS = {};
// Uses the REAL ProjectedTool shape (`expose.mcp.name`) — deliberately, not a `{ name }`
// convenience fixture. The first version of this file invented a top-level `name`, so the unit
// tests passed against a tool shape that does not exist while the detector was a no-op in
// production. A fixture that is easier to write than the real thing is how that ships green.
const tool = (name, effect, effectForCall) => ({ expose: { mcp: { name } }, effect, ...(effectForCall ? { effectForCall } : {}) });
const TOOLS = [
    tool('sessions:read', 'read'),
    tool('work_items:list', 'read'),
    tool('work_items:checkpoint', 'write'),
    tool('facts:assert', 'write'),
    tool('work_items:complete', 'write'),
];
const calls = (...names) => names.map((n) => ({ tool: n, args: null, dynamicArgs: false }));
describe('detectStrandedWrites (P-020)', () => {
    it('names a write that was ordered but never dispatched — the motivating case', () => {
        // Script: a read throws on an arg typo, so the checkpoint written after it never runs.
        const stranded = detectStrandedWrites(calls('sessions:read', 'work_items:checkpoint'), TOOLS, []);
        expect(stranded).toEqual(['work_items:checkpoint']);
    });
    it('ignores READS that never ran — re-running a read costs nothing', () => {
        const stranded = detectStrandedWrites(calls('sessions:read', 'work_items:list'), TOOLS, []);
        expect(stranded).toEqual([]);
    });
    it('uses the per-call classifier when deciding whether a static call is a write', () => {
        const release = tool('release:deploy', 'write', (args) => (args.op === 'status' ? 'read' : 'write'));
        const statusCall = { tool: 'release:deploy', args: { op: 'status' }, dynamicArgs: false };
        const triggerCall = { tool: 'release:deploy', args: { op: 'trigger' }, dynamicArgs: false };
        expect(detectStrandedWrites([statusCall], [release], [])).toEqual([]);
        expect(detectStrandedWrites([triggerCall], [release], [])).toEqual(['release:deploy']);
    });
    it('omits a write that dispatched at least once (a loop/branch may have run only some)', () => {
        const stranded = detectStrandedWrites(calls('work_items:checkpoint', 'facts:assert'), TOOLS, ['work_items:checkpoint']);
        expect(stranded).toEqual(['facts:assert']);
    });
    it('reports several stranded writes in SOURCE order', () => {
        const stranded = detectStrandedWrites(calls('sessions:read', 'facts:assert', 'work_items:checkpoint'), TOOLS, []);
        expect(stranded).toEqual(['facts:assert', 'work_items:checkpoint']);
    });
    it('dedupes a write called from several source sites', () => {
        const stranded = detectStrandedWrites(calls('facts:assert', 'facts:assert', 'facts:assert'), TOOLS, []);
        expect(stranded).toEqual(['facts:assert']);
    });
    it('claims nothing when every ordered write dispatched', () => {
        const stranded = detectStrandedWrites(calls('work_items:checkpoint', 'facts:assert'), TOOLS, ['work_items:checkpoint', 'facts:assert']);
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
const MAKE_CTX = () => ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    emit: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'h',
    role: 'worker',
    runId: 'run_X',
});
const json = (data) => ({
    content: [{ type: 'text', text: JSON.stringify(data) }],
});
const mkTool = (name, effect, fn) => ({
    pluginName: 'fix',
    description: name,
    inputSchema: { type: 'object' },
    capabilities: [],
    effect,
    expose: { mcp: { name } },
    fn,
});
const recordingDeps = (starts, settles) => ({
    ...DEPS,
    onDispatchStart: ({ callId }) => {
        if (typeof callId === 'string')
            starts.push(callId);
    },
    recordInvocation: async ({ callId, status }) => {
        settles.push({ callId, status });
    },
});
describe('P-020 end-to-end: a real aborted run reports its stranded writes', () => {
    it('surfaces the checkpoint that never dispatched when an earlier READ throws', async () => {
        const readFn = vi.fn(async () => {
            throw new Error('invalid_args: Unrecognized key(s) in object: "oops"');
        });
        const writeFn = vi.fn(async () => json({ ok: true }));
        const read = mkTool('wi:list', 'read', readFn);
        const checkpoint = mkTool('wi:checkpoint', 'write', writeFn);
        const r = await runToolOrchestration(`const l = await tools.wi.list({ oops: 1 });
       await tools.wi.checkpoint({ id: 'WI-1', checkpoint: 'state I believed was saved' });
       return { done: true };`, { ctx: MAKE_CTX(), deps: DEPS, tools: [read, checkpoint] });
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
        const r = await runToolOrchestration(`const l = await tools.wi.list({});
       if (l.items.length > 0) await tools.wi.checkpoint({ id: 'WI-1' });
       return { done: true };`, { ctx: MAKE_CTX(), deps: DEPS, tools: [read, write] });
        expect(r.ok).toBe(true);
        expect(r.strandedWrites).toBeUndefined();
    });
    it('does not claim a write that already dispatched before the failure', async () => {
        const write = mkTool('wi:checkpoint', 'write', async () => json({ ok: true }));
        const boom = mkTool('wi:list', 'read', async () => {
            throw new Error('nope');
        });
        const r = await runToolOrchestration(`await tools.wi.checkpoint({ id: 'WI-1' });
       await tools.wi.list({});
       return { done: true };`, { ctx: MAKE_CTX(), deps: DEPS, tools: [write, boom] });
        expect(r.ok).toBe(false);
        expect(r.plannedMutations.map((m) => m.tool)).toEqual(['wi:checkpoint']);
        // It landed — reporting it as stranded would be the cry-wolf failure EI-10951 fixed.
        expect(r.strandedWrites).toBeUndefined();
    });
    it('reports an exact settled prefix and correlates a non-cooperative detached write by callId', async () => {
        const starts = [];
        const settles = [];
        let releaseSecond;
        const secondPending = new Promise((resolve) => {
            releaseSecond = resolve;
        });
        let markSecondSettled;
        const secondSettled = new Promise((resolve) => {
            markSecondSettled = resolve;
        });
        const writeFn = vi.fn(async (args) => {
            const n = args.n;
            if (n === 2) {
                await secondPending;
                markSecondSettled();
            }
            return json({ ok: true, n });
        });
        const write = mkTool('wi:checkpoint', 'write', writeFn);
        const r = await runToolOrchestration(`await tools.wi.checkpoint({ n: 1 });
       await tools.wi.checkpoint({ n: 2 });
       await tools.wi.checkpoint({ n: 3 });
       return { done: true };`, {
            ctx: MAKE_CTX(),
            deps: recordingDeps(starts, settles),
            tools: [write],
            timeoutMs: 500,
            timeoutGraceMs: 25,
        });
        expect(r.ok).toBe(false);
        expect(r.error).toContain('script_timeout');
        expect(writeFn).toHaveBeenCalledTimes(2);
        expect(starts).toHaveLength(2);
        expect(settles).toEqual([{ callId: starts[0], status: 'ok' }]);
        expect(r.writeAttempts).toEqual([
            { index: 0, tool: 'wi:checkpoint', disposition: 'settled' },
            { index: 1, tool: 'wi:checkpoint', disposition: 'in_flight' },
        ]);
        expect(r.strandedWrites).toBeUndefined();
        expect(r.detachedCalls).toEqual([
            {
                callId: starts[1],
                tool: 'wi:checkpoint',
                effect: 'write',
                ordinal: 1,
                disposition: 'in_flight',
            },
        ]);
        // Do not leave a deliberately pending host dispatch behind for the test process.
        releaseSecond();
        await secondSettled;
    });
    it('settles an abort-cooperative write within grace and preserves its exact settled callId', async () => {
        const starts = [];
        const settles = [];
        let resolveAbort;
        const abortSeen = new Promise((resolve) => {
            resolveAbort = resolve;
        });
        const writeFn = vi.fn(async (_args, innerCtx) => {
            const signal = innerCtx.signal;
            await new Promise((resolve) => {
                const onAbort = () => {
                    resolveAbort();
                    resolve();
                };
                if (signal.aborted)
                    onAbort();
                else
                    signal.addEventListener('abort', onAbort, { once: true });
            });
            return json({ ok: true });
        });
        const write = mkTool('wi:checkpoint', 'write', writeFn);
        const r = await runToolOrchestration(`await tools.wi.checkpoint({ n: 1 }); return 'unreachable';`, {
            ctx: MAKE_CTX(),
            deps: recordingDeps(starts, settles),
            tools: [write],
            timeoutMs: 500,
            timeoutGraceMs: 50,
        });
        expect(r.ok).toBe(false);
        expect(r.error).toContain('script_timeout');
        expect(writeFn).toHaveBeenCalledOnce();
        expect(starts).toHaveLength(1);
        await abortSeen;
        // The dispatch settled during the grace window, so it is not detached; the telemetry
        // settlement still carries the exact id opened by onDispatchStart.
        expect(settles).toEqual([{ callId: starts[0], status: 'timeout' }]);
        expect(r.detachedCalls).toBeUndefined();
        expect(r.callRecords).toEqual([
            {
                ordinal: 0,
                tool: 'wi:checkpoint',
                effect: 'write',
                disposition: 'uncertain',
                outputReferences: [],
            },
        ]);
    });
    it('aborts a pending inner tool when the code:run worker deadline expires', async () => {
        let resolveAbort;
        const abortSeen = new Promise((resolve) => {
            resolveAbort = resolve;
        });
        const bash = mkTool('capability:bash', 'read', async (_args, innerCtx) => {
            const signal = innerCtx.signal;
            await new Promise((_resolve, reject) => {
                const onAbort = () => {
                    resolveAbort();
                    reject(new Error('inner capability:bash aborted with code:run'));
                };
                if (signal.aborted)
                    onAbort();
                else
                    signal.addEventListener('abort', onAbort, { once: true });
            });
            return json({ ok: true });
        });
        const r = await runToolOrchestration(`await tools.capability.bash({ command: 'sleep 60', timeout: 60000 }); return 'unreachable';`, { ctx: MAKE_CTX(), deps: DEPS, tools: [bash], timeoutMs: 100 });
        expect(r.ok).toBe(false);
        expect(r.error).toContain('script_timeout');
        await abortSeen;
    });
});
