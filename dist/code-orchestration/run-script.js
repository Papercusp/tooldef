/**
 * Default wall-clock budget for one orchestration script.
 *
 * EXPORTED because it is not only this function's default — it is the budget every caller who
 * RECOMMENDS folding tool calls into a script is implicitly promising. EI-21254965187146713: the
 * batch-hint told an agent to chain N `testing:run` calls inside one script, and the fold could
 * not finish, because a single child tool is allowed 60s by the dispatch stack (`exec.tool
 * .timeoutSec ?? 60`) while the script wrapping it had 30s. Nothing was wrong with either number
 * in isolation; the advice restated the script budget from memory instead of reading it. Anything
 * reasoning about whether a fold FITS must import this rather than repeat the literal.
 */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;
function jsonInputError(value, path, seen) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return null;
    if (typeof value === 'number')
        return Number.isFinite(value) ? null : `${path} must be a finite number`;
    if (typeof value !== 'object')
        return `${path} contains non-JSON ${typeof value}`;
    if (seen.has(value))
        return `${path} contains a cycle`;
    seen.add(value);
    if (Array.isArray(value)) {
        const ownKeys = Reflect.ownKeys(value);
        for (const key of ownKeys) {
            if (key === 'length')
                continue;
            if (typeof key !== 'string' || !/^\d+$/.test(key)) {
                seen.delete(value);
                return `${path} contains a non-JSON array property`;
            }
        }
        for (let index = 0; index < value.length; index += 1) {
            if (!Object.prototype.hasOwnProperty.call(value, index)) {
                seen.delete(value);
                return `${path}[${index}] is a sparse array slot`;
            }
            const error = jsonInputError(value[index], `${path}[${index}]`, seen);
            if (error) {
                seen.delete(value);
                return error;
            }
        }
        seen.delete(value);
        return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        seen.delete(value);
        return `${path} must be a plain JSON object`;
    }
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') {
            seen.delete(value);
            return `${path} contains a symbol key`;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
            seen.delete(value);
            return `${path}.${key} must be an enumerable data property`;
        }
        const error = jsonInputError(descriptor.value, `${path}.${key}`, seen);
        if (error) {
            seen.delete(value);
            return error;
        }
    }
    seen.delete(value);
    return null;
}
function validateJsonInputs(inputs) {
    if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) {
        return 'inputs must be a plain JSON object';
    }
    return jsonInputError(inputs, 'inputs', new Set());
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
  const { script, maxLogLines, sleepMaxMs, inputs: workerInputs } = workerData;

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
    // Tool results are wrapped in tracking Proxies before the script sees them. If a script
    // carries one of those nested values into the NEXT tool call, posting the raw Proxy back to
    // the host throws a DataCloneError (notably: "[object Array] could not be cloned"). The final
    // script return already uses unwrap() below; apply the same boundary rule to call args so
    // intermediate tool results can be safely composed into later calls.
    const callPayload = { ...payload, args: unwrap(payload.args, new Map()) };
    try {
      parentPort.postMessage(Object.assign({ t: 'call', id }, callPayload));
    } catch (cloneErr) {
      pending.delete(id);
      reject(new Error(
        'args_not_serializable: code:run could not send tool arguments across the sandbox boundary ' +
        'after unwrapping tracked values; pass JSON-serializable args. ' +
        ((cloneErr && cloneErr.message) || String(cloneErr)),
      ));
    }
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
  const ROOT_ENVELOPE_FIELDS = new Set(['content', 'text']);
  const SHAPE_HINT_LIMIT = 8;
  // EI-21163938645109933 / EI-21164455886001541: classify a miss instead of warning uniformly.
  // Bounded Levenshtein — bails as soon as every cell on a row exceeds max, so cost stays O(n*m)
  // with a tiny constant and never runs on more than AVAIL_LIMIT keys.
  const editWithin = (a, b, max) => {
    if (Math.abs(a.length - b.length) > max) return false;
    let prev = [];
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return false;
      prev = cur;
    }
    return prev[b.length] <= max;
  };
  // A typo is NEAR an available key; an optional-field probe resembles nothing on the shape.
  // Case-insensitive so a casing slip (rowcount/rowCount) reads as the typo it is.
  const nearestKey = (key, keys) => {
    const k = String(key).toLowerCase();
    for (const cand of keys) {
      const c = String(cand).toLowerCase();
      if (c === k) return cand;
      const max = Math.min(k.length, c.length) >= 5 ? 2 : 1;
      if (editWithin(k, c, max)) return cand;
      // Containment either way, not just a shared prefix. The incident this detector was BUILT
      // for is "count" read off a result whose key is "claimableCount" -- 9 edits apart, so a
      // distance test alone would file the founding case as an optional-field probe.
      // (No backticks in this comment: it lives INSIDE a template literal.)
      if (k.length >= 4 && (c.indexOf(k) >= 0 || k.indexOf(c) >= 0)) return cand;
    }
    return null;
  };
  const compactShapeHint = (target) => Object.keys(target)
    .sort()
    .slice(0, SHAPE_HINT_LIMIT)
    .join(', ') || '(none)';
  const shapeQuote = String.fromCharCode(96);
  const structuredRootShapeError = (tool, key, target) =>
    'structured_result_shape: ' + tool +
    ' returned a typed structured root; missing ' + shapeQuote + key + shapeQuote +
    ' is an MCP content/text envelope read. Use direct typed fields. Available keys: ' +
    compactShapeHint(target);
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
          && !(isArr && /^\\d+$/.test(key))) {
          const sig = tool + '|' + path + '|' + key;
          if (!missSeen.has(sig) && fieldMisses.length < MISS_LIMIT) {
            missSeen.add(sig);
            const availableKeys = Object.keys(target).slice(0, AVAIL_LIMIT);
            const near = nearestKey(key, availableKeys);
            fieldMisses.push(Object.assign(
              { tool, path: path || '(root)', read: key, available: availableKeys },
              near ? { likely: 'typo', didYouMean: near } : { likely: 'optional-field' },
            ));
          }
          if (!path && ROOT_ENVELOPE_FIELDS.has(key)) {
            throw new Error(structuredRootShapeError(tool, key, target));
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

  // --- functions.exec compatibility helpers without hidden cross-call state ---
  // bindings.values arrive as workerInputs. They remain immutable through \`inputs\`, while this
  // private copy is the explicit store/load state returned to the host for replay on the next run.
  const replayState = JSON.parse(JSON.stringify(workerInputs));
  let stateTouched = false;
  const STATE_KEY_LIMIT = 200;
  const STATE_BYTES_LIMIT = 65536;
  const generatedImages = [];
  const jsonValueError = (value, path, seen) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? null : path + ' must be a finite number';
    if (typeof value !== 'object') return path + ' contains non-JSON ' + typeof value;
    if (seen.has(value)) return path + ' contains a cycle';
    seen.add(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) return path + '[' + index + '] is sparse';
        const error = jsonValueError(value[index], path + '[' + index + ']', seen);
        if (error) return error;
      }
      seen.delete(value);
      return null;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && Object.getPrototypeOf(proto) !== null) return path + ' must be a plain JSON object';
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return path + ' contains a symbol key';
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        return path + '.' + key + ' must be an enumerable data property';
      }
      const error = jsonValueError(descriptor.value, path + '.' + key, seen);
      if (error) return error;
    }
    seen.delete(value);
    return null;
  };
  const cloneJsonValue = (value, path) => {
    const plain = unwrap(value, new Map());
    const error = jsonValueError(plain, path, new Set());
    if (error) throw new Error('state_not_serializable: ' + error);
    return JSON.parse(JSON.stringify(plain));
  };
  const requireStateKey = (key) => {
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
      throw new Error('state_key_invalid: store/load keys must be strings of 1-200 characters');
    }
    return key;
  };
  const touchState = () => {
    if (stateTouched) return;
    stateTouched = true;
    parentPort.postMessage({ t: 'state', op: 'touch' });
  };
  const load = (key) => {
    const safeKey = requireStateKey(key);
    touchState();
    if (!Object.prototype.hasOwnProperty.call(replayState, safeKey)) return undefined;
    return cloneJsonValue(replayState[safeKey], 'state.' + safeKey);
  };
  const store = (key, value) => {
    const safeKey = requireStateKey(key);
    const cloned = cloneJsonValue(value, 'state.' + safeKey);
    const nextState = { ...replayState, [safeKey]: cloned };
    if (Object.keys(nextState).length > STATE_KEY_LIMIT) {
      throw new Error('state_limit_exceeded: replay state may contain at most ' + STATE_KEY_LIMIT + ' keys');
    }
    const serialized = JSON.stringify(nextState);
    if (Buffer.byteLength(serialized, 'utf8') > STATE_BYTES_LIMIT) {
      throw new Error('state_limit_exceeded: replay state may contain at most ' + STATE_BYTES_LIMIT + ' UTF-8 bytes');
    }
    replayState[safeKey] = cloned;
    touchState();
    parentPort.postMessage({ t: 'state', op: 'set', key: safeKey, value: cloned });
    return cloneJsonValue(cloned, 'state.' + safeKey);
  };
  const notify = (value) => {
    parentPort.postMessage({ t: 'emit', name: 'notify', data: unwrap(value, new Map()) });
  };
  const yield_control = () => {
    parentPort.postMessage({ t: 'emit', name: 'yield_control', data: null });
  };
  const generatedImage = (value) => {
    generatedImages.push(unwrap(value, new Map()));
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
  // Keep the logger in the vm global scope rather than as a function parameter. A script is
  // allowed to use 'log' as an ordinary local variable (for example, to hold a tool result),
  // and a formal parameter named 'log' makes that valid script fail at compile time with
  // "Identifier 'log' has already been declared". The global still preserves the documented
  // bare log(...) convenience while allowing function-local shadowing.
  const wrap = (body) =>
    '(() => {\\n' +
    // Only the JSON string crosses the worker→VM context boundary. JSON.parse and Object.freeze
    // below are resolved inside the VM realm, so the script receives no worker/host prototypes.
    'const rawInputs = globalThis.__papercuspInputsJson;\\n' +
    'delete globalThis.__papercuspInputsJson;\\n' +
    'const freezeInputs = (value) => {\\n' +
    "  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;\\n" +
    '  for (const child of Object.values(value)) freezeInputs(child);\\n' +
    '  return Object.freeze(value);\\n' +
    '};\\n' +
    'const inputs = freezeInputs(JSON.parse(rawInputs));\\n' +
    'return (async (tools) => {\\n' +
    // atob is deliberately defined in the VM realm. Passing Node's host atob into the
    // context would give the script its host Function constructor, which can escape the VM.
    // This forgiving-base64 implementation matches the byte-page use case while keeping Node
    // globals (Buffer, process, require) out of the script's reach.
    'globalThis.atob = (input) => {\\n' +
    "  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';\\n" +
    "  const value = String(input).replace(/[\\\\t\\\\n\\\\f\\\\r ]/g, '');\\n" +
    "  const remainder = value.length % 4;\\n" +
    "  if (remainder === 1) throw new Error('InvalidCharacterError: invalid base64 length');\\n" +
    "  const padded = value + (remainder === 2 ? '==' : remainder === 3 ? '=' : '');\\n" +
    "  let output = '';\\n" +
    "  for (let i = 0; i < padded.length; i += 4) {\\n" +
    "    const c0 = padded.charAt(i);\\n" +
    "    const c1 = padded.charAt(i + 1);\\n" +
    "    const c2 = padded.charAt(i + 2);\\n" +
    "    const c3 = padded.charAt(i + 3);\\n" +
    "    const n0 = alphabet.indexOf(c0);\\n" +
    "    const n1 = alphabet.indexOf(c1);\\n" +
    "    const n2 = c2 === '=' ? 0 : alphabet.indexOf(c2);\\n" +
    "    const n3 = c3 === '=' ? 0 : alphabet.indexOf(c3);\\n" +
    "    if (n0 < 0 || n1 < 0 || n2 < 0 || n3 < 0 || (c2 === '=' && c3 !== '=') || ((c2 === '=' || c3 === '=') && i + 4 < padded.length)) {\\n" +
    "      throw new Error('InvalidCharacterError: invalid base64 data');\\n" +
    "    }\\n" +
    "    output += String.fromCharCode((n0 << 2) | (n1 >> 4));\\n" +
    "    if (c2 !== '=') output += String.fromCharCode(((n1 & 15) << 4) | (n2 >> 2));\\n" +
    "    if (c3 !== '=') output += String.fromCharCode(((n2 & 3) << 6) | n3);\\n" +
    "  }\\n" +
    "  return output;\\n" +
    '}\\n' +
    body +
    '\\n});\\n' +
    '})()';
  let factory;
  try {
    factory = vm.runInNewContext(
      wrap(script),
      {
        console: { log, error: log, warn: log },
        log,
        sleep,
        notify,
        yield_control,
        generatedImage,
        store,
        load,
        __papercuspInputsJson: JSON.stringify(workerInputs),
      },
      { displayErrors: true },
    );
  } catch (err) {
    parentPort.postMessage({ t: 'error', error: 'compile_error: ' + ((err && err.message) || String(err)) });
    return;
  }
  (async () => {
    try {
      const result = await factory(tools);
      // Deep-unwrap first: a tracking Proxy is not structured-cloneable, so returning a tool
      // result verbatim (\`return pp;\`) would otherwise become result_not_serializable.
      const plain = unwrap(result, new Map());
      try {
        parentPort.postMessage({
          t: 'done',
          result: plain,
          fieldMisses,
          sleepCaps,
          generatedImages,
          ...(stateTouched ? { state: replayState } : {}),
        });
      }
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
      parentPort.postMessage({
        t: 'error',
        error: friendly,
        generatedImages,
        ...(stateTouched ? { state: replayState } : {}),
      });
    }
  })();
})();`;
export async function runOrchestrationScript(script, facade, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
    const maxLogLines = opts.maxLogLines ?? 200;
    const logs = [];
    const inputs = opts.inputs ?? {};
    const inputsError = validateJsonInputs(inputs);
    if (inputsError) {
        return { ok: false, error: `inputs_not_serializable: ${inputsError}`, logs };
    }
    // Lazy: keeps the barrel browser-safe (see the header note on the type-only import above).
    const { Worker } = await import('node:worker_threads');
    return await new Promise((resolve) => {
        let settled = false;
        let latestState;
        const worker = new Worker(WORKER_SRC, {
            eval: true,
            name: 'code-orchestration',
            // Worker construction performs the host→worker structured clone. The worker serializes
            // this validated JSON data and the VM parses it again with realm-local intrinsics.
            workerData: { script, maxLogLines, sleepMaxMs: opts.sleepMaxMs, inputs },
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
            resolve({
                ...out,
                ...(out.state ? {} : latestState ? { state: latestState } : {}),
                logs,
            });
        };
        // The kill switch: terminate() stops the worker thread even mid sync-loop.
        const timer = setTimeout(() => {
            // Terminating the worker only stops the script. A host-side facade call may still be
            // awaiting a real tool (for example a long foreground capability:bash), and letting that
            // call continue after code:run returned leaves the caller without a resumable handle and
            // makes a retry capable of duplicating the command. Give the host a cancellation seam
            // before killing the worker (EI-20282336542235171).
            opts.onTimeout?.();
            finish({ ok: false, error: `script_timeout after ${timeoutMs}ms` });
        }, timeoutMs);
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
                    ...(m.generatedImages && m.generatedImages.length ? { generatedImages: m.generatedImages } : {}),
                    ...(m.state ? { state: m.state } : {}),
                });
            }
            if (m.t === 'error') {
                return finish({
                    ok: false,
                    error: m.error,
                    ...(m.generatedImages && m.generatedImages.length ? { generatedImages: m.generatedImages } : {}),
                    ...(m.state ? { state: m.state } : {}),
                });
            }
            if (m.t === 'state') {
                latestState ??= JSON.parse(JSON.stringify(inputs));
                if (m.op === 'set')
                    latestState[m.key] = m.value;
                return;
            }
            if (m.t === 'emit') {
                try {
                    opts.emit?.(m.name, m.data);
                }
                catch {
                    // Streaming is advisory: a detached/non-streaming transport must not fail the run.
                }
                return;
            }
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
        const toolName = typeof m.callName === 'string' ? m.callName : `${m.ns ?? '?'}.${m.verb ?? '?'}`;
        const nullBytePath = findNullBytePath(m.args);
        if (nullBytePath) {
            throw new Error(`code:run cannot dispatch ${toolName}: ${nullBytePath} contains a NUL byte. ` +
                'JavaScript `\\0` escapes become an actual NUL; for a shell `\\0` escape, write `\\\\0` in the code:run script source.');
        }
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
/**
 * Find the first NUL-containing string in an RPC argument tree before it reaches a real tool.
 *
 * JavaScript parses `\0` in a script string literal as an actual NUL. That is valid JavaScript,
 * but Node's child-process APIs reject NUL-containing argv/command strings, so the eventual
 * `capability:bash` error otherwise points at its internal `args[3]` rather than the code:run
 * source that introduced it. Keep the guard at this boundary: it preserves normal argument
 * semantics and gives the script author the exact extra escaping needed for shell `\0`.
 */
function findNullBytePath(value, path = 'args', seen = new WeakSet()) {
    if (typeof value === 'string')
        return value.includes('\u0000') ? path : undefined;
    if (value === null || typeof value !== 'object')
        return undefined;
    if (seen.has(value))
        return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            const found = findNullBytePath(value[i], `${path}[${i}]`, seen);
            if (found)
                return found;
        }
        return undefined;
    }
    for (const [key, child] of Object.entries(value)) {
        const found = findNullBytePath(child, `${path}.${key}`, seen);
        if (found)
            return found;
    }
    return undefined;
}
function errMsg(e) {
    return e instanceof Error ? e.message : String(e);
}
