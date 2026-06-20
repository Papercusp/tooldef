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
});
