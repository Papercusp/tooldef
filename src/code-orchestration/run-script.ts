/**
 * code-execution-tool-orchestration B-CX-1A — the sandbox EXECUTOR.
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
 * ISOLATION CAVEAT (intentional, documented): `node:vm` scopes the script's globals (no
 * `require`/`process`/`module`/`Buffer`; standard intrinsics like JSON/Math/Promise present) but
 * is NOT a security boundary — a determined script can escape a vm, and a synchronous infinite
 * loop blocks the host (the wall-clock race below only bounds async-yielding work). The security
 * model is the capability-envelope WHITELIST baked into the facade (tool-facade.ts) + the
 * dry-run/confirm gate on write-effect tools (B-CX-2A). Hardened isolation (worker thread /
 * subprocess) is a tracked follow-up; it does not change this module's surface.
 */
import * as vm from 'node:vm';
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
  /** Wall-clock budget for the whole script. Default 30s. */
  timeoutMs?: number;
  /** Cap on captured console lines. Default 200. */
  maxLogLines?: number;
}

const wrap = (body: string): string => `(async (tools, log) => {\n${body}\n})`;

export async function runOrchestrationScript(
  script: string,
  facade: ToolFacade,
  opts: RunScriptOptions = {},
): Promise<RunScriptResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxLogLines = opts.maxLogLines ?? 200;
  const logs: string[] = [];
  const log = (...parts: unknown[]): void => {
    if (logs.length < maxLogLines) logs.push(parts.map(stringify).join(' '));
  };

  type Factory = (tools: ToolFacade, log: (...p: unknown[]) => void) => Promise<unknown>;
  let factory: Factory;
  try {
    factory = vm.runInNewContext(
      wrap(script),
      { console: { log, error: log, warn: log } },
      { timeout: timeoutMs, displayErrors: true },
    ) as Factory;
  } catch (err) {
    return { ok: false, logs, error: `compile_error: ${errMsg(err)}` };
  }

  try {
    const result = await withTimeout(factory(facade, log), timeoutMs);
    return { ok: true, result, logs };
  } catch (err) {
    return { ok: false, logs, error: errMsg(err) };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`script_timeout after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
