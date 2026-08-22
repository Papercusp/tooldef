import { describe, it, expect, vi } from 'vitest';
import { runOrchestrationScript } from './run-script';
import type { ToolFacade } from './tool-facade';

// A plain object suffices as the facade for the executor's purposes.
const facade = (impl: Record<string, unknown>) => impl as unknown as ToolFacade;

describe('runOrchestrationScript (B-CX-1A)', () => {
  it('runs a multi-step script and returns ONLY its summary (intermediate stays in-runtime)', async () => {
    const fetchBig = vi.fn(async () => ({ rows: Array.from({ length: 5000 }, (_, i) => i) }));
    const r = await runOrchestrationScript(
      `const data = await tools.db.fetch();
       const evens = data.rows.filter((n) => n % 2 === 0);
       return { total: data.rows.length, evens: evens.length };`,
      facade({ db: { fetch: fetchBig } }),
    );
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ total: 5000, evens: 2500 }); // the 5000-row payload never leaves the runtime
    expect(fetchBig).toHaveBeenCalledOnce();
  });

  it('loops with control flow across many tool calls in ONE run', async () => {
    const get = vi.fn(async (a: { id: number }) => ({ id: a.id, failing: a.id % 2 === 0 }));
    const r = await runOrchestrationScript(
      `const failing = [];
       for (let i = 0; i < 6; i++) {
         const d = await tools.wi.get({ id: i });
         if (d.failing) failing.push(d.id);
       }
       return failing;`,
      facade({ wi: { get } }),
    );
    expect(r.ok).toBe(true);
    expect(r.result).toEqual([0, 2, 4]);
    expect(get).toHaveBeenCalledTimes(6); // 6 tool calls, 1 inference call
  });

  it('captures console output and surfaces thrown errors as ok=false', async () => {
    const r = await runOrchestrationScript(
      `log('starting'); throw new Error('boom');`,
      facade({}),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/boom/);
    expect(r.logs).toContain('starting');
  });

  it('allows a script to use log as a local tool-result binding', async () => {
    const get = vi.fn(async () => ({ value: 42 }));
    const r = await runOrchestrationScript(
      `const log = await tools.db.get(); return log.value;`,
      facade({ db: { get } }),
    );
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

  it('enforces the wall-clock timeout on an async hang', async () => {
    const r = await runOrchestrationScript(
      `await new Promise(() => {}); return 1;`,
      facade({}),
      { timeoutMs: 100 },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/script_timeout/);
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
    const r = await runOrchestrationScript(
      `const page = await tools.capability.read({ file_path: '/tmp/spill.md', byte_offset: 0, byte_limit: 4096 });
       const binary = atob(page.data);
       const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
       return { bytes: Array.from(decoded), atobType: typeof atob, bufferType: typeof Buffer };`,
      facade({ capability: { read } }),
    );
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
    const r = await runOrchestrationScript(
      `return await import('/some/repo/path/module.ts');`,
      facade({}),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^dynamic_import_unsupported:/);
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
    const hostTick = new Promise<string>((res) => setTimeout(() => res('host-alive'), 50));
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
    const r = await runOrchestrationScript(
      String.raw`return await tools.capability.bash({ command: "tr '\0' ' ' </proc/self/cmdline" });`,
      facade({ capability: { bash } }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/contains a NUL byte/);
    expect(r.error).toMatch(/write `\\\\0`/);
    expect(bash).not.toHaveBeenCalled();
  });

  it('passes the correctly escaped shell backslash-zero through unchanged', async () => {
    const bash = vi.fn(async (args: { command: string }) => ({ ok: true, command: args.command }));
    // Two backslashes in the script source become one shell backslash after JS parsing.
    const r = await runOrchestrationScript(
      String.raw`return await tools.capability.bash({ command: "tr '\\0' ' ' </proc/self/cmdline" });`,
      facade({ capability: { bash } }),
    );
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
    const r = await runOrchestrationScript(
      `await sleep(60_000); return 'unreachable';`,
      facade({}),
      { timeoutMs: 200 },
    );
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
    const r = await runOrchestrationScript(
      `const actual = await sleep(300); return { actual };`,
      facade({}),
      { sleepMaxMs: 30 },
    );
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
    const r = await runOrchestrationScript(
      `await sleep(10); await sleep(200); await sleep(150); return 'done';`,
      facade({}),
      { sleepMaxMs: 30 },
    );
    expect(r.ok).toBe(true);
    expect(r.sleepCaps).toEqual([
      { requestedMs: 200, actualMs: 30 },
      { requestedMs: 150, actualMs: 30 },
    ]);
  });

  it('the default cap is still 10_000ms (production behavior unchanged)', async () => {
    const r = await runOrchestrationScript(
      `const actual = await sleep(60_000); return { actual };`,
      facade({}),
      { timeoutMs: 200 },
    );
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

  it('reports the miss AND the real keys for the exact shape that caused the incident', async () => {
    const r = await runOrchestrationScript(
      `const c = await tools.work_items.claimable({});
       return { count: c?.count ?? c?.total ?? null };`,
      facade({ work_items: { claimable } }),
    );
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

  it('stays SILENT for a correct script — the signal only fires when the author was already wrong', async () => {
    const r = await runOrchestrationScript(
      `const c = await tools.work_items.claimable({});
       return { count: c.claimableCount, matched: c.matchedByFilter, first: c.claimable[0].id };`,
      facade({ work_items: { claimable } }),
    );
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ count: 1397, matched: 13649, first: 'WI-1' });
    expect(r.fieldMisses).toBeUndefined();
  });

  it('catches a NESTED miss inside an array element, with the dotted path', async () => {
    // The coord:send case: `r.woken` read on each row of `results[]`, where the rows carry
    // different keys entirely. A top-level-only check would miss this.
    const send = async () => ({ ok: true, results: [{ ok: true, to: ['a'], msg_id: 'm1' }] });
    const r = await runOrchestrationScript(
      `const s = await tools.coord.send({});
       return s.results.map((row) => ({ woken: row.woken ?? 0 }));`,
      facade({ coord: { send } }),
    );
    expect(r.ok).toBe(true);
    expect(r.result).toEqual([{ woken: 0 }]);
    const miss = (r.fieldMisses ?? []).find((m) => m.read === 'woken');
    expect(miss).toBeDefined();
    expect(miss?.path).toBe('results.0');
    expect(miss?.available).toEqual(['ok', 'to', 'msg_id']);
  });

  it('does NOT flag prototype members, array indices, or the await `then` probe', async () => {
    const get = async () => ({ rows: [1, 2, 3], nested: { a: 1 } });
    const r = await runOrchestrationScript(
      `const g = await tools.db.get({});
       const doubled = g.rows.map((n) => n * 2);
       const missing = g.rows[99];
       return {
         len: g.rows.length,
         doubled,
         missing: missing ?? 'none',
         str: typeof g.nested.toString,
         keys: Object.keys(g).length,
       };`,
      facade({ db: { get } }),
    );
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
    const r = await runOrchestrationScript(
      `const l = await tools.wi.list({});
       const ids = [];
       for (const w of l.items) { ids.push(w.id); }
       return { ids, count: [...l.items].length };`,
      facade({ wi: { list } }),
    );
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual({ ids: [1, 2, 3], count: 3 });
    expect(r.fieldMisses).toBeUndefined();
  });

  it('keeps object identity stable across repeated reads (the tracker must not re-wrap)', async () => {
    const get = async () => ({ nested: { a: 1 } });
    const r = await runOrchestrationScript(
      `const g = await tools.db.get({});
       return { same: g.nested === g.nested, spreadOk: { ...g.nested }.a };`,
      facade({ db: { get } }),
    );
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ same: true, spreadOk: 1 });
  });

  it('still serialises a tool result returned VERBATIM (a tracking proxy must never escape)', async () => {
    // Regression guard: a Proxy is not structured-cloneable, so without the deep-unwrap this
    // turns every `return someToolResult` into result_not_serializable.
    const get = async () => ({ ok: true, deep: { list: [{ x: 1 }] } });
    const r = await runOrchestrationScript(
      `return await tools.db.get({});`,
      facade({ db: { get } }),
    );
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
    const author = vi.fn(async (args: unknown) => ({ ok: true, received: args }));
    const r = await runOrchestrationScript(
      `const row = await tools.db.get({});
       return await tools.docs.author({
         tags: row.frontmatter.tags,
         documents: row.frontmatter.documents,
         plans: row.frontmatter.plans,
       });`,
      facade({ db: { get }, docs: { author } }),
    );
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
    const r = await runOrchestrationScript(
      `const viaCall = await tools.plans.get({});
       return { viaCall, list: [await tools.plans.get({})] };`,
      facade({ plans: { get } }),
    );
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual({
      viaCall: { ok: true, echoed: { slug: 's' } },
      list: [{ ok: true, echoed: { slug: 's' } }],
    });
  });

  it('bounds the report so a miss inside a hot loop cannot flood the result', async () => {
    const get = async (a: { id: number }) => ({ id: a.id });
    const r = await runOrchestrationScript(
      `const out = [];
       for (let i = 0; i < 50; i++) {
         const d = await tools.db.get({ id: i });
         out.push(d.nope ?? null);
       }
       return out.length;`,
      facade({ db: { get } }),
    );
    expect(r.ok).toBe(true);
    expect(r.result).toBe(50);
    // Distinct (tool, path, key) signatures dedupe to one; the hard cap bounds the rest.
    expect((r.fieldMisses ?? []).length).toBeGreaterThan(0);
    expect((r.fieldMisses ?? []).length).toBeLessThanOrEqual(12);
  });
});
