/**
 * P-016 / D-104 — auto-correct-and-EXECUTE, end to end through a real registered tool.
 *
 * `reencode-args.test.ts` pins the primitive. This file pins the thing the primitive exists
 * for: that a call which would have been REFUSED instead RUNS, that the handler receives the
 * corrected value, and that the result carries the disclosure.
 *
 * It exists because of a defect it caught while being written. `argReencodings` was declared on
 * every input/definition interface and read by both projected wrappers, and the whole feature
 * was still inert: neither `definePrincipalGatedTool` nor `defineRoleGatedTool` copied the field
 * from `input` into `def`, so `def.argReencodings` was always undefined. Every unit test of the
 * rule passed. Nothing typechecked wrong — an optional field that is never assigned is legal.
 * Only a dispatch-level test can see the difference between "the rule is correct" and "the rule
 * is reachable", which is why BOTH registration paths are exercised below rather than one.
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
import type { ArgReencoding } from './reencode-args';

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

/** `refs: [{ ref }] -> ["ref"]` — the shape of the real coord:send rule, minimised. */
const UNWRAP_REFS: ArgReencoding = {
  rule: 'refs.unwrap',
  reencode: (input) => {
    const obj = input as Record<string, unknown> | null;
    const refs = obj?.refs;
    if (
      !Array.isArray(refs) ||
      refs.length === 0 ||
      !refs.every((m) => m && typeof m === 'object' && typeof (m as { ref?: unknown }).ref === 'string')
    ) {
      return null;
    }
    const unwrapped = refs.map((m) => (m as { ref: string }).ref);
    const dropped = [
      ...new Set(refs.flatMap((m) => Object.keys(m as object).filter((k) => k !== 'ref'))),
    ];
    return {
      input: { ...obj, refs: unwrapped },
      corrections: [
        {
          path: 'refs',
          sent: refs,
          ran: unwrapped,
          rule: 'refs.unwrap',
          ...(dropped.length > 0 ? { dropped } : {}),
        },
      ],
    };
  },
};

const ARGS = z.object({ refs: z.array(z.string().min(1)) });

/** Register a fixture on the requested registration path and return what the handler saw. */
function fixture(
  name: string,
  opts: { roleGated: boolean; reencodings?: readonly ArgReencoding[] },
): { seen: () => unknown } {
  let seen: unknown;
  defineTool({
    name,
    capability: 'test:read',
    description: 'fixture',
    args: ARGS as never,
    ...(opts.roleGated ? { requirePrincipal: false as const, agentRoles: ['worker'] } : {}),
    ...(opts.reencodings ? { argReencodings: opts.reencodings } : {}),
    async handler(args: unknown) {
      seen = args;
      return { content: [{ type: 'text', text: 'handler ran' }] };
    },
  } as never);
  return { seen: () => seen };
}

const call = (name: string, input: unknown) =>
  dispatchProjectedTool(lookupByMcpName(name)!, name, input, ctx({ role: 'worker' }), DEPS);

const textOf = (result: { content?: Array<{ type: string; text?: string }> } | undefined) =>
  (result?.content ?? []).map((c) => c.text ?? '').join('\n');

/**
 * Both registration paths must carry the repair. Which one a tool lands in is decided by
 * `requirePrincipal: false` — a registration detail entirely invisible to the caller whose
 * arg shape is being repaired, so a rule that worked on only one path would fail for reasons
 * no caller could diagnose. coord:send, the verb this was measured for, is role-gated.
 */
