import { describe, expect, it } from 'vitest';
import type { ProjectedTool, UnifiedToolContext } from '../tool-projection';
import { ToolDispatchError, isPreExecutionFailure } from './dispatch-binding';
import {
  createDurableDispatch,
  durableAuthorizationDenied,
  durableRuntimeTools,
  DurableRunHaltedError,
  type DurableStepHost,
} from './durable-dispatch';

/** Mimics DBOS: steps are keyed by per-execution sequence and checked by name on replay. */
class MemoryStepStore {
  readonly records: Array<{ name: string; value: unknown }> = [];
  /** `crashAfterTool`: the named tool's step body runs (its effect happens), then the process
   * "dies" before the outcome is recorded — exactly the window a real SIGKILL leaves. */
  execution(crashAfterTool?: string): DurableStepHost {
    let fid = 0;
    return {
      runStep: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        const id = fid++;
        const prior = this.records[id];
        if (prior) {
          if (prior.name !== name) throw new Error(`unexpected step ${name}; recorded ${prior.name}`);
          return structuredClone(prior.value) as T;
        }
        const value = await fn();
        if (crashAfterTool && name.startsWith('tool:') && name.endsWith(`:${crashAfterTool}`)) {
          throw new Crash(`process died after dispatching ${crashAfterTool}`);
        }
        this.records[id] = { name, value: structuredClone(value) };
        return value;
      },
      sleep: async () => {
        fid++;
      },
      receive: async () => {
        fid++;
        return null;
      },
    };
  }
}

class Crash extends Error {}

function tool(name: string, effect: 'read' | 'write', idempotent = false): ProjectedTool {
  return {
    pluginName: 'test',
    description: name,
    inputSchema: { type: 'object' },
    capabilities: [],
    effect,
    idempotent,
    expose: { mcp: { name } },
    fn: async () => ({ content: [] }),
  };
}

const READ = tool('items:get', 'read');
const IDEMPOTENT = tool('items:put', 'write', true);
const UNCERTAIN = tool('mail:send', 'write');
const TOOLS = [READ, IDEMPOTENT, UNCERTAIN, ...durableRuntimeTools()];
const ctx = {} as UnifiedToolContext;

interface Harness {
  dispatched: string[];
  crashOn?: string;
  allow: Set<string>;
}

function execution(store: MemoryStepStore, harness: Harness) {
  const durable = createDurableDispatch({
    host: store.execution(harness.crashOn),
    tools: TOOLS,
    fingerprint: (args) => JSON.stringify(args ?? null),
    authorize: (name) => {
      if (!harness.allow.has(name)) throw durableAuthorizationDenied(name, `${name} is no longer allowed`);
    },
    inner: async (_tool, name, args) => {
      harness.dispatched.push(name);
      return { name, echo: args };
    },
  });
  const call = (t: ProjectedTool, args: unknown) =>
    durable.wrapDispatch(t, t.expose.mcp!.name, args, ctx, async () => undefined);
  return { call, state: durable.state };
}

