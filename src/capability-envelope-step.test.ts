/**
 * Behavior tests for the `capability-envelope` dispatch step
 * (agent-capability-confinement-2026-06-13 B-06 / P-012). The step is pure mechanism:
 * it acts only on the host `checkCapabilityEnvelope` port's verdict, threads it onto the
 * postInvoke event, and is a no-op (behavior-neutral) when the port is unwired. Policy
 * (the per-role envelope itself) is tested in operator-core's policy.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDispatchStack } from './dispatch-stack';
import {
  _resetProjectionRegistryForTests,
  type ProjectedTool,
  type UnifiedToolContext,
} from './tool-projection';
import type {
  CapabilityEnvelopeVerdict,
  DispatchProjectedDeps,
  PostInvokeEvent,
} from './dispatch-types';

const MAKE_CTX = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'default',
  harnessSlug: 'sheets',
  role: 'worker',
  runId: 'run_X',
  spawnId: 'spw_X',
  ...over,
});

const makeTool = (over: Partial<ProjectedTool> = {}): ProjectedTool => ({
  pluginName: 'fixture',
  description: 'fixture',
  inputSchema: { type: 'object' },
  capabilities: ['plans:write'],
  expose: { mcp: { name: 'fix.tool' } },
  fn: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetProjectionRegistryForTests();
});

describe('capability-envelope step', () => {
  it('is a no-op when no checkCapabilityEnvelope port is wired (behavior-neutral)', async () => {
    let invoked = false;
    const tool = makeTool({ fn: async () => { invoked = true; return { content: [{ type: 'text', text: 'ok' }] }; } });
    let event: PostInvokeEvent | null = null;
    const deps: DispatchProjectedDeps = { postInvoke: (e) => { event = e; } };

    const r = await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), deps);

    expect(r.ok).toBe(true);
    expect(invoked).toBe(true);
    // no step ran ⇒ the init value (null) is threaded; the ledger then records posture 'auto'.
    expect(event!.envelopeVerdict ?? null).toBeNull();
    // capabilities are always threaded for the ledger emit.
    expect(event!.capabilities).toEqual(['plans:write']);
  });

  it('short-circuits with capability_denied when the verdict is deny; handler not invoked', async () => {
    let invoked = false;
    const tool = makeTool({ fn: async () => { invoked = true; return { content: [{ type: 'text', text: 'ok' }] }; } });
    const verdict: CapabilityEnvelopeVerdict = {
      decision: 'deny', posture: 'rejected', applied: true, reason: 'protected capability',
    };
    let event: PostInvokeEvent | null = null;
    const deps: DispatchProjectedDeps = {
      checkCapabilityEnvelope: () => verdict,
      postInvoke: (e) => { event = e; },
    };

    const r = await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), deps);

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('capability_denied');
    expect(r.error?.message).toContain('protected capability');
    expect(invoked).toBe(false);
    // the verdict is still threaded so the ledger records posture 'rejected'.
    expect(event!.envelopeVerdict?.posture).toBe('rejected');
  });

  it('proceeds on observe (shadow), threading posture gated for the ledger', async () => {
    let invoked = false;
    const tool = makeTool({ fn: async () => { invoked = true; return { content: [{ type: 'text', text: 'ok' }] }; } });
    const verdict: CapabilityEnvelopeVerdict = {
      decision: 'observe', posture: 'gated', applied: true, reason: 'would-deny',
    };
    let event: PostInvokeEvent | null = null;
    const deps: DispatchProjectedDeps = {
      checkCapabilityEnvelope: async () => verdict,
      postInvoke: (e) => { event = e; },
    };

    const r = await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), deps);

    expect(r.ok).toBe(true);
    expect(invoked).toBe(true);
    expect(event!.envelopeVerdict?.posture).toBe('gated');
    expect(event!.envelopeVerdict?.reason).toBe('would-deny');
  });

  it('proceeds on allow', async () => {
    const verdict: CapabilityEnvelopeVerdict = { decision: 'allow', posture: 'auto', applied: true };
    let event: PostInvokeEvent | null = null;
    const deps: DispatchProjectedDeps = {
      checkCapabilityEnvelope: () => verdict,
      postInvoke: (e) => { event = e; },
    };
    const r = await runDispatchStack(makeTool(), 'fix.tool', {}, MAKE_CTX(), deps);
    expect(r.ok).toBe(true);
    expect(event!.envelopeVerdict?.posture).toBe('auto');
  });

  it('null verdict (exempt) proceeds with no verdict stashed', async () => {
    let event: PostInvokeEvent | null = null;
    const deps: DispatchProjectedDeps = {
      checkCapabilityEnvelope: () => null,
      postInvoke: (e) => { event = e; },
    };
    const r = await runDispatchStack(makeTool(), 'fix.tool', {}, MAKE_CTX(), deps);
    expect(r.ok).toBe(true);
    expect(event!.envelopeVerdict ?? null).toBeNull();
  });

  it('FAILS OPEN when the evaluator throws (sandbox is the backstop) — call proceeds', async () => {
    let invoked = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tool = makeTool({ fn: async () => { invoked = true; return { content: [{ type: 'text', text: 'ok' }] }; } });
    const deps: DispatchProjectedDeps = {
      checkCapabilityEnvelope: () => { throw new Error('evaluator bug'); },
    };
    const r = await runDispatchStack(tool, 'fix.tool', {}, MAKE_CTX(), deps);
    expect(r.ok).toBe(true);
    expect(invoked).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      '[capability-envelope] evaluator threw for "fix.tool" (failing open): evaluator bug',
    );
  });

  it('passes the tool capabilities + args to the port', async () => {
    let received: { toolName: string; capabilities: readonly string[]; args: unknown } | null = null;
    const deps: DispatchProjectedDeps = {
      checkCapabilityEnvelope: (arg) => {
        received = arg;
        return null;
      },
    };
    await runDispatchStack(
      makeTool({ capabilities: ['cup:spawn'] }),
      'fix.tool',
      { foo: 1 },
      MAKE_CTX({ role: 'queen' }),
      deps,
    );
    expect(received).not.toBeNull();
    expect(received!.toolName).toBe('fix.tool');
    expect(received!.capabilities).toEqual(['cup:spawn']);
    expect(received!.args).toEqual({ foo: 1 });
  });
});
