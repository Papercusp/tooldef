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
import { decode, type ResultFormat } from '@papercusp/result-encoding';
import { defineTool } from './define-tool';
import { dispatchProjectedTool, type DispatchProjectedDeps } from './dispatch-projected';
import { lookupByMcpName, _resetProjectionRegistryForTests, type UnifiedToolContext } from './tool-projection';
import {
  decodeDeltaCursor,
  encodeDeltaCursor,
  computeViewChecksum,
  applySemanticDelta,
  setSemanticDeltaEnabledResolver,
  resetSemanticDeltaEnabledResolver,
  type DeltaChange,
} from './delta-protocol';

interface SemRow {
  id: string;
  name: string;
  rev: number;
}
const semItemKey = (r: unknown) => (r as SemRow).id;
const semRowRevision = (r: unknown) => (r as SemRow).rev;
const sortById = (rs: SemRow[]) => [...rs].sort((a, b) => a.id.localeCompare(b.id));

/** Parse a serialized tool body back to its value (handles the `format: <fmt>` marker). */
function parseBody(text: string): unknown {
  const m = /^format: (\w+)\n/.exec(text);
  if (!m) return JSON.parse(text);
  return decode(text.slice(m[0].length), m[1] as ResultFormat);
}

// A bounded heterogeneous-free row-set, comfortably over the bypass threshold.
function makeSemRows(n = 10): SemRow[] {
  return Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `row-${i}-with-padding-text`, rev: 1 }));
}

/** Semantic-capable tool whose view revision tracks its rows (revision = view checksum). */
function defineSemanticTool(name: string, state: { rows: SemRow[] }, opts: { maxDeltaAge?: number } = {}): void {
  defineTool({
    name,
    requirePrincipal: false,
    capability: 'test:read',
    args: z.object({}),
    handler: async () => ({ data: state.rows }),
    delta: {
      revision: () => computeViewChecksum(state.rows, semItemKey, semRowRevision),
      itemKey: semItemKey,
      rowRevision: semRowRevision,
      ...(opts.maxDeltaAge !== undefined ? { maxDeltaAge: opts.maxDeltaAge } : {}),
    },
  });
}

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

