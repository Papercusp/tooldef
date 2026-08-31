/**
 * EI-18729688357283797 — the catalog's dominant harness-scoping arg spelling is
 * `harness` (work_items:*, docs:*, plans:*, features:*, issues:*, harness:*, …),
 * taught by the su persona as THE way to scope a per-call. A minority of tools
 * (the search:* family) instead declare `harness_slug`. Because arg validation
 * is STRICT (EI-10883), the taught reflex produced a guaranteed-failing call
 * against those tools — and the shared did-you-mean hint could even suggest the
 * WRONG correction when the tool separately declared an unrelated `scope` arg
 * (search:fulltext's `scope` is the search-source list, not a harness).
 *
 * `applyHarnessArgAlias` transparently renames `harness` -> `harness_slug`
 * BEFORE validation when the tool's declared shape has `harness_slug` but not
 * `harness`, so the taught reflex succeeds instead of failing.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { applyHarnessArgAlias, strictArgs } from './define-tool';
function toJsonSchema(shape) {
    return { type: 'object', properties: shape };
}
describe('applyHarnessArgAlias (EI-18729688357283797)', () => {
    const searchFulltextSchema = toJsonSchema({
        query: {},
        scope: {}, // an UNRELATED arg on this tool (search-source list, not a harness)
        harness_slug: {},
        limit: {},
    });
    it('renames `harness` to `harness_slug` when the tool declares harness_slug but not harness', () => {
        const out = applyHarnessArgAlias(searchFulltextSchema, {
            query: 'x',
            harness: 'papercusp',
        });
        expect(out).toEqual({ query: 'x', harness_slug: 'papercusp' });
        expect('harness' in out).toBe(false);
    });
    it('never overrides an explicit harness_slug the caller already supplied', () => {
        const out = applyHarnessArgAlias(searchFulltextSchema, {
            query: 'x',
            harness: 'wrong-one',
            harness_slug: 'papercusp',
        });
        expect(out).toEqual({ query: 'x', harness: 'wrong-one', harness_slug: 'papercusp' });
    });
    it('is a no-op when the tool declares its OWN `harness` arg (the common-case tools)', () => {
        const schemaWithHarness = toJsonSchema({ id: {}, harness: {} });
        const input = { id: 'WI-1', harness: 'papercusp' };
        expect(applyHarnessArgAlias(schemaWithHarness, input)).toBe(input);
    });
    it('is a no-op when the tool declares neither harness nor harness_slug', () => {
        const schema = toJsonSchema({ id: {} });
        const input = { id: 'WI-1', harness: 'papercusp' };
        expect(applyHarnessArgAlias(schema, input)).toBe(input);
    });
    it('is a no-op when no `harness` key is present at all', () => {
        const input = { query: 'x', harness_slug: 'papercusp' };
        expect(applyHarnessArgAlias(searchFulltextSchema, input)).toBe(input);
    });
    it('never throws on non-object inputs', () => {
        expect(applyHarnessArgAlias(searchFulltextSchema, undefined)).toBeUndefined();
        expect(applyHarnessArgAlias(searchFulltextSchema, null)).toBeNull();
        expect(applyHarnessArgAlias(searchFulltextSchema, 'x')).toBe('x');
        expect(applyHarnessArgAlias(searchFulltextSchema, [1, 2])).toEqual([1, 2]);
    });
});
describe('alias + strict gate end-to-end (EI-18729688357283797 x EI-10883)', () => {
    const schema = strictArgs(z.object({
        query: z.string(),
        scope: z.array(z.string()).optional(),
        harness_slug: z.string().optional(),
        limit: z.number().optional(),
    }));
    const jsonSchema = toJsonSchema({ query: {}, scope: {}, harness_slug: {}, limit: {} });
    it('BASELINE: `harness` is REJECTED by the closed-shape gate (the reported bug)', () => {
        const r = schema.safeParse({ query: 'x', harness: 'papercusp' });
        expect(r.success).toBe(false);
    });
    it('after the alias shim the SAME call validates cleanly', () => {
        const recovered = applyHarnessArgAlias(jsonSchema, { query: 'x', harness: 'papercusp' });
        const r = schema.safeParse(recovered);
        expect(r.success).toBe(true);
        expect(r.success && r.data.harness_slug).toBe('papercusp');
    });
    it('a genuinely undeclared arg still fails loudly (no false accept)', () => {
        const recovered = applyHarnessArgAlias(jsonSchema, { query: 'x', bogus: 1 });
        const r = schema.safeParse(recovered);
        expect(r.success).toBe(false);
    });
});
