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

  /**
   * The SECOND unrepresentable construct, and the one that gets mis-remedied.
   *
   * `z.custom<T>()` is invisible to every check an author normally runs — it is perfectly
   * well-typed, so `tsc` is affirmatively green — and it surfaces only when some suite
   * happens to import the catalog. The message must therefore carry the way OUT, and the
   * way out is not the transform remedy: a reader told to "terminate it with `.pipe()`"
   * has been handed a step that cannot be performed, and the natural next pick
   * (`z.unknown()`) merely trades a catalog break for a TS2322 at the assignment.
   */
  it('names the offending tool AND gives the custom-type remedy when its args carry z.custom()', () => {
    const name = uniq('guard:custom_type_');

    let msg = '';
    try {
      defineTool({
        name,
        requirePrincipal: false,
        capability: 'test:read',
        args: z.object({ passthrough: z.custom<{ tag: string }>().nullish() }),
        handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
      });
    } catch (err) {
      msg = (err as Error).message;
    }

    expect(msg).toContain(name); // which tool
    expect(msg).toMatch(/custom/i); // the cause, as the converter reported it
    expect(msg).toMatch(/z\.any\(\)/); // the remedy that actually applies

    // Load-bearing: the remedy must be CAUSE-SPECIFIC, not the transform boilerplate.
    // Before the cause-aware branch this message told a z.custom author to terminate a
    // transform that does not exist, so this assertion is what distinguishes the two.
    expect(msg).not.toMatch(/\.pipe\(/);
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

    // CALIBRATION for the z.custom case above: both rungs the remedy names must really
    // convert. Without this the custom test is satisfiable by a guard that rejects every
    // loosely-typed field, which would make the advice it prints unfollowable.
    for (const [label, schema] of [
      ['any', z.any()],
      ['unknown', z.unknown()],
    ] as const) {
      expect(
        () =>
          defineTool({
            name: uniq(`guard:representable_${label}_`),
            requirePrincipal: false,
            capability: 'test:read',
            args: z.object({ passthrough: schema.nullish() }),
            handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
          }),
        `z.${label}() must stay representable — the z.custom remedy names it as the way out`,
      ).not.toThrow();
    }
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
   * It looks like the obvious companion test and IN THIS PROJECT it is a trap — this is a
   * generic package with no consumer catalog in scope, so its registry holds only the
   * handful of tools these tests themselves define. A sweep here passes by iterating
   * almost nothing and ships VACUOUSLY GREEN, buying false assurance against exactly the
   * failure it appears to cover. su-f69a7079 measured this and su-02434335 removed an
   * earlier copy; recorded so the next reader does not helpfully add it back a third time.
   *
   * ⚠ SCOPE — do not read that as "a catalog sweep is always vacuous", and do not delete a
   * consumer's sweep as this known trap. A sweep IS sound wherever something actually
   * imports the full catalog first, and one lives there:
   * packages/operator-core/lib/__tests__/tool-input-schema-rejection.test.ts (superproject
   * path) does `import '../agent-tools/index'` and has caught two real regressions
   * (EI-20081950141743058, EI-21930203761949555). Note WHERE its totality comes from: the
   * import itself converts every tool at registration, so an unrepresentable schema fails
   * that file at COLLECTION; the explicit loop over getCatalog() covers only the legacy
   * built-ins. The import is the total guarantee, the loop is the named report.
   *
   * So the guarantee is enforced where it is cheap and total: at registration (the guards
   * above) and at the tools/list conversion sites, which call this same named-throw
   * wrapper rather than a raw z.toJSONSchema.
   */
});