describe('semantic deltas end-to-end (Lane E)', () => {
  it('first call → full body + cursor carrying the row digest + checksum', async () => {
    const state = { rows: makeSemRows() };
    defineSemanticTool('sem:first', state);
    const { meta } = await call('sem:first', { transport: 'mcp', requestedDelta: 'auto' });
    expect(meta.delta.mode).toBe('full');
    expect(meta.delta.supported).toBe(true);
    expect(meta.delta.checksum).toBe(computeViewChecksum(state.rows, semItemKey, semRowRevision));
    const decoded = decodeDeltaCursor(meta.delta.cursor)!;
    expect(Object.keys(decoded.dg ?? {})).toHaveLength(10); // digest embedded
    expect(typeof decoded.ts).toBe('number');
  });

  it('unchanged view → not_modified (revision = view checksum matched)', async () => {
    const state = { rows: makeSemRows() };
    defineSemanticTool('sem:unchanged', state);
    const first = await call('sem:unchanged', { transport: 'mcp', requestedDelta: 'auto' });
    const second = await call('sem:unchanged', { transport: 'mcp', requestedDelta: `auto~${first.meta.delta.cursor}` });
    expect(second.meta.delta.mode).toBe('not_modified');
  });

  it('changed view → mode:delta carrying ONLY the changed rows + counts + checksum; merge reconstructs the view', async () => {
    const state = { rows: makeSemRows() };
    defineSemanticTool('sem:delta', state);
    const first = await call('sem:delta', { transport: 'mcp', requestedDelta: 'auto' });
    const baseRows = parseBody(first.text) as SemRow[];
    expect(sortById(baseRows)).toEqual(sortById(state.rows)); // full snapshot recovered

    // Mutate: update r0, remove r1, add zz.
    state.rows = [
      { id: 'r0', name: 'row-0-with-padding-text', rev: 99 }, // updated
      ...state.rows.slice(2), // r1 removed
      { id: 'zz', name: 'brand-new-row', rev: 1 }, // added
    ];

    const second = await call('sem:delta', { transport: 'mcp', requestedDelta: `auto~${first.meta.delta.cursor}` });
    expect(second.meta.delta.mode).toBe('delta');
    expect(second.meta.delta.counts).toEqual({ added: 1, updated: 1, removed: 1 });

    const changes = parseBody(second.text) as DeltaChange<SemRow>[];
    // body carries ONLY the 3 changed rows, not the whole snapshot
    expect(changes).toHaveLength(3);
    expect(changes.some((c) => c.id === 'r5' && c.change === 'added')).toBe(false); // unchanged not present

    // The harness merge reconstructs the new full view exactly, and its checksum matches.
    const merged = applySemanticDelta(baseRows, changes, (r) => r.id);
    expect(sortById(merged)).toEqual(sortById(state.rows));
    expect(computeViewChecksum(merged, semItemKey, semRowRevision)).toBe(second.meta.delta.checksum);
  });

  it('explicit mode:not_modified on a changed view → full, NOT delta (harness wanted ETag-only)', async () => {
    const state = { rows: makeSemRows() };
    defineSemanticTool('sem:etagonly', state);
    const first = await call('sem:etagonly', { transport: 'mcp', requestedDelta: 'auto' });
    state.rows = [...state.rows, { id: 'zz', name: 'added-row-padding', rev: 1 }];
    const second = await call('sem:etagonly', {
      transport: 'mcp',
      requestedDelta: `not_modified~${first.meta.delta.cursor}`,
    });
    expect(second.meta.delta.mode).toBe('full');
    expect(second.meta.delta.reason).toBe('changed');
  });

  it('a prior cursor with no digest → full + reason:no_digest (cannot diff)', async () => {
    const state = { rows: makeSemRows() };
    defineSemanticTool('sem:nodigest', state);
    const first = await call('sem:nodigest', { transport: 'mcp', requestedDelta: 'auto' });
    const d = decodeDeltaCursor(first.meta.delta.cursor)!;
    const noDigestCursor = encodeDeltaCursor({ v: 1, fp: d.fp, rev: d.rev }); // strip dg + ts
    state.rows = [...state.rows, { id: 'zz', name: 'added-row-padding', rev: 1 }];
    const second = await call('sem:nodigest', { transport: 'mcp', requestedDelta: `auto~${noDigestCursor}` });
    expect(second.meta.delta.mode).toBe('full');
    expect(second.meta.delta.reason).toBe('no_digest');
  });

  it('cursor older than maxDeltaAge → full + reason:max_age (periodic forced-full)', async () => {
    const state = { rows: makeSemRows() };
    defineSemanticTool('sem:maxage', state, { maxDeltaAge: 1000 });
    const first = await call('sem:maxage', { transport: 'mcp', requestedDelta: 'auto' });
    const d = decodeDeltaCursor(first.meta.delta.cursor)!;
    const staleCursor = encodeDeltaCursor({ ...d, ts: 1 }); // ancient issued-at
    state.rows = [...state.rows, { id: 'zz', name: 'added-row-padding', rev: 1 }];
    const second = await call('sem:maxage', { transport: 'mcp', requestedDelta: `auto~${staleCursor}` });
    expect(second.meta.delta.mode).toBe('full');
    expect(second.meta.delta.reason).toBe('max_age');
  });

  it('delta-too-large guard: when every row changed, the delta is not smaller than full → full', async () => {
    const state = { rows: makeSemRows() };
    defineSemanticTool('sem:toolarge', state);
    const first = await call('sem:toolarge', { transport: 'mcp', requestedDelta: 'auto' });
    // bump EVERY row's rev → diff = all rows as 'updated' (each carrying full data) ≥ full
    state.rows = state.rows.map((r) => ({ ...r, rev: r.rev + 1 }));
    const second = await call('sem:toolarge', { transport: 'mcp', requestedDelta: `auto~${first.meta.delta.cursor}` });
    expect(second.meta.delta.mode).toBe('full');
    expect(second.meta.delta.reason).toBe('delta_too_large');
  });
});

