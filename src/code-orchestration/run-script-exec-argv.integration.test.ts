import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const subject = pathToFileURL(resolve(__dirname, 'run-script.ts')).href;

describe('orchestration workers from an inline ESM parent', () => {
  it.each([
    { kind: 'one-shot', flags: ['--input-type=module'] },
    { kind: 'one-shot', flags: ['--input-type', 'module'] },
    { kind: 'persistent', flags: ['--input-type=module'] },
    { kind: 'persistent', flags: ['--input-type', 'module'] },
  ])('runs $kind with $flags while retaining the parent loader', ({ kind, flags }) => {
    const script = `
      import assert from 'node:assert/strict';
      const { runOrchestrationScript, openOrchestrationKernel, closeOrchestrationKernel } =
        await import(${JSON.stringify(subject)});
      const scope = 'esm-parent-regression';
      const kernel = ${JSON.stringify(kind)} === 'persistent'
        ? await openOrchestrationKernel(scope) : undefined;
      try {
        const result = await runOrchestrationScript('return { executed: true };', {}, {
          timeoutMs: 10_000,
          ...(kernel ? { kernel: { id: kernel.id, scope } } : {}),
        });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.deepEqual(result.result, { executed: true });
        console.log('WORKER_ENTRY_MODE_OK');
      } finally {
        if (kernel) closeOrchestrationKernel(kernel.id, scope);
      }
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', ...flags, '--eval', script], {
      encoding: 'utf8', timeout: 30_000,
    });
    expect(result.status, result.stdout + '\n' + result.stderr).toBe(0);
    expect(result.stdout).toContain('WORKER_ENTRY_MODE_OK');
  }, 35_000);
});
