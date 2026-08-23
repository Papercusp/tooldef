/**
 * code-execution-tool-orchestration B-CX-1A / B-CX-SANDBOX — the sandbox EXECUTOR.
 *
 * Runs a model-submitted orchestration script with the tool facade injected as `tools`, and
 * returns ONLY the script's returned summary. Intermediate tool results live here in the
 * runtime and never re-enter the model's context — that, plus collapsing a flow that would require
 * multiple MODEL inference turns into one `code:run` call, is the token win. Independent direct
 * calls emitted together in one assistant turn already cost one inference turn; raw RPC count alone
 * is not a reason to script them.
 *
 *   // model writes:
 *   const open = await tools.workItems.list({ status: 'open' });
 *   const failing = [];
 *   for (const w of open.items) {
 *     const d = await tools.workItems.get({ id: w.id });
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
 * JSON/Math/Promise present) and gives clean compile-error reporting. A VM-local, browser-style
 * `atob` helper is installed for decoding the base64 byte pages returned by `capability:read`;
 * it is defined inside the VM rather than passing a host function across the boundary. So the
 * worker is the isolation+kill boundary; the inner vm is the globals-scoping + compile boundary.
 *
 * `setTimeout`/`setInterval` are Node/DOM globals, not JS-spec intrinsics, so they are NOT
 * ambient in the vm context (EI-7839: a script calling `setTimeout(...)` throws `setTimeout is
 * not defined`, immediately, even after prior tool calls already wrote). For a short async delay
 * (e.g. "write, wait briefly, re-verify"), the script's ambient globals instead include
 * `sleep(ms)` — an `await`-able helper capped at `SLEEP_MAX_MS` per call, so a runaway wait
 * degrades to the existing overall `script_timeout` kill rather than an unbounded hang. It is the
 * ONLY timer primitive exposed; raw `setTimeout`/`setInterval` stay absent so a script can't spin
 * up an open-ended polling loop instead of using `tools.*` calls directly. A clamped call is never
 * silent (EI-19324793244855883): it resolves with the ACTUAL ms waited (not the requested ms), and
 * is reported back in {@link RunScriptResult.sleepCaps} so a script measuring a rate/share over a
 * requested window can tell its window was shortened instead of silently dividing by the wrong
 * denominator.
 *
 * The facade is NOT cloneable into a worker (its members are live host functions that dispatch
 * through the real tool pipeline — DB, ctx, capability envelope), so each `tools.ns.verb(args)`
 * the script makes is RPC'd back to the host over the worker message channel: the worker holds a
 * Proxy facade, the host runs the REAL facade fn and posts the result back. The whitelist in
 * tool-facade.ts (the agent's capability envelope) + the dry-run/confirm gate on write-effect
 * tools (B-CX-2A) remain the security model; the worker is an availability/robustness boundary,
 * not a substitute for the whitelist.
 */
// ⚠ Node-only dependency, loaded LAZILY inside runOrchestrationScript. This module is re-exported
// by the tooldef barrel, and tooldef is an isomorphic lib consumed by the browser SPA — a static
// top-level `import { Worker } from 'node:worker_threads'` here gets externalized by vite and
// THROWS at module-eval time in the client, blanking the whole app (fleet incident 2026-07-04).
// The dynamic import defers evaluation to call time; nothing browser-side ever calls this fn.
// Guarded by browser-safe-barrel.test.ts — keep ALL node: builtins in this lib call-time-lazy.
import type { Worker as NodeWorker } from 'node:worker_threads';
import type { ToolFacade } from './tool-facade';

/**
 * EI-19301148486657755 — one recorded read of a field the tool result does NOT have.
 *
 * A wrong TOOL name has always been caught (typed signatures come back inline); a wrong FIELD
 * name was silent, because `undefined` from a property access is indistinguishable from a
 * legitimately-absent value — and the `?? null` / `?? 0` fallbacks agents write to keep summaries
 * bounded then convert that into a confident number. Live case: a monitor script read
 * `claimable.count` (the real key is `claimableCount`), summarised `count: null`, and the leader
 * read it as "0 claimable" against a queue of 1,397 — one step from standing down a 10-agent fleet.
 *
 * Same bug class as WI-6674's always-NULL accessor: a value meaning "I could not see it" sharing a
 * representation with a value meaning "there is none".
 */
export interface FieldMiss {
  /** The tool whose result was read, in colon form (e.g. `work_items:claimable`). */
  tool: string;
  /** Dotted path of the container that was read, or `(root)` for the result object itself. */
  path: string;
  /** The field name the script asked for and did not find. */
  read: string;
  /** The keys that ARE present on that container — i.e. what the author probably meant. */
  available: string[];
}

