/**
 * Bundled definition sites (P-002 / EI-25176539351759672): a tool defined inside a
 * bundle that also inlines tooldef has every stack frame in ONE file, so the defining
 * module is recovered from the frames' LINES and esbuild's `// <path>` module markers.
 * The end-to-end guard (a real esbuild bundle run under plain node) lives with the
 * host resolver in operator-core `tool-source-file.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  bundleModuleAtLine,
  definingModuleOfBundledSite,
  indexBundleModuleMarkers,
} from './bundle-definition-site';

// Shape of a non-minified esbuild ESM bundle: runtime helpers first (no marker), then
// each inlined module preceded by its marker line.
const BUNDLE = [
  'var __esm = (fn) => fn;', // 1  runtime helper, above every marker
  '', // 2
  '// ../../libs/generic/tooldef/src/define-tool.ts', // 3
  'function captureDefinitionSite() {}', // 4
  'function defineTool() { captureDefinitionSite(); }', // 5
  '', // 6
  '// ../../packages/operator-core/lib/agent-tools/coord/send.ts', // 7
  'var x = `', // 8
  '// not-a-marker inside a template, but no script extension', // 9
  '`;', // 10
  'defineTool({ name: "coord:send" });', // 11
  '// ../../packages/operator-core/lib/agent-tools/coord/ack.mts', // 12
  'defineTool({ name: "coord:ack" });', // 13
].join('\n');

describe('indexBundleModuleMarkers', () => {
  it('indexes every module marker with its 1-based line, and nothing else', () => {
    const markers = indexBundleModuleMarkers(BUNDLE);
    expect(markers.lines).toEqual([3, 7, 12]);
    expect(markers.paths).toEqual([
      '../../libs/generic/tooldef/src/define-tool.ts',
      '../../packages/operator-core/lib/agent-tools/coord/send.ts',
      '../../packages/operator-core/lib/agent-tools/coord/ack.mts',
    ]);
  });

  it('accepts CRLF line endings and a marker on line 1', () => {
    const markers = indexBundleModuleMarkers('// a.ts\r\nx\r\n// b.js\r\n');
    expect(markers).toEqual({ lines: [1, 3], paths: ['a.ts', 'b.js'] });
  });
});

describe('bundleModuleAtLine', () => {
  const markers = indexBundleModuleMarkers(BUNDLE);
  it('answers the nearest marker at or above the line', () => {
    expect(bundleModuleAtLine(markers, 3)).toBe('../../libs/generic/tooldef/src/define-tool.ts');
    expect(bundleModuleAtLine(markers, 11)).toBe('../../packages/operator-core/lib/agent-tools/coord/send.ts');
    expect(bundleModuleAtLine(markers, 99)).toBe('../../packages/operator-core/lib/agent-tools/coord/ack.mts');
  });
  it('is null above the first marker (runtime helpers belong to no module)', () => {
    expect(bundleModuleAtLine(markers, 1)).toBeNull();
  });
});

describe('definingModuleOfBundledSite', () => {
  const markers = indexBundleModuleMarkers(BUNDLE);

  it('skips frame [0]’s module and helper frames, and takes the first other module', () => {
    // capture (4), defineTool (5), helper (1), caller (11)
    expect(definingModuleOfBundledSite(markers, { lines: [4, 5, 1, 11, 13] })).toEqual({
      selfModule: '../../libs/generic/tooldef/src/define-tool.ts',
      definingModule: '../../packages/operator-core/lib/agent-tools/coord/send.ts',
    });
  });

  it('is null when no frame leaves the define-tool module', () => {
    expect(definingModuleOfBundledSite(markers, { lines: [4, 5] })).toBeNull();
  });

  it('is null when frame [0] is not in define-tool (the bundle on disk is not the one loaded)', () => {
    // Frame [0] landing in an ordinary module means the line numbers do not describe
    // this file, so any answer would name the wrong module.
    expect(definingModuleOfBundledSite(markers, { lines: [11, 13] })).toBeNull();
    expect(definingModuleOfBundledSite(markers, { lines: [] })).toBeNull();
  });
});
