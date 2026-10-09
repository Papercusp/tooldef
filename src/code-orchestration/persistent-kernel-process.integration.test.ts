import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('./__fixtures__/persistent-kernel-worker.mts', import.meta.url));
const scope = JSON.stringify(['process-proof-workspace', 'process-proof-owner', 'process-proof-harness']);
const workers: ChildProcess[] = [];
let sequence = 0;

async function start(): Promise<ChildProcess> {
  const child = fork(fixture, [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  workers.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('kernel worker fixture did not start')), 20_000);
    const exited = (code: number | null) => finish(new Error(`kernel worker fixture exited: ${code}`));
    const ready = (message: unknown) => { if ((message as { ready?: boolean })?.ready) finish(); };
    function finish(error?: Error) {
      clearTimeout(timer); child.off('message', ready); child.off('exit', exited);
      if (error) reject(error); else resolve();
    }
    child.on('message', ready); child.once('exit', exited);
  });
  return child;
}

async function call(child: ChildProcess, op: string, extra: Record<string, unknown> = {}) {
  const seq = ++sequence;
  return await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`kernel fixture ${op} did not answer`)), 10_000);
    const exited = () => finish(new Error('kernel worker exited while a call was pending'));
    const response = (message: any) => {
      if (message?.seq === seq) finish(message.error ? new Error(message.error) : undefined, message);
    };
    function finish(error?: Error, result?: unknown) {
      clearTimeout(timer); child.off('message', response); child.off('exit', exited);
      if (error) reject(error); else resolve(result);
    }
    child.on('message', response); child.once('exit', exited);
    child.send({ seq, op, scope, ...extra }, (error) => { if (error) finish(error); });
  });
}

beforeAll(async () => { await Promise.all([start(), start()]); }, 30_000);
afterAll(async () => {
  await Promise.all(workers.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit;
  }));
});

describe('persistent kernel process-boundary truth', () => {
  it('retains state on its owner and refuses a sibling without replaying or replacing the VM', async () => {
    const [owner, sibling] = workers;
    expect(owner.pid).not.toBe(sibling.pid);
    const opened = await call(owner, 'open'); const id = opened.result.id;
    expect((await call(owner, 'run', { id, script: 'globalThis.counter = 40; return counter;' })).result.result).toBe(40);
    const foreign = await call(sibling, 'run', { id, script: 'globalThis.counter = 900; return counter;' });
    expect(foreign.result).toMatchObject({ ok: false, kernel: { id, state: 'unrecoverable', restartRecovery: 'unrecoverable' } });
    expect(foreign.result.error).toContain('kernel_unrecoverable');
    expect((await call(owner, 'run', { id, script: 'return ++counter;' })).result.result).toBe(41);
    expect((await call(sibling, 'close', { id })).result.state).toBe('unrecoverable');
    expect((await call(owner, 'status', { id })).result.state).toBe('live');
    expect((await call(owner, 'close', { id })).result.state).toBe('closed');
  });

  it('reports the old lifetime as unrecoverable after a fresh owner process starts', async () => {
    const owner = workers[0]; const { result: opened } = await call(owner, 'open');
    await call(owner, 'run', { id: opened.id, script: 'globalThis.saved = 7; return saved;' });
    const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited;
    const replacement = await start();
    expect((await call(replacement, 'status', { id: opened.id })).result).toMatchObject({ state: 'unrecoverable', restartRecovery: 'unrecoverable' });
    expect((await call(replacement, 'run', { id: opened.id, script: 'return saved;' })).result.ok).toBe(false);
    const fresh = await call(replacement, 'open');
    expect((await call(replacement, 'run', { id: fresh.result.id, script: 'return typeof saved;' })).result.result).toBe('undefined');
    await call(replacement, 'close', { id: fresh.result.id });
  });
});