describe.each([
  { label: 'principal-gated (registerLegacyAsProjected)', roleGated: false },
  { label: 'role-gated (registerRoleGatedAsProjected)', roleGated: true },
])('auto-correct-and-execute — $label', ({ label, roleGated }) => {
  const slug = roleGated ? 'role' : 'principal';

  it('RUNS the corrected call instead of refusing it, and hands the handler the corrected value', async () => {
    const f = fixture(`test:reencode-runs-${slug}`, { roleGated, reencodings: [UNWRAP_REFS] });

    const out = await call(`test:reencode-runs-${slug}`, { refs: [{ ref: 'WI-1' }, { ref: 'WI-2' }] });

    expect(out.ok).toBe(true);
    expect(f.seen()).toEqual({ refs: ['WI-1', 'WI-2'] });
    expect(textOf(out.result)).toContain('handler ran');
  });

  it('discloses the correction FIRST in the content and structurally in _meta', async () => {
    fixture(`test:reencode-discloses-${slug}`, { roleGated, reencodings: [UNWRAP_REFS] });

    const out = await call(`test:reencode-discloses-${slug}`, {
      refs: [{ ref: 'WI-1', provenance: 'authored' }],
    });

    // PROMINENT means first: an advisory the reader scrolls past is one they did not get.
    expect(out.result?.content?.[0]?.text).toContain('AUTO-CORRECTED AND RAN');
    expect(textOf(out.result)).toContain('`provenance`');

    // The structured half rides _meta unconditionally — EI-10883's requirement must not
    // depend on the caller having negotiated structuredContent.
    const corrected = (out.result?._meta as { corrected?: Array<Record<string, unknown>> })
      ?.corrected;
    expect(corrected).toHaveLength(1);
    expect(corrected?.[0]).toMatchObject({
      path: 'refs',
      ran: ['WI-1'],
      rule: 'refs.unwrap',
      dropped: ['provenance'],
    });
  });

  it('leaves an ALREADY-VALID call completely alone — the rule is never even consulted', async () => {
    // Ordering is the safety property: validate first, repair second. If the repair ran on the
    // hot path it could re-shape a valid call, which is a silent behaviour change rather than
    // a repair. A spy is the only way to see the difference — the output would look identical.
    const spy = vi.fn(UNWRAP_REFS.reencode);
    const f = fixture(`test:reencode-untouched-${slug}`, {
      roleGated,
      reencodings: [{ rule: 'refs.unwrap', reencode: spy }],
    });

    const out = await call(`test:reencode-untouched-${slug}`, { refs: ['WI-1'] });

    expect(out.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(f.seen()).toEqual({ refs: ['WI-1'] });
    expect(out.result?.content?.[0]?.text).not.toContain('AUTO-CORRECTED');
    expect((out.result?._meta as { corrected?: unknown })?.corrected).toBeUndefined();
  });

  it('still refuses a shape no rule covers, with the ordinary taught message', async () => {
    // D-107 rulings 2 and 4 in miniature: a bare string and a member with no `ref` are a
    // DISAMBIGUATION, not a re-encoding, and must keep the refusal.
    fixture(`test:reencode-uncovered-${slug}`, { roleGated, reencodings: [UNWRAP_REFS] });

    const out = await call(`test:reencode-uncovered-${slug}`, { refs: [{ id: 'WI-1' }] });

    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('invalid_input');
    expect(out.error?.message).toContain('invalid_args');
  });

  it('falls back to the ORIGINAL diagnosis when a rule fires but the result still does not validate', async () => {
    // A second-order error from a partial repair would replace the caller's real diagnosis with
    // a confusing one about a field they never got wrong.
    fixture(`test:reencode-partial-${slug}`, { roleGated, reencodings: [UNWRAP_REFS] });

    const out = await call(`test:reencode-partial-${slug}`, {
      refs: [{ ref: 'WI-1' }],
      surprise: true,
    });

    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('invalid_input');
    expect(out.error?.message).toContain('surprise');
  });

  it('a tool that registers NO re-encodings refuses exactly as before (the calibration control)', async () => {
    // Without this row, every "it repaired" assertion above would also pass if the dispatcher
    // repaired unconditionally. This is the case that proves the declaration is what opts in.
    fixture(`test:reencode-optout-${slug}`, { roleGated });

    const out = await call(`test:reencode-optout-${slug}`, { refs: [{ ref: 'WI-1' }] });

    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('invalid_input');
  });
});
