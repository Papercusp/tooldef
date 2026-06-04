/**
 * Unit tests for the generic emits collector
 * (coord-lifecycle-automation-2026-06-04 D-002).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  collectToolEmits,
  getCollectedToolEmits,
  _resetCollectedToolEmitsForTests,
} from './emits-registry';
import type { ToolEmitSpec } from './types';

const spec = (fire: string): ToolEmitSpec => ({ fire, render: () => ({}) });

describe('collectToolEmits', () => {
  beforeEach(() => _resetCollectedToolEmitsForTests());

  it('collects emits in declaration order', () => {
    collectToolEmits('a:b', [spec('coord:emit')]);
    collectToolEmits('c:d', [spec('coord:emit')]);
    expect(getCollectedToolEmits().map((e) => e.toolName)).toEqual(['a:b', 'c:d']);
  });

  it('a tool with no/empty emits is a no-op', () => {
    collectToolEmits('a:b', undefined);
    collectToolEmits('c:d', []);
    expect(getCollectedToolEmits()).toHaveLength(0);
  });

  it('re-registering a tool by name REPLACES (hot-reload / test re-import) — no dup', () => {
    collectToolEmits('a:b', [spec('coord:emit')]);
    collectToolEmits('a:b', [spec('coord:emit'), spec('coord:emit')]);
    const all = getCollectedToolEmits();
    expect(all).toHaveLength(1);
    expect(all[0].emits).toHaveLength(2);
  });

  it('re-registering with empty emits DROPS the stale entry + keeps order intact', () => {
    collectToolEmits('a:b', [spec('coord:emit')]);
    collectToolEmits('c:d', [spec('coord:emit')]);
    collectToolEmits('e:f', [spec('coord:emit')]);
    collectToolEmits('c:d', []); // drop the middle one
    const names = getCollectedToolEmits().map((e) => e.toolName);
    expect(names).toEqual(['a:b', 'e:f']);
    // After the splice, re-registering the tail still replaces correctly.
    collectToolEmits('e:f', [spec('x:y'), spec('x:y')]);
    const ef = getCollectedToolEmits().find((e) => e.toolName === 'e:f');
    expect(ef?.emits).toHaveLength(2);
    expect(getCollectedToolEmits()).toHaveLength(2);
  });
});