/**
 * EI-19324793244855883 — one recorded read of a WINDOW that was silently shorter than requested.
 *
 * `sleep(ms)` is capped at `SLEEP_MAX_MS` per call so a runaway wait degrades to the script's
 * overall timeout instead of hanging. Before this, the clamp was silent: no throw, no log line,
 * no field anywhere saying the delay was shortened — so a script measuring a rate/share over a
 * requested window (e.g. `await sleep(30000)` to sample a 30s DB-time delta) got back a window
 * 3x+ shorter than it asked for and divided by the number it *requested*, not the number it
 * *got*. The derived rate/share then looks perfectly well-formed and is wrong. Same bug shape as
 * {@link FieldMiss}: a value meaning "this was cut short" sharing a representation (silent
 * success) with a value meaning "this ran to completion".
 */
export interface SleepCap {
  /** The ms the script asked `sleep()` to wait. */
  requestedMs: number;
  /** The ms it actually waited (== SLEEP_MAX_MS whenever requestedMs exceeds the cap). */
  actualMs: number;
}

/** JSON-only values that may cross into the orchestration VM as frozen runtime inputs. */
export type OrchestrationInputValue =
  | null
  | boolean
  | number
  | string
  | readonly OrchestrationInputValue[]
  | { readonly [key: string]: OrchestrationInputValue };

/**
 * Runtime recipe/script inputs. The host validates this shape before constructing the worker;
 * the worker then structured-clones it and reconstructs it with the VM realm's own JSON/Object
 * intrinsics before recursively freezing it. No host object prototype or callable crosses in.
 */
export type OrchestrationInputs = Readonly<Record<string, OrchestrationInputValue>>;

export interface RunScriptResult {
  ok: boolean;
  /** The script's returned value — the summary that re-enters the model's context. */
  result?: unknown;
  /** Captured console output from the script (bounded by maxLogLines). */
  logs: string[];
  /** Present when ok=false: 'compile_error: …', 'script_timeout …', or the thrown message. */
  error?: string;
  /**
   * Reads of fields that did not exist on a tool result (see {@link FieldMiss}). Present only when
   * non-empty, so a correct script pays nothing and sees nothing — this fires exactly when the
   * author was already wrong, which is what makes it safe to surface unconditionally.
   */
  fieldMisses?: FieldMiss[];
  /**
   * `sleep(ms)` calls that asked for longer than `SLEEP_MAX_MS` and were silently clamped (see
   * {@link SleepCap}). Present only when non-empty.
   */
  sleepCaps?: SleepCap[];
  /** Explicit replay state after any store/load helper call. Seeded from `inputs`. */
  state?: OrchestrationInputs;
  /** Raw generated-image helper calls; validated and converted by the orchestration boundary. */
  generatedImages?: GeneratedImageRequest[];
}

export interface GeneratedImageRequest {
  image_url: string;
  output_hint?: string;
}

export interface RunScriptOptions {
  /** Wall-clock budget for the whole script. Default 30s. Sync loops are killed at this bound. */
  timeoutMs?: number;
  /**
   * Called immediately before the worker is terminated by the wall-clock budget. Host-side tool
   * calls may still be awaiting their real handler after the worker is gone, so callers must use
   * this hook to cancel those calls before the result is returned (EI-20282336542235171).
   */
  onTimeout?: () => void;
  /** Cap on captured console lines. Default 200. */
  maxLogLines?: number;
  /**
   * Optional V8 old-generation heap cap (MB) for the worker. When set, a script that allocates
   * past it is killed by the runtime with a heap-OOM error instead of bloating the host. Omit for
   * no explicit cap (the Node default). Very small values (<16) can make the worker fail to boot.
   */
  maxOldGenerationSizeMb?: number;
  /**
   * Per-call cap (ms) for the sandbox's `sleep(ms)` helper. Default 10_000 (see the header note on
   * `sleep`). Exposed mainly so tests can exercise the clamp path without a real multi-second wait;
   * production callers should leave this at the default.
   */
  sleepMaxMs?: number;
  /** Optional JSON-only runtime inputs exposed to the script as the deeply frozen `inputs` value. */
  inputs?: OrchestrationInputs;
  /** Streaming helper sink. notify/yield_control map to this caller-scoped transport callback. */
  emit?: (name: string, data: unknown) => void;
}

