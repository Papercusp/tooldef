/**
 * EI-19486111655110215 — CROSS-PHASE requirements reported alongside a schema failure.
 *
 * The measured defect: `work_items:complete` refused one close three times, each for a
 * DIFFERENT reason, because schema validation and the handler's own preconditions run in
 * separate phases. Zod already reports every SCHEMA issue at once; what it cannot see is a
 * requirement enforced after the parse and conditional on a post-parse value (there,
 * `assumptions`, required only for a terminal close). So a caller who fixes the schema
 * error is refused a second time for a reason the first refusal already had the input to
 * name — and because a malformed completion is KNOWN to coerce silently on that verb, the
 * second refusal reads as "my object is still malformed" rather than "a different,
 * unrelated arg is required".
 *
 * Note the item's own proposed fix (non-abort-early zod) could not have worked: only one of
 * the two failures is a zod issue at all. The fix is a declared hook, not a parser change.
 *
 * This is a DISPATCH-level test for the same reason `reencode-args-dispatch.test.ts` is:
 * `argReencodings` shipped completely INERT once — declared on every interface, read by
 * both wrappers, and never copied from `input` into `def` by either builder
 * (EI-22172195473893352). Every unit test of the rule passed; nothing typechecked wrong,
 * because an optional field that is never assigned is legal. Only dispatch can tell
 * "correct" from "reachable", so BOTH registration paths are exercised below.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { defineTool } from './define-tool';
import { dispatchProjectedTool, type DispatchProjectedDeps } from './dispatch-projected';
import {
  _resetProjectionRegistryForTests,
  lookupByMcpName,
  type UnifiedToolContext,
} from './tool-projection';

const DEPS: DispatchProjectedDeps = {};

const ctx = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'default',
  runId: 'r',
  transport: 'mcp',
  principal: {
    slug: 'system:superuser',
    workspaceId: 'default',
    capabilities: new Set(['test:read']),
  },
  tx: {},
  ...over,
});

afterEach(() => _resetProjectionRegistryForTests());

/**
 * Minimised `work_items:complete`: `addedTests` is the SCHEMA half (boolean), and
 * `assumptions` is the CROSS-PHASE half — optional to the parser because it is required
 * only when `state` carries close intent, which is exactly why it cannot live in the schema.
 */
const ARGS = z.object({
  id: z.string().min(1),
  state: z.string().optional(),
  addedTests: z.boolean().optional(),
  assumptions: z.string().optional(),
});

const ASSUMPTIONS_LINE = 'a terminal close requires `assumptions` ("none" or fact keys)';

/** The real shape: conditional on a value, and silent when nothing further would fail. */
const assumptionsPrecondition = (raw: unknown): readonly string[] => {
  const obj = raw as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') return [];
  const closing = typeof obj.state === 'string' && obj.state === 'resolved';
  return closing && obj.assumptions === undefined ? [ASSUMPTIONS_LINE] : [];
};

function fixture(
  name: string,
  opts: {
    roleGated: boolean;
    argPreconditions?: (rawInput: unknown) => readonly string[];
  },
): void {
  defineTool({
    name,
    capability: 'test:read',
    description: 'fixture',
    args: ARGS as never,
    ...(opts.roleGated ? { requirePrincipal: false as const, agentRoles: ['worker'] } : {}),
    ...(opts.argPreconditions ? { argPreconditions: opts.argPreconditions } : {}),
    async handler() {
      return { content: [{ type: 'text', text: 'handler ran' }] };
    },
  } as never);
}

const call = (name: string, input: unknown) =>
  dispatchProjectedTool(lookupByMcpName(name)!, name, input, ctx({ role: 'worker' }), DEPS);

