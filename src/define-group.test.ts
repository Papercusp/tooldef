/**
 * Tests for the group registry (defineGroup / registerGroup / lookupGroup /
 * getGroupCatalog) — the catalogue analogue of `registry.ts`. The
 * projection-side behavior (derivation + render) is covered in
 * catalogue-projection.test.ts; this file pins the registry mechanics +
 * the define-time summary precedence (`summary ?? guidance.when`).
 *
 * Run with: npx vitest run libs/generic/tooldef/src/define-group.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  defineGroup,
  registerGroup,
  lookupGroup,
  getGroupCatalog,
  _resetGroupCatalogForTests,
} from './define-group';
import { declaredGroupSlugs } from './catalogue-projection';

afterEach(() => {
  _resetGroupCatalogForTests();
});

describe('defineGroup summary precedence (define-time legs)', () => {
  it('uses an explicit summary', () => {
    const def = defineGroup('plans', { summary: 'Work-plan store' });
    expect(def.summary).toBe('Work-plan store');
    expect(lookupGroup('plans')?.summary).toBe('Work-plan store');
  });

  it('composes the summary from guidance.when when no explicit summary', () => {
    const def = defineGroup('hive', { guidance: { when: 'Spawn and manage sub-agents' } });
    expect(def.summary).toBe('Spawn and manage sub-agents');
  });

  it('prefers an explicit summary over guidance.when', () => {
    const def = defineGroup('coord', {
      summary: 'Talk to peers / the Queen',
      guidance: { when: 'ignored when summary is present' },
    });
    expect(def.summary).toBe('Talk to peers / the Queen');
  });

  it('leaves summary undefined (for projection-time derivation) when neither leg is present', () => {
    const def = defineGroup('misc');
    expect(def.summary).toBeUndefined();
  });

  it('trims whitespace and treats blank-only as undefined', () => {
    expect(defineGroup('a', { summary: '  padded  ' }).summary).toBe('padded');
    expect(defineGroup('b', { summary: '   ' }).summary).toBeUndefined();
  });

  it('carries the order hint through', () => {
    expect(defineGroup('z', { summary: 's', order: 0 }).order).toBe(0);
  });
});

describe('group registry', () => {
  it('registerGroup + lookupGroup round-trip', () => {
    registerGroup({ slug: 'plans', summary: 'Plans' });
    expect(lookupGroup('plans')?.summary).toBe('Plans');
    expect(lookupGroup('absent')).toBeUndefined();
  });

  it('getGroupCatalog returns every registered group', () => {
    defineGroup('plans', { summary: 'a' });
    defineGroup('coord', { summary: 'b' });
    expect(getGroupCatalog().map((g) => g.slug).sort()).toEqual(['coord', 'plans']);
  });

  it('is idempotent for a same-slug re-declaration (HMR / double-import)', () => {
    defineGroup('plans', { summary: 'Plans' });
    defineGroup('plans', { summary: 'Plans' });
    expect(getGroupCatalog().filter((g) => g.slug === 'plans')).toHaveLength(1);
  });

  it('last-wins on a differing re-declaration (advisory metadata, never throws)', () => {
    defineGroup('plans', { summary: 'first' });
    expect(() => defineGroup('plans', { summary: 'second' })).not.toThrow();
    expect(lookupGroup('plans')?.summary).toBe('second');
    expect(getGroupCatalog().filter((g) => g.slug === 'plans')).toHaveLength(1);
  });

  it('declaredGroupSlugs lists only groups with a resolved summary', () => {
    defineGroup('plans', { summary: 'has one' });
    defineGroup('misc'); // no summary → derived at projection time, not "declared"
    expect(declaredGroupSlugs()).toEqual(['plans']);
  });

  it('_resetGroupCatalogForTests clears the registry', () => {
    defineGroup('plans', { summary: 'x' });
    _resetGroupCatalogForTests();
    expect(getGroupCatalog()).toHaveLength(0);
  });
});