describe('grouped-view exemplar (the plans:attention pattern — rows selector flattens groups)', () => {
  // Mirrors plans:attention: the response is a GROUPED aggregate `{ groups, tierCounts }`
  // (untouched for the UI); the diffable unit is the FLAT item set, extracted by the
  // `rows` selector. No explicit `revision` → derived from the item-set checksum.
  function defineGroupedTool(name: string, state: { groups: { key: string; items: SemRow[] }[] }): void {
    defineTool({
      name,
      requirePrincipal: false,
      capability: 'test:read',
      args: z.object({}),
      handler: async () => ({ data: { groups: state.groups, tierCounts: { decision: state.groups.length } } }),
      delta: {
        rows: (data) => {
          const g = (data as { groups?: { items?: unknown[] }[] } | null)?.groups;
          return Array.isArray(g) ? g.flatMap((x) => (Array.isArray(x.items) ? x.items : [])) : null;
        },
        itemKey: (r) => (r as SemRow).id,
        rowType: () => 'attn',
        schemaVersion: 'g-v1',
      },
    });
  }
  const flatten = (groups: { items: SemRow[] }[]) => groups.flatMap((g) => g.items);

  it('first → full grouped body + cursor digest over the flattened items + checksum', async () => {
    const state = { groups: [
      { key: 'plan-a', items: makeSemRows(6) },
      { key: 'alerts', items: makeSemRows(5).map((r) => ({ ...r, id: `a-${r.id}` })) },
    ] };
    defineGroupedTool('grp:first', state);
    const { text, meta } = await call('grp:first', { transport: 'mcp', requestedDelta: 'auto' });
    // the full body is still the grouped aggregate
    const body = parseBody(text) as { groups: { key: string }[] };
    expect(body.groups.map((g) => g.key)).toEqual(['plan-a', 'alerts']);
    expect(meta.delta.mode).toBe('full');
    // The tool declares no rowRevision → content-hash (matching plans:attention).
    expect(meta.delta.checksum).toBe(computeViewChecksum(flatten(state.groups), semItemKey));
    expect(Object.keys(decodeDeltaCursor(meta.delta.cursor)?.dg ?? {})).toHaveLength(11);
  });

  it('unchanged → not_modified (item-set checksum matched, no explicit revision)', async () => {
    const state = { groups: [{ key: 'plan-a', items: makeSemRows(8) }] };
    defineGroupedTool('grp:unchanged', state);
    const first = await call('grp:unchanged', { transport: 'mcp', requestedDelta: 'auto' });
    const second = await call('grp:unchanged', { transport: 'mcp', requestedDelta: `auto~${first.meta.delta.cursor}` });
    expect(second.meta.delta.mode).toBe('not_modified');
  });

  it('an item changed inside a group → delta carrying the changed items; merge over the flattened base reconstructs it', async () => {
    const state = { groups: [
      { key: 'plan-a', items: makeSemRows(6) },
      { key: 'alerts', items: makeSemRows(4).map((r) => ({ ...r, id: `a-${r.id}` })) },
    ] };
    defineGroupedTool('grp:delta', state);
    const first = await call('grp:delta', { transport: 'mcp', requestedDelta: 'auto' });
    const baseItems = flatten((parseBody(first.text) as { groups: { items: SemRow[] }[] }).groups);

    // Mutate within the groups: update plan-a/r0, remove alerts/a-r1, add plan-a/new.
    state.groups = [
      { key: 'plan-a', items: [{ id: 'r0', name: 'row-0-with-padding-text', rev: 42 }, ...state.groups[0].items.slice(1), { id: 'new', name: 'fresh-item-row', rev: 1 }] },
      { key: 'alerts', items: state.groups[1].items.filter((r) => r.id !== 'a-r1') },
    ];

    const second = await call('grp:delta', { transport: 'mcp', requestedDelta: `auto~${first.meta.delta.cursor}` });
    expect(second.meta.delta.mode).toBe('delta');
    expect(second.meta.delta.counts).toEqual({ added: 1, updated: 1, removed: 1 });
    const changes = parseBody(second.text) as DeltaChange<SemRow>[];
    // rowType tag carried on added/updated (removed rows carry only an id).
    expect(changes.filter((c) => c.change !== 'removed').every((c) => c.type === 'attn')).toBe(true);

    const merged = applySemanticDelta(baseItems, changes, (r) => r.id);
    expect(sortById(merged)).toEqual(sortById(flatten(state.groups)));
    expect(computeViewChecksum(merged, semItemKey)).toBe(second.meta.delta.checksum);
  });
});

