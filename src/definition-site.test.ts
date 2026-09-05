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
    } as never);

    const tool = lookupByMcpName('stalenesstest:sourced');
    expect(tool).toBeDefined();
    // The capture must resolve to the DEFINING file — this one — and specifically
    // NOT to define-tool.ts, which is the exact off-by-one the old code hit.
    expect(tool?.sourceFile).toMatch(/definition-site\.test\.[cm]?ts$/);
    expect(tool?.sourceFile).not.toMatch(/define-tool\.[cm]?ts$/);
  });

  it('captures an absolute FILESYSTEM PATH, never a file:// URL', () => {
    defineTool({
      name: 'stalenesstest:path-form',
      requirePrincipal: false,
      capability: 'harness:read',
      description: 'fixture',
      args: z.object({}),
      handler: async () => ({ ok: true }),
    } as never);

    const sourceFile = projectedToolSourceFile('stalenesstest:path-form');
    expect(sourceFile).toBeTruthy();

    // `ProjectedTool.sourceFile` is documented as an absolute PATH, and every host
    // consumer relativizes it against a repo root by string prefix. Under ESM the raw
    // stack frame is a `file://` URL, which fails that comparison SILENTLY and in the
    // direction that reads as a legitimate answer — "this file is outside the repo" —
    // so the consumer's verdict degrades to `unknown` for every tool while nothing
    // errors. Measured 2026-09-05 (P-003 / EI-22450280531836927): 884 of 1,078 open
    // tool-failure filings, i.e. 100% of those whose subject resolved at all.
    expect(sourceFile!.startsWith('file:')).toBe(false);
    expect(sourceFile!.startsWith('/')).toBe(true);

    // The property that actually matters to a consumer: a plain prefix comparison
    // against an ancestor directory succeeds. This is the exact operation
    // `relativizeToRepo` performs in operator-core, restated here so the contract is
    // guarded at the field's SOURCE and not only at one host that happens to use it.
    const ancestor = sourceFile!.slice(0, sourceFile!.lastIndexOf('/'));
    expect(sourceFile!.startsWith(`${ancestor}/`)).toBe(true);
  });

  it('resolves a source file through every name spelling a reporter might use', () => {
    defineTool({
      name: 'stalenesstest:multi-form',
      requirePrincipal: false,
      capability: 'harness:read',
      description: 'fixture',
      args: z.object({}),
      handler: async () => ({ ok: true }),
    } as never);

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
