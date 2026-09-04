/**
 * A tool records the file that DEFINED it (EI-21351815194031529).
 *
 * This is the derivation the host-side staleness check rests on: without a real
 * source path, "is this tool's schema stale?" has nothing to ask git about. It is
 * captured from the call stack, so the failure mode is silent — a wrong frame index
 * yields `undefined`, not an error, and every consumer then degrades to "unknown"
 * forever while looking perfectly healthy.
 *
 * That is not hypothetical: the previous `deriveNameFromCallSite` took frame `[2]`
 * with a comment asserting `[1]=defineTool`, but it is invoked one level deeper than
 * that comment assumed, so it read `defineTool`'s own frame and returned null for
 * every tool. Nobody noticed, because every first-party tool passes an explicit
 * `name`. These tests exist so the same silence cannot recur.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from './define-tool';
import { lookupByMcpName, projectedToolSourceFile } from './tool-projection';
describe('definition-site capture', () => {
    it('records THIS test file as the source of a tool defined here', () => {
        defineTool({
            name: 'stalenesstest:sourced',
            requirePrincipal: false,
            capability: 'harness:read',
            description: 'fixture',
            args: z.object({}),
            handler: async () => ({ ok: true }),
        });
        const tool = lookupByMcpName('stalenesstest:sourced');
        expect(tool).toBeDefined();
        // The capture must resolve to the DEFINING file — this one — and specifically
        // NOT to define-tool.ts, which is the exact off-by-one the old code hit.
        expect(tool?.sourceFile).toMatch(/definition-site\.test\.[cm]?ts$/);
        expect(tool?.sourceFile).not.toMatch(/define-tool\.[cm]?ts$/);
    });
    it('resolves a source file through every name spelling a reporter might use', () => {
        defineTool({
            name: 'stalenesstest:multi-form',
            requirePrincipal: false,
            capability: 'harness:read',
            description: 'fixture',
            args: z.object({}),
            handler: async () => ({ ok: true }),
        });
        const canonical = projectedToolSourceFile('stalenesstest:multi-form');
        expect(canonical).toMatch(/definition-site\.test\.[cm]?ts$/);
        // An agent filing a tool-failure copies whatever spelling it saw — the
        // underscore form from its client, or the fully-mangled advertised id.
        expect(projectedToolSourceFile('stalenesstest_multi-form')).toBe(canonical);
        expect(projectedToolSourceFile('mcp__papercusp-su__stalenesstest_multi-form')).toBe(canonical);
    });
    it('returns null for an unknown tool rather than guessing', () => {
        expect(projectedToolSourceFile('stalenesstest:no-such-verb')).toBeNull();
    });
});
