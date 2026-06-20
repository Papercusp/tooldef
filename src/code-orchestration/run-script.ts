/**
 * code-execution-tool-orchestration B-CX-1A / B-CX-SANDBOX — the sandbox EXECUTOR.
 *
 * Runs a model-submitted orchestration script with the tool facade injected as `tools`, and
 * returns ONLY the script's returned summary. Intermediate tool results live here in the
 * runtime and never re-enter the model's context — that, plus collapsing many tool round-trips
 * into one `code:run` call, is the token win the plan is built around.
 *
 *   // model writes:
 *   const open = await tools.work_items.list({ status: 'open' });
 *   const failing = [];
 *   for (const w of open.items) {
 *     const d = await tools.work_items.get({ id: w.id });
 *     if (d.checks?.failing) failing.push(w.id);
 *   }
 *   return { scanned: open.items.length, failing };   // ← only THIS returns to the model
 *
 * ISOLATION (B-CX-SANDBOX): the script runs in a dedicated **worker thread**, NOT on the host
 * event loop. The worker gives us two things the old in-host `node:vm` executor could not:
 *
 *   1. A *synchronous* infinite loop (`while (true) {}`) blocks only the WORKER thread; the host
 *      stays responsive and `worker.terminate()` HARD-KILLS the runaway at the timeout. (The old
 *      executor's vm `timeout` only applied while *compiling* the async wrapper — the wrapper's
 *      body ran on the host loop afterward, so a sync loop froze the whole process.)
 *   2. Optional memory bounds via the worker's V8 heap cap (`maxOldGenerationSizeMb`).
 *
 * Inside the worker we STILL run the body under `node:vm.runInNewContext`, which scopes the
 * script's globals (no `require`/`process`/`module`/`Buffer`; standard intrinsics like
 * JSON/Math/Promise present) and gives clean compile-error reporting. So the worker is the
 * isolation+kill boundary; the inner vm is the globals-scoping + compile boundary.
 *
 * The facade is NOT cloneable into a worker (its members are live host functions that dispatch
 * through the real tool pipeline — DB, ctx, capability envelope), so each `tools.ns.verb(args)`
 * the script makes is RPC'd back to the host over the worker message channel: the worker holds a
 * Proxy facade, the host runs the REAL facade fn and posts the result back. The whitelist in
 * tool-facade.ts (the agent's capability envelope) + the dry-run/confirm gate on write-effect
 * tools (B-CX-2A) remain the security model; the worker is an availability/robustness boundary,
 * not a substitute for the whitelist.
 */
import { Worker } from 'node:worker_threads';
import type { ToolFacade } from './tool-facade';

export interface RunScriptResult {
  ok: boolean;
  /** The script's returned value — the summary that re-enters the model's context. */
  result?: unknown;
  /** Captured console output from the script (bounded by maxLogLines). */
  logs: string[];
  /** Present when ok=false: 'compile_error: …', 'script_timeout …', or the thrown message. */
  error?: string;
}

export interface RunScriptOptions {
  /** Wall-clock budget for the whole script. Default 30s. Sync loops are killed at this bound. */
  timeoutMs?: number;
  /** Cap on captured console lines. Default 200. */
  maxLogLines?: number;
  /**
   * Optional V8 old-generation heap cap (MB) for the worker. When set, a script that allocates
   * past it is killed by the runtime with a heap-OOM error instead of bloating the host. Omit for
   * no explicit cap (the Node default). Very small values (<16) can make the worker fail to boot.
   */
  maxOldGenerationSizeMb?: number;
}

/**
 * The worker body, embedded as a string and run via `new Worker(src, { eval: true })`.
 *
 * Embedding (vs a sibling .js file) avoids runtime path-resolution that differs across vitest /
 * tsx / compiled dist — the one consumer is this module, so the source travels with it. The code
 * is plain JS (CommonJS `require` is available in an eval worker) and self-contained: it imports
 * nothing from this package.
 *
 * Host↔worker protocol (all messages are `{ t: <kind>, … }`):
 *   worker → host : { t:'call', id, ns?, verb?, callName?, args }   a `tools.*` invocation
 *                   { t:'log', text }                               a console/log line
 *                   { t:'done', result } | { t:'error', error }     terminal
 *   host  → worker: { t:'result', id, ok, value? , error? }         a tool-call reply
 */
