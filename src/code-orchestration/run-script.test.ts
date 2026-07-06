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