function jsonInputError(value: unknown, path: string, seen: Set<object>): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${path} must be a finite number`;
  if (typeof value !== 'object') return `${path} contains non-JSON ${typeof value}`;
  if (seen.has(value)) return `${path} contains a cycle`;
  seen.add(value);

  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value);
    for (const key of ownKeys) {
      if (key === 'length') continue;
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

function validateJsonInputs(inputs: unknown): string | null {
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
            fieldMisses.push({ tool, path: path || '(root)', read: key, available: Object.keys(target).slice(0, AVAIL_LIMIT) });
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

export async function runOrchestrationScript(
  script: string,
  facade: ToolFacade,
  opts: RunScriptOptions = {},
): Promise<RunScriptResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxLogLines = opts.maxLogLines ?? 200;
  const logs: string[] = [];
  const inputs = opts.inputs ?? {};
  const inputsError = validateJsonInputs(inputs);
  if (inputsError) {
    return { ok: false, error: `inputs_not_serializable: ${inputsError}`, logs };
  }

  // Lazy: keeps the barrel browser-safe (see the header note on the type-only import above).
  const { Worker } = await import('node:worker_threads');

  return await new Promise<RunScriptResult>((resolve) => {
    let settled = false;
    let latestState: Record<string, OrchestrationInputValue> | undefined;
    const worker: NodeWorker = new Worker(WORKER_SRC, {
      eval: true,
      name: 'code-orchestration',
      // Worker construction performs the host→worker structured clone. The worker serializes
      // this validated JSON data and the VM parses it again with realm-local intrinsics.
      workerData: { script, maxLogLines, sleepMaxMs: opts.sleepMaxMs, inputs },
      ...(opts.maxOldGenerationSizeMb
        ? { resourceLimits: { maxOldGenerationSizeMb: opts.maxOldGenerationSizeMb } }
        : {}),
    });

    const finish = (out: Omit<RunScriptResult, 'logs'>): void => {
      if (settled) return;
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

    worker.on('message', (m: WorkerMessage) => {
      if (m.t === 'log') {
        if (logs.length < maxLogLines) logs.push(m.text);
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
        latestState ??= JSON.parse(JSON.stringify(inputs)) as Record<string, OrchestrationInputValue>;
        if (m.op === 'set') latestState[m.key] = m.value;
        return;
      }
      if (m.t === 'emit') {
        try {
          opts.emit?.(m.name, m.data);
        } catch {
          // Streaming is advisory: a detached/non-streaming transport must not fail the run.
        }
        return;
      }
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
  worker: NodeWorker,
  facade: ToolFacade,
  m: CallMessage,
  isSettled: () => boolean,
): Promise<void> {
  try {
    const toolName = typeof m.callName === 'string' ? m.callName : `${m.ns ?? '?'}.${m.verb ?? '?'}`;
    const nullBytePath = findNullBytePath(m.args);
    if (nullBytePath) {
      throw new Error(
        `code:run cannot dispatch ${toolName}: ${nullBytePath} contains a NUL byte. ` +
          'JavaScript `\\0` escapes become an actual NUL; for a shell `\\0` escape, write `\\\\0` in the code:run script source.',
      );
    }

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

/**
 * Find the first NUL-containing string in an RPC argument tree before it reaches a real tool.
 *
 * JavaScript parses `\0` in a script string literal as an actual NUL. That is valid JavaScript,
 * but Node's child-process APIs reject NUL-containing argv/command strings, so the eventual
 * `capability:bash` error otherwise points at its internal `args[3]` rather than the code:run
 * source that introduced it. Keep the guard at this boundary: it preserves normal argument
 * semantics and gives the script author the exact extra escaping needed for shell `\0`.
 */
function findNullBytePath(value: unknown, path = 'args', seen = new WeakSet<object>()): string | undefined {
  if (typeof value === 'string') return value.includes('\u0000') ? path : undefined;
  if (value === null || typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findNullBytePath(value[i], `${path}[${i}]`, seen);
      if (found) return found;
    }
    return undefined;
  }

  for (const [key, child] of Object.entries(value)) {
    const found = findNullBytePath(child, `${path}.${key}`, seen);
    if (found) return found;
  }
  return undefined;
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
  | {
      t: 'done';
      result: unknown;
      fieldMisses?: FieldMiss[];
      sleepCaps?: SleepCap[];
      state?: OrchestrationInputs;
      generatedImages?: GeneratedImageRequest[];
    }
  | {
      t: 'error';
      error: string;
      state?: OrchestrationInputs;
      generatedImages?: GeneratedImageRequest[];
    }
  | { t: 'state'; op: 'touch' }
  | { t: 'state'; op: 'set'; key: string; value: OrchestrationInputValue }
  | { t: 'emit'; name: string; data: unknown }
  | CallMessage;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