describe('createDurableDispatch (P-019 / D-019)', () => {
  it('reuses recorded step results after a crash and resumes the pending safe step', async () => {
    const store = new MemoryStepStore();
    const first: Harness = { dispatched: [], crashOn: 'items:put', allow: new Set(['items:get', 'items:put']) };
    const run1 = execution(store, first);
    await expect(run1.call(READ, { id: 1 })).resolves.toEqual({ name: 'items:get', echo: { id: 1 } });
    await expect(run1.call(IDEMPOTENT, { id: 1 })).rejects.toBeInstanceOf(Crash);

    const second: Harness = { dispatched: [], allow: new Set(['items:get', 'items:put']) };
    const run2 = execution(store, second);
    await expect(run2.call(READ, { id: 1 })).resolves.toEqual({ name: 'items:get', echo: { id: 1 } });
    await expect(run2.call(IDEMPOTENT, { id: 1 })).resolves.toEqual({ name: 'items:put', echo: { id: 1 } });
    // The recorded read is NOT dispatched again; the interrupted idempotent write resumes.
    expect(second.dispatched).toEqual(['items:put']);
    expect(run2.state.steps.map((s) => [s.tool, s.source])).toEqual([
      ['items:get', 'recorded'],
      ['items:put', 'live'],
    ]);
  });

  it('never repeats a recorded uncertain write', async () => {
    const store = new MemoryStepStore();
    const first: Harness = { dispatched: [], crashOn: 'items:get', allow: new Set(['mail:send', 'items:get']) };
    const run1 = execution(store, first);
    await run1.call(UNCERTAIN, { to: 'a' });
    await expect(run1.call(READ, { id: 2 })).rejects.toBeInstanceOf(Crash);

    const second: Harness = { dispatched: [], allow: new Set(['mail:send', 'items:get']) };
    const run2 = execution(store, second);
    await expect(run2.call(UNCERTAIN, { to: 'a' })).resolves.toEqual({ name: 'mail:send', echo: { to: 'a' } });
    await run2.call(READ, { id: 2 });
    expect(second.dispatched).toEqual(['items:get']);
  });

  it('stops for reconciliation when an uncertain write was in flight at the crash', async () => {
    const store = new MemoryStepStore();
    const first: Harness = { dispatched: [], crashOn: 'mail:send', allow: new Set(['mail:send', 'items:get']) };
    const run1 = execution(store, first);
    await expect(run1.call(UNCERTAIN, { to: 'b' })).rejects.toBeInstanceOf(Crash);

    const second: Harness = { dispatched: [], allow: new Set(['mail:send', 'items:get']) };
    const run2 = execution(store, second);
    const halted = await run2.call(UNCERTAIN, { to: 'b' }).catch((e: unknown) => e);
    expect(halted).toBeInstanceOf(DurableRunHaltedError);
    expect((halted as DurableRunHaltedError).reason).toBe('needs-reconciliation');
    // No live retry of the unknown write, and nothing after it dispatches either.
    await expect(run2.call(READ, { id: 3 })).rejects.toBeInstanceOf(DurableRunHaltedError);
    expect(second.dispatched).toEqual([]);
    expect(run2.state.reconciliation).toMatchObject({ ordinal: 0, tool: 'mail:send' });

    // The reconciliation verdict is itself recorded: a further recovery replays it.
    const third: Harness = { dispatched: [], allow: new Set(['mail:send', 'items:get']) };
    const run3 = execution(store, third);
    await expect(run3.call(UNCERTAIN, { to: 'b' })).rejects.toBeInstanceOf(DurableRunHaltedError);
    expect(third.dispatched).toEqual([]);
  });

  it('stops for reconciliation when an uncertain write fails after dispatch began', async () => {
    const store = new MemoryStepStore();
    const durable = createDurableDispatch({
      host: store.execution(),
      tools: TOOLS,
      fingerprint: (args) => JSON.stringify(args),
      authorize: () => {},
      inner: async () => {
        throw new ToolDispatchError('mail:send', 'upstream_timeout', 'gateway timed out');
      },
    });
    const call = durable.wrapDispatch(UNCERTAIN, 'mail:send', { to: 'c' }, ctx, async () => undefined);
    await expect(call).rejects.toBeInstanceOf(DurableRunHaltedError);
    expect(durable.state.reconciliation?.reason).toContain('outcome is unknown');
  });

  it('rechecks authorization on live steps only and never replays an old grant', async () => {
    const store = new MemoryStepStore();
    const first: Harness = { dispatched: [], crashOn: 'items:put', allow: new Set(['items:get', 'items:put']) };
    const run1 = execution(store, first);
    await run1.call(READ, { id: 4 });
    await expect(run1.call(IDEMPOTENT, { id: 4 })).rejects.toBeInstanceOf(Crash);

    // items:put was revoked between the crash and recovery.
    const second: Harness = { dispatched: [], allow: new Set(['items:get']) };
    const run2 = execution(store, second);
    await expect(run2.call(READ, { id: 4 })).resolves.toMatchObject({ name: 'items:get' });
    const refused = await run2.call(IDEMPOTENT, { id: 4 }).catch((e: unknown) => e);
    expect(isPreExecutionFailure(refused)).toBe(true);
    expect(second.dispatched).toEqual([]);
  });

  it('halts on replay divergence instead of continuing with changed arguments', async () => {
    const store = new MemoryStepStore();
    const run1 = execution(store, { dispatched: [], allow: new Set(['items:get']) });
    await run1.call(READ, { id: 5 });
    const second: Harness = { dispatched: [], allow: new Set(['items:get']) };
    const run2 = execution(store, second);
    const halted = await run2.call(READ, { id: 999 }).catch((e: unknown) => e);
    expect((halted as DurableRunHaltedError).reason).toBe('replay-diverged');
    expect(second.dispatched).toEqual([]);
  });

  it('replays a recorded pre-execution refusal with the same classification', async () => {
    const store = new MemoryStepStore();
    const run1 = execution(store, { dispatched: [], allow: new Set() });
    const live = await run1.call(READ, { id: 6 }).catch((e: unknown) => e);
    const run2 = execution(store, { dispatched: [], allow: new Set(['items:get']) });
    const replayed = await run2.call(READ, { id: 6 }).catch((e: unknown) => e);
    expect(isPreExecutionFailure(live)).toBe(true);
    expect(isPreExecutionFailure(replayed)).toBe(true);
    expect((replayed as Error).message).toBe((live as Error).message);
  });

  it('records runtime time and randomness so replay sees the same values', async () => {
    const store = new MemoryStepStore();
    const [now, random] = durableRuntimeTools();
    const run1 = execution(store, { dispatched: [], allow: new Set() });
    const t1 = await run1.call(now!, {});
    const r1 = await run1.call(random!, {});
    const run2 = execution(store, { dispatched: [], allow: new Set() });
    expect(await run2.call(now!, {})).toEqual(t1);
    expect(await run2.call(random!, {})).toEqual(r1);
    expect(run2.state.steps.every((s) => s.source === 'recorded')).toBe(true);
  });

  it('serializes concurrent calls in ordinal order so step identities are deterministic', async () => {
    const store = new MemoryStepStore();
    const order: string[] = [];
    const durable = createDurableDispatch({
      host: store.execution(),
      tools: TOOLS,
      fingerprint: (args) => JSON.stringify(args),
      authorize: () => {},
      inner: async (_tool, name, args) => {
        order.push(`start:${JSON.stringify(args)}`);
        await new Promise((resolve) => setTimeout(resolve, (args as { delay: number }).delay));
        order.push(`end:${JSON.stringify(args)}`);
        return name;
      },
    });
    await Promise.all([
      durable.wrapDispatch(UNCERTAIN, 'mail:send', { delay: 20 }, ctx, async () => undefined),
      durable.wrapDispatch(READ, 'items:get', { delay: 1 }, ctx, async () => undefined),
    ]);
    expect(store.records.map((r) => r.name)).toEqual(['intent:0:mail:send', 'tool:0:mail:send', 'tool:1:items:get']);
    expect(order).toEqual(['start:{"delay":20}', 'end:{"delay":20}', 'start:{"delay":1}', 'end:{"delay":1}']);
  });
});
