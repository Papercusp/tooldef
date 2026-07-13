/**
 * Guard: a tool whose `args` cannot be represented in JSON Schema must fail at
 * registration with an error that NAMES THE TOOL.
 *
 * WHY (the detector was the real bug, and the expensive one):
 *
 * `toJsonSchema(def.args)` runs at REGISTRATION — during module import — and again,
 * unguarded, when tools/list is served. So an unrepresentable args schema does not
 * degrade ONE tool; it throws mid-import and takes the ENTIRE catalog down with it.
 *
 * Before this guard, that surfaced as a bare adapter error with no tool and no file:
 *
 *     Error: Transforms cannot be represented in JSON Schema
 *     Test Files 1 failed | Tests: no tests
 *
 * i.e. an anonymous collection-time crash in whichever unlucky test happened to import
 * the catalog. It reads like an unrelated zod/infra break — it was in fact a single
 * trailing `.transform()` added to ONE tool's args, and a triage pass had already
 * mis-attributed the failure to something else. Naming the offender turns a
 * catalog-wide mystery into a one-line pointer.
 *
 * (Contrast the *event*-schema path, which catches and falls back to a placeholder:
 * an event view can degrade and leave the tool callable. An args schema cannot — it
 * IS the callable contract — so the right behaviour is fail-fast, but NAMED.)
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineTool } from './define-tool';

let n = 0;
const uniq = (base: string) => `${base}${(n += 1)}`;

describe('args schemas must be JSON-Schema-representable', () => {
  it('names the offending tool when its args carry a trailing .transform()', () => {
    const name = uniq('guard:trailing_transform_');

    const register = () =>
      defineTool({
        name,
        requirePrincipal: false,
        capability: 'test:read',
        // The exact shape that broke a real tool: an alias resolved with a trailing
        // transform. Its OUTPUT type is not expressible in JSON Schema.
        args: z
          .object({ body: z.string().optional(), comment: z.string().optional() })
          .transform((v) => ({ ...v, body: v.body ?? v.comment })),
        handler: async () => ({ ok: true }),
      });

    // Fails loudly...
    expect(register).toThrow();

    // ...and — the whole point — the message identifies WHICH tool, and how to fix it.
    let msg = '';
    try {
      register();
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain(name); // the tool name: what was missing before
    expect(msg).toMatch(/transform/i); // the cause
    expect(msg).toMatch(/handler|pipe/i); // the remedy
  });

  it('accepts the representable constructs: refinements, preprocess, and a piped transform', () => {
    // .superRefine — how a tool should validate a field alias (no value rewriting).
    expect(() =>
      defineTool({
        name: uniq('guard:refine_'),
        requirePrincipal: false,
        capability: 'test:read',
        args: z
          .object({ body: z.string().optional(), comment: z.string().optional() })
          .superRefine((v, ctx) => {
            if (!v.body && !v.comment) ctx.addIssue({ code: 'custom', message: 'need one' });
          }),
        handler: async () => ({ ok: true }),
      }),
    ).not.toThrow();

    // A transform TERMINATED BY .pipe() is fine — the pipe's output is representable.
    expect(() =>
      defineTool({
        name: uniq('guard:piped_transform_'),
        requirePrincipal: false,
        capability: 'test:read',
        args: z.object({
          slugs: z
            .union([z.string(), z.array(z.string())])
            .transform((v) => (Array.isArray(v) ? v : [v]))
            .pipe(z.array(z.string())),
        }),
        handler: async () => ({ ok: true }),
      }),
    ).not.toThrow();

    // z.preprocess is transparent to schema introspection.
    expect(() =>
      defineTool({
        name: uniq('guard:preprocess_'),
        requirePrincipal: false,
        capability: 'test:read',
        args: z.preprocess((v) => v, z.object({ a: z.string() })),
        handler: async () => ({ ok: true }),
      }),
    ).not.toThrow();
  });
});
