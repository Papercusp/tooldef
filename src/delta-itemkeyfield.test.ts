/**
 * itemKeyField conveyance (agent-tool-delta-client-rollout-2026-06-23, P-004). The
 * _meta.delta envelope conveys the tool's itemKey FIELD NAME so an OUT-OF-PROCESS client
 * (the MCP proxy) can merge a delta generically via `row[itemKeyField]` — the itemKey
 * function can't cross a process boundary. This pins that a field-based merge reconstructs
 * the view exactly (and the harness checksum matches the server's), the whole point of conveyance.
 */
import { describe, it, expect } from 'vitest';
import { computeRowDigest, diffFromDigest, applySemanticDelta, computeViewChecksum } from './delta-protocol';

describe('itemKeyField — generic out-of-process merge', () => {
  it('reconstructs the view using ONLY the conveyed field name (no itemKey function)', () => {
    const field = 'slug'; // as carried in _meta.delta.itemKeyField
    const itemKey = (row: unknown) => (row as Record<string, unknown>)[field] as string;
    const base = [{ slug: 'a', v: 1 }, { slug: 'b', v: 1 }, { slug: 'c', v: 1 }];
    const next = [{ slug: 'b', v: 2 }, { slug: 'c', v: 1 }, { slug: 'd', v: 1 }]; // a removed, b updated, d added
    const changes = diffFromDigest(computeRowDigest(base, itemKey)!, next, itemKey);
    const merged = applySemanticDelta(base, changes, itemKey);
    expect(new Set(merged.map(itemKey))).toEqual(new Set(['b', 'c', 'd']));
    expect(merged.find((r) => itemKey(r) === 'b')).toEqual({ slug: 'b', v: 2 });
    // The checksum the harness verifies against matches the server's view checksum.
    expect(computeViewChecksum(merged, itemKey)).toBe(computeViewChecksum(next, itemKey));
  });

  it('works for a different conveyed field (id)', () => {
    const itemKey = (row: unknown) => (row as Record<string, unknown>).id as string;
    const base = [{ id: '1' }];
    const next = [{ id: '1' }, { id: '2' }];
    const merged = applySemanticDelta(base, diffFromDigest(computeRowDigest(base, itemKey)!, next, itemKey), itemKey);
    expect(new Set(merged.map(itemKey))).toEqual(new Set(['1', '2']));
  });
});