describe('host flag gate (FLAGS.TOOL_DELTA_PROTOCOL via setSemanticDeltaEnabledResolver)', () => {
  // The semantic-delta upgrade is host-gated. tooldef defaults the resolver to
  // `() => true`; the Papercusp host (operator-core/agent-tools/delta-flag-wiring.ts)
  // wires it to the flag so OFF reverts to the unconditionally-safe Lane-B `full`.
  afterEach(() => resetSemanticDeltaEnabledResolver());

  it('resolver OFF: a changed view that WOULD delta degrades to full + reason:flag_off', async () => {
    setSemanticDeltaEnabledResolver(() => false);
    const state = { rows: makeSemRows() };
    defineSemanticTool('sem:flagoff', state);
    const first = await call('sem:flagoff', { transport: 'mcp', requestedDelta: 'auto' });
    state.rows = [...state.rows, { id: 'zz', name: 'added-row-padding', rev: 1 }]; // would be a 1-row delta
    const second = await call('sem:flagoff', { transport: 'mcp', requestedDelta: `auto~${first.meta.delta.cursor}` });
    expect(second.meta.delta.mode).toBe('full');
    expect(second.meta.delta.reason).toBe('flag_off');
    // full body recovers the whole new view (Lane-B correctness preserved)
    expect(sortById(parseBody(second.text) as SemRow[])).toEqual(sortById(state.rows));
  });

  it('resolver OFF still serves not_modified on an UNCHANGED view (the ETag path is flag-independent)', async () => {
    setSemanticDeltaEnabledResolver(() => false);
    const state = { rows: makeSemRows() };
    defineSemanticTool('sem:flagoff-unchanged', state);
    const first = await call('sem:flagoff-unchanged', { transport: 'mcp', requestedDelta: 'auto' });
    const second = await call('sem:flagoff-unchanged', {
      transport: 'mcp',
      requestedDelta: `auto~${first.meta.delta.cursor}`,
    });
    expect(second.meta.delta.mode).toBe('not_modified');
  });

  it('resolver ON (async, mirrors getFlag): the same changed view upgrades to mode:delta', async () => {
    setSemanticDeltaEnabledResolver(async () => true);
    const state = { rows: makeSemRows() };
    defineSemanticTool('sem:flagon', state);
    const first = await call('sem:flagon', { transport: 'mcp', requestedDelta: 'auto' });
    state.rows = [...state.rows, { id: 'zz', name: 'added-row-padding', rev: 1 }];
    const second = await call('sem:flagon', { transport: 'mcp', requestedDelta: `auto~${first.meta.delta.cursor}` });
    expect(second.meta.delta.mode).toBe('delta');
    expect(second.meta.delta.counts).toEqual({ added: 1, updated: 0, removed: 0 });
  });

  it('the resolver is consulted with the call ctx (can target per-workspace)', async () => {
    const seen: unknown[] = [];
    setSemanticDeltaEnabledResolver((c) => {
      seen.push((c as { workspaceId?: string })?.workspaceId);
      return false;
    });
    const state = { rows: makeSemRows() };
    defineSemanticTool('sem:flagctx', state);
    const first = await call('sem:flagctx', { transport: 'mcp', requestedDelta: 'auto' });
    state.rows = [...state.rows, { id: 'zz', name: 'added-row-padding', rev: 1 }];
    await call('sem:flagctx', { transport: 'mcp', requestedDelta: `auto~${first.meta.delta.cursor}`, workspaceId: 'ws-42' });
    expect(seen).toContain('ws-42'); // resolver saw the call's workspaceId
  });
});
