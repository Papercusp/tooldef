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
import { getCatalog, lookup } from './registry';

let n = 0;
const uniq = (base: string) => `${base}${(n += 1)}`;

/** The exact shape that broke a real tool (EI-10996): an alias resolved with a
 *  trailing transform, whose OUTPUT type JSON Schema cannot express. */
const unrepresentableArgs = () =>
  z
    .object({ body: z.string().optional(), comment: z.string().optional() })
    .transform((v) => ({ ...v, body: v.body ?? v.comment }));

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
        handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
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
        handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
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
        handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
      }),
    ).not.toThrow();

    // z.preprocess is transparent to schema introspection.
    expect(() =>
      defineTool({
        name: uniq('guard:preprocess_'),
        requirePrincipal: false,
        capability: 'test:read',
        args: z.preprocess((v) => v, z.object({ a: z.string() })),
        handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
      }),
    ).not.toThrow();
  });

  /**
   * WI-4596 — the guard above is necessary but was not SUFFICIENT.
   *
   * The principal-gated path used to `register()` the tool into the catalog and only
   * THEN run the guarded conversion. While the throw is fatal that ordering is
   * invisible: the process dies either way. But the throw is not always fatal — any
   * caller that CATCHES a module-import error (HMR re-eval, a test harness, a plugin
   * loader) carries on with an unrepresentable-schema tool still seated in the catalog.
   * The very next tools/list then maps that tool straight back through the conversion
   * and dies ANONYMOUSLY, catalog-wide — precisely the failure the guard was added to
   * eliminate, resurrected one layer downstream.
   *
   * So the invariant is not "registration throws"; it is "a tool the catalog cannot
   * serve never ENTERS the catalog". Projecting before registering is what makes that
   * true, and this test is what keeps it true if the two lines are ever reordered.
   */
  it('a tool with an unrepresentable args schema never ENTERS the catalog (order: project, then register)', () => {
    const name = uniq('guard:catalog_ordering_');

    // NOTE: `requirePrincipal` is deliberately OMITTED. Only the principal-gated path
    // populates the registry catalog that tools/list iterates; the role-gated path
    // (requirePrincipal:false — what the tests above use) never calls register(), so it
    // cannot exercise this ordering at all.
    expect(() =>
      defineTool({
        name,
        capability: 'test:read',
        description: 'fixture',
        args: unrepresentableArgs(),
        handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      }),
    ).toThrow(new RegExp(name));

    // The load-bearing assertions: the failed tool left NO residue behind. A survivor
    // here is a live catalog-wide tools/list crash for every client.
    expect(lookup(name)).toBeUndefined();
    expect(getCatalog().some((t) => t.name === name)).toBe(false);
  });

  /*
   * DELIBERATELY NOT HERE: a catalog-wide "every registered tool is representable" sweep.
   * It looks like the obvious companion test and it is a trap — under vitest the registry
   * holds only ~40 of the ~590 tools (nothing imports the full catalog), so it passes by
   * iterating almost nothing and ships VACUOUSLY GREEN, buying false assurance against
   * exactly the failure it appears to cover. su-f69a7079 measured this and su-02434335
   * removed an earlier copy of it; it is recorded here so the next reader does not
   * helpfully add it back a third time.
   *
   * The guarantee is enforced where it is cheap and total instead: at registration (the
   * guard above) and at the two tools/list conversion sites, which now call the same
   * named-throw wrapper rather than a raw z.toJSONSchema.
   */
});
