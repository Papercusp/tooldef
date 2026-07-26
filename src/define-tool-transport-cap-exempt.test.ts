/**
 * EI-18719561823587590: `applyPayloadTier` shapes in two INDEPENDENT steps —
 * (1) tier shaping, and (2) a HARD CEILING that force-applies the generic
 * bounded projection to any result over `PAYLOAD_TIER_HARD_CEILING_CHARS`
 * REGARDLESS of the resolved tier. Step 2's only exit was an explicit per-call
 * `payloadTier:'full'` arg.
 *
 * That gap silently truncated `code:run`'s INTERMEDIATE results. A prior fix
 * (EI-18699443874201617) cleared `ctx.contextTier` for inner calls, which skips
 * step 1 only — so a merely-LARGE inner result was still row-truncated, and a
 * script's in-script `.filter()`/`.find()` searched a subset with a miss
 * indistinguishable from real absence. `ctx.transportCapExempt` is step 2's
 * exit for an in-process consumer whose result never reaches an agent context.
 *
 * These drive the REAL dispatch path (dispatchProjectedTool → wrapper →
 * applyPayloadTier), not a handler called directly — per define-tool.ts's own
 * warning that a handler-level test proves only that the handler READS a ctx
 * field, never that dispatch DELIVERS it. Both wrapper paths are covered: the
 * principal-gated (legacy) one and the role-gated one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from './define-tool';
import { dispatchProjectedTool, type DispatchProjectedDeps } from './dispatch-projected';
import { PAYLOAD_TIER_HARD_CEILING_CHARS } from './payload-tier';
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

/**
 * A row set that comfortably overruns the ceiling, shaped like the real
 * `facts:list` payload the bug was measured on — with a needle in a row late
 * enough to be dropped by the bounded projection.
 */
const ROW_COUNT = 40;
const NEEDLE = 'bug-drain-skip-p2p';
const fatRows = () => ({
  count: ROW_COUNT,
  facts: Array.from({ length: ROW_COUNT }, (_, i) => ({
    key: i === ROW_COUNT - 10 ? NEEDLE : `fact-${i}`,
    body: 'x'.repeat(Math.ceil(PAYLOAD_TIER_HARD_CEILING_CHARS / 12)),
  })),
});

/** Parse the tool result back to the data the CALLER (or an in-script read) sees. */
const readBack = (res: unknown): { count?: number; facts?: { key: string }[]; _projection?: { truncated?: boolean } } => {
  const content = (res as { content?: { type: string; text?: string }[] }).content;
  const text = content?.find((c) => c.type === 'text')?.text ?? '{}';
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

afterEach(() => _resetProjectionRegistryForTests());

describe('transportCapExempt — the hard-ceiling exit for in-process consumers (EI-18719561823587590)', () => {
  describe('principal-gated (legacy) wrapper', () => {
    const define = (name: string) =>
      defineTool({
        name,
        capability: 'test:read',
        description: 'fixture',
        args: z.object({}),
        async handler() {
          return { data: fatRows() };
        },
      });

    it('WITHOUT the flag an over-ceiling result is force-truncated (the pre-fix behaviour, still correct for a transport caller)', async () => {
      define('test:cap-legacy-off');
      const res = await dispatchProjectedTool(
        lookupByMcpName('test:cap-legacy-off')!,
        'test:cap-legacy-off',
        {},
        ctx(),
        DEPS,
      );
      const data = readBack(res);
      // This is the exact failure the bug report measured: fewer rows than the
      // tool returned, and the searched-for key simply absent.
      expect(data.facts?.length ?? 0).toBeLessThan(ROW_COUNT);
      expect(data.facts?.some((f) => f.key === NEEDLE) ?? false).toBe(false);
      expect(data._projection?.truncated).toBe(true);
    });

    it('WITH the flag the script sees every row — including the one the projection dropped', async () => {
      define('test:cap-legacy-on');
      const res = await dispatchProjectedTool(
        lookupByMcpName('test:cap-legacy-on')!,
        'test:cap-legacy-on',
        {},
        ctx({ transportCapExempt: true }),
        DEPS,
      );
      const data = readBack(res);
      expect(data.facts?.length).toBe(ROW_COUNT);
      expect(data.facts?.some((f) => f.key === NEEDLE)).toBe(true);
      expect(data._projection).toBeUndefined();
    });
  });

  describe('role-gated wrapper', () => {
    const define = (name: string) =>
      defineTool({
        name,
        capability: 'test:read',
        description: 'fixture',
        requirePrincipal: false as const,
        args: z.object({}),
        async handler() {
          return { data: fatRows() };
        },
      });

    it('WITHOUT the flag an over-ceiling result is force-truncated', async () => {
      define('test:cap-role-off');
      const res = await dispatchProjectedTool(
        lookupByMcpName('test:cap-role-off')!,
        'test:cap-role-off',
        {},
        ctx(),
        DEPS,
      );
      const data = readBack(res);
      expect(data.facts?.length ?? 0).toBeLessThan(ROW_COUNT);
      expect(data._projection?.truncated).toBe(true);
    });

    it('WITH the flag the full payload survives', async () => {
      define('test:cap-role-on');
      const res = await dispatchProjectedTool(
        lookupByMcpName('test:cap-role-on')!,
        'test:cap-role-on',
        {},
        ctx({ transportCapExempt: true }),
        DEPS,
      );
      const data = readBack(res);
      expect(data.facts?.length).toBe(ROW_COUNT);
      expect(data.facts?.some((f) => f.key === NEEDLE)).toBe(true);
    });
  });

  /**
   * Direction-of-error guard. The exemption must not become a blanket
   * uncapping: an ordinary transport caller — including one whose SESSION tier
   * resolves to 'full' — must still be capped, because an over-cap payload on
   * the MCP transport is a hard failure. Only the explicit per-call
   * `payloadTier:'full'` arg (WI-5078) and this ctx flag are exits.
   */
  it('a session-level full tier is still NOT an exemption — only the explicit arg or the ctx flag', async () => {
    defineTool({
      name: 'test:cap-session-full',
      capability: 'test:read',
      description: 'fixture',
      args: z.object({}),
      async handler() {
        return { data: fatRows() };
      },
    });
    const res = await dispatchProjectedTool(
      lookupByMcpName('test:cap-session-full')!,
      'test:cap-session-full',
      {},
      ctx({ contextTier: 'full' }),
      DEPS,
    );
    const data = readBack(res);
    expect(data.facts?.length ?? 0).toBeLessThan(ROW_COUNT);
    expect(data._projection?.truncated).toBe(true);
  });
});
