/**
 * browser-safe-barrel — the tooldef ISOMORPHIC invariant, as a test.
 *
 * @papercusp/tooldef is consumed by BOTH the Node host and the browser SPA
 * (operator-vite reaches it through operator-core client modules). A static
 * top-level `import ... from 'node:*'` anywhere in the (non-test) source is
 * re-exported by the barrel, gets externalized by vite, and THROWS at
 * module-eval time in the client — blanking the entire app. That exact
 * failure shipped on 2026-07-04: code-orchestration/run-script.ts imported
 * `{ Worker } from 'node:worker_threads'` statically and every SPA route
 * rendered a white page.
 *
 * The rule this pins: Node builtins in this lib must be loaded LAZILY
 * (`await import('node:…')` inside the function that needs them) or be
 * type-only (`import type`). Both are invisible to a browser consumer that
 * merely imports the barrel.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...sourceFiles(p));
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.test\.tsx?$/.test(name)) continue; // tests run under Node only
    out.push(p);
  }
  return out;
}

/** Static VALUE imports of node builtins (type-only imports are erased at compile). */
const STATIC_NODE_IMPORT = /^import\s+(?!type\b)[^;]*?from\s+['"]node:[^'"]+['"]/m;

describe('tooldef stays browser-safe (isomorphic barrel)', () => {
  it('no non-test source file statically imports a node: builtin', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      // Strip block + line comments so a commented example can't false-positive.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (STATIC_NODE_IMPORT.test(code)) offenders.push(path.relative(SRC, file));
    }
    expect(
      offenders,
      `Static node: imports leak into the browser via the barrel and blank the SPA.\n` +
        `Load them lazily (await import('node:…') inside the fn) or as import type.\n` +
        `Offenders: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
