/**
 * EI-21353729155349111 — the MIRROR of the `Unrecognized key` staleness case pinned by
 * server-vintage-hint.test.ts.
 *
 * There, the caller is newer than the server (it sent an arg the process predates).
 * Here, the SERVER is newer-than-the-tree's-reader: it is still enforcing a constraint
 * (`minItems`, an enum member, a range) that the tree has since relaxed. That case is
 * strictly nastier to diagnose, because the evidence a reader naturally reaches for
 * actively misleads them — they open the tool's source, see no such constraint, and
 * conclude the tool is broken rather than that they are talking to an older build of it.
 *
 * The lead case below is the real one, reproduced exactly: EI-21310032409432146, where
 * `work_items:complete` refused `verification.coverage.residue: []` against a live
 * `minItems: 1` the tree had already dropped, and it cost a full investigation.
 *
 * Pinned through the REAL dispatch path (defineTool → dispatchProjectedTool) rather than
 * the pure formatter, for the reason server-vintage-hint.test.ts already states: a unit
 * test on the formatter alone would not catch it not being WIRED into its call site —
 * and the wiring here is a single branch in `makeInvalidInputError` that is very easy to
 * regress back to the empty string it replaced.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from './define-tool';
import { dispatchProjectedTool, type DispatchProjectedDeps } from './dispatch-projected';
import { _resetProjectionRegistryForTests, lookupByMcpName, type UnifiedToolContext } from './tool-projection';
import { resetServerVintageResolver, setServerVintageResolver } from './server-vintage';

const DEPS: DispatchProjectedDeps = {};

const ctx = (): UnifiedToolContext => ({
  log: () => {},
  signal: new AbortController().signal,
  progress: () => {},
  emit: () => {},
  workspaceId: 'default',
  runId: 'r',
  transport: 'mcp',
  principal: { slug: 'system:superuser', workspaceId: 'default', capabilities: new Set(['test:read']) },
  tx: {},
});

/** Define a fixture tool and call it, returning the invalid_args message. */
async function failWith(name: string, args: z.ZodTypeAny, input: unknown): Promise<string> {
  defineTool({
    name,
    capability: 'test:read',
    description: 'fixture',
    args: args as never,
    async handler() {
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  });
  // dispatchProjectedTool does not throw on a validation failure — it returns a
  // discriminated { ok: false, error } result.
  const outcome = await dispatchProjectedTool(lookupByMcpName(name)!, name, input, ctx(), DEPS);
  if (outcome.ok) throw new Error('expected the call to fail with invalid_input');
  expect(outcome.error?.code).toBe('invalid_input');
  return outcome.error?.message ?? '';
}

/** The EI-21310032409432146 shape: an array field carrying a `minItems: 1` floor. */
const RESIDUE_SCHEMA = z.object({ residue: z.array(z.string()).min(1) });

afterEach(() => {
  _resetProjectionRegistryForTests();
  resetServerVintageResolver();
});

describe('constraintVintageHint — a stale CONSTRAINT is annotated, not just a stale ARG', () => {
  it('annotates the real EI-21310032409432146 case: minItems refusing an empty array', async () => {
    setServerVintageResolver(() => ({ buildId: '6760f8ec31', bootedAgoMs: 3 * 60 * 60_000 }));

    const message = await failWith('test:constraint-vintage-residue', RESIDUE_SCHEMA, { residue: [] });

    // It still says what actually failed...
    expect(message).toContain('invalid_args');
    expect(message).toContain('residue');
    // ...and now also which code was enforcing it, and that the tree may disagree.
    expect(message).toContain('6760f8ec31');
    expect(message).toContain('3.0h');
    expect(message).toContain('CONSTRAINT');
    expect(message).toContain('verify against the serving build');
  });

  it('is silent when no host resolver is registered (behaviour-neutral for every other consumer)', async () => {
    const message = await failWith('test:constraint-vintage-unregistered', RESIDUE_SCHEMA, { residue: [] });

    expect(message).toContain('invalid_args');
    expect(message).not.toContain('CONSTRAINT');
    expect(message).not.toContain('This server is running build');
  });

  it('annotates a bad enum value too (invalid_value, not just a size floor)', async () => {
    setServerVintageResolver(() => ({ buildId: 'abc123', bootedAgoMs: 90 * 60_000 }));

    const message = await failWith(
      'test:constraint-vintage-enum',
      z.object({ mode: z.enum(['a', 'b']) }),
      { mode: 'c' },
    );

    expect(message).toContain('CONSTRAINT');
    expect(message).toContain('abc123');
  });

  it('does NOT double-hint: an unrecognized key keeps the ARG wording, not the CONSTRAINT wording', async () => {
    setServerVintageResolver(() => ({ buildId: 'abc123', bootedAgoMs: 60_000 }));

    const message = await failWith(
      'test:constraint-vintage-unknown-key',
      z.object({ known: z.string() }),
      { known: 'x', bogus: 1 },
    );

    expect(message).toContain('Unrecognized key');
    // The arg-shaped hint fires...
    expect(message.toLowerCase()).toContain('restart');
    // ...and the constraint-shaped one does not, so the reader gets ONE diagnosis.
    expect(message).not.toContain('CONSTRAINT');
  });

  it('does NOT hint on a shape problem (a missing required field) — that caller gets the schema instead', async () => {
    setServerVintageResolver(() => ({ buildId: 'abc123', bootedAgoMs: 60_000 }));

    const message = await failWith(
      'test:constraint-vintage-missing-required',
      z.object({ id: z.string(), label: z.string() }),
      { label: 'ok' },
    );

    expect(message).not.toContain('CONSTRAINT');
  });

  it('does not re-introduce the full args-schema dump on the value-level branch (EI-10943 stands)', async () => {
    // The whole point of the value-level branch is that a caller who knows the shape and
    // sent a bad VALUE does not need 1,800 chars of schema. This adds one sentence to
    // that branch and must not become a wedge for the dump coming back.
    setServerVintageResolver(() => ({ buildId: 'abc123', bootedAgoMs: 60_000 }));

    const message = await failWith('test:constraint-vintage-no-dump', RESIDUE_SCHEMA, { residue: [] });

    expect(message).toContain('CONSTRAINT');
    expect(message).not.toContain('full args schema');
  });
});
