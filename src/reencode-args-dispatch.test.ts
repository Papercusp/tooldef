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

import { applyCasingArgAliases, defineTool } from './define-tool';
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

/** `content` is a text|image|resource union; every fixture here returns text blocks. */
const texts = (result: { content?: readonly unknown[] } | undefined): string[] =>
  (result?.content ?? []).map((c) => (c as { text?: string }).text ?? '');

const textOf = (result: { content?: readonly unknown[] } | undefined) => texts(result).join('\n');

describe('exact casing aliases', () => {
  it('re-encodes an exact lowerCamelCase spelling to the declared snake_case key', () => {
    const out = applyCasingArgAliases(
      { type: 'object', properties: { timeout_sec: { type: 'number' } } },
      { timeoutSec: 90 },
    );

    expect(out?.input).toEqual({ timeout_sec: 90 });
    expect(out?.corrections).toEqual([
      expect.objectContaining({
        path: 'timeoutSec',
        sent: { timeoutSec: 90 },
        ran: { timeout_sec: 90 },
        rule: 'args.exact-casing-alias',
      }),
    ]);
  });

  it('re-encodes an exact snake_case spelling to the declared lowerCamelCase key', () => {
    const out = applyCasingArgAliases(
      { type: 'object', properties: { wakeOnReply: { type: 'boolean' } } },
      { wake_on_reply: true },
    );

    expect(out?.input).toEqual({ wakeOnReply: true });
  });

  it('never overrides a canonical key or guesses from a merely similar name', () => {
    const schema = { type: 'object', properties: { timeout_sec: { type: 'number' } } };
    expect(applyCasingArgAliases(schema, { timeout_sec: 30, timeoutSec: 90 })).toBeNull();
    expect(applyCasingArgAliases(schema, { timeoutSecs: 90 })).toBeNull();
    expect(applyCasingArgAliases(schema, { timeoutsec: 90 })).toBeNull();
  });

  it('selects the caller-matched union branch instead of borrowing a key from another branch', () => {
    const schema = {
      anyOf: [
        { properties: { op: { const: 'wait' }, timeout_sec: { type: 'number' } } },
        { properties: { op: { const: 'run' }, timeoutSec: { type: 'number' } } },
      ],
    };
    expect(applyCasingArgAliases(schema, { op: 'wait', timeoutSec: 90 })?.input).toEqual({
      op: 'wait',
      timeout_sec: 90,
    });
    expect(applyCasingArgAliases(schema, { op: 'run', timeout_sec: 90 })?.input).toEqual({
      op: 'run',
      timeoutSec: 90,
    });
  });
});

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

  it('accepts an exact casing twin through the real dispatcher and discloses it', async () => {
    const name = `test:casing-alias-${slug}`;
    let seen: unknown;
    defineTool({
      name,
      capability: 'test:read',
      description: 'fixture',
      args: z.object({ timeout_sec: z.number().int().positive() }) as never,
      ...(roleGated ? { requirePrincipal: false as const, agentRoles: ['worker'] } : {}),
      async handler(args: unknown) {
        seen = args;
        return { content: [{ type: 'text', text: 'handler ran' }] };
      },
    } as never);

    const out = await call(name, { timeoutSec: 90 });

    expect(out.ok).toBe(true);
    expect(seen).toEqual({ timeout_sec: 90 });
    expect(texts(out.result)[0]).toContain('AUTO-CORRECTED AND RAN');
    expect(texts(out.result)[0]).toContain('args.exact-casing-alias');
    expect((out.result?._meta as { corrected?: unknown[] })?.corrected).toEqual([
      expect.objectContaining({
        path: 'timeoutSec',
        sent: { timeoutSec: 90 },
        ran: { timeout_sec: 90 },
      }),
    ]);
  });

  it('KEEPS the whole handler payload beside the notice, every block of it', async () => {
    // The second defect this file caught. `attachRequestedStructuredContent` is async, so the
    // first cut handed `disclose` a PROMISE — which spreads to `{}`. Every corrected call
    // returned the correction notice and NOTHING ELSE: the caller was told their call succeeded
    // while its entire result was silently discarded. It reads as a passing repair right up
    // until you look at what came back, and a single-block handler makes it easy to miss, so
    // this asserts on a MULTI-block payload and on order.
    let seen: unknown;
    defineTool({
      name: `test:reencode-payload-${slug}`,
      capability: 'test:read',
      description: 'fixture',
      args: ARGS as never,
      ...(roleGated ? { requirePrincipal: false as const, agentRoles: ['worker'] } : {}),
      argReencodings: [UNWRAP_REFS],
      async handler(args: unknown) {
        seen = args;
        return {
          content: [
            { type: 'text', text: 'first block' },
            { type: 'text', text: 'second block' },
          ],
        };
      },
    } as never);

    const out = await call(`test:reencode-payload-${slug}`, { refs: [{ ref: 'WI-1' }] });

    expect(seen).toEqual({ refs: ['WI-1'] });
    expect(texts(out.result)).toEqual([
      expect.stringContaining('AUTO-CORRECTED AND RAN'),
      'first block',
      'second block',
    ]);
  });

  it('keeps the payload on the JSON/serialized branch too, not just the raw-text one', async () => {
    // The branch coverage gap the typechecker found after the suite was already green: a
    // single-text-item JSON body takes the `serializeProjectedResult` path instead of the raw
    // passthrough, and that producer is async as well. Four such sites carried the same
    // promise defect while every assertion above passed, because no fixture returned JSON.
    defineTool({
      name: `test:reencode-json-${slug}`,
      capability: 'test:read',
      description: 'fixture',
      args: ARGS as never,
      ...(roleGated ? { requirePrincipal: false as const, agentRoles: ['worker'] } : {}),
      argReencodings: [UNWRAP_REFS],
      async handler() {
        return { content: [{ type: 'text', text: JSON.stringify({ rows: [{ id: 1 }] }) }] };
      },
    } as never);

    const out = await call(`test:reencode-json-${slug}`, { refs: [{ ref: 'WI-1' }] });

    expect(out.ok).toBe(true);
    const joined = textOf(out.result);
    expect(joined).toContain('AUTO-CORRECTED AND RAN');
    // The handler's actual data must still be in there — the whole point.
    expect(joined).toContain('rows');
    expect((out.result?._meta as { corrected?: unknown[] })?.corrected).toHaveLength(1);
  });

  it('discloses the correction FIRST in the content and structurally in _meta', async () => {
    fixture(`test:reencode-discloses-${slug}`, { roleGated, reencodings: [UNWRAP_REFS] });

    const out = await call(`test:reencode-discloses-${slug}`, {
      refs: [{ ref: 'WI-1', provenance: 'authored' }],
    });

    // PROMINENT means first: an advisory the reader scrolls past is one they did not get.
    expect(texts(out.result)[0]).toContain('AUTO-CORRECTED AND RAN');
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
    expect(texts(out.result)[0] ?? '').not.toContain('AUTO-CORRECTED');
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
