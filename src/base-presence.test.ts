/**
 * base-presence.test.ts — the harness base-presence contract (D-006), rule by rule.
 * Pure unit; no I/O. Each describe maps to a numbered rule in
 * `agent-insights/tool-delta-base-presence-contract.mdx`.
 */
import { describe, expect, it } from 'vitest';
import { BasePresenceTracker, dispatchWithBasePresence } from './base-presence';
import { DeltaToolClient, type DeltaResponse } from './delta-client';
import { computeViewChecksum } from './delta-protocol';

const VK = 'plans:attention:scopeA';
const idKey = (r: unknown): string => String((r as { id: string }).id);

describe('BasePresenceTracker — cold / rule 2 (haveBase + negotiation)', () => {
  it('a cold view has no base and negotiates full', () => {
    const t = new BasePresenceTracker();
    expect(t.haveBase(VK)).toBe(false);
    expect(t.negotiationFor(VK)).toBe('full');
    expect(t.size).toBe(0);
  });

  it('negotiates not_modified~cursor once a base is established', () => {
    const t = new BasePresenceTracker();
    t.onFull(VK, 'cur-1');
    expect(t.haveBase(VK)).toBe(true);
    expect(t.negotiationFor(VK)).toBe('not_modified~cur-1');
  });

  it('negotiates auto~cursor when a semantic delta is wanted', () => {
    const t = new BasePresenceTracker();
    t.onFull(VK, 'cur-1');
    expect(t.negotiationFor(VK, true)).toBe('auto~cur-1');
  });

  it('an empty cursor still yields a well-formed single-~ wire value', () => {
    const t = new BasePresenceTracker();
    t.onFull(VK, undefined); // server may omit the cursor (e.g. small-response bypass)
    expect(t.negotiationFor(VK)).toBe('not_modified~');
  });
});

describe('rule 5 — a full response (re)establishes the base', () => {
  it('stores the base + cursor', () => {
    const t = new BasePresenceTracker();
    t.onFull(VK, 'cur-1');
    expect(t.haveBase(VK)).toBe(true);
    expect(t.size).toBe(1);
  });

  it('a later full replaces the cursor', () => {
    const t = new BasePresenceTracker();
    t.onFull(VK, 'cur-1');
    t.onFull(VK, 'cur-2');
    expect(t.negotiationFor(VK)).toBe('not_modified~cur-2');
    expect(t.size).toBe(1);
  });
});

describe('rule 4 — not_modified keeps the base, refreshes the cursor', () => {
  it('base stays present; cursor advances', () => {
    const t = new BasePresenceTracker();
    t.onFull(VK, 'cur-1');
    t.onNotModified(VK, 'cur-2');
    expect(t.haveBase(VK)).toBe(true);
    expect(t.negotiationFor(VK)).toBe('not_modified~cur-2');
  });

  it('a not_modified with no cursor keeps the prior cursor', () => {
    const t = new BasePresenceTracker();
    t.onFull(VK, 'cur-1');
    t.onNotModified(VK, undefined);
    expect(t.negotiationFor(VK)).toBe('not_modified~cur-1');
  });

  it('a not_modified for an UNtracked view is a no-op (no base conjured)', () => {
    const t = new BasePresenceTracker();
    t.onNotModified(VK, 'cur-x');
    expect(t.haveBase(VK)).toBe(false);
    expect(t.negotiationFor(VK)).toBe('full');
  });
});

describe('delta — keeps the base (client merged it), refreshes the cursor', () => {
  it('base stays present; cursor advances', () => {
    const t = new BasePresenceTracker();
    t.onFull(VK, 'cur-1');
    t.onDelta(VK, 'cur-2');
    expect(t.haveBase(VK)).toBe(true);
    expect(t.negotiationFor(VK)).toBe('not_modified~cur-2');
  });

  it('a delta for an untracked view is a no-op', () => {
    const t = new BasePresenceTracker();
    t.onDelta(VK, 'cur-x');
    expect(t.haveBase(VK)).toBe(false);
  });
});

describe('rule 6 — supported:false untracks the view', () => {
  it('onUnsupported drops the base', () => {
    const t = new BasePresenceTracker();
    t.onFull(VK, 'cur-1');
    t.onUnsupported(VK);
    expect(t.haveBase(VK)).toBe(false);
    expect(t.negotiationFor(VK)).toBe('full');
    expect(t.size).toBe(0);
  });

  it('record(supported=false) untracks regardless of mode', () => {
    const t = new BasePresenceTracker();
    t.onFull(VK, 'cur-1');
    t.record(VK, 'not_modified', 'cur-2', false);
    expect(t.haveBase(VK)).toBe(false);
  });
});

