import { describe, expect, it, vi } from 'vitest';
import { mergeBulkEnvelopes, runBulk } from './_bulk';

describe('shared bulk executor', () => {
  it('loads and executes without the Zod authoring adapter', async () => {
    vi.resetModules();
    vi.doMock('zod', () => {
      throw new Error('The neutral bulk executor must not load Zod.');
    });
    try {
      const neutral = await import('./_bulk');
      expect(neutral.toList('a')).toEqual(['a']);
      expect(await neutral.runBulk(['a'], async id => ({ ok: true, id }))).toEqual({
        ok: true,
        results: [{ ok: true, id: 'a' }],
        counts: { ok: 1, failed: 0 },
      });
    } finally {
      vi.doUnmock('zod');
      vi.resetModules();
    }
  });

  it('isolates a thrown operation and retains repeated business keys', async () => {
    const calls: number[] = [];
    const result = await runBulk([1, 1, 2], async (id, index) => {
      calls.push(index);
      if (index === 1) throw new Error('denied');
      return { ok: true, id, index };
    }, { keyOf: (id, index) => ({ id, index }) });
    expect(calls).toEqual([0, 1, 2]);
    expect(result).toEqual({
      ok: false,
      results: [
        { ok: true, id: 1, index: 0 },
        { ok: false, id: 1, index: 1, error: 'denied' },
        { ok: true, id: 2, index: 2 },
      ],
      counts: { ok: 2, failed: 1 },
    });
  });

  it('bounds active work and retains input order after out-of-order completion', async () => {
    const started: number[] = [];
    const finish = new Map<number, () => void>();
    let signalThird!: () => void;
    const thirdStarted = new Promise<void>(resolve => { signalThird = resolve; });
    const pending = runBulk([0, 1, 2], async id => {
      started.push(id);
      if (id === 2) signalThird();
      await new Promise<void>(resolve => { finish.set(id, resolve); });
      return { ok: true, id };
    }, { maxConcurrency: 2 });
    expect(started).toEqual([0, 1]);
    finish.get(1)!();
    await thirdStarted;
    expect(started).toEqual([0, 1, 2]);
    finish.get(2)!();
    finish.get(0)!();
    expect((await pending).results.map(row => row.id)).toEqual([0, 1, 2]);
  });

  it('derives a merged failure even when the first envelope succeeded', async () => {
    const good = await runBulk([1], async id => ({ ok: true, id }));
    const bad = await runBulk([2], async id => ({ ok: false, id }));
    expect(mergeBulkEnvelopes<{ ok: boolean; id: number }>([good, bad])).toEqual({
      ok: false, results: [{ ok: true, id: 1 }, { ok: false, id: 2 }],
      counts: { ok: 1, failed: 1 },
    });
  });
});
