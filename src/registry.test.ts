/**
 * Tests for the legacy in-memory tool catalog (`register`).
 * Run with: npx vitest run libs/generic/tooldef/src/registry.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { register, lookup, _resetCatalogForTests } from './registry';
import type { ToolDefinition } from './types';

const baseDef = (over: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name: 'fix:tool',
  description: 'test tool',
  capability: 'fix:read',
  tier: 'low',
  args: z.object({}),
  handler: async () => ({ data: 'ok' }),
  ...over,
});

afterEach(() => _resetCatalogForTests());

describe('register', () => {
  it('registers and looks up a tool', () => {
    register(baseDef());
    expect(lookup('fix:tool')).toBeDefined();
  });

  it('is a no-op for the exact same def object', () => {
    const def = baseDef();
    register(def);
    expect(() => register(def)).not.toThrow();
  });

  it('throws on a same-name collision with a different capability', () => {
    register(baseDef());
    expect(() => register(baseDef({ capability: 'other:write' }))).toThrow(
      /capability=fix:read/,
    );
  });

  // EI-14: same name + same capability used to silently REPLACE — so two
  // genuinely different tools (e.g. the bare `coord:ask` vs the knowledge-first
  // `coord:ask`, both capability coord:write) would mask one another with no
  // signal. A structurally-different collision must now fail loud.
  it('throws on a same-name same-capability collision between DIFFERENT tools (EI-14)', () => {
    register(baseDef({ name: 'coord:ask', capability: 'coord:write', description: 'knowledge-first' }));
    expect(() => register(baseDef({ name: 'coord:ask', capability: 'coord:write', description: 'ask the owner' }))).toThrow(
      /silently shadows the first/,
    );
  });

  it('silently replaces a structurally-identical re-eval (HMR / double-import)', () => {
    register(baseDef({ name: 'coord:ask', capability: 'coord:write', description: 'knowledge-first' }));
    // A fresh-but-identical def object is what a module re-evaluation produces.
    expect(() =>
      register(baseDef({ name: 'coord:ask', capability: 'coord:write', description: 'knowledge-first' })),
    ).not.toThrow();
    expect(lookup('coord:ask')).toBeDefined();
  });
});
