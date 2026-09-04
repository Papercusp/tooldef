/**
 * Tests for defineResource — name/mime defaults, tier inference, registration.
 * Run with: npx vitest run libs/generic/tooldef/src/define-resource.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineResource } from './define-resource';
import { lookupResource, matchResource, _resetResourceCatalogForTests } from './resource-registry';
import { setCapabilityTierResolver, defaultTierResolver } from './capability-tiers';
import type { ResourceContents } from './types';

const read = async (uri: string): Promise<ResourceContents> => ({
  uri,
  mimeType: 'application/json',
  text: '{}',
});

afterEach(() => {
  _resetResourceCatalogForTests();
  setCapabilityTierResolver(defaultTierResolver);
});

describe('defineResource', () => {
  it('registers a resource given an explicit name and returns the def', () => {
    const def = defineResource({ name: 'ws:harnesses', uri: 'papercusp://ws/harnesses', capability: 'ws:read', read });
    expect(def.name).toBe('ws:harnesses');
    expect(lookupResource('ws:harnesses')).toBe(def);
  });

  it('defaults mimeType to application/json', () => {
    const def = defineResource({ name: 'a:b', uri: 'papercusp://a/b', capability: 'a:read', read });
    expect(def.mimeType).toBe('application/json');
  });

  it('keeps an explicit mimeType', () => {
    const def = defineResource({ name: 'a:b', uri: 'papercusp://a/b', capability: 'a:read', mimeType: 'text/plain', read });
    expect(def.mimeType).toBe('text/plain');
  });

  it('defaults the description to `Resource <name>`', () => {
    const def = defineResource({ name: 'a:b', uri: 'papercusp://a/b', capability: 'a:read', read });
    expect(def.description).toBe('Resource a:b');
  });

  it('infers tier from the capability via the active resolver', () => {
    setCapabilityTierResolver((cap) => (cap === 'secrets:read' ? 'high' : 'low'));
    const def = defineResource({ name: 's', uri: 'papercusp://s', capability: 'secrets:read', read });
    expect(def.tier).toBe('high');
  });

  it('is matchable through the registry after definition (templated)', () => {
    defineResource({ name: 'h', uri: 'papercusp://harness/{slug}/issues', capability: 'h:read', read });
    const hit = matchResource('papercusp://harness/papercup/issues');
    expect(hit!.vars).toEqual({ slug: 'papercup' });
  });

  it('throws when the name cannot be derived and none is given', () => {
    expect(() => defineResource({ uri: 'papercusp://x', capability: 'x:read', read })).toThrow(
      /could not derive name/,
    );
  });
});