describe.each([
  ['principal-gated', false],
  ['role-gated', true],
] as const)('argPreconditions on the %s registration path', (slug, roleGated) => {
  it('THE POINT: one refusal names the schema failure AND the cross-phase requirement', async () => {
    fixture(`test:precond-both-${slug}`, { roleGated, argPreconditions: assumptionsPrecondition });

    // Both halves wrong at once — the exact call the filing agent made.
    const out = await call(`test:precond-both-${slug}`, {
      id: 'WI-1',
      state: 'resolved',
      addedTests: 'yes-lots-of-them',
    });

    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('invalid_input');
    const message = out.error?.message ?? '';
    // The schema half is untouched — this must ADD to the diagnosis, never replace it.
    expect(message).toContain('invalid_args');
    expect(message).toContain('addedTests');
    // ...and the half that used to cost a whole second round-trip.
    expect(message).toContain(ASSUMPTIONS_LINE);
  });

  it('CONTROL — the same refusal WITHOUT the declaration carries no cross-phase section', async () => {
    // Without this, the assertion above passes for a tool whose hook was never reached:
    // an always-present section proves nothing about whether the declaration was read.
    // This is the assertion that fails if either builder drops the field (EI-22172195473893352).
    fixture(`test:precond-undeclared-${slug}`, { roleGated });

    const out = await call(`test:precond-undeclared-${slug}`, {
      id: 'WI-1',
      state: 'resolved',
      addedTests: 'yes-lots-of-them',
    });

    expect(out.ok).toBe(false);
    expect(out.error?.message ?? '').toContain('addedTests');
    expect(out.error?.message ?? '').not.toContain('ALSO required');
    expect(out.error?.message ?? '').not.toContain(ASSUMPTIONS_LINE);
  });

  it('CONTROL — says nothing when the cross-phase requirement is already satisfied', async () => {
    // A hook that fired unconditionally would "pass" the headline test while teaching every
    // caller a requirement they had already met.
    fixture(`test:precond-satisfied-${slug}`, { roleGated, argPreconditions: assumptionsPrecondition });

    const out = await call(`test:precond-satisfied-${slug}`, {
      id: 'WI-1',
      state: 'resolved',
      assumptions: 'none',
      addedTests: 'yes-lots-of-them',
    });

    expect(out.ok).toBe(false);
    expect(out.error?.message ?? '').toContain('addedTests');
    expect(out.error?.message ?? '').not.toContain(ASSUMPTIONS_LINE);
  });

  it('a VALID call never invokes the hook — the failing path pays, the ordinary path does not', async () => {
    const spy = vi.fn(assumptionsPrecondition);
    fixture(`test:precond-valid-${slug}`, { roleGated, argPreconditions: spy });

    // Would trip the precondition if it ran, but the schema accepts this call.
    const out = await call(`test:precond-valid-${slug}`, { id: 'WI-1', state: 'resolved' });

    expect(out.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a THROWING hook is dropped, never allowed to mask the real diagnosis', async () => {
    // It sees unvalidated input of arbitrary shape, so it is the one place in the refusal
    // path most likely to throw. Replacing a precise schema error with a stack trace would
    // be strictly worse than the gap this closes.
    fixture(`test:precond-throws-${slug}`, {
      roleGated,
      argPreconditions: () => {
        throw new Error('precondition exploded');
      },
    });

    const out = await call(`test:precond-throws-${slug}`, {
      id: 'WI-1',
      state: 'resolved',
      addedTests: 'yes-lots-of-them',
    });

    expect(out.ok).toBe(false);
    expect(out.error?.message ?? '').toContain('addedTests');
    expect(out.error?.message ?? '').not.toContain('precondition exploded');
  });

  it('tolerates a hook returning a non-array or blank lines without emitting an empty section', async () => {
    fixture(`test:precond-junk-${slug}`, {
      roleGated,
      argPreconditions: () => ['   ', ''] as readonly string[],
    });

    const out = await call(`test:precond-junk-${slug}`, {
      id: 'WI-1',
      state: 'resolved',
      addedTests: 'yes-lots-of-them',
    });

    expect(out.ok).toBe(false);
    expect(out.error?.message ?? '').toContain('addedTests');
    expect(out.error?.message ?? '').not.toContain('ALSO required');
  });
});
