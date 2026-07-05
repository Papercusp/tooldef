/**
 * Tests for the catalogue projection (defineGroup + capability map).
 * Run with: npx vitest run libs/generic/tooldef/src/catalogue-projection.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { register, _resetCatalogForTests } from './registry';
import { defineGroup, _resetGroupCatalogForTests } from './define-group';
import {
  groupOf,
  describeGroupFromMembers,
  catalogueProjection,
  renderCapabilityMap,
} from './catalogue-projection';
import type { ToolDefinition, ToolGuidance } from './types';

const tool = (name: string, guidance?: ToolGuidance): ToolDefinition => ({
  name,
  description: guidance?.when ?? `Tool ${name}`,
  capability: 'fix:read',
  tier: 'low',
  args: z.object({}),
  handler: async () => ({ data: 'ok' }),
  guidance,
});

afterEach(() => {
  _resetCatalogForTests();
  _resetGroupCatalogForTests();
});

describe('groupOf', () => {
  it('splits on the first colon', () => {
    expect(groupOf('plans:get')).toBe('plans');
    expect(groupOf('work_items:set_state')).toBe('work_items');
  });
  it('groups an un-namespaced name under itself', () => {
    expect(groupOf('recall')).toBe('recall');
  });
});

describe('describeGroupFromMembers', () => {
  it('lists member verbs', () => {
    const s = describeGroupFromMembers([tool('plans:get'), tool('plans:list'), tool('plans:search')]);
    expect(s).toBe('get, list, search');
  });
  it('elides past the cap with +N more', () => {
    const members = Array.from({ length: 11 }, (_, i) => tool(`x:v${i}`));
    const s = describeGroupFromMembers(members)!;
    expect(s).toContain('+3 more');
  });
  it('returns null for an empty group', () => {
    expect(describeGroupFromMembers([])).toBeNull();
  });
});

describe('catalogueProjection', () => {
  it('groups the catalog by namespace with counts', () => {
    register(tool('plans:get'));
    register(tool('plans:list'));
    register(tool('coord:orient'));
    const entries = catalogueProjection();
    const plans = entries.find((e) => e.group === 'plans')!;
    const coord = entries.find((e) => e.group === 'coord')!;
    expect(plans.toolCount).toBe(2);
    expect(coord.toolCount).toBe(1);
  });

  it('derives a summary from members when no defineGroup (Level 1)', () => {
    register(tool('plans:get'));
    register(tool('plans:set-status'));
    const plans = catalogueProjection().find((e) => e.group === 'plans')!;
    expect(plans.declared).toBe(false);
    expect(plans.summary).toBe('get, set-status');
  });

  it('prefers an explicit defineGroup summary over the derived one (Level 2)', () => {
    register(tool('plans:get'));
    register(tool('plans:set-status'));
    defineGroup('plans', { summary: 'Work-plan store — plans, items, decisions, status' });
    const plans = catalogueProjection().find((e) => e.group === 'plans')!;
    expect(plans.declared).toBe(true);
    expect(plans.summary).toBe('Work-plan store — plans, items, decisions, status');
  });

  it('composes the summary from defineGroup guidance.when when no explicit summary', () => {
    register(tool('pot:get'));
    defineGroup('hive', { guidance: { when: 'Spawn and manage sub-agents' } });
    const hive = catalogueProjection().find((e) => e.group === 'hive')!;
    expect(hive.summary).toBe('Spawn and manage sub-agents');
    expect(hive.declared).toBe(true);
  });

  it('honors defineGroup order in the sort, then count desc', () => {
    register(tool('a:one'));
    register(tool('b:one'));
    register(tool('b:two'));
    register(tool('z:one'));
    defineGroup('z', { summary: 'pinned first', order: 0 });
    const order = catalogueProjection().map((e) => e.group);
    expect(order[0]).toBe('z'); // explicit order 0 wins
    // among the rest, larger namespace (b=2) precedes smaller (a=1)
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a'));
  });
});

describe('renderCapabilityMap', () => {
  it('renders aligned rows with header + footer', () => {
    register(tool('coord:orient'));
    register(tool('plans:get'));
    defineGroup('coord', { summary: 'Talk to peers / the Queen' });
    const text = renderCapabilityMap();
    expect(text).toContain('coord');
    expect(text).toContain('Talk to peers / the Queen');
    expect(text).toContain('tools:find(');
  });

  it('can drop tiny namespaces via minTools', () => {
    register(tool('big:a'));
    register(tool('big:b'));
    register(tool('tiny:a'));
    const text = renderCapabilityMap(undefined, { minTools: 2 });
    expect(text).toContain('big');
    expect(text).not.toContain('\ntiny');
  });
});
