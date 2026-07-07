"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runOrchestrationScript = runOrchestrationScript;
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

  // --- EI-7839: a bounded sleep() helper, since the vm context has no setTimeout/setInterval ---
  // (those are Node/DOM globals, not JS-spec intrinsics — runInNewContext's sandbox omits them
  // entirely, so a script calling setTimeout() throws ReferenceError, not a timeout). A script
  // that needs a short async delay (e.g. "fire a write, wait briefly, re-verify") previously had
  // no way to do that inside code:run at all. Capped at SLEEP_MAX_MS per call so a runaway
  // sleep(huge) degrades to the existing overall script_timeout kill rather than a surprising
  // multi-minute hang; built on the WORKER's own (real, Node) setTimeout — this scope is outside
  // the sandboxed vm context, so it is not itself exposed to the script.
  const SLEEP_MAX_MS = 10000;
  const sleep = (ms) => new Promise((resolve) => {
    const bounded = Math.max(0, Math.min(Number(ms) || 0, SLEEP_MAX_MS));
    setTimeout(resolve, bounded);
  });

  // --- compile + run the body under vm (globals-scoped); a leading newline guards a trailing // comment ---
  const wrap = (body) => '(async (tools, log) => {\\n' + body + '\\n})';
  let factory;
  try {
    factory = vm.runInNewContext(wrap(script), { console: { log, error: log, warn: log }, sleep }, { displayErrors: true });
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
async function runOrchestrationScript(script, facade, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const maxLogLines = opts.maxLogLines ?? 200;
    const logs = [];
    // Lazy: keeps the barrel browser-safe (see the header note on the type-only import above).
    const { Worker } = await Promise.resolve().then(() => __importStar(require('node:worker_threads')));
    return await new Promise((resolve) => {
        let settled = false;
        const worker = new Worker(WORKER_SRC, {
            eval: true,
            name: 'code-orchestration',
            workerData: { script, maxLogLines },
            ...(opts.maxOldGenerationSizeMb
                ? { resourceLimits: { maxOldGenerationSizeMb: opts.maxOldGenerationSizeMb } }
                : {}),
        });
        const finish = (out) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            void worker.terminate();
            resolve({ ...out, logs });
        };
        // The kill switch: terminate() stops the worker thread even mid sync-loop.
        const timer = setTimeout(() => finish({ ok: false, error: `script_timeout after ${timeoutMs}ms` }), timeoutMs);
        worker.on('message', (m) => {
            if (m.t === 'log') {
                if (logs.length < maxLogLines)
                    logs.push(m.text);
                return;
            }
            if (m.t === 'done')
                return finish({ ok: true, result: m.result });
            if (m.t === 'error')
                return finish({ ok: false, error: m.error });
            if (m.t === 'call')
                void handleCall(worker, facade, m, () => settled);
        });
        // A worker that dies without a terminal message (native crash, OOM kill) still settles.
        worker.on('error', (err) => finish({ ok: false, error: errMsg(err) }));
        worker.on('exit', (code) => {
            if (!settled)
                finish({ ok: false, error: `worker exited unexpectedly (code ${code})` });
        });
    });
}
/** Run one RPC'd tool call against the REAL host facade and post the reply back to the worker. */
async function handleCall(worker, facade, m, isSettled) {
    try {
        let value;
        if (typeof m.callName === 'string') {
            value = await facade.call(m.callName, m.args);
        }
        else {
            const fn = facade?.[m.ns]?.[m.verb];
            if (typeof fn !== 'function') {
                throw new Error(`code-orchestration: tool not available in this sandbox: ${m.ns}.${m.verb}`);
            }
            value = await fn(m.args);
        }
        if (isSettled())
            return;
        try {
            worker.postMessage({ t: 'result', id: m.id, ok: true, value });
        }
        catch (cloneErr) {
            // Tool returned something the structured clone can't carry to the worker.
            worker.postMessage({ t: 'result', id: m.id, ok: false, error: `result_not_serializable: ${errMsg(cloneErr)}` });
        }
    }
    catch (err) {
        if (isSettled())
            return;
        worker.postMessage({ t: 'result', id: m.id, ok: false, error: errMsg(err) });
    }
}
function errMsg(e) {
    return e instanceof Error ? e.message : String(e);
}
