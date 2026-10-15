/**
 * WI-6554700010008923: a tool's declared `shape` must run even when its handler
 * returns a raw MCP `{ content: [{ type:'text', text: JSON }] }` result instead of
 * a `{ data }` envelope.
 *
 * Measured defect: both wrappers in define-tool.ts returned from their raw-content
 * branch BEFORE `applyPayloadTier`, so a raw result never reached the shaper.
 * `improvements:capture` declares `shape: { standard, trimmed }` to compact its
 * write echo, but its success path returns raw content, so the shaper never ran
 * (p50 5KB result, 31% of calls over the transport cap, issue.payload+body = 75-90%
 * of the bytes).
 *
 * These drive the REAL path (defineTool → dispatchProjectedTool → wrapper), on both
 * wrappers, because the raw branch exists twice and a fix at one site is invisible
 * from the other. Each positive case has a falsifier next to it: the same handler
 * on a non-mcp transport (whose verbatim-bytes contract must not change) and an
 * unshaped tool (which must keep its existing passthrough).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from './define-tool';
import { dispatchProjectedTool, type DispatchProjectedDeps } from './dispatch-projected';
import { _resetProjectionRegistryForTests, lookupByMcpName, type UnifiedToolContext } from './tool-projection';

const DEPS: DispatchProjectedDeps = {};

const ctx = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'default',
  runId: 'r',
  transport: 'mcp',
  principal: { slug: 'system:superuser', workspaceId: 'default', capabilities: new Set(['test:read']) },
  tx: {},
  ...over,
});

const ROW_COUNT = 12;
const SHAPED_MARK = 'SHAPED-BY-TIER';
const FAT_BODY = 'BODY-'.repeat(60);

/** An object WITH an array field: the shape `reencodableJsonPayload` already re-encodes. */
const rows = () => ({
  rows: Array.from({ length: ROW_COUNT }, (_, i) => ({ key: `row-${i}`, detail: 'd'.repeat(40) })),
});
/** A plain object with NO array field: the improvements:capture write-echo shape. */
const echo = () => ({ ok: true, issue: { id: 'EI-1', title: 't', body: FAT_BODY } });

const shape = {
  trimmed: (d: unknown) => {
    const v = d as { rows?: unknown[]; issue?: Record<string, unknown> };
    if (Array.isArray(v.rows)) return { rows: v.rows.slice(0, 2), tierMark: SHAPED_MARK };
    if (v.issue) return { ...v, issue: { id: v.issue.id }, tierMark: SHAPED_MARK };
    return d;
  },
};

const raw = (data: unknown, extra: Record<string, unknown> = {}) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  ...extra,
});

const textOf = (res: unknown) => {
  const envelope = res as { result?: { content?: { type: string; text?: string }[] } };
  const content = (envelope.result ?? (res as { content?: { type: string; text?: string }[] })).content;
  return content?.map((c) => c.text ?? '').join('\n') ?? '';
};

afterEach(() => _resetProjectionRegistryForTests());

for (const wrapper of ['principal-gated (legacy)', 'role-gated'] as const) {
  const slug = wrapper === 'role-gated' ? 'role' : 'legacy';

  const define = (name: string, result: unknown, withShape = true) =>
    defineTool({
      name,
      capability: 'test:read',
      description: 'fixture',
      ...(wrapper === 'role-gated' ? { requirePrincipal: false as const } : {}),
      args: z.object({}),
      ...(withShape ? { shape } : {}),
      async handler() {
        return result as never;
      },
    });

  const callResult = async (name: string, over: Partial<UnifiedToolContext> = {}) => {
    const result = await dispatchProjectedTool(lookupByMcpName(name)!, name, {}, ctx(over), DEPS);
    if (!result.ok) throw new Error('dispatch failed: ' + result.error?.code);
    return result.result!;
  };

  const call = async (name: string, over: Partial<UnifiedToolContext> = {}) =>
    textOf(await callResult(name, over));

  it.each([false, true])(
    'preserves handler _meta through MCP raw-JSON re-encoding with shape=%s',
    async (withShape) => {
      const name = 'test:raw-meta-' + slug + '-' + (withShape ? 'shaped' : 'unshaped');
      const preservePaths = ['rows[].detail'];
      define(name, raw(rows(), {
        _meta: { __papercusp_nested_result_door_preserve_paths: preservePaths },
      }), withShape);

      const result = await callResult(name, { contextTier: 'trimmed' });

      expect(result._meta?.__papercusp_nested_result_door_preserve_paths).toEqual(preservePaths);
      expect(result._meta?.format).toBe('toon');
      if (withShape) {
        expect(textOf(result)).toContain(SHAPED_MARK);
      } else {
        expect(textOf(result)).toMatch(/^format: toon\n/);
      }
    },
  );

  describe(`raw-content result + declared shape through the ${wrapper} wrapper`, () => {
    it('shapes a raw JSON body with an array field on a trimmed mcp session', async () => {
      define(`test:rrs-${slug}-rows`, raw(rows()));
      const text = await call(`test:rrs-${slug}-rows`, { contextTier: 'trimmed' });
      expect(text).toContain(SHAPED_MARK);
      expect((text.match(/\brow-\d+/g) ?? []).length).toBeLessThan(ROW_COUNT);
    });

    it('shapes a raw plain-object JSON body (the capture write echo) on a trimmed mcp session', async () => {
      define(`test:rrs-${slug}-echo`, raw(echo()));
      const text = await call(`test:rrs-${slug}-echo`, { contextTier: 'trimmed' });
      expect(text).toContain(SHAPED_MARK);
      expect(text).not.toContain(FAT_BODY);
    });

    it('a full-tier session still gets the unshaped body', async () => {
      define(`test:rrs-${slug}-full`, raw(echo()));
      const text = await call(`test:rrs-${slug}-full`);
      expect(text).not.toContain(SHAPED_MARK);
      expect(text).toContain(FAT_BODY);
    });

    it('a non-mcp transport keeps the exact raw bytes (verbatim-content contract)', async () => {
      define(`test:rrs-${slug}-http`, raw(echo()));
      const text = await call(`test:rrs-${slug}-http`, { contextTier: 'trimmed', transport: 'http' });
      expect(text).toBe(JSON.stringify(echo()));
    });

    it('an isError raw result is never shaped', async () => {
      define(`test:rrs-${slug}-err`, raw({ ok: false, error: 'boom', issue: { id: 'x', body: FAT_BODY } }, { isError: true }));
      const text = await call(`test:rrs-${slug}-err`, { contextTier: 'trimmed' });
      expect(text).not.toContain(SHAPED_MARK);
      expect(text).toContain(FAT_BODY);
    });

    it('an UNSHAPED tool keeps its plain-object raw passthrough byte-identical', async () => {
      define(`test:rrs-${slug}-noshape`, raw(echo()), false);
      const text = await call(`test:rrs-${slug}-noshape`, { contextTier: 'trimmed' });
      expect(text).toBe(JSON.stringify(echo()));
    });
  });
}
