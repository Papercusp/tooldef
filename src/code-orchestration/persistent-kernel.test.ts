import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeOrchestrationKernel,
  inspectOrchestrationKernel,
  openOrchestrationKernel,
  runOrchestrationScript,
} from './run-script';
import type { ToolFacade } from './tool-facade';

const facade = (implementation: Record<string, unknown> = {}) => implementation as unknown as ToolFacade;
const opened: Array<{ id: string; scope: string }> = [];
async function open(scope = 'workspace:owner:harness') {
  const status = await openOrchestrationKernel(scope);
  const handle = { id: status.id, scope };
  opened.push(handle);
  return handle;
}
afterEach(() => {
  for (const handle of opened.splice(0)) closeOrchestrationKernel(handle.id, handle.scope);
  vi.useRealTimers();
});

describe('persistent orchestration worker lifetime', () => {
  it('retains live objects, binary values and functions across cells without replay inputs', async () => {
    const kernel = await open();
    const first = await runOrchestrationScript(`
      globalThis.data = { count: 2, bytes: new Uint8Array([0, 127, 255]) };
      globalThis.increment = () => ++data.count;
      const cellLocal = 'private';
      return increment();`, facade(), { kernel });
    expect(first.ok).toBe(true);
    expect(first.result).toBe(3);
    const second = await runOrchestrationScript(`return {
      count: increment(), bytes: Array.from(data.bytes), local: typeof cellLocal,
      node: [typeof process, typeof require, typeof Buffer],
    };`, facade(), { kernel });
    expect(second.result).toEqual({ count: 4, bytes: [0, 127, 255], local: 'undefined', node: ['undefined', 'undefined', 'undefined'] });
    expect(second.state).toBeUndefined();
    expect(second.kernel).toMatchObject({ state: 'live', statePersistence: 'globalThis', restartRecovery: 'unrecoverable' });
  });

  it('uses the current cell facade instead of a cached authority envelope', async () => {
    const kernel = await open();
    const previous = vi.fn(async () => 'previous');
    expect((await runOrchestrationScript('return await tools.private.read({});', facade({ private: { read: previous } }), { kernel })).result).toBe('previous');
    const denied = await runOrchestrationScript('return await tools.private.read({});', facade(), { kernel });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('not available');
    expect(previous).toHaveBeenCalledOnce();
    const current = vi.fn(async () => 'current');
    expect((await runOrchestrationScript('return await tools.private.read({});', facade({ private: { read: current } }), { kernel })).result).toBe('current');
  });

  it('composes retained tracked tool results into later returns and tool arguments', async () => {
    const kernel = await open();
    await runOrchestrationScript('globalThis.saved = await tools.data.get({}); return true;', facade({ data: { get: async () => ({ rows: [{ value: 3 }] }) } }), { kernel });
    const echo = vi.fn(async (args) => args);
    const result = await runOrchestrationScript('const missing = saved.rows[0].missing; return await tools.echo.get({ saved });', facade({ echo: { get: echo } }), { kernel });
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ saved: { rows: [{ value: 3 }] } });
    expect(echo).toHaveBeenCalledWith({ saved: { rows: [{ value: 3 }] } });
    expect(result.fieldMisses).toContainEqual(expect.objectContaining({ read: 'missing', tool: 'data:get' }));
  });

  it('cleans up unawaited cell timers before the next cell can observe late mutations', async () => {
    const kernel = await open();
    await runOrchestrationScript('void sleep(80).then(() => { globalThis.late = true; }); return 1;', facade(), { kernel });
    const next = await runOrchestrationScript('await sleep(120); return typeof late;', facade(), { kernel });
    expect(next.result).toBe('undefined');
  });

  it('cannot reuse a captured previous-cell dispatch function', async () => {
    const kernel = await open();
    const write = vi.fn(async () => ({ ok: true }));
    await runOrchestrationScript('globalThis.stale = () => tools.write.commit({}); return true;', facade({ write: { commit: write } }), { kernel });
    const result = await runOrchestrationScript('return await stale();', facade(), { kernel });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('kernel_cell_ended');
    expect(write).not.toHaveBeenCalled();
  });

  it('fails closed for another owner/workspace scope and unknown restart handles', async () => {
    const kernel = await open('workspace-a:owner-a');
    const call = vi.fn(async () => 'should not run');
    const foreign = await runOrchestrationScript('return await tools.write.commit({});', facade({ write: { commit: call } }), {
      kernel: { ...kernel, scope: 'workspace-b:owner-a' },
    });
    expect(foreign.error).toContain('kernel_unrecoverable');
    expect(closeOrchestrationKernel(kernel.id, 'workspace-a:owner-b').state).toBe('unrecoverable');
    expect(inspectOrchestrationKernel(kernel.id, kernel.scope).state).toBe('live');
    expect(inspectOrchestrationKernel('lost-before-process-restart', kernel.scope).restartRecovery).toBe('unrecoverable');
    expect(call).not.toHaveBeenCalled();
  });

  it('rejects concurrent cells rather than interleaving state or dispatch contexts', async () => {
    const kernel = await open();
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    let release!: (value: number) => void;
    const held = new Promise<number>((resolve) => { release = resolve; });
    const first = runOrchestrationScript('return await tools.wait.get({});', facade({ wait: { get: () => { entered(); return held; } } }), { kernel });
    await entry;
    const concurrent = await runOrchestrationScript('globalThis.changed = true; return true;', facade(), { kernel });
    expect(concurrent.error).toContain('kernel_busy');
    release(7);
    expect((await first).result).toBe(7);
    expect((await runOrchestrationScript('return typeof changed;', facade(), { kernel })).result).toBe('undefined');
  });

  it('kills synchronous runaway cells and reports the resulting state loss', async () => {
    const kernel = await open();
    await runOrchestrationScript('globalThis.saved = 9; return saved;', facade(), { kernel });
    const result = await runOrchestrationScript('while (true) {}', facade(), { kernel, timeoutMs: 100 });
    expect(result.error).toContain('script_timeout');
    expect(result.kernel?.state).toBe('lost');
    expect((await runOrchestrationScript('return saved;', facade(), { kernel })).error).toContain('kernel_unrecoverable');
  });

  it('cancels active cells and calls the existing host settlement hook', async () => {
    const kernel = await open();
    const abort = new AbortController();
    const settle = vi.fn();
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    const running = runOrchestrationScript('await tools.wait.get({}); return true;', facade({ wait: { get: () => { entered(); return new Promise(() => {}); } } }), {
      kernel, signal: abort.signal, onTimeout: settle,
    });
    await entry;
    abort.abort();
    expect((await running).error).toContain('script_aborted');
    expect(settle).toHaveBeenCalledOnce();
    expect(inspectOrchestrationKernel(kernel.id, kernel.scope).state).toBe('lost');
  });

  it('explicit close cancels active work before retiring its worker', async () => {
    const kernel = await open();
    const settle = vi.fn();
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    const running = runOrchestrationScript('await tools.wait.get({});', facade({ wait: { get: () => { entered(); return new Promise(() => {}); } } }), { kernel, onTimeout: settle });
    await entry;
    expect(closeOrchestrationKernel(kernel.id, kernel.scope).state).toBe('closed');
    const result = await running;
    expect(result.error).toContain('kernel_closed');
    expect(result.kernel?.state).toBe('closed');
    expect(settle).toHaveBeenCalledOnce();
    expect(closeOrchestrationKernel(kernel.id, kernel.scope).state).toBe('closed');
  });

  it('bounds console/media output per cell and resets replay inputs', async () => {
    const kernel = await open();
    const result = await runOrchestrationScript(`
      for (let i = 0; i < 10; i++) log('λ' + i);
      generatedImage({image_url: 'data:image/png;base64,aGVsbG8='});
      store('explicit', 5); return inputs.value;`, facade(), { kernel, maxLogLines: 2, inputs: { value: 8 } });
    expect(result.logs).toEqual(['λ0', 'λ1']);
    expect(result.generatedImages).toHaveLength(1);
    expect(result.result).toBe(8);
    const next = await runOrchestrationScript('return { value: inputs.value, oldReplay: load("explicit") };', facade(), { kernel, inputs: { value: 9 } });
    expect(next.result).toEqual({ value: 9, oldReplay: undefined });
    expect(next.logs).toEqual([]);
    expect(next.generatedImages).toBeUndefined();
  });

  it('caps live workers per scope and releases capacity on close', async () => {
    const scope = 'bounded:scope';
    const four = await Promise.all(Array.from({ length: 4 }, () => open(scope)));
    await expect(open(scope)).rejects.toThrow('kernel_scope_limit');
    closeOrchestrationKernel(four[0].id, scope);
    expect((await open(scope)).id).toBeTruthy();
    expect((await open('separate:scope')).id).toBeTruthy();
  });

  it('expires idle workers without claiming restart recovery', async () => {
    const kernel = await open();
    vi.useFakeTimers();
    await runOrchestrationScript('return 1;', facade(), { kernel });
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(inspectOrchestrationKernel(kernel.id, kernel.scope)).toMatchObject({ state: 'closed', reason: 'idle-expired', restartRecovery: 'unrecoverable' });
  });
});
