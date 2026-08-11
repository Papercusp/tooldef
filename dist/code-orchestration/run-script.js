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
  const { script, maxLogLines, sleepMaxMs } = workerData;

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

  // --- EI-19301148486657755: detect reads of fields the tool result does not have ---
  // Every tool result handed to the script is wrapped in a Proxy that records a read of a key
  // that is not present. A wrong FIELD name was previously silent (undefined is indistinguishable
  // from a legitimately-absent value), which is how "count: null" got read as a real 0.
  //
  // Membership is tested with \`key in target\`, which walks the prototype chain — so Array.prototype
  // methods (.map/.filter), Object.prototype members (.toString) and the like resolve normally and
  // record nothing. Only PROBE_KEYS (runtime lookups performed on arbitrary values, never authored
  // field reads) and numeric array indices need explicit exclusion.
  //
  // Proxies are memoized per raw object so identity is stable (\`r.a === r.a\` stays true), and the
  // script's returned value is deep-unwrapped before postMessage — a Proxy is NOT structured-
  // cloneable, so letting one escape would turn every \`return someToolResult\` into
  // result_not_serializable.
  const MISS_LIMIT = 12;
  const AVAIL_LIMIT = 30;
  const fieldMisses = [];
  const missSeen = new Set();
  const proxyToRaw = new WeakMap();
  const rawToProxy = new WeakMap();
  const PROBE_KEYS = new Set(['then', 'toJSON', 'constructor', 'inspect', 'nodeType', '$$typeof']);
  // Plain data (object/array) test that works ACROSS REALMS. The script runs under
  // vm.runInNewContext, so an object it builds itself (\`return { viaCall };\`) has the VM
  // context's Object.prototype — a strict \`proto === Object.prototype\` identity check is false
  // for it, which made unwrap() skip the wrapper and let a Proxy escape into postMessage
  // (result_not_serializable). Compare structurally instead: any realm's Object.prototype is the
  // object whose own prototype is null. A Date/Map/class instance has a deeper chain, so it is
  // correctly excluded and passes through untouched.
  const isContainer = (v) => {
    if (Array.isArray(v)) return true; // realm-agnostic by spec
    if (typeof v !== 'object' || v === null) return false;
    const proto = Object.getPrototypeOf(v);
    if (proto === null) return true; // Object.create(null)
    return Object.getPrototypeOf(proto) === null;
  };
  const track = (value, tool, path) => {
    if (!isContainer(value)) return value;
    const cached = rawToProxy.get(value);
    if (cached) return cached;
    const isArr = Array.isArray(value);
    const proxy = new Proxy(value, {
      get(target, key) {
        // Symbol keys pass straight through, UNTRACKED and UNWRAPPED. They are protocol lookups
        // (Symbol.iterator for for...of, Symbol.toPrimitive, util.inspect.custom), never an
        // authored field read — and a Symbol cannot be concatenated into the dotted path below:
        // \`'items' + '.' + Symbol.iterator\` throws "Cannot convert a Symbol value to a string",
        // which is exactly how a for...of over a NESTED array (l.items) broke before this guard.
        if (typeof key === 'symbol') return Reflect.get(target, key);
        if (!(key in target)
          && !PROBE_KEYS.has(key)
          && !(isArr && /^\\d+$/.test(key))
          && fieldMisses.length < MISS_LIMIT) {
          const sig = tool + '|' + path + '|' + key;
          if (!missSeen.has(sig)) {
            missSeen.add(sig);
            fieldMisses.push({ tool, path: path || '(root)', read: key, available: Object.keys(target).slice(0, AVAIL_LIMIT) });
          }
        }
        return track(Reflect.get(target, key), tool, path ? path + '.' + key : key);
      },
    });
    proxyToRaw.set(proxy, value);
    rawToProxy.set(value, proxy);
    return proxy;
  };
  const unwrap = (v, seen) => {
    if (!v || typeof v !== 'object') return v;
    const raw = proxyToRaw.get(v) || v;
    if (!isContainer(raw)) return raw;
    if (seen.has(raw)) return seen.get(raw);
    const out = Array.isArray(raw) ? [] : {};
    seen.set(raw, out);
    for (const k of Object.keys(raw)) out[k] = unwrap(raw[k], seen);
    return out;
  };

  // --- the Proxy facade injected as \`tools\` (mirrors tool-facade.ts: tools.ns.verb + tools.call) ---
  const nsProxy = (ns) => new Proxy({}, {
    get(_t, verb) {
      if (typeof verb !== 'string' || verb === 'then') return undefined;
      return (...a) => rpc({ ns, verb, args: a[0] }).then((v) => track(v, ns + ':' + verb, ''));
    },
  });
  const tools = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (prop === 'call') return (name, args) => rpc({ callName: name, args }).then((v) => track(v, String(name), ''));
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
  //
  // EI-19324793244855883: the clamp used to be silent — no throw, no log, no field anywhere
  // saying the delay was shortened. A script measuring a rate/share over a requested window
  // (e.g. sleep(30000) to sample a 30s delta) got a window 3x+ shorter than requested and divided
  // by the number it ASKED for, producing a confidently wrong result. Now every clamped call is
  // recorded (bounded by SLEEP_CAP_LIMIT, same pattern as fieldMisses above) and returned in the
  // \`done\` message as \`sleepCaps\`, AND sleep() resolves with the ACTUAL ms waited so a careful
  // script can self-correct with \`const actual = await sleep(n)\`.
  const SLEEP_MAX_MS = Number(sleepMaxMs) > 0 ? Number(sleepMaxMs) : 10000;
  const SLEEP_CAP_LIMIT = 20;
  const sleepCaps = [];
  const sleep = (ms) => new Promise((resolve) => {
    const requested = Number(ms) || 0;
    const bounded = Math.max(0, Math.min(requested, SLEEP_MAX_MS));
    if (bounded < requested && sleepCaps.length < SLEEP_CAP_LIMIT) {
      sleepCaps.push({ requestedMs: requested, actualMs: bounded });
    }
    setTimeout(() => resolve(bounded), bounded);
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
      // Deep-unwrap first: a tracking Proxy is not structured-cloneable, so returning a tool
      // result verbatim (\`return pp;\`) would otherwise become result_not_serializable.
      const plain = unwrap(result, new Map());
      try { parentPort.postMessage({ t: 'done', result: plain, fieldMisses, sleepCaps }); }
      catch (cloneErr) { parentPort.postMessage({ t: 'error', error: 'result_not_serializable: ' + ((cloneErr && cloneErr.message) || String(cloneErr)) }); }
    } catch (err) {
      const msg = (err && err.message) || String(err);
      // EI-19294786663902075: vm.runInNewContext is built with no importModuleDynamically
      // callback, so a script's await import(...) throws this exact V8-level message before
      // the specifier is ever looked at -- indistinguishable, on first read, from a bad path.
      // Rewritten here so the constraint (tools.* only -- the whitelist IS the security boundary,
      // same reason require/process are absent) costs one read instead of a wasted retry.
      const friendly = /dynamic import callback/i.test(msg)
        ? 'dynamic_import_unsupported: code:run cannot import()/require() repo modules or node builtins -- only tools.ns.verb(args) is exposed (the role tool whitelist IS the sandbox security boundary, same reason require/process are absent). Use capability:bash + npx tsx for direct module/DB access outside that whitelist.'
        : msg;
      parentPort.postMessage({ t: 'error', error: friendly });
    }
  })();
})();`;
export async function runOrchestrationScript(script, facade, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const maxLogLines = opts.maxLogLines ?? 200;
    const logs = [];
    // Lazy: keeps the barrel browser-safe (see the header note on the type-only import above).
    const { Worker } = await import('node:worker_threads');
    return await new Promise((resolve) => {
        let settled = false;
        const worker = new Worker(WORKER_SRC, {
            eval: true,
            name: 'code-orchestration',
            workerData: { script, maxLogLines, sleepMaxMs: opts.sleepMaxMs },
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
            if (m.t === 'done') {
                return finish({
                    ok: true,
                    result: m.result,
                    ...(m.fieldMisses && m.fieldMisses.length ? { fieldMisses: m.fieldMisses } : {}),
                    ...(m.sleepCaps && m.sleepCaps.length ? { sleepCaps: m.sleepCaps } : {}),
                });
            }
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