describe('rule 3 — compaction clears every base (rebootstrap-pending)', () => {
  it('after compaction all views negotiate full', () => {
    const t = new BasePresenceTracker();
    t.onFull('v1', 'c1');
    t.onFull('v2', 'c2');
    expect(t.size).toBe(2);
    t.onCompaction();
    expect(t.haveBase('v1')).toBe(false);
    expect(t.haveBase('v2')).toBe(false);
    expect(t.negotiationFor('v1')).toBe('full');
    expect(t.size).toBe(0);
  });

  it('a full after compaction re-establishes the base', () => {
    const t = new BasePresenceTracker();
    t.onFull(VK, 'cur-1');
    t.onCompaction();
    t.onFull(VK, 'cur-3');
    expect(t.haveBase(VK)).toBe(true);
    expect(t.negotiationFor(VK)).toBe('not_modified~cur-3');
  });
});

describe('record() dispatch — the single wiring entrypoint', () => {
  it('routes full → establishes base', () => {
    const t = new BasePresenceTracker();
    t.record(VK, 'full', 'cur-1');
    expect(t.haveBase(VK)).toBe(true);
    expect(t.negotiationFor(VK)).toBe('not_modified~cur-1');
  });

  it('routes not_modified → keeps base, advances cursor', () => {
    const t = new BasePresenceTracker();
    t.record(VK, 'full', 'cur-1');
    t.record(VK, 'not_modified', 'cur-2');
    expect(t.negotiationFor(VK)).toBe('not_modified~cur-2');
  });

  it('a realistic poll loop: full → not_modified×N → compaction → full', () => {
    const t = new BasePresenceTracker();
    // cold read
    expect(t.negotiationFor(VK)).toBe('full');
    t.record(VK, 'full', 'c0');
    // steady-state polls — server keeps saying not_modified
    for (let i = 1; i <= 5; i++) {
      expect(t.negotiationFor(VK)).toBe(`not_modified~c${i - 1}`);
      t.record(VK, 'not_modified', `c${i}`);
    }
    expect(t.negotiationFor(VK)).toBe('not_modified~c5');
    // turn wrapper compacts → the base is gone from context
    t.onCompaction();
    expect(t.negotiationFor(VK)).toBe('full'); // forced full, re-inject
    t.record(VK, 'full', 'c6');
    expect(t.negotiationFor(VK)).toBe('not_modified~c6');
  });
});

describe('scope guard — disabled harness (external Claude Code / Codex)', () => {
  it('never asserts base-presence; every negotiation is full', () => {
    const t = new BasePresenceTracker({ enabled: false });
    expect(t.isEnabled).toBe(false);
    t.onFull(VK, 'cur-1'); // ignored
    t.record(VK, 'full', 'cur-1'); // ignored
    expect(t.haveBase(VK)).toBe(false);
    expect(t.negotiationFor(VK)).toBe('full');
    expect(t.size).toBe(0);
  });

  it('enabled defaults to true', () => {
    expect(new BasePresenceTracker().isEnabled).toBe(true);
  });
});

describe('forget / multi-view independence', () => {
  it('forget drops only the named view', () => {
    const t = new BasePresenceTracker();
    t.onFull('v1', 'c1');
    t.onFull('v2', 'c2');
    t.forget('v1');
    expect(t.haveBase('v1')).toBe(false);
    expect(t.haveBase('v2')).toBe(true);
    expect(t.size).toBe(1);
  });
});