const WORKER_SRC = `(() => {
  const { parentPort, workerData } = require('node:worker_threads');
  const vm = require('node:vm');
  const { script, maxLogLines } = workerData;

  const stringify = (v) => {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  };

  // --- console capture (bounded; stop posting past the cap to keep message volume sane) ---
  let logCount = 0;
  const log = (...parts) => {
    if (logCount < maxLogLines) { logCount++; parentPort.postMessage({ t: 'log', text: parts.map(stringify).join(' ') }); }
  };

  // --- RPC: each tools.* call posts to the host and awaits the reply ---
  let nextId = 1;
  const pending = new Map();
  parentPort.on('message', (m) => {
    if (m && m.t === 'result') {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); m.ok ? p.resolve(m.value) : p.reject(new Error(m.error)); }
    }
  });
  const rpc = (payload) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    parentPort.postMessage(Object.assign({ t: 'call', id }, payload));
  });

  // --- the Proxy facade injected as \`tools\` (mirrors tool-facade.ts: tools.ns.verb + tools.call) ---
  const nsProxy = (ns) => new Proxy({}, {
    get(_t, verb) {
      if (typeof verb !== 'string' || verb === 'then') return undefined;
      return (...a) => rpc({ ns, verb, args: a[0] });
    },
  });
  const tools = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (prop === 'call') return (name, args) => rpc({ callName: name, args });
      return nsProxy(prop);
    },
  });

  // --- compile + run the body under vm (globals-scoped); a leading newline guards a trailing // comment ---
  const wrap = (body) => '(async (tools, log) => {\\n' + body + '\\n})';
  let factory;
  try {
    factory = vm.runInNewContext(wrap(script), { console: { log, error: log, warn: log } }, { displayErrors: true });
  } catch (err) {
    parentPort.postMessage({ t: 'error', error: 'compile_error: ' + ((err && err.message) || String(err)) });
    return;
  }
  (async () => {
    try {
      const result = await factory(tools, log);
      try { parentPort.postMessage({ t: 'done', result }); }
      catch (cloneErr) { parentPort.postMessage({ t: 'error', error: 'result_not_serializable: ' + ((cloneErr && cloneErr.message) || String(cloneErr)) }); }
    } catch (err) {
      parentPort.postMessage({ t: 'error', error: (err && err.message) || String(err) });
    }
  })();
})();`;

export async function runOrchestrationScript(
  script: string,
  facade: ToolFacade,
  opts: RunScriptOptions = {},
): Promise<RunScriptResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxLogLines = opts.maxLogLines ?? 200;
  const logs: string[] = [];

  return await new Promise<RunScriptResult>((resolve) => {
    let settled = false;
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      name: 'code-orchestration',
      workerData: { script, maxLogLines },
      ...(opts.maxOldGenerationSizeMb
        ? { resourceLimits: { maxOldGenerationSizeMb: opts.maxOldGenerationSizeMb } }
        : {}),
    });

    const finish = (out: Omit<RunScriptResult, 'logs'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve({ ...out, logs });
    };

    // The kill switch: terminate() stops the worker thread even mid sync-loop.
    const timer = setTimeout(
      () => finish({ ok: false, error: `script_timeout after ${timeoutMs}ms` }),
      timeoutMs,
    );

    worker.on('message', (m: WorkerMessage) => {
      if (m.t === 'log') {
        if (logs.length < maxLogLines) logs.push(m.text);
        return;
      }
      if (m.t === 'done') return finish({ ok: true, result: m.result });
      if (m.t === 'error') return finish({ ok: false, error: m.error });
      if (m.t === 'call') void handleCall(worker, facade, m, () => settled);
    });

    // A worker that dies without a terminal message (native crash, OOM kill) still settles.
    worker.on('error', (err) => finish({ ok: false, error: errMsg(err) }));
    worker.on('exit', (code) => {
      if (!settled) finish({ ok: false, error: `worker exited unexpectedly (code ${code})` });
    });
  });
}

/** Run one RPC'd tool call against the REAL host facade and post the reply back to the worker. */
async function handleCall(
  worker: Worker,
  facade: ToolFacade,
  m: CallMessage,
  isSettled: () => boolean,
): Promise<void> {
  try {
    let value: unknown;
    if (typeof m.callName === 'string') {
      value = await facade.call(m.callName, m.args);
    } else {
      const fn = facade?.[m.ns!]?.[m.verb!];
      if (typeof fn !== 'function') {
        throw new Error(`code-orchestration: tool not available in this sandbox: ${m.ns}.${m.verb}`);
      }
      value = await fn(m.args);
    }
    if (isSettled()) return;
    try {
      worker.postMessage({ t: 'result', id: m.id, ok: true, value });
    } catch (cloneErr) {
      // Tool returned something the structured clone can't carry to the worker.
      worker.postMessage({ t: 'result', id: m.id, ok: false, error: `result_not_serializable: ${errMsg(cloneErr)}` });
    }
  } catch (err) {
    if (isSettled()) return;
    worker.postMessage({ t: 'result', id: m.id, ok: false, error: errMsg(err) });
  }
}

interface CallMessage {
  t: 'call';
  id: number;
  ns?: string;
  verb?: string;
  callName?: string;
  args?: unknown;
}
type WorkerMessage =
  | { t: 'log'; text: string }
  | { t: 'done'; result: unknown }
  | { t: 'error'; error: string }
  | CallMessage;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
