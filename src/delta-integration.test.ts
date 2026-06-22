/**
 * End-to-end freshness negotiation through the real defineTool → projected
 * dispatcher path (agent-tool-delta-protocol-2026-06-22, Lane B / P-005).
 * Verifies the WIRING — `delta` capability declared at registration, the
 * projectedFn computing the fingerprint + revision and delegating to
 * `negotiateDelta`, `ctx.requestedDelta` driving the outcome, body suppression
 * on `not_modified` — not just the pure core in isolation.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from './define-tool';
import { dispatchProjectedTool, type DispatchProjectedDeps } from './dispatch-projected';
import { lookupByMcpName, _resetProjectionRegistryForTests, type UnifiedToolContext } from './tool-projection';
import { decodeDeltaCursor } from './delta-protocol';

const DEPS: DispatchProjectedDeps = {};

const ctx = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'w',
  runId: 'r',
  ...over,
});

// 12 rows, comfortably over the small-response bypass threshold (256 bytes).
const ROWS = Array.from({ length: 12 }, (_, i) => ({ id: i, name: `row-${i}-with-some-padding-text` }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Meta = Record<string, any>;

async function call(name: string, over: Partial<UnifiedToolContext> = {}): Promise<{ text: string; meta: Meta }> {
  const tool = lookupByMcpName(name)!;
  const r = await dispatchProjectedTool(tool, name, {}, ctx(over), DEPS);
  if (!r.ok) throw new Error(`dispatch failed: ${r.error?.code}`);
  const result = r.result!;
  const text = (result.content[0] as { text: string }).text;
  return { text, meta: (result._meta ?? {}) as Meta };
}

function defineDeltaTool(
  name: string,
  revRef: { v: string },
  opts: { data?: unknown; scope?: (a: unknown, c: unknown) => string; schemaVersion?: string } = {},
): void {
  defineTool({
    name,
    requirePrincipal: false,
    capability: 'test:read',
    args: z.object({}),
    handler: async () => ({ data: opts.data ?? ROWS }),
    delta: {
      revision: () => revRef.v,
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(opts.schemaVersion ? { schemaVersion: opts.schemaVersion } : {}),
    },
  });
}

function defineNoCapTool(name: string): void {
  defineTool({
    name,
    requirePrincipal: false,
    capability: 'test:read',
    args: z.object({}),
    handler: async () => ({ data: ROWS }),
  });
}

afterEach(() => _resetProjectionRegistryForTests());

describe('delta negotiation end-to-end through defineTool', () => {
  it('first call (no _delta) on a delta-capable tool → full body + fresh cursor', async () => {
    const rev = { v: 'r1' };
    defineDeltaTool('delta:basic1', rev);
    const { text, meta } = await call('delta:basic1', { transport: 'mcp' });
    expect(meta.delta.mode).toBe('full');
    expect(meta.delta.supported).toBe(true);
    expect(meta.delta.reason).toBe('no_request');
    expect(typeof meta.delta.cursor).toBe('string');
    expect(decodeDeltaCursor(meta.delta.cursor)?.rev).toBe('r1');
    // the full body is still served (compact TOON for the array)
    expect(text).toMatch(/^format: toon\n/);
    expect(text).toContain('row-0');
  });

  it('a matching cursor on an UNCHANGED view → not_modified, body suppressed', async () => {
    const rev = { v: 'r1' };
    defineDeltaTool('delta:basic2', rev);
    const first = await call('delta:basic2', { transport: 'mcp' });
    const second = await call('delta:basic2', {
      transport: 'mcp',
      requestedDelta: `not_modified~${first.meta.delta.cursor}`,
    });
    expect(second.meta.delta.mode).toBe('not_modified');
    expect(second.meta.delta.supported).toBe(true);
    expect(second.text).toMatch(/^mode: not_modified/);
    expect(second.text).toContain('count: 12');
    // the snapshot body is NOT replayed
    expect(second.text).not.toContain('row-0');
    // a fresh cursor is still minted for the next round
    expect(decodeDeltaCursor(second.meta.delta.cursor)?.rev).toBe('r1');
    // and _meta.format is left unset (no compact body to tag)
    expect(second.meta.format).toBeUndefined();
  });

  it('a cursor on a CHANGED view (revision advanced) → full body + reason:changed', async () => {
    const rev = { v: 'r1' };
    defineDeltaTool('delta:basic3', rev);
    const first = await call('delta:basic3', { transport: 'mcp' });
    rev.v = 'r2'; // the view changed between calls
    const second = await call('delta:basic3', {
      transport: 'mcp',
      requestedDelta: `not_modified~${first.meta.delta.cursor}`,
    });
    expect(second.meta.delta.mode).toBe('full');
    expect(second.meta.delta.reason).toBe('changed');
    expect(second.text).toMatch(/^format: toon\n/);
    expect(second.text).toContain('row-0');
    expect(decodeDeltaCursor(second.meta.delta.cursor)?.rev).toBe('r2');
  });

  it('the cursor is bound to the requested format (changing format → view_changed → full)', async () => {
    const rev = { v: 'r1' };
    defineDeltaTool('delta:fmtbind', rev);
    const compact = await call('delta:fmtbind', { transport: 'mcp', requestedFormat: 'compact' });
    const asJson = await call('delta:fmtbind', {
      transport: 'mcp',
      requestedFormat: 'json',
      requestedDelta: `not_modified~${compact.meta.delta.cursor}`,
    });
    expect(asJson.meta.delta.mode).toBe('full');
    expect(asJson.meta.delta.reason).toBe('view_changed');
  });

  it('schemaVersion bump invalidates an outstanding cursor → full + schema_changed', async () => {
    const rev = { v: 'r1' };
    // Mint a cursor under v1...
    defineDeltaTool('delta:sv', rev, { schemaVersion: 'v1' });
    const first = await call('delta:sv', { transport: 'mcp' });
    _resetProjectionRegistryForTests();
    // ...then the endpoint ships v2.
    defineDeltaTool('delta:sv', rev, { schemaVersion: 'v2' });
    const second = await call('delta:sv', {
      transport: 'mcp',
      requestedDelta: `not_modified~${first.meta.delta.cursor}`,
    });
    expect(second.meta.delta.mode).toBe('full');
    expect(second.meta.delta.reason).toBe('schema_changed');
    expect(decodeDeltaCursor(second.meta.delta.cursor)?.sv).toBe('v2');
  });

  it('small-response bypass: a tiny body skips delta machinery (full, no cursor)', async () => {
    const rev = { v: 'r1' };
    defineDeltaTool('delta:tiny', rev, { data: [{ id: 1 }] });
    const { meta } = await call('delta:tiny', { transport: 'mcp', requestedDelta: 'auto' });
    expect(meta.delta.mode).toBe('full');
    expect(meta.delta.supported).toBe(true);
    expect(meta.delta.reason).toBe('bypass');
    expect(meta.delta.cursor).toBeUndefined();
  });

  it('a non-capable tool given a _delta request → full + supported:false (harness stops asking)', async () => {
    defineNoCapTool('delta:nocap1');
    const { text, meta } = await call('delta:nocap1', { transport: 'mcp', requestedDelta: 'not_modified~whatever' });
    expect(meta.delta.mode).toBe('full');
    expect(meta.delta.supported).toBe(false);
    expect(meta.delta.reason).toBe('not_capable');
    expect(meta.delta.cursor).toBeUndefined();
    expect(text).toMatch(/^format: toon\n/); // full body unchanged
  });

  it('a non-capable tool with NO _delta request → no _meta.delta at all (zero overhead)', async () => {
    defineNoCapTool('delta:nocap2');
    const { meta } = await call('delta:nocap2', { transport: 'mcp' });
    expect(meta.delta).toBeUndefined();
  });

  it('a revision source that throws degrades to a full body (never fails the call)', async () => {
    defineTool({
      name: 'delta:throws',
      requirePrincipal: false,
      capability: 'test:read',
      args: z.object({}),
      handler: async () => ({ data: ROWS }),
      delta: {
        revision: () => {
          throw new Error('db down');
        },
      },
    });
    const { text, meta } = await call('delta:throws', { transport: 'mcp', requestedDelta: 'auto' });
    expect(meta.delta.mode).toBe('full');
    expect(meta.delta.reason).toBe('revision_error');
    expect(text).toMatch(/^format: toon\n/);
  });
});
