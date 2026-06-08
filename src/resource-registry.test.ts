/**
 * Tests for the resource catalog + RFC-6570 `{var}` URI matcher.
 * Run with: npx vitest run libs/generic/tooldef/src/resource-registry.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerResource,
  lookupResource,
  getResourceCatalog,
  matchResource,
  _resetResourceCatalogForTests,
} from './resource-registry';
import type { ResourceDefinition } from './types';

const baseDef = (over: Partial<ResourceDefinition> = {}): ResourceDefinition => ({
  uri: 'papercusp://workspace/harnesses',
  name: 'workspace:harnesses',
  description: 'all harnesses',
  mimeType: 'application/json',
  capability: 'workspace:read',
  tier: 'low',
  read: async (uri) => ({ uri, mimeType: 'application/json', text: '[]' }),
  ...over,
});

afterEach(() => _resetResourceCatalogForTests());

describe('registerResource / lookupResource / getResourceCatalog', () => {
  it('registers and looks up by name', () => {
    registerResource(baseDef());
    expect(lookupResource('workspace:harnesses')).toBeDefined();
    expect(getResourceCatalog()).toHaveLength(1);
  });

  it('returns undefined for an unknown name', () => {
    expect(lookupResource('nope')).toBeUndefined();
  });
});

describe('matchResource — concrete URIs', () => {
  it('matches a concrete URI exactly with no vars', () => {
    registerResource(baseDef());
    const hit = matchResource('papercusp://workspace/harnesses');
    expect(hit).not.toBeNull();
    expect(hit!.def.name).toBe('workspace:harnesses');
    expect(hit!.vars).toEqual({});
  });

  it('does not match a different URI', () => {
    registerResource(baseDef());
    expect(matchResource('papercusp://workspace/other')).toBeNull();
  });

  it('anchors the match (no partial / prefix matches)', () => {
    registerResource(baseDef());
    expect(matchResource('papercusp://workspace/harnesses/extra')).toBeNull();
    expect(matchResource('x-papercusp://workspace/harnesses')).toBeNull();
  });
});

describe('matchResource — templated URIs', () => {
  it('extracts a single {var} segment', () => {
    registerResource(baseDef({ name: 'harness:issues', uri: 'papercusp://harness/{slug}/issues' }));
    const hit = matchResource('papercusp://harness/papercup/issues');
    expect(hit).not.toBeNull();
    expect(hit!.def.name).toBe('harness:issues');
    expect(hit!.vars).toEqual({ slug: 'papercup' });
  });

  it('extracts multiple {var} segments', () => {
    registerResource(baseDef({ name: 'multi', uri: 'papercusp://harness/{slug}/feature/{fid}' }));
    const hit = matchResource('papercusp://harness/abc/feature/F-001');
    expect(hit!.vars).toEqual({ slug: 'abc', fid: 'F-001' });
  });

  it('does NOT let a {var} segment cross a slash', () => {
    registerResource(baseDef({ name: 'harness:issues', uri: 'papercusp://harness/{slug}/issues' }));
    // `{slug}` is `[^/]+`, so a two-segment slug must not match.
    expect(matchResource('papercusp://harness/a/b/issues')).toBeNull();
  });

  it('escapes regex metacharacters in the literal parts of the template', () => {
    // The `.` in `a.b` must be a literal dot, not "any char".
    registerResource(baseDef({ name: 'dotted', uri: 'papercusp://a.b/{id}' }));
    expect(matchResource('papercusp://aXb/1')).toBeNull();
    expect(matchResource('papercusp://a.b/1')!.vars).toEqual({ id: '1' });
  });

  it('returns the first registered resource when several could match', () => {
    registerResource(baseDef({ name: 'first', uri: 'papercusp://x/{a}' }));
    registerResource(baseDef({ name: 'second', uri: 'papercusp://x/{b}' }));
    expect(matchResource('papercusp://x/v')!.def.name).toBe('first');
  });
});

describe('collision handling', () => {
  it('is a no-op for the exact same def object', () => {
    const def = baseDef();
    registerResource(def);
    expect(() => registerResource(def)).not.toThrow();
    expect(getResourceCatalog()).toHaveLength(1);
  });

  it('silently replaces a same-name same-uri re-eval and refreshes the matcher', () => {
    registerResource(baseDef({ uri: 'papercusp://harness/{slug}', name: 'h' }));
    expect(() => registerResource(baseDef({ uri: 'papercusp://harness/{slug}', name: 'h', description: 'v2' }))).not.toThrow();
    expect(lookupResource('h')?.description).toBe('v2');
    expect(matchResource('papercusp://harness/foo')!.vars).toEqual({ slug: 'foo' });
  });

  it('throws on a same-name collision with a different uri', () => {
    registerResource(baseDef({ name: 'h', uri: 'papercusp://harness/{slug}' }));
    expect(() => registerResource(baseDef({ name: 'h', uri: 'papercusp://other/{slug}' }))).toThrow(
      /Resource name collision: "h"/,
    );
  });
});

describe('_resetResourceCatalogForTests', () => {
  it('clears both the catalog and the matcher table', () => {
    registerResource(baseDef({ uri: 'papercusp://harness/{slug}', name: 'h' }));
    expect(matchResource('papercusp://harness/foo')).not.toBeNull();
    _resetResourceCatalogForTests();
    expect(getResourceCatalog()).toHaveLength(0);
    expect(matchResource('papercusp://harness/foo')).toBeNull();
  });
});
