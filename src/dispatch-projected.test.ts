/**
 * Tests for the unified projected-tool dispatcher.
 * Run with: npx vitest run packages/agent-mcp/src/dispatch-projected.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchProjectedTool,
  dispatchProjectedToolStream,
  defaultComputeQuotaWindow,
  InvalidInputError,
  type DispatchProjectedDeps,
  type DispatchStreamEvent,
} from './dispatch-projected';
import {
  _resetProjectionRegistryForTests,
  type ProjectedTool,
  type UnifiedToolContext,
} from './tool-projection';
import { PASS_THROUGH } from './dispatch-projected';
import type { ToolResult } from './wire';
import type { AuthAuditEvent } from './authz';

const MAKE_CTX = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'default',
  harnessSlug: 'sheets',
  role: 'worker',
  featureId: 'F-AUTH-003',
  chunkId: 'ck_X',
  runId: 'run_X',
  spawnId: 'spw_X',
  parentSpawnId: null,
  ...over,
});

const MAKE_DEPS = (over: Partial<DispatchProjectedDeps> = {}): DispatchProjectedDeps => ({
  readQuotaState: undefined,
  recordInvocation: undefined,
  ...over,
});

const makeTool = (over: Partial<ProjectedTool> = {}): ProjectedTool => ({
  pluginName: 'fixture',
  description: 'fixture',
  inputSchema: { type: 'object' },
  capabilities: [],
  expose: { mcp: { name: 'fix.tool' } },
  fn: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  ...over,
});

afterEach(() => _resetProjectionRegistryForTests());

describe('defaultComputeQuotaWindow', () => {
  // The engine's generic default is run-scoped, perRun-capped. Papercusp's
  // role-aware policy (worker→chunk/perChunk, power-user→session) lives in the
  // host adapter now and is covered by agent-mcp/src/quota-policy.test.ts.
  it('keys on run:<id> regardless of role', () => {
    expect(defaultComputeQuotaWindow(MAKE_CTX({ role: 'worker', runId: 'run_A' }), undefined).key).toBe('run:run_A');
    expect(defaultComputeQuotaWindow(MAKE_CTX({ role: 'architect', runId: 'run_B' }), undefined).key).toBe('run:run_B');
  });
  it('returns a null window when ctx has no runId', () => {
    expect(defaultComputeQuotaWindow(MAKE_CTX({ runId: undefined }), { perRun: 5 }).key).toBeNull();
  });
  it('takes the ceiling from roleQuota.perRun', () => {
    expect(defaultComputeQuotaWindow(MAKE_CTX(), { perRun: 5 }).limit).toBe(5);
  });
  it('reports a null limit when there is no roleQuota', () => {
    expect(defaultComputeQuotaWindow(MAKE_CTX(), undefined).limit).toBeNull();
  });
});

describe('dispatchProjectedTool', () => {
  it('invokes the function and returns its ToolResult', async () => {
    const tool = makeTool({
      fn: async () => ({ content: [{ type: 'text', text: 'invoked' }] }),
    });
    const r = await dispatchProjectedTool(tool, 'fix.tool', { x: 1 }, MAKE_CTX(), MAKE_DEPS());
    expect(r.ok).toBe(true);
    expect(r.result?.content[0]).toEqual({ type: 'text', text: 'invoked' });
  });

  it('passes the unified context to the function', async () => {
    let captured: UnifiedToolContext | null = null;
    const tool = makeTool({
      fn: async (_input, ctx) => {
        captured = ctx;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX({ role: 'architect', spawnId: 'spw_Y' }), MAKE_DEPS());
    expect(captured).not.toBeNull();
    expect(captured!.role).toBe('architect');
    expect(captured!.spawnId).toBe('spw_Y');
  });

  it('rejects role-not-allowed when caller role outside allowlist', async () => {
    const tool = makeTool({ agentRoles: ['architect'] });
    const recorded: string[] = [];
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX({ role: 'worker' }), MAKE_DEPS({
      recordInvocation: vi.fn(async (i) => { recorded.push(i.status); }),
    }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('role_not_allowed');
    expect(recorded).toEqual(['role-not-allowed']);
  });

  it('skips role check when ctx.role is unset (HTTP caller without role)', async () => {
    const tool = makeTool({ agentRoles: ['architect'] });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX({ role: undefined }), MAKE_DEPS());
    expect(r.ok).toBe(true);
  });

  // ctx.gateBypass is the engine's neutral "privileged caller" signal (P-014).
  // The host (papercuspGateBypass) maps superuser/power-user onto it; the engine
  // no longer reads isSuperuser/isPowerUser for gating.
  it('gateBypass.role skips the role-allowlist gate', async () => {
    const tool = makeTool({ agentRoles: ['architect'] });
    const denied = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX({ role: 'worker' }), MAKE_DEPS());
    expect(denied.error?.code).toBe('role_not_allowed');
    const bypassed = await dispatchProjectedTool(
      tool, 'fix.tool', {}, MAKE_CTX({ role: 'worker', gateBypass: { role: true } }), MAKE_DEPS(),
    );
    expect(bypassed.ok).toBe(true);
  });

  it('gateBypass.capability skips the capability gate', async () => {
    const tool = makeTool({ capabilities: ['secrets:read'] });
    const principal = {
      kind: 'system' as const, slug: 'p', workspaceId: 'default',
      authMethod: 'process-internal' as const, trust: 'trusted' as const,
      capabilities: new Set<string>(), // lacks 'secrets:read'
    };
    const denied = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX({ principal }), MAKE_DEPS());
    expect(denied.error?.code).toBe('missing_capability');
    const bypassed = await dispatchProjectedTool(
      tool, 'fix.tool', {}, MAKE_CTX({ principal, gateBypass: { capability: true } }), MAKE_DEPS(),
    );
    expect(bypassed.ok).toBe(true);
  });

  it('gateBypass.quota skips the quota gate', async () => {
    const tool = makeTool({ rolesQuota: { worker: { perRun: 1 } } });
    const deps = MAKE_DEPS({ readQuotaState: vi.fn(async () => ({ count: 1 })) });
    const denied = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), deps);
    expect(denied.error?.code).toBe('quota_exceeded');
    const bypassed = await dispatchProjectedTool(
      tool, 'fix.tool', {}, MAKE_CTX({ gateBypass: { quota: true } }), deps,
    );
    expect(bypassed.ok).toBe(true);
  });

  // ── harness-required gate (P-020) ──────────────────────────────────────
  it("harness:'required' with no harnessSlug → harness_required", async () => {
    const tool = makeTool({ harness: 'required' });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX({ harnessSlug: undefined }), MAKE_DEPS());
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('harness_required');
  });

  it("harness:'required' with the '*' wildcard → harness_required (superuser no-harness sentinel)", async () => {
    const tool = makeTool({ harness: 'required' });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX({ harnessSlug: '*' }), MAKE_DEPS());
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('harness_required');
  });

  it("harness:'required' with a concrete harnessSlug → passes", async () => {
    const tool = makeTool({ harness: 'required' });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX({ harnessSlug: 'sheets' }), MAKE_DEPS());
    expect(r.ok).toBe(true);
  });

  it('no harness declaration (default) → no gate even without a harnessSlug', async () => {
    const tool = makeTool();
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX({ harnessSlug: undefined }), MAKE_DEPS());
    expect(r.ok).toBe(true);
  });

  it("harness:'optional' / 'none' → never gated", async () => {
    for (const h of ['optional', 'none'] as const) {
      const tool = makeTool({ harness: h });
      const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX({ harnessSlug: '*' }), MAKE_DEPS());
      expect(r.ok).toBe(true);
    }
  });

  it('gateBypass.harness skips the harness gate (explicit escape hatch)', async () => {
    const tool = makeTool({ harness: 'required' });
    const denied = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX({ harnessSlug: undefined }), MAKE_DEPS());
    expect(denied.error?.code).toBe('harness_required');
    const bypassed = await dispatchProjectedTool(
      tool, 'fix.tool', {}, MAKE_CTX({ harnessSlug: undefined, gateBypass: { harness: true } }), MAKE_DEPS(),
    );
    expect(bypassed.ok).toBe(true);
  });

  // The default policy is run-scoped/perRun; these exercise the engine's
  // generic enforcement. The worker→chunk/perChunk path is host policy and is
  // covered end-to-end by the custom-computeQuotaWindow test below.
  it('rejects quota_exceeded when count is at the limit', async () => {
    const tool = makeTool({ rolesQuota: { worker: { perRun: 1 } } });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({
      readQuotaState: vi.fn(async () => ({ count: 1 })),
    }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('quota_exceeded');
    expect(r.error?.meta).toMatchObject({ used: 1, limit: 1 });
  });

  it('allows when count under limit', async () => {
    const tool = makeTool({ rolesQuota: { worker: { perRun: 5 } } });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({
      readQuotaState: vi.fn(async () => ({ count: 2 })),
    }));
    expect(r.ok).toBe(true);
  });

  it('fails-open when readQuotaState throws', async () => {
    const tool = makeTool({ rolesQuota: { worker: { perRun: 1 } } });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({
      readQuotaState: vi.fn(async () => { throw new Error('pg down'); }),
    }));
    expect(r.ok).toBe(true);
  });

  it('honors a host-supplied computeQuotaWindow (window key + ceiling)', async () => {
    const tool = makeTool({ rolesQuota: { worker: { perChunk: 1 } } });
    const seen: string[] = [];
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX({ chunkId: 'ck_Z' }), MAKE_DEPS({
      // Host policy: key on the chunk, cap by perChunk — the engine reads
      // neither field name itself.
      computeQuotaWindow: (ctx, rq) => ({ key: `chunk:${ctx.chunkId}`, limit: rq?.perChunk ?? null }),
      readQuotaState: vi.fn(async (_t, _c, windowKey) => { seen.push(windowKey); return { count: 1 }; }),
    }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('quota_exceeded');
    expect(r.error?.meta).toMatchObject({ windowKey: 'chunk:ck_Z', used: 1, limit: 1 });
    expect(seen).toEqual(['chunk:ck_Z']);
  });

  it('records ok invocations with output size', async () => {
    const tool = makeTool({
      fn: async () => ({ content: [{ type: 'text', text: 'a b c' }] }),
    });
    const recorded: Array<{ status: string; outputSize?: number | null }> = [];
    await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({
      recordInvocation: vi.fn(async (i) => { recorded.push({ status: i.status, outputSize: i.outputSize }); }),
    }));
    expect(recorded[0]?.status).toBe('ok');
    expect(recorded[0]?.outputSize).toBeGreaterThan(0);
  });

  it('records handler_error when fn throws', async () => {
    const tool = makeTool({ fn: async () => { throw new Error('boom'); } });
    const recorded: string[] = [];
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({
      recordInvocation: vi.fn(async (i) => { recorded.push(i.status); }),
    }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('handler_error');
    expect(recorded).toEqual(['error']);
  });

  it('codes InvalidInputError as invalid_input, not handler_error (EI-334 false-structural leg)', async () => {
    // defineTool's projected fn throws InvalidInputError on a zod-parse
    // failure. handler_error is the STRUCTURAL telemetry class (a tool bug);
    // a caller's bad args must surface as invalid_input (status invalid-input,
    // HTTP 400) so the repeated-tool-error watchdog files it as caller-class.
    const tool = makeTool({ fn: async () => { throw new InvalidInputError('invalid_args: brief: Too big'); } });
    const recorded: Array<{ status: string; errorCode?: string | null }> = [];
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({
      recordInvocation: vi.fn(async (i) => { recorded.push({ status: i.status, errorCode: i.errorCode }); }),
    }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('invalid_input');
    expect(r.error?.message).toContain('invalid_args: brief: Too big');
    expect(recorded).toEqual([{ status: 'invalid-input', errorCode: 'invalid_input' }]);
  });

  it('codes a foreign-instance InvalidInputError by name (dual-module-instance hosts)', async () => {
    // Same name-based match the Unauthorized/HarnessRequired classes carry:
    // when the host loads a second copy of this module, instanceof is false.
    const foreign = new Error('invalid_args: nope');
    Object.defineProperty(foreign, 'name', { value: 'InvalidInputError' });
    const tool = makeTool({ fn: async () => { throw foreign; } });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS());
    expect(r.error?.code).toBe('invalid_input');
  });

  it('returns timeout when fn exceeds timeoutSec', async () => {
    const tool = makeTool({
      timeoutSec: 0.05,
      fn: async (_input, ctx) =>
        new Promise<ToolResult>((resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
          setTimeout(() => resolve({ content: [] }), 1000);
        }),
    });
    const recorded: string[] = [];
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({
      recordInvocation: vi.fn(async (i) => { recorded.push(i.status); }),
    }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('timeout');
    expect(recorded).toEqual(['timeout']);
  });

  it('aborts the handler when idleTimeoutSec elapses without an emit', async () => {
    const tool = makeTool({
      timeoutSec: 60,
      idleTimeoutSec: 1, // 1s idle cap
      fn: (_input, ctx) =>
        new Promise<ToolResult>((resolve, reject) => {
          // Emit immediately, then go silent for 4s. Idle watchdog should
          // abort around 1s.
          ctx.emit('delta', { text: 'hi' });
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted by idle')));
          setTimeout(() => resolve({ content: [{ type: 'text', text: 'never' }] }), 4_000);
        }),
    });
    const start = Date.now();
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS());
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    // Idle check interval is max(1s, idleSec/4). With idleSec=1 that's 1s,
    // so abort fires somewhere in [1s, 2s]. Generous upper bound for CI noise.
    expect(elapsed).toBeLessThan(3_500);
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    // Reported as timeout since the abort signal fired.
    expect(r.error?.code).toBe('timeout');
  }, 10_000);

  it('does NOT abort when emits keep arriving inside idleTimeoutSec', async () => {
    const tool = makeTool({
      timeoutSec: 60,
      idleTimeoutSec: 1,
      fn: async (_input, ctx) => {
        // Emit every 300ms for ~1.5s — well inside the 1s idle gap.
        for (let i = 0; i < 5; i++) {
          ctx.emit('delta', { text: `chunk-${i}` });
          await new Promise((r) => setTimeout(r, 300));
        }
        return { content: [{ type: 'text', text: 'done' }] };
      },
    });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS());
    expect(r.ok).toBe(true);
  }, 10_000);

  it('ctx.transport is plumbed through to recordInvocation deps', async () => {
    // PR for migration 058-tool-invocations-transport: every transport
    // (HTTP / MCP / IPC / in_process) sets ctx.transport on its ctx so
    // the shared PROJECTED_DEPS.recordInvocation can persist it on
    // harness_shared.tool_invocations.transport. Verify the dispatcher
    // doesn't strip the field on its way through wrappedEmit + the
    // success-path record call.
    const tool = makeTool({
      fn: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    const recorded: Array<{ transport?: 'http' | 'mcp' | 'ipc' | 'in_process' }> = [];
    const deps: DispatchProjectedDeps = {
      recordInvocation: async (input) => {
        recorded.push({ transport: input.ctx.transport });
      },
    };
    const ctx = MAKE_CTX({ transport: 'ipc' });
    await dispatchProjectedTool(tool, 'fix.tool', {}, ctx, deps);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].transport).toBe('ipc');
  });

  it('errorCode (the dispatcher error CLASS) is plumbed through to recordInvocation (P-007)', async () => {
    // watchdog-robustness P-007 / D-009: the dispatcher computes a rich error
    // `code` then persists it on tool_invocations.error_code so the watchdog can
    // tell a deterministic config bug from a transient crash WITHOUT parsing
    // errorMessage. A throwing handler surfaces as code 'handler_error' — verify
    // the class reaches the record call, not just the coarse status='error'.
    const tool = makeTool({
      fn: async () => { throw new Error('boom'); },
    });
    const recorded: Array<{ status?: string; errorCode?: string | null }> = [];
    const deps: DispatchProjectedDeps = {
      recordInvocation: async (input) => {
        recorded.push({ status: input.status, errorCode: input.errorCode });
      },
    };
    await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), deps);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].status).toBe('error');            // coarse status (unchanged)
    expect(recorded[0].errorCode).toBe('handler_error'); // NEW: the class is preserved
  });

  it('errorCode is null on a successful call (P-007)', async () => {
    const tool = makeTool({ fn: async () => ({ content: [{ type: 'text', text: 'ok' }] }) });
    let captured: { status?: string; errorCode?: string | null } = {};
    const deps: DispatchProjectedDeps = {
      recordInvocation: async (input) => { captured = { status: input.status, errorCode: input.errorCode }; },
    };
    await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), deps);
    expect(captured.status).toBe('ok');
    expect(captured.errorCode ?? null).toBeNull();
  });

  it('ok-on-abort: handler returns ok despite signal aborted → surfaces as timeout error', async () => {
    // Round-7 follow-up: the watchdog used to fire but if the handler
    // returned normally without observing ctx.signal.aborted, the
    // dispatcher would emit `ok: true` + the partial result. That hid
    // wedged-but-non-throwing handlers from the consumer (they saw a
    // bogus `done` instead of `error: timeout`). The fix treats
    // abort.signal.aborted as authoritative.
    const tool = makeTool({
      timeoutSec: 60,
      idleTimeoutSec: 1,
      fn: async (_input, ctx) => {
        // Handler IGNORES ctx.signal and sleeps WELL past the idle cap.
        // The idle timer's setInterval first fires at checkMs (1000ms);
        // the > comparison means we need to sleep > 2× checkMs to
        // reliably catch the abort before the handler returns.
        await new Promise((r) => setTimeout(r, 3000));
        // Returns ok despite the abort having fired.
        return { content: [{ type: 'text', text: 'should-not-surface' }] };
      },
    });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS());
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('timeout');
  }, 10_000);

  it('ctx.progress refreshes idleTimeoutSec deadline (alias parity)', async () => {
    // Regression: a tool that calls ctx.progress() exclusively (no
    // direct ctx.emit) used to trip the idle watchdog because the
    // dispatcher only wrapped emit. Plan decision D2 says progress is
    // an alias of emit('progress', ...); the dispatcher must re-bind
    // progress so it refreshes lastEmitMs too.
    const tool = makeTool({
      timeoutSec: 60,
      idleTimeoutSec: 1,
      fn: async (_input, ctx) => {
        for (let i = 0; i < 5; i++) {
          ctx.progress(i * 20, `step ${i}`);
          await new Promise((r) => setTimeout(r, 300));
        }
        return { content: [{ type: 'text', text: 'done' }] };
      },
    });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS());
    expect(r.ok).toBe(true);
  }, 10_000);

  it('routes ctx.progress() through ctx.emit (D2 alias unified — Phase 4 T2.2)', async () => {
    // Per D2 of the original plan, ctx.progress IS ctx.emit('progress', ...).
    // The dispatcher's wrappedProgress (always installed post-T2.2) routes
    // every progress() call through wrappedEmit so it also lands in the
    // replay buffer + bumps the idle deadline. The transport-supplied
    // `ctx.progress` callback is shadowed by this wrapper; only the emit
    // path receives the call.
    const emitCalls: Array<{ name: string; data: unknown }> = [];
    const progressCalls: Array<[number | undefined, string | undefined]> = [];
    const tool = makeTool({
      fn: async (_input, ctx) => {
        ctx.progress(0, 'starting');
        ctx.progress(50);
        ctx.progress(100, 'done');
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    const ctx = MAKE_CTX({
      emit: (name, data) => emitCalls.push({ name, data }),
      progress: (pct, msg) => progressCalls.push([pct, msg]),
    });
    await dispatchProjectedTool(tool, 'fix.tool', {}, ctx, MAKE_DEPS());
    // progress() no longer reaches the transport-supplied callback —
    // it's shadowed by wrappedProgress which goes through emit.
    expect(progressCalls).toEqual([]);
    // Instead, each progress() landed as a 'progress' event on the emit channel.
    expect(emitCalls).toEqual([
      { name: 'progress', data: { progress: 0, total: 100, message: 'starting' } },
      { name: 'progress', data: { progress: 50, total: 100 } },
      { name: 'progress', data: { progress: 100, total: 100, message: 'done' } },
    ]);
  });
});

describe('dispatchProjectedToolStream', () => {
  it('yields each ctx.emit call as an event, then done with the ToolResult', async () => {
    const tool = makeTool({
      fn: async (_input, ctx) => {
        ctx.emit('delta', { text: 'hi' });
        ctx.emit('delta', { text: ' world' });
        ctx.emit('cost', { usd: 0.0042 });
        return { content: [{ type: 'text', text: 'hi world' }] };
      },
    });
    const events: DispatchStreamEvent[] = [];
    for await (const ev of dispatchProjectedToolStream(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS())) {
      events.push(ev);
    }
    expect(events.map((e) => e.kind)).toEqual(['event', 'event', 'event', 'done']);
    expect(events[0]).toEqual({ kind: 'event', name: 'delta', data: { text: 'hi' } });
    expect(events[2]).toEqual({ kind: 'event', name: 'cost', data: { usd: 0.0042 } });
    expect(events[3]).toMatchObject({ kind: 'done', result: { content: [{ type: 'text', text: 'hi world' }] } });
  });

  it('yields role_not_allowed when the calling role is not in the tool roles allowlist', async () => {
    const tool = makeTool({ agentRoles: ['operator'] });
    const ctx = MAKE_CTX({ role: 'worker' });
    const events: DispatchStreamEvent[] = [];
    for await (const ev of dispatchProjectedToolStream(tool, 'fix.tool', {}, ctx, MAKE_DEPS())) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'error', error: { code: 'role_not_allowed' } });
  });

  it('routes ctx.progress through the same emit channel', async () => {
    const tool = makeTool({
      fn: async (_input, ctx) => {
        ctx.progress(50, 'halfway');
        return { content: [] };
      },
    });
    const events: DispatchStreamEvent[] = [];
    for await (const ev of dispatchProjectedToolStream(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS())) {
      events.push(ev);
    }
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      kind: 'event',
      name: 'progress',
      data: { progress: 50, total: 100, message: 'halfway' },
    });
    expect(events[1]?.kind).toBe('done');
  });
});

describe('replay buffer (Phase 4 T2.2)', () => {
  // Tests are colocated with dispatch-projected so they exercise the
  // real wrappedEmit. The buffer's own unit tests live in
  // replay-buffer.test.ts.

  it('captures each emit into the per-call buffer when replayBufferSize > 0', async () => {
    const { clearAllBuffersForTests, readBuffer } = await import('./replay-buffer');
    clearAllBuffersForTests();

    const tool = makeTool({
      replayBufferSize: 100,
      fn: async (_input, ctx) => {
        ctx.emit('delta', { text: 'one' });
        ctx.emit('delta', { text: 'two' });
        ctx.emit('cost', { usd: 0.001 });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    const ctx = MAKE_CTX({ workspaceId: 'ws-buf', runId: 'run-buf-1' });
    await dispatchProjectedTool(tool, 'fix.tool', {}, ctx, MAKE_DEPS());

    const out = readBuffer({ workspaceId: 'ws-buf', toolName: 'fix.tool', runId: 'run-buf-1', sinceId: 0 });
    expect(out).not.toBeNull();
    expect(out!.map((e) => ({ id: e.id, name: e.name, data: e.data }))).toEqual([
      { id: 1, name: 'delta', data: { text: 'one' } },
      { id: 2, name: 'delta', data: { text: 'two' } },
      { id: 3, name: 'cost', data: { usd: 0.001 } },
    ]);
  });

  it('NO buffer is opened when replayBufferSize is 0/undefined', async () => {
    const { clearAllBuffersForTests, readBuffer } = await import('./replay-buffer');
    clearAllBuffersForTests();

    const tool = makeTool({
      // replayBufferSize omitted (default disabled)
      fn: async (_input, ctx) => {
        ctx.emit('delta', { text: 'one' });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    const ctx = MAKE_CTX({ workspaceId: 'ws-nobuf', runId: 'run-nobuf-1' });
    await dispatchProjectedTool(tool, 'fix.tool', {}, ctx, MAKE_DEPS());

    expect(readBuffer({ workspaceId: 'ws-nobuf', toolName: 'fix.tool', runId: 'run-nobuf-1', sinceId: 0 })).toBeNull();
  });

  it('event_count is reported to recordInvocation on completion', async () => {
    const tool = makeTool({
      fn: async (_input, ctx) => {
        ctx.emit('delta', { text: 'a' });
        ctx.emit('delta', { text: 'b' });
        ctx.progress(50, 'half');
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    let recordedEventCount: number | undefined;
    await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({
      recordInvocation: vi.fn(async (i) => { recordedEventCount = i.eventCount; }),
    }));
    // 2 emits + 1 progress (which goes through wrappedEmit per D2) = 3
    expect(recordedEventCount).toBe(3);
  });

  it('eventCount = 0 on role-not-allowed gate-failure path', async () => {
    const tool = makeTool({ agentRoles: ['architect'] });
    let recordedEventCount: number | undefined;
    await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX({ role: 'worker' }), MAKE_DEPS({
      recordInvocation: vi.fn(async (i) => { recordedEventCount = i.eventCount; }),
    }));
    expect(recordedEventCount).toBe(0);
  });

  it('concurrent calls do not cross-contaminate buffers (reviewer concern #4)', async () => {
    const { clearAllBuffersForTests, readBuffer } = await import('./replay-buffer');
    clearAllBuffersForTests();

    const tool = makeTool({
      replayBufferSize: 100,
      fn: async (input, ctx) => {
        const label = (input as { label: string }).label;
        ctx.emit('delta', { text: `from-${label}-1` });
        ctx.emit('delta', { text: `from-${label}-2` });
        return { content: [{ type: 'text', text: label }] };
      },
    });

    // Two concurrent invocations with different runIds.
    await Promise.all([
      dispatchProjectedTool(tool, 'fix.tool', { label: 'A' }, MAKE_CTX({ runId: 'run-cc-A' }), MAKE_DEPS()),
      dispatchProjectedTool(tool, 'fix.tool', { label: 'B' }, MAKE_CTX({ runId: 'run-cc-B' }), MAKE_DEPS()),
    ]);

    const outA = readBuffer({ workspaceId: 'default', toolName: 'fix.tool', runId: 'run-cc-A', sinceId: 0 })!;
    const outB = readBuffer({ workspaceId: 'default', toolName: 'fix.tool', runId: 'run-cc-B', sinceId: 0 })!;

    expect(outA.map((e) => e.data)).toEqual([{ text: 'from-A-1' }, { text: 'from-A-2' }]);
    expect(outB.map((e) => e.data)).toEqual([{ text: 'from-B-1' }, { text: 'from-B-2' }]);
  });
});

describe('metadata_json auto-fill from ctx.uiClientId (telemetry-tagging audit)', () => {
  // Plan: apps/operator/docs/plans/llm-testing-framework-2026-05-14.md §5.4
  // Every tool's invocation row must carry the spawning caller's
  // uiClientId in metadata_json so the llm-testing framework can
  // filter telemetry by run. The dispatcher auto-fills it when
  // ctx.uiClientId is set and the handler didn't override.

  it('auto-fills metadata_json.uiClientId when handler never calls ctx.metadata', async () => {
    let captured: Record<string, unknown> | null | undefined = undefined;
    const tool = makeTool({
      fn: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    await dispatchProjectedTool(
      tool,
      'fix.tool',
      {},
      MAKE_CTX({ uiClientId: 'audit-probe-1' }),
      MAKE_DEPS({
        recordInvocation: async (input) => { captured = input.metadataJson; },
      }),
    );
    expect(captured).toEqual({ uiClientId: 'audit-probe-1' });
  });

  it('merges ctx.uiClientId into handler-supplied metadata', async () => {
    let captured: Record<string, unknown> | null | undefined = undefined;
    const tool = makeTool({
      fn: async (_input, ctx) => {
        ctx.metadata?.({ kind: 'docs:get', heading: 'overview' });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    await dispatchProjectedTool(
      tool,
      'fix.tool',
      {},
      MAKE_CTX({ uiClientId: 'audit-probe-2' }),
      MAKE_DEPS({
        recordInvocation: async (input) => { captured = input.metadataJson; },
      }),
    );
    expect(captured).toEqual({
      kind: 'docs:get',
      heading: 'overview',
      uiClientId: 'audit-probe-2',
    });
  });

  it('respects handler override of uiClientId (does not clobber)', async () => {
    let captured: Record<string, unknown> | null | undefined = undefined;
    const tool = makeTool({
      fn: async (_input, ctx) => {
        ctx.metadata?.({ uiClientId: 'handler-wins' });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    await dispatchProjectedTool(
      tool,
      'fix.tool',
      {},
      MAKE_CTX({ uiClientId: 'audit-probe-3' }),
      MAKE_DEPS({
        recordInvocation: async (input) => { captured = input.metadataJson; },
      }),
    );
    expect(captured).toEqual({ uiClientId: 'handler-wins' });
  });

  it('does nothing when ctx.uiClientId is null/undefined', async () => {
    let captured: Record<string, unknown> | null | undefined = undefined;
    const tool = makeTool({
      fn: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    await dispatchProjectedTool(
      tool,
      'fix.tool',
      {},
      MAKE_CTX({ uiClientId: null }),
      MAKE_DEPS({
        recordInvocation: async (input) => { captured = input.metadataJson; },
      }),
    );
    expect(captured).toBeNull();
  });

  it('auto-fill applies on error path too', async () => {
    let captured: Record<string, unknown> | null | undefined = undefined;
    const tool = makeTool({
      fn: async () => { throw new Error('boom'); },
    });
    const r = await dispatchProjectedTool(
      tool,
      'fix.tool',
      {},
      MAKE_CTX({ uiClientId: 'audit-probe-error' }),
      MAKE_DEPS({
        recordInvocation: async (input) => { captured = input.metadataJson; },
      }),
    );
    expect(r.ok).toBe(false);
    expect(captured).toEqual({ uiClientId: 'audit-probe-error' });
  });
});

describe('overrideTool dep (plan §10.4 — brain-subprocess injection)', () => {
  it('returns the override result when overrideTool returns one', async () => {
    let handlerCalled = false;
    const tool = makeTool({
      fn: async () => {
        handlerCalled = true;
        return { content: [{ type: 'text', text: 'real-handler' }] };
      },
    });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({
      overrideTool: () => ({ content: [{ text: '{"error":"forced"}' }], isError: true }),
    }));
    expect(r.ok).toBe(true);
    expect(handlerCalled).toBe(false);
    expect(r.result?.content[0]).toEqual({ text: '{"error":"forced"}' });
  });

  it('PASS_THROUGH falls through to the real handler', async () => {
    let handlerCalled = false;
    const tool = makeTool({
      fn: async () => {
        handlerCalled = true;
        return { content: [{ type: 'text', text: 'real-handler' }] };
      },
    });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({
      overrideTool: () => PASS_THROUGH,
    }));
    expect(r.ok).toBe(true);
    expect(handlerCalled).toBe(true);
    expect(r.result?.content[0]).toEqual({ type: 'text', text: 'real-handler' });
  });

  it('absent overrideTool runs the real handler (default behavior preserved)', async () => {
    let handlerCalled = false;
    const tool = makeTool({
      fn: async () => {
        handlerCalled = true;
        return { content: [{ type: 'text', text: 'real-handler' }] };
      },
    });
    await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS());
    expect(handlerCalled).toBe(true);
  });

  it('overrideTool receives tool name + args + ctx for decisioning', async () => {
    const seen: Array<{ name: string; args: unknown; uiClientId: unknown }> = [];
    const tool = makeTool();
    await dispatchProjectedTool(
      tool,
      'harness.status',
      { slug: 'sheets' },
      MAKE_CTX({ uiClientId: 'llm-testing/abc' }),
      MAKE_DEPS({
        overrideTool: (name, args, ctx) => {
          seen.push({ name, args, uiClientId: ctx.uiClientId });
          return PASS_THROUGH;
        },
      }),
    );
    expect(seen).toEqual([
      { name: 'harness.status', args: { slug: 'sheets' }, uiClientId: 'llm-testing/abc' },
    ]);
  });
});

describe('authorize gate (RFC tooldef-auth Phase 1b — resource authz + audited break-glass)', () => {
  it('allow → handler runs, the allow is audited', async () => {
    const events: AuthAuditEvent[] = [];
    const tool = makeTool({ authorize: () => ({ allow: true, reason: 'owner' }) });
    const r = await dispatchProjectedTool(
      tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({ auditAuth: (e) => events.push(e) }),
    );
    expect(r.ok).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({ gate: 'authorize', decision: 'allow', reason: 'owner', tool: 'fix.tool' }),
    ]);
  });

  it('deny → authorization_denied, handler is NOT run, the deny is audited', async () => {
    let ran = false;
    const events: AuthAuditEvent[] = [];
    const tool = makeTool({
      fn: async () => { ran = true; return { content: [{ type: 'text', text: 'ok' }] }; },
      authorize: () => ({ allow: false, reason: 'not owner' }),
    });
    const r = await dispatchProjectedTool(
      tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({ auditAuth: (e) => events.push(e) }),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('authorization_denied');
    expect(ran).toBe(false);
    expect(events[0]).toMatchObject({ gate: 'authorize', decision: 'deny', reason: 'not owner' });
  });

  it('fails closed when authorize throws (deny + audit)', async () => {
    const events: AuthAuditEvent[] = [];
    const tool = makeTool({ authorize: () => { throw new Error('boom'); } });
    const r = await dispatchProjectedTool(
      tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({ auditAuth: (e) => events.push(e) }),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('authorization_denied');
    expect(events[0]).toMatchObject({ gate: 'authorize', decision: 'deny' });
    expect(events[0]?.reason).toContain('boom');
  });

  // Break-glass best practice: a privileged bypass must be policy-governed AND logged,
  // never a silent super-admin (RFC §8 D2).
  it('gateBypass.policy skips the hook BUT audits the bypass', async () => {
    let ran = false;
    const events: AuthAuditEvent[] = [];
    const tool = makeTool({
      fn: async () => { ran = true; return { content: [{ type: 'text', text: 'ok' }] }; },
      authorize: () => ({ allow: false, reason: 'would-deny' }),
    });
    const r = await dispatchProjectedTool(
      tool, 'fix.tool', {}, MAKE_CTX({ gateBypass: { policy: true } }),
      MAKE_DEPS({ auditAuth: (e) => events.push(e) }),
    );
    expect(r.ok).toBe(true); // the deny was bypassed → handler ran
    expect(ran).toBe(true);
    expect(events[0]).toMatchObject({ gate: 'authorize', decision: 'allow', reason: 'gateBypass.policy' });
  });

  it('the role/capability/quota bypasses do NOT imply the authorize bypass', async () => {
    const events: AuthAuditEvent[] = [];
    const tool = makeTool({ authorize: () => ({ allow: false, reason: 'still enforced' }) });
    const r = await dispatchProjectedTool(
      tool, 'fix.tool', {}, MAKE_CTX({ gateBypass: { role: true, capability: true, quota: true } }),
      MAKE_DEPS({ auditAuth: (e) => events.push(e) }),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('authorization_denied');
    expect(events[0]).toMatchObject({ gate: 'authorize', decision: 'deny' });
  });

  it('a tool with no authorize hook is unaffected (additive — no decision, no audit)', async () => {
    const events: AuthAuditEvent[] = [];
    const tool = makeTool(); // no authorize
    const r = await dispatchProjectedTool(
      tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({ auditAuth: (e) => events.push(e) }),
    );
    expect(r.ok).toBe(true);
    expect(events).toEqual([]);
  });
});

describe('role-requirement gate (RFC tooldef-auth Phase 2 — declarative RBAC)', () => {
  const withRoles = (roles: string[]) => ({
    kind: 'system' as const,
    slug: 'p',
    workspaceId: 'default',
    authMethod: 'process-internal' as const,
    trust: 'trusted' as const,
    capabilities: new Set<string>(),
    roles: new Set(roles),
  });

  it('allows when the principal has one of the required roles (any-of)', async () => {
    const tool = makeTool({ requireRoles: ['admin'] });
    const r = await dispatchProjectedTool(
      tool, 'fix.tool', {}, MAKE_CTX({ principal: withRoles(['staff', 'admin']) }), MAKE_DEPS(),
    );
    expect(r.ok).toBe(true);
  });

  it('denies (missing_role) + audits when the principal lacks every required role', async () => {
    const events: AuthAuditEvent[] = [];
    const tool = makeTool({ requireRoles: ['admin'] });
    const r = await dispatchProjectedTool(
      tool, 'fix.tool', {}, MAKE_CTX({ principal: withRoles(['staff']) }),
      MAKE_DEPS({ auditAuth: (e) => events.push(e) }),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('missing_role');
    expect(events[0]).toMatchObject({ gate: 'role', decision: 'deny' });
  });

  it('fails closed for an anonymous call (no principal)', async () => {
    const tool = makeTool({ requireRoles: ['admin'] });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX({ principal: undefined }), MAKE_DEPS());
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('missing_role');
  });

  it('gateBypass.role bypasses the RBAC requirement (a superuser passes role gates)', async () => {
    const tool = makeTool({ requireRoles: ['admin'] });
    const r = await dispatchProjectedTool(
      tool, 'fix.tool', {}, MAKE_CTX({ principal: withRoles([]), gateBypass: { role: true } }), MAKE_DEPS(),
    );
    expect(r.ok).toBe(true);
  });

  it('a tool with no requireRoles is unaffected (additive)', async () => {
    const tool = makeTool();
    const r = await dispatchProjectedTool(
      tool, 'fix.tool', {}, MAKE_CTX({ principal: withRoles([]) }), MAKE_DEPS(),
    );
    expect(r.ok).toBe(true);
  });
});

describe('default-deny gate (RFC tooldef-auth Phase 3 — opt-in fail-closed posture)', () => {
  it('off (default): an ungated tool is allowed (no behavior change)', async () => {
    const tool = makeTool({ capabilities: [] }); // declares no gate
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS());
    expect(r.ok).toBe(true);
  });

  it('on: an ungated, non-public tool is denied (ungated)', async () => {
    const tool = makeTool({ capabilities: [] });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({ defaultDeny: true }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('ungated');
  });

  it('on: an ungated tool marked public is allowed (the [AllowAnonymous] equivalent)', async () => {
    const tool = makeTool({ capabilities: [], public: true });
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({ defaultDeny: true }));
    expect(r.ok).toBe(true);
  });

  it('on: a tool declaring a capability gate is allowed (not ungated)', async () => {
    const tool = makeTool({ capabilities: ['x'] }); // no principal → capability gate skips, but a gate IS declared
    const r = await dispatchProjectedTool(tool, 'fix.tool', {}, MAKE_CTX(), MAKE_DEPS({ defaultDeny: true }));
    expect(r.ok).toBe(true);
  });

  it('on: a tool gated only by agent roles is allowed (declares a gate)', async () => {
    const tool = makeTool({ capabilities: [], agentRoles: ['worker'] });
    const r = await dispatchProjectedTool(
      tool, 'fix.tool', {}, MAKE_CTX({ role: 'worker' }), MAKE_DEPS({ defaultDeny: true }),
    );
    expect(r.ok).toBe(true);
  });
});
