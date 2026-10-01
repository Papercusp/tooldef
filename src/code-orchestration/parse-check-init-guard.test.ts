import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * P-007 / cupboard-release-pipeline-content-trust D-010 recurrence guard.
 *
 * In a bundled Cloudflare Worker the TypeScript compiler can load as a HALF-INITIALISED module
 * (typescript.js reads the CJS `__filename` at init and the ESM bundle has none). The old
 * ensureParseCheckReady() cached that module as-is, so every later checkScript() silently took the
 * REGEX FALLBACK — which misses destructured calls (`const { coord } = tools; coord.send()`), the
 * exact evasion class server-side authority analysis exists to catch.
 *
 * These tests load a FRESH parse-check module per case (vi.resetModules) so the module-level `_ts`
 * cache is not shared, and swap the `typescript` import for a broken one.
 */
const mkTool = (name: string) => ({ expose: { mcp: { name } } }) as never;
const tools = [mkTool('coord:send'), mkTool('plans:get')];
const DESTRUCTURED = `const { coord } = tools; await coord.send({ to: ['x'] });`;

afterEach(() => {
  vi.doUnmock('typescript');
  vi.resetModules();
});

describe('ensureParseCheckReady init guard', () => {
  it('POSITIVE CONTROL: the real compiler loads and resolves a destructured call', async () => {
    vi.resetModules();
    const mod = await import('./parse-check');
    await expect(mod.ensureParseCheckReady()).resolves.toBeUndefined();
    const r = mod.checkScript(DESTRUCTURED, tools);
    // Without this the guard cases below could pass vacuously (a broken instrument).
    expect(r.hasParseErrors).toBe(false);
    expect(r.refs).toContain('coord.send');
  });

  it('rejects (never caches) a module that lacks createSourceFile', async () => {
    vi.resetModules();
    vi.doMock('typescript', () => ({ default: {} }));
    const mod = await import('./parse-check');
    await expect(mod.ensureParseCheckReady()).rejects.toThrow(/createSourceFile/);
    // Not cached as `{}`: a second call fails the same way instead of resolving.
    await expect(mod.ensureParseCheckReady()).rejects.toThrow(/createSourceFile/);
    // And checkScript refuses outright rather than degrading to a regex scan.
    expect(() => mod.checkScript(DESTRUCTURED, tools)).toThrow(/ensureParseCheckReady/);
  });

  it('rejects a partially-populated module (version/enums present, parser absent)', async () => {
    vi.resetModules();
    vi.doMock('typescript', () => ({ default: { version: '6.0.2', SyntaxKind: {} } }));
    const mod = await import('./parse-check');
    await expect(mod.ensureParseCheckReady()).rejects.toThrow(/createSourceFile/);
  });
});
