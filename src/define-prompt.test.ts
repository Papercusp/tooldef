/**
 * Tests for definePrompt — name handling, tier inference, self-registration.
 * Run with: npx vitest run libs/generic/tooldef/src/define-prompt.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import { definePrompt } from './define-prompt';
import { lookupPrompt, _resetPromptCatalogForTests } from './prompt-registry';
import { setCapabilityTierResolver, defaultTierResolver } from './capability-tiers';
import type { PromptResult } from './types';

const render = async (): Promise<PromptResult> => ({ messages: [] });

afterEach(() => {
  _resetPromptCatalogForTests();
  setCapabilityTierResolver(defaultTierResolver);
});

describe('definePrompt', () => {
  it('registers a prompt given an explicit name and returns the def', () => {
    const def = definePrompt({ name: 'review:summary', render });
    expect(def.name).toBe('review:summary');
    expect(lookupPrompt('review:summary')).toBe(def);
  });

  it('defaults the description to `Prompt <name>`', () => {
    const def = definePrompt({ name: 'a:b', render });
    expect(def.description).toBe('Prompt a:b');
  });

  it('keeps an explicit description', () => {
    const def = definePrompt({ name: 'a:b', description: 'custom', render });
    expect(def.description).toBe('custom');
  });

  it('is tier "low" for a public (capability-less) prompt', () => {
    const def = definePrompt({ name: 'pub:prompt', render });
    expect(def.capability).toBeUndefined();
    expect(def.tier).toBe('low');
  });

  it('infers tier from the capability via the active resolver', () => {
    setCapabilityTierResolver((cap) => (cap === 'secrets:read' ? 'high' : 'low'));
    const def = definePrompt({ name: 'sec:prompt', capability: 'secrets:read', render });
    expect(def.tier).toBe('high');
  });

  it('carries the argument schema through', () => {
    const args = [{ name: 'slug', required: true }];
    const def = definePrompt({ name: 'a:b', arguments: args, render });
    expect(def.arguments).toEqual(args);
  });

  it('throws when the name cannot be derived and none is given', () => {
    // Called from a *.test.ts (not under prompts/<group>/<verb>.ts), so the
    // call-site derivation returns null → must throw.
    expect(() => definePrompt({ render })).toThrow(/could not derive name/);
  });
});
