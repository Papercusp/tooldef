/**
 * Tests for guidance.seeAlso — result-aware cross-link pointers
 * (presence-coord-unification-2026-07-01 D-003).
 *
 * Covers the pure surface (normalize/resolve/render/read/apply) AND one
 * end-to-end pass through the real dispatch stack, proving a tool that declares
 * `guidance.seeAlso` gets `_meta._seeAlso` + a "See also:" text block rendered
 * uniformly into its envelope.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  resolveSeeAlso,
  renderSeeAlsoText,
  readJsonResult,
  applySeeAlso,
  type SeeAlso,
  type SeeAlsoPointer,
} from './see-also';
import type { ToolResult } from './wire';
import { runDispatchStack } from './dispatch-stack';
import type { ProjectedTool, UnifiedToolContext } from './tool-projection';

const textResult = (obj: unknown): ToolResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
});

describe('resolveSeeAlso', () => {
  const R = textResult({ ok: true });

  it('normalizes a bare-string array into { tool } pointers', () => {
    expect(resolveSeeAlso(['coord:roster', 'coord:glance'], R, {}, {})).toEqual([
      { tool: 'coord:roster' },
      { tool: 'coord:glance' },
    ]);
  });

  it('preserves selector + reason on structured pointers', () => {
    const seeAlso: SeeAlso = [
      { tool: 'coord:catch-up', selector: '@fleet:backend', reason: 'the backlog' },
    ];
    expect(resolveSeeAlso(seeAlso, R, {}, {})).toEqual([
      { tool: 'coord:catch-up', selector: '@fleet:backend', reason: 'the backlog' },
    ]);
  });

  it('evaluates the callback form with (result, args, ctx)', () => {
    const spy = vi.fn(
      (_r: ToolResult, _a: unknown, _c: unknown): SeeAlsoPointer[] => [
        { tool: 'fleet:assignments' },
      ],
    );
    const out = resolveSeeAlso(spy, R, { a: 1 }, { c: 2 });
    expect(out).toEqual([{ tool: 'fleet:assignments' }]);
    expect(spy).toHaveBeenCalledWith(R, { a: 1 }, { c: 2 });
  });

  it('returns [] when the callback yields null / undefined / []', () => {
    expect(resolveSeeAlso(() => null, R, {}, {})).toEqual([]);
    expect(resolveSeeAlso(() => undefined, R, {}, {})).toEqual([]);
    expect(resolveSeeAlso(() => [], R, {}, {})).toEqual([]);
  });

  it('never throws out of a broken callback — swallows and returns []', () => {
    expect(
      resolveSeeAlso(() => {
        throw new Error('boom');
      }, R, {}, {}),
    ).toEqual([]);
  });

  it('returns [] for an undefined seeAlso', () => {
    expect(resolveSeeAlso(undefined, R, {}, {})).toEqual([]);
  });

  it('filters out empty strings and objects without a tool', () => {
    const seeAlso = ['', '   ', { reason: 'no tool' }, { tool: 'ok' }] as unknown as SeeAlso;
    expect(resolveSeeAlso(seeAlso, R, {}, {})).toEqual([{ tool: 'ok' }]);
  });
});

describe('renderSeeAlsoText', () => {
  it('formats tool + selector + reason and joins with "; "', () => {
    expect(
      renderSeeAlsoText([
        { tool: 'coord:catch-up', selector: '@fleet:x', reason: 'history' },
        { tool: 'coord:roster' },
      ]),
    ).toBe('See also: coord:catch-up @fleet:x — history; coord:roster');
  });

  it('omits an absent selector or reason', () => {
    expect(renderSeeAlsoText([{ tool: 't', reason: 'why' }])).toBe('See also: t — why');
    expect(renderSeeAlsoText([{ tool: 't', selector: 's' }])).toBe('See also: t s');
  });
});

describe('readJsonResult', () => {
  it('parses the first text content block as JSON', () => {
    expect(readJsonResult<{ ok: boolean }>(textResult({ ok: true }))).toEqual({ ok: true });
  });

  it('returns undefined when the first text block is not JSON', () => {
    expect(readJsonResult({ content: [{ type: 'text' as const, text: 'not json' }] })).toBeUndefined();
  });

  it('returns undefined when there is no text content', () => {
    expect(readJsonResult({ content: [] })).toBeUndefined();
  });
});

describe('applySeeAlso', () => {
  it('appends a "See also:" text block and sets _meta._seeAlso', () => {
    const base = textResult({ ok: true });
    const out = applySeeAlso(base, ['coord:roster'], {}, {});
    expect(out._meta?._seeAlso).toEqual([{ tool: 'coord:roster' }]);
    expect(out.content.at(-1)).toEqual({ type: 'text', text: 'See also: coord:roster' });
    // original text block preserved ahead of the appended line
    expect(out.content).toHaveLength(2);
  });

  it('self-gates: a callback returning [] leaves the result byte-identical', () => {
    const base = textResult({ ended: 0 });
    const seeAlso: SeeAlso = (r) => {
      const j = readJsonResult<{ ended: number }>(r);
      return (j?.ended ?? 0) > 0 ? ['coord:catch-up'] : [];
    };
    expect(applySeeAlso(base, seeAlso, {}, {})).toBe(base);
  });

  it('fills real counts + selector from the result via the callback', () => {
    const base = textResult({ ended: 3, slug: 'backend' });
    const seeAlso: SeeAlso = (r) => {
      const j = readJsonResult<{ ended: number; slug: string }>(r);
      return j && j.ended > 0
        ? [{ tool: 'coord:catch-up', selector: `@fleet:${j.slug}`, reason: `${j.ended} ended` }]
        : [];
    };
    const out = applySeeAlso(base, seeAlso, {}, {});
    expect(out._meta?._seeAlso).toEqual([
      { tool: 'coord:catch-up', selector: '@fleet:backend', reason: '3 ended' },
    ]);
    expect(out.content.at(-1)).toEqual({
      type: 'text',
      text: 'See also: coord:catch-up @fleet:backend — 3 ended',
    });
  });

  it('passes a soft-error result through unchanged (failed calls pay nothing)', () => {
    const err: ToolResult = { content: [{ type: 'text', text: '{}' }], isError: true };
    expect(applySeeAlso(err, ['coord:roster'], {}, {})).toBe(err);
  });

  it('passes through unchanged when the tool declares no seeAlso', () => {
    const base = textResult({ ok: true });
    expect(applySeeAlso(base, undefined, {}, {})).toBe(base);
  });

  it('preserves pre-existing _meta keys', () => {
    const base: ToolResult = { content: [{ type: 'text', text: '{}' }], _meta: { keep: 1 } };
    const out = applySeeAlso(base, ['t'], {}, {});
    expect(out._meta).toEqual({ keep: 1, _seeAlso: [{ tool: 't' }] });
  });

  it('does not mutate the original result', () => {
    const base = textResult({ ok: true });
    const beforeLen = base.content.length;
    applySeeAlso(base, ['t'], {}, {});
    expect(base.content).toHaveLength(beforeLen);
    expect(base._meta).toBeUndefined();
  });
});

// ── End-to-end: seeAlso renders through the real dispatch stack ──────────────

const MAKE_CTX = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'default',
  harnessSlug: 'h',
  role: 'worker',
  runId: 'run_X',
  ...over,
});

const makeTool = (over: Partial<ProjectedTool> = {}): ProjectedTool => ({
  pluginName: 'fixture',
  description: 'fixture',
  inputSchema: { type: 'object' },
  capabilities: [],
  expose: { mcp: { name: 'fix.tool' } },
  fn: async () => textResult({ ok: true, ended: 2 }),
  ...over,
});

describe('seeAlso — end-to-end through runDispatchStack', () => {
  it('renders _meta._seeAlso + a "See also:" block into the dispatch envelope', async () => {
    const tool = makeTool({
      guidance: {
        when: 'fixture',
        seeAlso: (r) => {
          const j = readJsonResult<{ ended: number }>(r);
          return (j?.ended ?? 0) > 0 ? [{ tool: 'coord:catch-up', reason: 'history' }] : [];
        },
      },
    });
    const r = await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), {});
    expect(r.ok).toBe(true);
    expect(r.result?._meta?._seeAlso).toEqual([{ tool: 'coord:catch-up', reason: 'history' }]);
    expect(r.result?.content.at(-1)).toEqual({
      type: 'text',
      text: 'See also: coord:catch-up — history',
    });
  });

  it('self-gates end-to-end: no pointers ⇒ no "See also:" block appended', async () => {
    const tool = makeTool({
      fn: async () => textResult({ ok: true, ended: 0 }),
      guidance: {
        when: 'fixture',
        seeAlso: (r) => {
          const j = readJsonResult<{ ended: number }>(r);
          return (j?.ended ?? 0) > 0 ? ['coord:catch-up'] : [];
        },
      },
    });
    const r = await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), {});
    expect(r.ok).toBe(true);
    expect(r.result?._meta?._seeAlso).toBeUndefined();
    expect(r.result?.content).toHaveLength(1);
  });
});
