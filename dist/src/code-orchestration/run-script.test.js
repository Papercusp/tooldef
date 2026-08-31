import { describe, it, expect, vi } from 'vitest';
import { runOrchestrationScript } from './run-script';
// A plain object suffices as the facade for the executor's purposes.
const facade = (impl) => impl;
describe('runOrchestrationScript (B-CX-1A)', () => {
    it('runs a multi-step script and returns ONLY its summary (intermediate stays in-runtime)', async () => {
        const fetchBig = vi.fn(async () => ({ rows: Array.from({ length: 5000 }, (_, i) => i) }));
        const r = await runOrchestrationScript(`const data = await tools.db.fetch();
       const evens = data.rows.filter((n) => n % 2 === 0);
       return { total: data.rows.length, evens: evens.length };`, facade({ db: { fetch: fetchBig } }));
        expect(r.ok).toBe(true);
        expect(r.result).toEqual({ total: 5000, evens: 2500 }); // the 5000-row payload never leaves the runtime
        expect(fetchBig).toHaveBeenCalledOnce();
    });
    it('loops with control flow across many tool calls in ONE run', async () => {
        const get = vi.fn(async (a) => ({ id: a.id, failing: a.id % 2 === 0 }));
        const r = await runOrchestrationScript(`const failing = [];
       for (let i = 0; i < 6; i++) {
         const d = await tools.wi.get({ id: i });
         if (d.failing) failing.push(d.id);
       }
       return failing;`, facade({ wi: { get } }));
        expect(r.ok).toBe(true);
        expect(r.result).toEqual([0, 2, 4]);
        expect(get).toHaveBeenCalledTimes(6); // 6 tool calls, 1 inference call
    });
    it('captures console output and surfaces thrown errors as ok=false', async () => {
        const r = await runOrchestrationScript(`log('starting'); throw new Error('boom');`, facade({}));
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/boom/);
        expect(r.logs).toContain('starting');
    });
    it('allows a script to use log as a local tool-result binding', async () => {
        const get = vi.fn(async () => ({ value: 42 }));
        const r = await runOrchestrationScript(`const log = await tools.db.get(); return log.value;`, facade({ db: { get } }));
        expect(r.ok).toBe(true);
        expect(r.error).toBeUndefined();
        expect(r.result).toBe(42);
        expect(get).toHaveBeenCalledOnce();
    });
    it('reports a compile error for malformed script', async () => {
        const r = await runOrchestrationScript(`this is ( not valid`, facade({}));
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/compile_error/);
    });
    // EI-21909921686340240: code:run scripts are compiled as plain JavaScript
    // (via vm.runInNewContext) — TypeScript-only syntax (type annotations, `as`
    // casts, interfaces) fails to parse with an opaque V8 SyntaxError and no
    // guidance that TypeScript isn't supported here. The compile_error message
    // now always appends that guidance so a caller isn't left guessing.
    it('appends plain-JavaScript-only guidance to a compile error from TypeScript syntax', async () => {
        const r = await runOrchestrationScript(`const f = (t:any) => t; return f(1);`, facade({}));
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/compile_error/);
        expect(r.error).toMatch(/plain JavaScript only/);
        expect(r.error).toMatch(/TypeScript type annotations/);
    });
    it('enforces the wall-clock timeout on an async hang', async () => {
        const r = await runOrchestrationScript(`await new Promise(() => {}); return 1;`, facade({}), { timeoutMs: 100 });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/script_timeout/);
    });
    it('awaits an async timeout hook but caps a hook that never settles', async () => {
        let hookReachedAfterAwait = false;
        const startedAt = Date.now();
        const r = await runOrchestrationScript(`await new Promise(() => {});`, facade({}), {
            timeoutMs: 30,
            timeoutGraceMs: 40,
            onTimeout: async () => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                hookReachedAfterAwait = true;
                await new Promise(() => { });
            },
        });
        const elapsed = Date.now() - startedAt;
        expect(r.ok).toBe(false);
        expect(r.error).toContain('script_timeout');
        // A synchronous/void-only timeout callback would resolve before this continuation ran.
        expect(hookReachedAfterAwait).toBe(true);
        // The never-settling tail cannot hold the caller beyond the configured bounded grace.
        expect(elapsed).toBeLessThan(500);
    });
    it('denies node ambient access (no require/process in the vm context)', async () => {
        const r = await runOrchestrationScript(`return typeof require + ',' + typeof process;`, facade({}));
        expect(r.ok).toBe(true);
        expect(r.result).toBe('undefined,undefined');
    });
    it('decodes a capability:read byte page with VM-local atob without exposing Buffer', async () => {
        const bytes = Uint8Array.from([0, 255, 1, 128, 226, 156, 147]);
        const encoded = Buffer.from(bytes).toString('base64');
        const read = vi.fn(async () => ({
            ok: true,
            encoding: 'base64',
            byte_offset: 0,
            byte_length: bytes.length,
            total_bytes: bytes.length,
            eof: true,
            data: encoded,
            next_cursor: null,
        }));
        const r = await runOrchestrationScript(`const page = await tools.capability.read({ file_path: '/tmp/spill.md', byte_offset: 0, byte_limit: 4096 });
       const binary = atob(page.data);
       const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
       return { bytes: Array.from(decoded), atobType: typeof atob, bufferType: typeof Buffer };`, facade({ capability: { read } }));
        expect(r.ok).toBe(true);
        expect(r.result).toEqual({
            bytes: Array.from(bytes),
            atobType: 'function',
            bufferType: 'undefined',
        });
        expect(read).toHaveBeenCalledOnce();
    });
    // EI-19294786663902075: the vm context has no importModuleDynamically callback, so a script's
    // `await import(...)` throws the V8-internal "A dynamic import callback was not specified."
    // before the specifier is even looked at -- which reads like a bad path, not a sandbox limit.
    // Rewritten into a named, actionable error instead of leaking the vm implementation detail.
    it('rewrites a dynamic import attempt into a named, actionable error (not the raw vm message)', async () => {
        const r = await runOrchestrationScript(`return await import('node:fs');`, facade({}));
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/^dynamic_import_unsupported:/);
        expect(r.error).not.toMatch(/dynamic import callback/i);
        expect(r.error).toMatch(/tools\.ns\.verb/);
    });
    it('same rewrite applies to importing an arbitrary repo path, not just node builtins', async () => {
        const r = await runOrchestrationScript(`return await import('/some/repo/path/module.ts');`, facade({}));
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/^dynamic_import_unsupported:/);
    });
    // EI-7839 / EI-20385364997159134 / EI-21867145325617024 (and other recurring reports of the
    // same root cause): setTimeout is deliberately absent from the vm context (sleep(ms) is the
    // documented replacement), so a script calling it threw a bare, unrewritten "setTimeout is not
    // defined" ReferenceError with no hint that sleep(ms) exists -- the same shape of confusion the
    // dynamic-import rewrite above already solves for imports. This asserts the matching rewrite.
    it('rewrites a setTimeout call into a named, actionable error pointing at sleep(ms) (not the raw ReferenceError)', async () => {
        const r = await runOrchestrationScript(`return await new Promise((resolve) => setTimeout(resolve, 10));`, facade({}));
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/^setTimeout_unsupported:/);
        expect(r.error).not.toMatch(/^setTimeout is not defined$/);
        expect(r.error).toMatch(/sleep\(ms\)/);
    });
    it('same rewrite applies to setInterval, with repeating-delay guidance instead of the sleep(ms) API', async () => {
        const r = await runOrchestrationScript(`setInterval(() => {}, 10); return 1;`, facade({}));
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/^setInterval_unsupported:/);
        expect(r.error).not.toMatch(/^setInterval is not defined$/);
        expect(r.error).toMatch(/loop with await sleep\(ms\)/);
    });
    // Reproduces the exact D-115 evidence-script shape from EI-21867145325617024: a tool call
    // BEFORE the unsupported timer already dispatched (and so already has a real side effect) by
    // the time the script throws; a second, later-ordered call was planned but never reached. The
    // rewritten error must still surface cleanly even when the script is not a clean single-liner.
    it('surfaces the rewritten timer error even after a prior tool call already dispatched (the stranded-write shape)', async () => {
        const before = vi.fn(async () => ({ ok: true, marker: 'before-timer' }));
        const after = vi.fn(async () => ({ ok: true, marker: 'after-timer' }));
        const r = await runOrchestrationScript(`const first = await tools.capability.read({ file_path: '/tmp/x' });
       await new Promise((resolve) => setTimeout(resolve, 10));
       const second = await tools.capability.bash({ command: 'echo unreachable' });
       return { first, second };`, facade({ capability: { read: before, bash: after } }));
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/^setTimeout_unsupported:/);
        expect(before).toHaveBeenCalledOnce(); // the call ordered BEFORE setTimeout already ran
        expect(after).not.toHaveBeenCalled(); // the call ordered AFTER it was never dispatched
    });
    // B-CX-SANDBOX: the reason the executor moved to a worker thread — a SYNCHRONOUS infinite loop
    // must be killable. The old in-host vm executor's wall-clock race only bounded async-yielding
    // work, so `while (true) {}` froze the whole process. Now the worker is terminated at the bound.
    it('kills a SYNCHRONOUS infinite loop at the timeout (the host stays alive)', async () => {
        const start = Date.now();
        const r = await runOrchestrationScript(`while (true) {}`, facade({}), { timeoutMs: 300 });
        const elapsed = Date.now() - start;
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/script_timeout/);
        // Terminated near the bound — proves the host wasn't blocked by the sync loop.
        expect(elapsed).toBeLessThan(2000);
    });
    it('keeps the host responsive while a sync loop runs (concurrent work completes)', async () => {
        // If the sync loop blocked the host event loop, this Promise.all would never settle the timer.
        const hung = runOrchestrationScript(`for (;;) {}`, facade({}), { timeoutMs: 400 });
        const hostTick = new Promise((res) => setTimeout(() => res('host-alive'), 50));
        const [tick] = await Promise.all([hostTick, hung]);
        expect(tick).toBe('host-alive');
    });
    it('isolates state between runs (no shared sandbox globals leak across calls)', async () => {
        const a = await runOrchestrationScript(`globalThis.__leak = 'from-a'; return 'a';`, facade({}));
        const b = await runOrchestrationScript(`return typeof globalThis.__leak;`, facade({}));
        expect(a.ok).toBe(true);
        expect(b.ok).toBe(true);
        expect(b.result).toBe('undefined'); // a fresh worker per run — no cross-run global leak
    });
    it('exposes JSON inputs as VM-realm values that are recursively frozen', async () => {
        const r = await runOrchestrationScript(`const nestedSet = Reflect.set(inputs.profile, 'name', 'changed');
       const listSet = Reflect.set(inputs.ids, 0, 99);
       return {
         value: inputs,
         rootFrozen: Object.isFrozen(inputs),
         nestedFrozen: Object.isFrozen(inputs.profile),
         listFrozen: Object.isFrozen(inputs.ids),
         vmPrototype: Object.getPrototypeOf(inputs) === Object.prototype,
         nestedSet,
         listSet,
       };`, facade({}), { inputs: { profile: { name: 'original' }, ids: [1, 2, 3] } });
        expect(r).toMatchObject({
            ok: true,
            result: {
                value: { profile: { name: 'original' }, ids: [1, 2, 3] },
                rootFrozen: true,
                nestedFrozen: true,
                listFrozen: true,
                vmPrototype: true,
                nestedSet: false,
                listSet: false,
            },
        });
    });
    it('structured-clones inputs before host-side work can mutate the source object', async () => {
        const inputs = { profile: { name: 'before' } };
        const mutateHost = vi.fn(async () => {
            inputs.profile.name = 'after';
            return { ok: true };
        });
        const r = await runOrchestrationScript(`await tools.host.mutate(); return inputs.profile.name;`, facade({ host: { mutate: mutateHost } }), { inputs });
        expect(mutateHost).toHaveBeenCalledOnce();
        expect(inputs.profile.name).toBe('after');
        expect(r).toMatchObject({ ok: true, result: 'before' });
    });
    it('rejects callable and host-prototyped input values before constructing the worker', async () => {
        class HostValue {
            value = 'host';
        }
        const callable = await runOrchestrationScript(`return inputs;`, facade({}), {
            inputs: { leak: (() => 'host') },
        });
        const prototyped = await runOrchestrationScript(`return inputs;`, facade({}), {
            inputs: { leak: new HostValue() },
        });
        expect(callable).toMatchObject({ ok: false, error: expect.stringContaining('non-JSON function') });
        expect(prototyped).toMatchObject({ ok: false, error: expect.stringContaining('plain JSON object') });
    });
    it('surfaces a thrown error from inside a tool call as ok=false', async () => {
        const boom = vi.fn(async () => {
            throw new Error('tool exploded');
        });
        const r = await runOrchestrationScript(`return await tools.svc.go();`, facade({ svc: { go: boom } }));
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/tool exploded/);
    });
    it('rejects a NUL introduced by a JavaScript backslash-zero escape with actionable shell guidance', async () => {
        const bash = vi.fn(async () => ({ ok: true }));
        // String.raw keeps one backslash in the script source. The vm then parses `\0` as a NUL,
        // matching the live code:run failure that otherwise surfaced as child_process args[3].
        const r = await runOrchestrationScript(String.raw `return await tools.capability.bash({ command: "tr '\0' ' ' </proc/self/cmdline" });`, facade({ capability: { bash } }));
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/contains a NUL byte/);
        expect(r.error).toMatch(/write `\\\\0`/);
        expect(bash).not.toHaveBeenCalled();
    });
    it('passes the correctly escaped shell backslash-zero through unchanged', async () => {
        const bash = vi.fn(async (args) => ({ ok: true, command: args.command }));
        // Two backslashes in the script source become one shell backslash after JS parsing.
        const r = await runOrchestrationScript(String.raw `return await tools.capability.bash({ command: "tr '\\0' ' ' </proc/self/cmdline" });`, facade({ capability: { bash } }));
        expect(r.ok).toBe(true);
        expect(r.result).toEqual({ ok: true, command: "tr '\\0' ' ' </proc/self/cmdline" });
        expect(bash).toHaveBeenCalledWith({ command: "tr '\\0' ' ' </proc/self/cmdline" });
    });
    it('rejects a call to a tool absent from the facade (whitelist boundary)', async () => {
        const r = await runOrchestrationScript(`return await tools.secret.exfiltrate();`, facade({}));
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/not available/);
    });
    // EI-7839: setTimeout is a Node/DOM global, not a JS intrinsic — runInNewContext's sandbox
    // omits it, so a script that reaches for it throws immediately (even after prior writes already
    // executed). sleep(ms) is the documented, bounded replacement.
    it('EI-7839: raw setTimeout is NOT ambient in the sandbox (the bug this fix addresses)', async () => {
        const r = await runOrchestrationScript(`return typeof setTimeout;`, facade({}));
        expect(r.ok).toBe(true);
        expect(r.result).toBe('undefined');
    });
    it('EI-7839: sleep(ms) is ambient and actually delays before resolving', async () => {
        const start = Date.now();
        const r = await runOrchestrationScript(`await sleep(50); return 'done';`, facade({}));
        expect(r.ok).toBe(true);
        expect(r.result).toBe('done');
        expect(Date.now() - start).toBeGreaterThanOrEqual(45); // small slack for timer jitter
    });
    it('EI-7839: sleep(ms) is capped so a runaway wait degrades to the overall script_timeout', async () => {
        const r = await runOrchestrationScript(`await sleep(60_000); return 'unreachable';`, facade({}), { timeoutMs: 200 });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/script_timeout/);
    });
});
describe('EI-19324793244855883: sleep(ms) clamp is no longer silent', () => {
    // The incident: a script measured a rate over a requested window (`await sleep(30000)` to
    // sample a 30s DB-time delta), got back ~10.1s because the clamp silently shortened it, and
    // divided by the REQUESTED window — a confidently wrong, well-formed number with no error.
    //
    // `sleepMaxMs` is a TEST-ONLY override (production leaves it at the 10s default) so these
    // exercise the real clamp path without a real multi-second wait.
    it('reports a clamped call in sleepCaps, with both the requested and actual ms', async () => {
        const r = await runOrchestrationScript(`await sleep(300); return 'done';`, facade({}), {
            sleepMaxMs: 30,
        });
        expect(r.ok).toBe(true);
        expect(r.result).toBe('done');
        expect(r.sleepCaps).toEqual([{ requestedMs: 300, actualMs: 30 }]);
    });
    it('resolves with the ACTUAL ms waited, so a careful script can self-correct', async () => {
        const r = await runOrchestrationScript(`const actual = await sleep(300); return { actual };`, facade({}), { sleepMaxMs: 30 });
        expect(r.ok).toBe(true);
        expect(r.result).toEqual({ actual: 30 });
    });
    it('stays SILENT (no sleepCaps field) for a request within the cap', async () => {
        const r = await runOrchestrationScript(`await sleep(10); return 'done';`, facade({}), {
            sleepMaxMs: 30,
        });
        expect(r.ok).toBe(true);
        expect(r.sleepCaps).toBeUndefined();
    });
    it('records one entry per clamped call, in a multi-sleep script', async () => {
        const r = await runOrchestrationScript(`await sleep(10); await sleep(200); await sleep(150); return 'done';`, facade({}), { sleepMaxMs: 30 });
        expect(r.ok).toBe(true);
        expect(r.sleepCaps).toEqual([
            { requestedMs: 200, actualMs: 30 },
            { requestedMs: 150, actualMs: 30 },
        ]);
    });
    it('the default cap is still 10_000ms (production behavior unchanged)', async () => {
        const r = await runOrchestrationScript(`const actual = await sleep(60_000); return { actual };`, facade({}), { timeoutMs: 200 });
        // Same assertion as the pre-existing "runaway wait degrades to script_timeout" test above —
        // 200ms budget can't reach the real 10s clamp, so this just re-confirms the default didn't move.
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/script_timeout/);
    });
});
describe('EI-19301148486657755: reading a field the tool result does not have', () => {
    // The incident: a fleet-leader monitor script summarised work_items:claimable with
    // `count: c?.count ?? c?.total ?? null`. The real key is `claimableCount`, so BOTH guesses
    // were undefined, `?? null` made it a confident `null`, and the leader read that as
    // "0 claimable" against a queue of 1,397 — one step from standing down a 10-agent fleet.
    const claimable = async () => ({
        ok: true,
        harness: 'papercusp',
        claimableCount: 1397,
        matchedByFilter: 13649,
        claimable: [{ id: 'WI-1' }],
    });
    it('fails compactly when a script reads the content envelope from a typed structured root', async () => {
        const presence = async () => ({
            summary: { alive: 1, active: 1 },
            active: [{ id: 'member-with-a-large-roster-payload' }],
        });
        const r = await runOrchestrationScript(`const result = await tools.coord.presence({});
       return result?.content?.[0]?.text ?? result;`, facade({ coord: { presence } }));
        expect(r.ok).toBe(false);
        expect(r.result).toBeUndefined();
        expect(r.error).toMatch(/^structured_result_shape:/);
        expect(r.error).toContain('coord:presence');
        expect(r.error).toContain('content');
        expect(r.error).toContain('summary');
        expect(r.error).not.toContain('member-with-a-large-roster-payload');
        expect(r.error?.length).toBeLessThan(300);
    });
    it('uses the same compact error for a root text-envelope read', async () => {
        const presence = async () => ({ summary: { alive: 1 }, active: [] });
        const r = await runOrchestrationScript(`const result = await tools.coord.presence({});
       return result?.text ?? result;`, facade({ coord: { presence } }));
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/^structured_result_shape:/);
        expect(r.error).toContain('`text`');
    });
    it('preserves direct typed access on the same structured root', async () => {
        const presence = async () => ({ summary: { alive: 1 }, active: [{ id: 'member-1' }] });
        const r = await runOrchestrationScript(`const result = await tools.coord.presence({});
       return { alive: result.summary.alive, active: result.active.length };`, facade({ coord: { presence } }));
        expect(r.ok).toBe(true);
        expect(r.result).toEqual({ alive: 1, active: 1 });
        expect(r.fieldMisses).toBeUndefined();
    });
    it('reports the miss AND the real keys for the exact shape that caused the incident', async () => {
        const r = await runOrchestrationScript(`const c = await tools.work_items.claimable({});
       return { count: c?.count ?? c?.total ?? null };`, facade({ work_items: { claimable } }));
        expect(r.ok).toBe(true);
        // The summary is still the (wrong) value the script computed — we do not silently rewrite it.
        expect(r.result).toEqual({ count: null });
        // ...but the null is no longer indistinguishable from a real zero.
        const misses = r.fieldMisses ?? [];
        expect(misses.map((m) => m.read).sort()).toEqual(['count', 'total']);
        expect(misses[0]?.tool).toBe('work_items:claimable');
        expect(misses[0]?.path).toBe('(root)');
        expect(misses[0]?.available).toContain('claimableCount');
    });
    // P-007 (EI-21163938645109933 / EI-21164455886001541): a miss is either a TYPO or a probe of a
    // legitimately-OPTIONAL field, and reporting both identically is what made this signal read as
    // noise. The Proxy cannot see the surrounding syntax — but the KEY can be judged by proximity.
    it('classifies a near-miss key as a typo and names the key it resembles', async () => {
        const r = await runOrchestrationScript(`const c = await tools.work_items.claimable({});
       return { count: c.count ?? null };`, facade({ work_items: { claimable } }));
        const miss = (r.fieldMisses ?? []).find((m) => m.read === 'count');
        // The founding incident of this whole detector: `count` read off `claimableCount`. It is 9
        // edits away, so containment — not edit distance — is what must catch it.
        expect(miss?.likely).toBe('typo');
        expect(miss?.didYouMean).toBe('claimableCount');
    });
    it('classifies a key resembling nothing on the shape as an absent optional field', async () => {
        const r = await runOrchestrationScript(`const c = await tools.work_items.claimable({});
       return { cls: c.criterionClass ?? null };`, facade({ work_items: { claimable } }));
        const miss = (r.fieldMisses ?? []).find((m) => m.read === 'criterionClass');
        // The EI-21164455886001541 shape: a legitimately-optional field, set on some rows of a
        // collection and absent on others, resembling no key on the shape it was read from.
        expect(miss?.likely).toBe('optional-field');
        expect(miss?.didYouMean).toBeUndefined();
    });
    // CONTROL: the classifier must actually DISCRIMINATE. If both keys ever land in the same class,
    // the split is decorative and the noise it was built to remove is back.
    it('CONTROL: a typo and an optional probe do not land in the same class', async () => {
        const r = await runOrchestrationScript(`const c = await tools.work_items.claimable({});
       return { a: c.count ?? null, b: c.criterionClass ?? null };`, facade({ work_items: { claimable } }));
        const classes = (r.fieldMisses ?? []).map((m) => [m.read, m.likely]);
        expect(classes).toEqual(expect.arrayContaining([
            ['count', 'typo'],
            ['criterionClass', 'optional-field'],
        ]));
    });
    it('stays SILENT for a correct script — the signal only fires when the author was already wrong', async () => {
        const r = await runOrchestrationScript(`const c = await tools.work_items.claimable({});
       return { count: c.claimableCount, matched: c.matchedByFilter, first: c.claimable[0].id };`, facade({ work_items: { claimable } }));
        expect(r.ok).toBe(true);
        expect(r.result).toEqual({ count: 1397, matched: 13649, first: 'WI-1' });
        expect(r.fieldMisses).toBeUndefined();
    });
    it('catches a NESTED miss inside an array element, with the dotted path', async () => {
        // The coord:send case: `r.woken` read on each row of `results[]`, where the rows carry
        // different keys entirely. A top-level-only check would miss this.
        const send = async () => ({ ok: true, results: [{ ok: true, to: ['a'], msg_id: 'm1' }] });
        const r = await runOrchestrationScript(`const s = await tools.coord.send({});
       return s.results.map((row) => ({ woken: row.woken ?? 0 }));`, facade({ coord: { send } }));
        expect(r.ok).toBe(true);
        expect(r.result).toEqual([{ woken: 0 }]);
        const miss = (r.fieldMisses ?? []).find((m) => m.read === 'woken');
        expect(miss).toBeDefined();
        expect(miss?.path).toBe('results.0');
        expect(miss?.available).toEqual(['ok', 'to', 'msg_id']);
    });
    it('does NOT flag prototype members, array indices, or the await `then` probe', async () => {
        const get = async () => ({ rows: [1, 2, 3], nested: { a: 1 } });
        const r = await runOrchestrationScript(`const g = await tools.db.get({});
       const doubled = g.rows.map((n) => n * 2);
       const missing = g.rows[99];
       return {
         len: g.rows.length,
         doubled,
         missing: missing ?? 'none',
         str: typeof g.nested.toString,
         keys: Object.keys(g).length,
       };`, facade({ db: { get } }));
        expect(r.ok).toBe(true);
        expect(r.result).toEqual({
            len: 3,
            doubled: [2, 4, 6],
            missing: 'none',
            str: 'function',
            keys: 2,
        });
        // .map/.length/.toString resolve via the prototype chain; rows[99] is a legitimate
        // out-of-bounds index; `then` is the runtime's own thenable probe on every await.
        expect(r.fieldMisses).toBeUndefined();
    });
    it('supports for...of over a NESTED array (symbol keys must never reach the path builder)', async () => {
        // Regression: the tracker built its dotted path with `path + '.' + key`. `for (const w of
        // l.items)` reads Symbol.iterator on the array at path 'items', and concatenating a Symbol
        // throws "Cannot convert a Symbol value to a string" — which failed 10 orchestrate tests
        // while every top-level-only test still passed.
        const list = async () => ({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
        const r = await runOrchestrationScript(`const l = await tools.wi.list({});
       const ids = [];
       for (const w of l.items) { ids.push(w.id); }
       return { ids, count: [...l.items].length };`, facade({ wi: { list } }));
        expect(r.ok).toBe(true);
        expect(r.error).toBeUndefined();
        expect(r.result).toEqual({ ids: [1, 2, 3], count: 3 });
        expect(r.fieldMisses).toBeUndefined();
    });
    it('keeps object identity stable across repeated reads (the tracker must not re-wrap)', async () => {
        const get = async () => ({ nested: { a: 1 } });
        const r = await runOrchestrationScript(`const g = await tools.db.get({});
       return { same: g.nested === g.nested, spreadOk: { ...g.nested }.a };`, facade({ db: { get } }));
        expect(r.ok).toBe(true);
        expect(r.result).toEqual({ same: true, spreadOk: 1 });
    });
    it('still serialises a tool result returned VERBATIM (a tracking proxy must never escape)', async () => {
        // Regression guard: a Proxy is not structured-cloneable, so without the deep-unwrap this
        // turns every `return someToolResult` into result_not_serializable.
        const get = async () => ({ ok: true, deep: { list: [{ x: 1 }] } });
        const r = await runOrchestrationScript(`return await tools.db.get({});`, facade({ db: { get } }));
        expect(r.ok).toBe(true);
        expect(r.error).toBeUndefined();
        expect(r.result).toEqual({ ok: true, deep: { list: [{ x: 1 }] } });
    });
    it('unwraps proxied nested tool-result values before passing them to the next tool', async () => {
        // Regression: tool results are tracked with Proxies in the worker. Passing a nested array or
        // object from that result into another tool used to post the Proxy itself across the worker
        // boundary, which failed with "[object Array] could not be cloned" before the host tool ran.
        const get = async () => ({
            frontmatter: {
                tags: ['agent', 'runbook'],
                documents: [{ path: 'src/example.ts' }],
                plans: ['plan-a'],
            },
        });
        const author = vi.fn(async (args) => ({ ok: true, received: args }));
        const r = await runOrchestrationScript(`const row = await tools.db.get({});
       return await tools.docs.author({
         tags: row.frontmatter.tags,
         documents: row.frontmatter.documents,
         plans: row.frontmatter.plans,
       });`, facade({ db: { get }, docs: { author } }));
        expect(r.ok).toBe(true);
        expect(r.error).toBeUndefined();
        expect(author).toHaveBeenCalledOnce();
        expect(author).toHaveBeenCalledWith({
            tags: ['agent', 'runbook'],
            documents: [{ path: 'src/example.ts' }],
            plans: ['plan-a'],
        });
        expect(r.result).toEqual({
            ok: true,
            received: {
                tags: ['agent', 'runbook'],
                documents: [{ path: 'src/example.ts' }],
                plans: ['plan-a'],
            },
        });
    });
    it('serialises a tool result nested inside a SCRIPT-BUILT wrapper object (cross-realm unwrap)', async () => {
        // Regression: the script runs under vm.runInNewContext, so `{ viaCall }` carries the VM
        // realm's Object.prototype. A strict `proto === Object.prototype` check is false for it, so
        // unwrap skipped the wrapper and the proxy inside reached postMessage as
        // "result_not_serializable: #<Object> could not be cloned".
        const get = async () => ({ ok: true, echoed: { slug: 's' } });
        const r = await runOrchestrationScript(`const viaCall = await tools.plans.get({});
       return { viaCall, list: [await tools.plans.get({})] };`, facade({ plans: { get } }));
        expect(r.ok).toBe(true);
        expect(r.error).toBeUndefined();
        expect(r.result).toEqual({
            viaCall: { ok: true, echoed: { slug: 's' } },
            list: [{ ok: true, echoed: { slug: 's' } }],
        });
    });
    it('bounds the report so a miss inside a hot loop cannot flood the result', async () => {
        const get = async (a) => ({ id: a.id });
        const r = await runOrchestrationScript(`const out = [];
       for (let i = 0; i < 50; i++) {
         const d = await tools.db.get({ id: i });
         out.push(d.nope ?? null);
       }
       return out.length;`, facade({ db: { get } }));
        expect(r.ok).toBe(true);
        expect(r.result).toBe(50);
        // Distinct (tool, path, key) signatures dedupe to one; the hard cap bounds the rest.
        expect((r.fieldMisses ?? []).length).toBeGreaterThan(0);
        expect((r.fieldMisses ?? []).length).toBeLessThanOrEqual(12);
    });
    it('seeds store/load from explicit inputs and returns replayable state without mutating inputs', async () => {
        const r = await runOrchestrationScript(`const before = load('cursor');
       store('cursor', before + 1);
       store('filters', [...load('filters'), 'urgent']);
       return { before, immutable: inputs.cursor, after: load('cursor') };`, facade({}), { inputs: { cursor: 2, filters: ['open'] } });
        expect(r).toMatchObject({
            ok: true,
            result: { before: 2, immutable: 2, after: 3 },
            state: { cursor: 3, filters: ['open', 'urgent'] },
        });
    });
    it('rejects non-JSON store values instead of silently changing their meaning', async () => {
        const r = await runOrchestrationScript(`store('cursor', Number.NaN); return 'unreachable';`, facade({}));
        expect(r.ok).toBe(false);
        expect(r.error).toContain('state_not_serializable');
        expect(r.error).toContain('finite number');
    });
    it('streams notify/yield_control and records generatedImage requests for host validation', async () => {
        const emit = vi.fn();
        const r = await runOrchestrationScript(`notify({ phase: 'rendering', count: 1 });
       yield_control();
       generatedImage({ image_url: 'data:image/png;base64,aGVsbG8=', output_hint: 'preview' });
       return 'done';`, facade({}), { emit });
        expect(r.ok).toBe(true);
        expect(emit).toHaveBeenNthCalledWith(1, 'notify', { phase: 'rendering', count: 1 });
        expect(emit).toHaveBeenNthCalledWith(2, 'yield_control', null);
        expect(r.generatedImages).toEqual([
            { image_url: 'data:image/png;base64,aGVsbG8=', output_hint: 'preview' },
        ]);
    });
    it('retains the latest explicit state when a later synchronous loop times out', async () => {
        const r = await runOrchestrationScript(`store('cursor', 4); while (true) {}`, facade({}), {
            inputs: { cursor: 3 },
            timeoutMs: 100,
        });
        expect(r.ok).toBe(false);
        expect(r.error).toContain('script_timeout');
        expect(r.state).toEqual({ cursor: 4 });
    });
});
