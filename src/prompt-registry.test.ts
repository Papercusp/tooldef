/**
 * Tests for the prompt catalog (symmetric to registry.ts / resource-registry.ts).
 * Run with: npx vitest run libs/generic/tooldef/src/prompt-registry.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerPrompt,
  lookupPrompt,
  getPromptCatalog,
  _resetPromptCatalogForTests,
} from './prompt-registry';
import type { PromptDefinition } from './types';

const baseDef = (over: Partial<PromptDefinition> = {}): PromptDefinition => ({
  name: 'review:summary',
  description: 'summarize a review',
  capability: undefined,
  tier: 'low',
  render: async () => ({ messages: [] }),
  ...over,
});

afterEach(() => _resetPromptCatalogForTests());

describe('registerPrompt / lookupPrompt', () => {
  it('registers and looks up a prompt', () => {
    registerPrompt(baseDef());
    expect(lookupPrompt('review:summary')).toBeDefined();
    expect(lookupPrompt('review:summary')?.description).toBe('summarize a review');
  });

  it('returns undefined for an unknown name', () => {
    expect(lookupPrompt('nope:missing')).toBeUndefined();
  });

  it('getPromptCatalog returns every registered prompt', () => {
    registerPrompt(baseDef({ name: 'a:one' }));
    registerPrompt(baseDef({ name: 'b:two' }));
    const names = getPromptCatalog().map((p) => p.name).sort();
    expect(names).toEqual(['a:one', 'b:two']);
  });
});

describe('collision handling', () => {
  it('is a no-op for the exact same def object', () => {
    const def = baseDef();
    registerPrompt(def);
    expect(() => registerPrompt(def)).not.toThrow();
    expect(getPromptCatalog()).toHaveLength(1);
  });

  it('silently replaces a same-name same-capability re-eval (HMR / double-import)', () => {
    registerPrompt(baseDef({ description: 'first' }));
    expect(() => registerPrompt(baseDef({ description: 'second' }))).not.toThrow();
    expect(lookupPrompt('review:summary')?.description).toBe('second');
    expect(getPromptCatalog()).toHaveLength(1);
  });

  it('throws on a same-name collision with a different capability', () => {
    registerPrompt(baseDef({ capability: 'review:read' }));
    expect(() => registerPrompt(baseDef({ capability: 'review:write' }))).toThrow(
      /Prompt name collision: "review:summary"/,
    );
  });

  it('treats undefined vs a real capability as a real collision', () => {
    registerPrompt(baseDef({ capability: undefined }));
    expect(() => registerPrompt(baseDef({ capability: 'review:read' }))).toThrow(
      /collision/,
    );
  });
});

describe('_resetPromptCatalogForTests', () => {
  it('clears the catalog', () => {
    registerPrompt(baseDef());
    expect(getPromptCatalog()).toHaveLength(1);
    _resetPromptCatalogForTests();
    expect(getPromptCatalog()).toHaveLength(0);
    expect(lookupPrompt('review:summary')).toBeUndefined();
  });
});