describe('dispatchWithBasePresence — the turn-wrapper integration seam', () => {
  it('cold read asks for full (no _meta.delta), establishes the base', async () => {
    const t = new BasePresenceTracker();
    const c = new DeltaToolClient();
    const seen: (string | undefined)[] = [];
    const out = await dispatchWithBasePresence(t, c, VK, idKey, async (req) => {
      seen.push(req);
      return { mode: 'full', cursor: 'c0', rows: [{ id: 'a' }, { id: 'b' }] };
    });
    expect(seen).toEqual([undefined]); // cold → full
    expect(out.mode).toBe('full');
    expect(out.rows).toHaveLength(2);
    expect(t.haveBase(VK)).toBe(true);
  });

  it('warm read sends not_modified~cursor and returns the cached base without replay', async () => {
    const t = new BasePresenceTracker();
    const c = new DeltaToolClient();
    await dispatchWithBasePresence(t, c, VK, idKey, async () => ({
      mode: 'full', cursor: 'c0', rows: [{ id: 'a' }, { id: 'b' }],
    }));
    const seen: (string | undefined)[] = [];
    const out = await dispatchWithBasePresence(t, c, VK, idKey, async (req) => {
      seen.push(req);
      return { mode: 'not_modified', cursor: 'c1' };
    });
    expect(seen).toEqual(['not_modified~c0']);
    expect(out.mode).toBe('not_modified');
    expect(out.rows).toEqual([{ id: 'a' }, { id: 'b' }]); // cached base, not re-read off the wire
    expect(t.negotiationFor(VK)).toBe('not_modified~c1'); // cursor advanced
  });

  it('wantSemantic asks for auto~cursor and merges a checksum-valid delta', async () => {
    const t = new BasePresenceTracker();
    const c = new DeltaToolClient();
    await dispatchWithBasePresence(t, c, VK, idKey, async () => ({
      mode: 'full', cursor: 'c0', rows: [{ id: 'a' }, { id: 'b' }],
    }));
    const merged = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const seen: (string | undefined)[] = [];
    const out = await dispatchWithBasePresence(
      t, c, VK, idKey,
      async (req) => {
        seen.push(req);
        return {
          mode: 'delta',
          cursor: 'c1',
          checksum: computeViewChecksum(merged, idKey),
          changes: [{ change: 'added', id: 'c', data: { id: 'c' } }],
        } satisfies DeltaResponse;
      },
      { wantSemantic: true },
    );
    expect(seen).toEqual(['auto~c0']);
    expect(out.mode).toBe('delta');
    expect(out.rows).toHaveLength(3); // merged
    expect(t.haveBase(VK)).toBe(true);
  });

  it('after compaction the next read forces full even though the client still has the rows cached', async () => {
    const t = new BasePresenceTracker();
    const c = new DeltaToolClient();
    await dispatchWithBasePresence(t, c, VK, idKey, async () => ({
      mode: 'full', cursor: 'c0', rows: [{ id: 'a' }],
    }));
    t.onCompaction(); // the turn wrapper compacted — the model lost the base
    const seen: (string | undefined)[] = [];
    const out = await dispatchWithBasePresence(t, c, VK, idKey, async (req) => {
      seen.push(req);
      return { mode: 'full', cursor: 'c2', rows: [{ id: 'a' }] };
    });
    expect(seen).toEqual([undefined]); // forced full — NOT not_modified, despite the cached rows
    expect(out.mode).toBe('full');
    expect(t.haveBase(VK)).toBe(true); // re-established
  });

  it('a checksum-mismatched delta forces a second full dispatch (never a wrong view)', async () => {
    const t = new BasePresenceTracker();
    const c = new DeltaToolClient();
    await dispatchWithBasePresence(t, c, VK, idKey, async () => ({
      mode: 'full', cursor: 'c0', rows: [{ id: 'a' }, { id: 'b' }],
    }));
    const seen: (string | undefined)[] = [];
    const out = await dispatchWithBasePresence(t, c, VK, idKey, async (req) => {
      seen.push(req);
      if (req !== undefined) {
        return { mode: 'delta', cursor: 'c1', checksum: 'WRONG', changes: [{ change: 'added', id: 'c', data: { id: 'c' } }] };
      }
      return { mode: 'full', cursor: 'c2', rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
    });
    expect(seen).toEqual(['not_modified~c0', undefined]); // delta failed → forced clean full
    expect(out.mode).toBe('full');
    expect(out.rows).toHaveLength(3);
  });

  it('a disabled (out-of-scope) tracker always asks for full', async () => {
    const t = new BasePresenceTracker({ enabled: false });
    const c = new DeltaToolClient();
    await dispatchWithBasePresence(t, c, VK, idKey, async () => ({
      mode: 'full', cursor: 'c0', rows: [{ id: 'a' }],
    }));
    const seen: (string | undefined)[] = [];
    await dispatchWithBasePresence(t, c, VK, idKey, async (req) => {
      seen.push(req);
      return { mode: 'full', cursor: 'c1', rows: [{ id: 'a' }] };
    });
    expect(seen).toEqual([undefined]); // never asserts base-presence
    expect(t.haveBase(VK)).toBe(false);
  });
});
