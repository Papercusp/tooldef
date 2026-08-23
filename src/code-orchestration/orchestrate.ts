/**
 * code-execution-tool-orchestration B-CX-2A — the orchestration COMPOSITION.
 *
 * Ties the B-CX-1A pieces together into the one call the `code:run` agent tool makes:
 *   1. PARSE-CHECK the script against the allowed tool set (fast-fail on disallowed refs).
 *   2. Build the facade over `realDispatch(ctx, deps)` — the REAL dispatcher pipeline —
 *      wrapped by the DRY-RUN/CONFIRM gate: in dryRun, `effect:'write'` calls (the B-CX-PRE
 *      marker) are RECORDED, not executed, so an agent/operator can preview every mutation
 *      before committing; reads run normally. Non-dryRun runs everything.
 *   3. Run the script (node:vm), returning ONLY its summary.
 *
 * Lives in tooldef (not operator-core) so it's e2e-testable against the real dispatcher with
 * fixture tools + a fixture ctx; the `code:run` defineTool is a thin wrapper over this.
 *
 * Known MVP gap (documented): inner calls enforce the dispatcher's role + capability gates (from
 * ctx) but not the host capability-ENVELOPE port unless the caller threads it via `deps`. The
 * facade whitelist (`allowed`) + the dryRun gate are the layers present; threading the host
 * envelope port into `deps` is a hardening follow-up.
 */
import type { ProjectedTool, UnifiedToolContext } from '../tool-projection';
import type { DispatchProjectedDeps } from '../dispatch-types';
import { buildToolFacade, type FacadeDispatch } from './tool-facade';
import { realDispatch, isPreExecutionFailure } from './dispatch-binding';
import {
  runOrchestrationScript,
  type FieldMiss,
  type OrchestrationInputs,
  type SleepCap,
} from './run-script';
import { checkScript, ensureParseCheckReady, type StaticToolCall } from './parse-check';

/**
 * Per-inner-call context-rebinding hook (WI-1411). By default every call the
 * script makes reuses the SAME fixed `ctx` passed to `runToolOrchestration` —
 * fine for an ordinary concrete-workspace caller (its ctx is already bound
 * correctly for the whole batch) but WRONG for a caller whose effective
 * per-call binding can differ from call to call (e.g. an unscoped superuser
 * passing a per-call `{ workspace: 'X' }` arg — the EI-30 "hop without
 * re-auth" convention a direct MCP dispatch honors via
 * `effectiveDispatchWorkspace`/`withWorkspace`/ALS, but which a single fixed
 * `ctx` can never express). `next(callCtx)` performs the actual dispatch with
 * whatever context the wrapper decides is correct for THIS call.
 */
export type DispatchNext = (callCtx: UnifiedToolContext) => Promise<unknown>;
export type WrapDispatch = (
  tool: ProjectedTool,
  toolName: string,
  args: unknown,
  ctx: UnifiedToolContext,
  next: DispatchNext,
) => Promise<unknown>;

export interface OrchestrateOptions {
  ctx: UnifiedToolContext;
  deps: DispatchProjectedDeps;
  /** Candidate tools (typically the full projected registry). */
  tools: readonly ProjectedTool[];
  /** Optional whitelist (full MCP names) — the agent's envelope. Absent ⇒ all `tools`. */
  allowed?: ReadonlySet<string>;
  /** When true, `effect:'write'` calls are recorded, not executed. Default false. */
  dryRun?: boolean;
  /** Wall-clock budget. Default = run-script's 30s. */
  timeoutMs?: number;
  /**
   * Optional per-call context-rebinding hook (WI-1411) — see `WrapDispatch`.
   * Absent ⇒ every call in the batch dispatches under the fixed `ctx`
   * (pre-WI-1411 behavior), which stays correct for any caller whose binding
   * doesn't vary per call.
   */
  wrapDispatch?: WrapDispatch;
  /** Optional JSON-only runtime inputs, exposed inside the VM as deeply frozen `inputs`. */
  inputs?: OrchestrationInputs;
}

export interface PlannedMutation {
  tool: string;
  args: unknown;
}

export type WriteAttemptDisposition =
  | 'in_flight'
  | 'settled'
  | 'semantic_rejected'
  | 'rejected'
  | 'uncertain';

/**
 * Runtime disposition of one committing write call. Unlike `plannedMutations` (which records
 * only that dispatch started), this remains honest when the vm times out while a host-side tool
 * promise is still pending. `index` is the zero-based dispatch order, so a sequential caller can
 * resume from an exact prefix without echoing sensitive/full call args into the result.
 */
export interface WriteAttempt {
  index: number;
  tool: string;
  disposition: WriteAttemptDisposition;
}

/**
 * A validated durable-output identity observed on an inner result. The preview
 * and owner fields from the model-facing reference envelope are deliberately
 * absent: a trace needs identity/integrity, not another copy of potentially
 * sensitive display text or an invocation-ephemeral owner id.
 */
export interface OrchestrationOutputReference {
  uri: string;
  byteCount: number;
  sha256: string;
  expiresAt?: string;
  audience?: 'owner' | 'workspace' | 'public';
}

export type OrchestrationCallDisposition =
  | 'planned'
  | 'in_flight'
  | 'settled'
  | 'semantic_rejected'
  | 'rejected'
  | 'uncertain';

/**
 * Secret-free runtime evidence for one inner call. Arguments and results never
 * enter this record. The operator-side P-013 normalizer combines these records
 * with checkScript's static argument view before anything is persisted.
 */
export interface OrchestrationCallRecord {
  ordinal: number;
  tool: string;
  effect: 'read' | 'write' | 'unknown';
  disposition: OrchestrationCallDisposition;
  outputReferences: OrchestrationOutputReference[];
}

/**
 * Runtime-owned safety evidence for one orchestration run. This is deliberately
 * outside the script-authored summary: a script cannot prove its own authority
 * invariants by returning `authorityUnchanged: true`.
 *
 * The server runtime cannot observe prompts injected into a native client while
 * this call is in flight. Reporting that boundary explicitly is safer than
 * manufacturing an `unchanged` verdict from the absence of a server signal.
 */
export interface OrchestrationRuntimeObservations {
  authorizationObservationCount: number;
  authorityWideningDetected: boolean;
  midTurnPromptInjectionObservability: 'not-observable';
}

/** A statically ordered write that the script never reached after an earlier throw. */
export interface NotDispatchedWrite {
  tool: string;
  /** Explicitly false: this write never crossed the dispatcher boundary. */
  executed: false;
}

/**
 * A write-effect call whose result reported `ok: false` WITHOUT throwing (EI-7669) — the
 * dispatch itself succeeded (realDispatch only throws on a dispatch-level failure), but the
 * tool's own business-logic result carries a semantic rejection (e.g. work_items:set_state's
 * completion-integrity check). A script that doesn't inspect every result (the common case —
 * `Promise.allSettled` counts a resolved-but-ok:false call the same as a real success) would
 * otherwise silently treat this as an executed mutation. Empty in dryRun (nothing executed).
 */
export interface FailedMutation {
  tool: string;
  args: unknown;
  result: unknown;
}

/** EI-10951: a write-effect call that THREW — recorded with why, so the caller can tell a
 *  provably-never-landed rejection from an honestly-uncertain one. */
export interface ThrownMutation {
  tool: string;
  args: unknown;
  error: string;
}

/** A child call that failed semantically or threw, regardless of read/write effect. */
export interface ChildFailure {
  tool: string;
  kind: 'semantic' | 'rejected' | 'uncertain';
  result?: unknown;
  error?: string;
}

/**
 * P-027: media a script explicitly elects to return to the model. This is deliberately
 * narrower than an arbitrary inner ToolResult: only image/audio data blocks are eligible,
 * and they cross the outer transport only when the FINAL script result uses the
 * `{ summary, media }` contract. Intermediate tool results never populate this array.
 */
export type CodeRunMediaContent =
  | { type: 'image'; data: string; mimeType: string; _meta?: Record<string, unknown> }
  | { type: 'audio'; data: string; mimeType: string };

export interface OrchestrateResult {
  ok: boolean;
  /** The script's returned summary (what re-enters the model's context). */
  summary?: unknown;
  /** Validated image/audio blocks from an explicit final `{ summary, media }` result. */
  media?: CodeRunMediaContent[];
  /** Explicit store/load state, suitable for replay as the next invocation's bindings.values. */
  state?: OrchestrationInputs;
  logs: string[];
  error?: string;
  /** Set when the parse-check failed. */
  unknownRefs?: string[];
  dryRun: boolean;
  /** P-012 (census double-count): how many times the script actually ENTERED the host
   *  dispatcher — reads and writes alike, throwing calls included, dryRun-skipped writes
   *  and unknown-ref stub rejections excluded. Equals the number of inner
   *  tool_invocations rows this run produced, which is what a wrapper tool needs to
   *  mark its own row as a dispatch wrapper only when inner rows actually exist.
   *  Optional so pre-existing hand-built fixture results are unaffected;
   *  runToolOrchestration's own return always populates it. */
  dispatchCount?: number;
  /** Exact UTF-8 bytes of every child result that settled and entered the script
   *  runtime. Thrown dispatches have no result body and therefore add zero. */
  intermediateBytes?: number;
  /** Independent runtime evidence; never derived from the script's return value. */
  runtimeObservations: OrchestrationRuntimeObservations;
  /** Write-effect calls the script made (recorded in dryRun, observed otherwise).
   *  NOTE: recorded at DISPATCH time, so this includes calls that then threw — subtract
   *  `rejectedMutations` + `uncertainMutations` for the set that actually landed. */
  plannedMutations: PlannedMutation[];
  /** Runtime disposition for every non-dry-run write dispatch, in dispatch order. A timeout may
   * return entries as `in_flight`; those are UNKNOWN, not landed, until the caller verifies them. */
  writeAttempts?: WriteAttempt[];
  /** EI-10951: write-effect calls the dispatcher REJECTED before the handler ran (bad args,
   *  a denied gate). These provably wrote NOTHING — safe to fix and re-run. */
  rejectedMutations?: ThrownMutation[];
  /** EI-10951: write-effect calls that threw for some OTHER reason (a handler error, a
   *  timeout mid-flight). These MAY have partially landed — the honestly-uncertain set, and
   *  the only one that still warrants a "verify before you re-run" warning. */
  uncertainMutations?: ThrownMutation[];
  /** Write-effect calls that resolved with a top-level `ok: false` result (EI-7669). Always
   *  empty (or absent, on a hand-built fixture result predating this field) under dryRun
   *  (nothing executed yet) — runToolOrchestration's own return always populates it. Optional
   *  so pre-existing test fixtures constructing an OrchestrateResult literal don't all need
   *  updating; shapeMutationEcho defaults a missing value to `[]`. */
  okFalseMutations?: FailedMutation[];
  /** Every failed child call, including reads. This is the aggregate truth surface used by
   * wrappers/telemetry; mutation-specific arrays above remain the recovery/safety surface. */
  childFailures?: ChildFailure[];
  /**
   * EI-7784: true when `okFalseMutations` is non-empty — the script itself ran to completion
   * (`ok` stays whatever `run.ok` says: did the SCRIPT throw/timeout), but at least one
   * write-effect call silently rejected without throwing. `ok` alone cannot carry this (it is
   * ALREADY a meaningful, independent signal — "did the script itself complete" — that several
   * existing callers branch on, e.g. `code:run`'s own recipe-capture gate and `recipes:run`'s
   * per-item `ok`), so this is a SEPARATE flag rather than overloading `ok`'s existing meaning.
   * A caller that checks only `ok` (not this flag) is exactly the gap that let three real
   * incidents (EI-7763, EI-7778, WI-3042's assignee:null drop) look like clean successes. Optional
   * (defaults absent/false-ish) so pre-existing hand-built fixture results are unaffected;
   * runToolOrchestration's own return always populates it. */
  partial?: boolean;
  /**
   * P-020: write-effect tools the script ORDERED but that never dispatched at all, because
   * an earlier throw unwound the vm before reaching them. Present only on a failed run, and
   * only when non-empty. Distinct from every other mutation array here: those are recorded
   * at dispatch, so a call that never dispatched appears in NONE of them — this is the only
   * surface that can tell an author their trailing `work_items:checkpoint` never happened.
   * Provable set only (see `detectStrandedWrites`): a tool that ran at least once is omitted.
   */
  strandedWrites?: string[];
  /**
   * P-020 compatibility companion to `strandedWrites`. The legacy string list is useful for
   * concise human output but does not carry a disposition in its shape. This field makes the
   * recovery fact machine-readable: every listed write has `executed:false` because it never
   * dispatched at all. It is present only when `strandedWrites` is present.
   */
  notDispatchedWrites?: NotDispatchedWrite[];
  /**
   * EI-19301148486657755: reads of fields that do not exist on a tool result — the author asked
   * for `count` on a result whose key is `claimableCount`. Present only when non-empty.
   *
   * This is the FIELD-name counterpart of `unknownRefs` (wrong TOOL name). Both exist for the same
   * reason: the protection has to fire without the agent having predicted the mistake, because the
   * failure is silent — `undefined` reads as a legitimate absence, and the `?? null` fallbacks that
   * keep summaries bounded then launder it into a confident value.
   */
  fieldMisses?: FieldMiss[];
  /**
   * EI-19324793244855883: `sleep(ms)` calls the script made that asked for longer than the
   * sandbox's cap and were silently clamped. Present only when non-empty — see {@link SleepCap}.
   */
  sleepCaps?: SleepCap[];
  /**
   * Internal P-013 capture evidence. code:run and recipes:run remove this field
   * from their model-facing payloads after persisting the normalized trace.
   */
  callRecords?: OrchestrationCallRecord[];
}

function setContainsAll<T>(superset: ReadonlySet<T> | undefined, subset: ReadonlySet<T> | undefined): boolean {
  if (!subset || subset.size === 0) return true;
  if (!superset) return false;
  for (const value of subset) if (!superset.has(value)) return false;
  return true;
}

/** True only when the actual inner-dispatch context has a grant the outer caller lacked. */
function authorityWidened(
  outer: UnifiedToolContext,
  inner: UnifiedToolContext,
): boolean {
  if (inner.isSuperuser === true && outer.isSuperuser !== true) return true;
  if (inner.role !== outer.role) return true;

  const outerPrincipal = outer.principal;
  const innerPrincipal = inner.principal;
  if (!innerPrincipal) return false;
  if (!outerPrincipal) return true;
  if (innerPrincipal.slug !== outerPrincipal.slug) return true;
  if (!setContainsAll(outerPrincipal.capabilities, innerPrincipal.capabilities)) return true;
  if (!setContainsAll(outerPrincipal.roles, innerPrincipal.roles)) return true;
  return false;
}

/**
 * P-020 (fleet-leadership-continuity-and-actuation-2026-08-01) — name the writes that
 * NEVER RAN, not just the ones that failed.
 *
 * A thrown call aborts the vm script, so every `tools.ns.verb(...)` written AFTER it in
 * source order never dispatches at all. Those calls are invisible to every existing
 * recovery surface — `plannedMutations`/`rejected`/`uncertain` are all recorded AT
 * DISPATCH, and an unreached line never dispatched. So the result could say "1 call was
 * rejected, nothing was written" while silently omitting that the script had also ordered
 * a `work_items:checkpoint` that never happened. The agent reads "nothing written, safe to
 * re-run", fixes the typo'd read... and the continuity write it thought it had made is gone.
 *
 * EI-18717906460509995 already recognised this shape and added ORDERING_HINT — but that is a
 * MITIGATION ("write your durable calls first"), not a report: it tells the author how to
 * avoid the trap next time and still never says which write was stranded THIS time. This is
 * the missing read-side half.
 *
 * Sound by construction — it reports only the provable set. `checkScript` already resolves
 * every statically-visible facade reference to its canonical `ns:verb` (it runs anyway, for
 * `unknownRefs`), so this reuses that parse rather than adding a second, drifting one. A
 * write-effect tool named in the script with ZERO dispatches provably never ran. A tool that
 * dispatched at least once is deliberately NOT reported: inside a loop or a branch it may
 * have run some iterations and not others, and no static count can tell which — claiming
 * otherwise would be the same cry-wolf failure EI-10951 fixed in the warning next door.
 * Dynamic dispatch (`tools.call(someVar)`) is likewise invisible to the static parse and
 * simply not claimed.
 *
 * Source order is preserved so the report reads as the script does.
 *
 * PURE — unit-tested without a vm, PG, or a live dispatcher.
 */
export type ResolvedToolEffect = 'read' | 'write' | 'unknown';

/**
 * Resolve a projected tool's effect for one facade call. A classifier is
 * advisory metadata: malformed output or a thrown classifier must not turn a
 * safe static write into an executable dry-run call.
 */
export function resolveToolEffect(
  tool: Pick<ProjectedTool, 'effect' | 'effectForCall'>,
  args: unknown,
): ResolvedToolEffect {
  const fallback: ResolvedToolEffect =
    tool.effect === 'read' || tool.effect === 'write' ? tool.effect : 'unknown';
  if (typeof tool.effectForCall !== 'function') return fallback;
  try {
    const resolved = tool.effectForCall(args);
    return resolved === 'read' || resolved === 'write' ? resolved : fallback;
  } catch {
    return fallback;
  }
}

export function detectStrandedWrites(
  staticCalls: readonly StaticToolCall[],
  tools: readonly ProjectedTool[],
  dispatchedToolNames: readonly string[],
): string[] {
  // `expose.mcp.name` is the canonical projected name — the SAME accessor buildToolFacade and
  // facadeToolNames use, and the one `checkScript` resolves its `calls` against. A ProjectedTool
  // has no top-level `.name`; reading one yields `undefined` for every tool, which silently
  // empties this set and makes the whole detector a no-op that still passes any unit test whose
  // fixture invents the field. (It did exactly that until an end-to-end run caught it.)
  const toolsByName = new Map(
    tools
      .map((tool) => [tool.expose?.mcp?.name, tool] as const)
      .filter((entry): entry is readonly [string, ProjectedTool] => typeof entry[0] === 'string'),
  );
  const dispatched = new Set(dispatchedToolNames);
  const stranded: string[] = [];
  const seen = new Set<string>();
  for (const call of staticCalls) {
    const name = call.tool;
    const tool = toolsByName.get(name);
    if (!tool || resolveToolEffect(tool, call.args) !== 'write') continue; // reads are re-runnable; only writes strand
    if (dispatched.has(name)) continue; // ran at least once — cannot prove anything about the rest
    if (seen.has(name)) continue;
    seen.add(name);
    stranded.push(name);
  }
  return stranded;
}

/** True when `value` is a plain object carrying a top-level `ok: false` — the tool's own
 *  reported semantic failure, as distinct from a dispatch-level throw (already handled by
 *  realDispatch before the result ever reaches here). */
function isOkFalseResult(value: unknown): value is { ok: false; [key: string]: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in (value as Record<string, unknown>) &&
    (value as { ok?: unknown }).ok === false
  );
}

/**
 * True when `value` is a house BULK envelope (`{ ok: true, results: [...], counts: { failed } }`
 * — the keyed-array bulk contract, `_bulk.ts`'s `runBulk`/`bulkContent`) reporting at least one
 * per-item failure. By that contract's OWN design the top-level `ok` is ALWAYS `true` ("the batch
 * ran"; `counts.failed` is where per-item truth lives), so `isOkFalseResult` alone never catches a
 * partial bulk failure (EI-18664105352441219: `plans:add-item` against a non-existent plan
 * returned `{ ok:true, results:[{ ok:false, error:'not_found' }], counts:{ ok:0, failed:1 } }`,
 * and a batched script's own mutation tally read it as a landed write — `code:run` reported
 * `mutations:{ count:1 }` for a write that never happened). Detecting this here, once, covers
 * every one of the ~64 existing bulk-contract tools (and any future one) without each having to
 * special-case its own top-level `ok`.
 */
function isBulkPartialFailure(
  value: unknown,
): value is { ok: true; results: Array<{ ok: boolean; [k: string]: unknown }>; counts: { failed: number } } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.ok !== true || !Array.isArray(v.results)) return false;
  const counts = v.counts;
  if (typeof counts !== 'object' || counts === null) return false;
  const failed = (counts as Record<string, unknown>).failed;
  return typeof failed === 'number' && failed > 0;
}

const OUTPUT_REFERENCE_SHA_RE = /^[0-9a-f]{64}$/i;
const OUTPUT_REFERENCE_AUDIENCES = new Set(['owner', 'workspace', 'public']);

/**
 * Copy only the integrity-bearing subset of a typed P-006 reference. Reject
 * credential-bearing/query URIs and malformed metadata rather than letting a
 * result-shaped object smuggle arbitrary text into a persisted execution trace.
 */
function safeOutputReference(value: unknown): OrchestrationOutputReference | null {
  if (!isPlainRecord(value) || value.kind !== 'reference') return null;
  const { uri, byteCount, sha256, expiresAt, audience } = value;
  if (
    typeof uri !== 'string' ||
    uri.length === 0 ||
    uri.length > 2_048 ||
    typeof byteCount !== 'number' ||
    !Number.isSafeInteger(byteCount) ||
    byteCount < 0 ||
    typeof sha256 !== 'string' ||
    !OUTPUT_REFERENCE_SHA_RE.test(sha256)
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== 'papercusp:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }
  if (expiresAt !== undefined && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) {
    return null;
  }
  if (audience !== undefined && (typeof audience !== 'string' || !OUTPUT_REFERENCE_AUDIENCES.has(audience))) {
    return null;
  }
  return {
    uri,
    byteCount,
    sha256: sha256.toLowerCase(),
    ...(typeof expiresAt === 'string' ? { expiresAt } : {}),
    ...(audience === 'owner' || audience === 'workspace' || audience === 'public' ? { audience } : {}),
  };
}

/** Bounded recursive scan: inner tool results are arbitrary transport values. */
function extractOutputReferences(value: unknown): OrchestrationOutputReference[] {
  const found: OrchestrationOutputReference[] = [];
  const seenObjects = new Set<object>();
  const seenRefs = new Set<string>();
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length > 0 && visited < 2_000 && found.length < 32) {
    const current = pending.pop()!;
    visited += 1;
    if (typeof current.value !== 'object' || current.value === null || current.depth > 16) continue;
    if (seenObjects.has(current.value)) continue;
    seenObjects.add(current.value);
    const reference = safeOutputReference(current.value);
    if (reference) {
      const key = `${reference.uri}\u0000${reference.sha256}`;
      if (!seenRefs.has(key)) {
        seenRefs.add(key);
        found.push(reference);
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    for (const child of Object.values(current.value as Record<string, unknown>)) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return found;
}

const STRICT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MEDIA_MIME_RE = /^(image|audio)\/[A-Za-z0-9][A-Za-z0-9.+_-]*$/;
const GENERATED_IMAGE_DATA_URL_RE = /^data:(image\/[A-Za-z0-9][A-Za-z0-9.+_-]*);base64,(.+)$/;

interface ParsedFinalResult {
  summary: unknown;
  media?: CodeRunMediaContent[];
  error?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validateMediaItem(value: unknown, index: number): CodeRunMediaContent | string {
  if (!isPlainRecord(value)) return `media[${index}] must be an object`;
  const type = value.type;
  if (type !== 'image' && type !== 'audio') {
    return `media[${index}].type must be "image" or "audio"`;
  }
  if (typeof value.data !== 'string' || value.data.length === 0 || !STRICT_BASE64_RE.test(value.data)) {
    return `media[${index}].data must be non-empty canonical base64`;
  }
  if (typeof value.mimeType !== 'string' || !MEDIA_MIME_RE.test(value.mimeType)) {
    return `media[${index}].mimeType must be a concrete image/* or audio/* MIME type`;
  }
  if (!value.mimeType.startsWith(`${type}/`)) {
    return `media[${index}].mimeType must match its ${type} content type`;
  }
  // Copy only the validated MCP fields: arbitrary sibling properties from script data must not
  // hitch a ride around the authored summary/result-door contract.
  return { type, data: value.data, mimeType: value.mimeType };
}

function validateGeneratedImages(
  values: readonly unknown[] | undefined,
): { media: CodeRunMediaContent[]; error?: string } {
  const media: CodeRunMediaContent[] = [];
  for (let index = 0; index < (values?.length ?? 0); index += 1) {
    const value = values![index];
    if (!isPlainRecord(value)) {
      return { media: [], error: `invalid_generated_image: generatedImages[${index}] must be an object` };
    }
    if (typeof value.image_url !== 'string') {
      return { media: [], error: `invalid_generated_image: generatedImages[${index}].image_url must be a data URL` };
    }
    const match = GENERATED_IMAGE_DATA_URL_RE.exec(value.image_url);
    if (!match || !STRICT_BASE64_RE.test(match[2]!)) {
      return {
        media: [],
        error: `invalid_generated_image: generatedImages[${index}].image_url must be a canonical base64 image data URL`,
      };
    }
    if (
      value.output_hint !== undefined &&
      (typeof value.output_hint !== 'string' || value.output_hint.length > 2_000)
    ) {
      return {
        media: [],
        error: `invalid_generated_image: generatedImages[${index}].output_hint must be a string of at most 2000 characters`,
      };
    }
    media.push({
      type: 'image',
      data: match[2]!,
      mimeType: match[1]!,
      ...(value.output_hint === undefined ? {} : { _meta: { output_hint: value.output_hint } }),
    });
  }
  return { media };
}

/**
 * Interpret the opt-in final media contract without changing legacy summaries. An ordinary
 * returned object — including `{ summary: ... }` — remains byte-for-byte the script summary;
 * only the presence of `media` activates the envelope and therefore requires `summary` too.
 */
function parseFinalResult(value: unknown): ParsedFinalResult {
  if (!isPlainRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'media')) {
    return { summary: value };
  }
  const summary = value.summary;
  if (!Object.prototype.hasOwnProperty.call(value, 'summary')) {
    return {
      summary: undefined,
      error: 'invalid_media_result: an explicit media result must include a summary field',
    };
  }
  if (!Array.isArray(value.media)) {
    return { summary, error: 'invalid_media_result: media must be an array' };
  }
  const media: CodeRunMediaContent[] = [];
  for (let index = 0; index < value.media.length; index += 1) {
    const item = validateMediaItem(value.media[index], index);
    if (typeof item === 'string') {
      return { summary, error: `invalid_media_result: ${item}` };
    }
    media.push(item);
  }
  return { summary, media };
}

export async function runToolOrchestration(
  script: string,
  opts: OrchestrateOptions,
): Promise<OrchestrateResult> {
  const { ctx, deps, tools, allowed, dryRun = false, timeoutMs, wrapDispatch } = opts;
  // The worker timeout in runOrchestrationScript kills only the script worker. Host-side tool
  // handlers can still be awaiting their own work after that point, so give every inner dispatch
  // a signal owned by this orchestration and abort it when the worker deadline fires. Without
  // this boundary a long foreground capability:bash keeps running after code:run returned with
  // no bash_id/resumable handle, and a retry can duplicate the command (EI-20282336542235171).
  const orchestrationAbort = new AbortController();
  const abortFromParent = (): void => {
    if (!orchestrationAbort.signal.aborted) orchestrationAbort.abort();
  };
  // `signal` is DECLARED required on UnifiedToolContext, but callers into the stack routinely omit
  // it — which is why the sibling boundary in dispatch-stack.ts guards it the same way rather than
  // trusting the type. Reading it unguarded here threw a TypeError before any work ran (WI-38330).
  if (ctx.signal?.aborted) abortFromParent();
  else ctx.signal?.addEventListener('abort', abortFromParent, { once: true });
  const dispatchCtx: UnifiedToolContext = { ...ctx, signal: orchestrationAbort.signal };
  const plannedMutations: PlannedMutation[] = [];
  const writeAttempts: WriteAttempt[] = [];
  const okFalseMutations: FailedMutation[] = [];
  const childFailures: ChildFailure[] = [];
  // EI-10951: a write that THREW never landed (rejected) or may have (uncertain) — but it
  // certainly was not "already executed", which is what we used to tell the caller.
  const rejectedMutations: ThrownMutation[] = [];
  const uncertainMutations: ThrownMutation[] = [];
  const callRecords: OrchestrationCallRecord[] = [];
  const dispatchedToolNames: string[] = [];
  let authorizationObservationCount = 0;
  let authorityWideningDetected = false;
  let dispatchCount = 0;
  let intermediateBytes = 0;

  await ensureParseCheckReady(); // lazy-load the TS compiler before the static parse-check (kept out of the eager client bundle)
  const check = checkScript(script, tools, allowed);
  // F8 (autonomous-loop-hardening / H2): an unknown tool ref no longer NUKES the whole run before
  // it starts (which forced a full re-run of the good calls too). We still surface `unknownRefs`
  // (→ advisory facadeHelp so the agent fixes the name), but we RUN the script — binding each
  // unknown ref to a stub that REJECTS only when CALLED. So the good calls execute and the author
  // can isolate the bad one (Promise.allSettled / try-catch) instead of re-running the whole batch,
  // and a bad ref in an unreached branch is a no-op. The `allowed` whitelist is still the security
  // boundary — a stub grants NO reach; it only turns a cryptic "cannot read undefined" into a clear
  // per-call error.
  const unknownRefs = check.ok ? undefined : check.unknownRefs;

  const dispatch: FacadeDispatch = async (tool, name, args) => {
    const effect = resolveToolEffect(tool, args);
    const callRecord: OrchestrationCallRecord = {
      ordinal: callRecords.length,
      tool: name,
      effect,
      disposition: 'in_flight',
      outputReferences: [],
    };
    callRecords.push(callRecord);
    let writeAttempt: WriteAttempt | undefined;
    if (effect === 'write') {
      plannedMutations.push({ tool: name, args });
      if (dryRun) {
        callRecord.disposition = 'planned';
        return { dryRun: true, wouldCall: name, args };
      }
      writeAttempt = {
        index: writeAttempts.length,
        tool: name,
        disposition: 'in_flight',
      };
      writeAttempts.push(writeAttempt);
    }
    dispatchedToolNames.push(name);
    // Counted at the same point the host's dispatcher is entered (a throw below still
    // reached it), so this equals the number of inner telemetry rows the run produced —
    // what lets a wrapper tool (code:run / recipes:run) mark its own row as a dispatch
    // wrapper only when inner rows actually exist (census double-count, P-012).
    dispatchCount += 1;
    const call: DispatchNext = (callCtx) => {
      // Observe the exact context that enters the real dispatcher, after any
      // per-call workspace/principal rebinding. This is the runtime-owned
      // authorization entry; the script cannot forge or suppress it.
      authorizationObservationCount += 1;
      authorityWideningDetected ||= authorityWidened(ctx, callCtx);
      return realDispatch(callCtx, deps)(tool, name, args);
    };
    try {
      const result = await (wrapDispatch
        ? wrapDispatch(tool, name, args, dispatchCtx, call)
        : call(dispatchCtx));
      // P-008: measure the exact serialized payload the script receives. Tool
      // results are JSON transport values; keep telemetry fail-soft if a custom
      // in-process fixture returns a non-serializable object.
      try {
        const serialized = JSON.stringify(result);
        if (serialized !== undefined) {
          intermediateBytes += new TextEncoder().encode(serialized).byteLength;
        }
      } catch {
        // Telemetry must never turn a settled child call into a failed run.
      }
      callRecord.outputReferences = extractOutputReferences(result);
      // EI-7669: realDispatch only throws on a dispatch-level failure — a tool that dispatched fine
      // but reports its OWN semantic rejection (ok: false in its result body, e.g. a completion-
      // integrity check) resolves normally here. Tally those so a batched script that doesn't check
      // every result still gets visibility instead of silently counting the write as executed.
      if (isOkFalseResult(result) || isBulkPartialFailure(result)) {
        callRecord.disposition = 'semantic_rejected';
        childFailures.push({ tool: name, kind: 'semantic', result });
        if (effect === 'write') {
          if (writeAttempt) writeAttempt.disposition = 'semantic_rejected';
          okFalseMutations.push({ tool: name, args, result });
        }
      } else if (writeAttempt) {
        writeAttempt.disposition = 'settled';
        callRecord.disposition = 'settled';
      } else {
        callRecord.disposition = 'settled';
      }
      return result;
    } catch (err) {
      // EI-10951: a write-effect call that THREW was still being counted as "already
      // executed", so a typo'd argument produced a scary — and false — "N writes already
      // landed, do NOT re-run" warning. Record WHY it threw: a pre-execution rejection
      // (bad args, a denied gate) provably wrote nothing and is safe to re-run, while any
      // other throw stays UNKNOWN and keeps the loud warning it deserves.
      const preExecution = isPreExecutionFailure(err);
      callRecord.disposition = preExecution ? 'rejected' : 'uncertain';
      childFailures.push({
        tool: name,
        kind: preExecution ? 'rejected' : 'uncertain',
        error: err instanceof Error ? err.message : String(err),
      });
      if (effect === 'write') {
        if (writeAttempt) writeAttempt.disposition = preExecution ? 'rejected' : 'uncertain';
        (preExecution ? rejectedMutations : uncertainMutations).push({
          tool: name,
          args,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  };

  const facade = buildToolFacade(tools, dispatch, allowed, unknownRefs);
  const run = await runOrchestrationScript(script, facade, {
    ...(timeoutMs ? { timeoutMs } : {}),
    onTimeout: abortFromParent,
    ...(opts.inputs ? { inputs: opts.inputs } : {}),
    ...(ctx.emit ? { emit: (name, data) => ctx.emit(name, data) } : {}),
  });
  ctx.signal?.removeEventListener('abort', abortFromParent);
  // P-020: only meaningful when the script ABORTED — a run that completed reached every line
  // it was going to, so an undispatched write there was a branch not taken, not a stranding.
  const strandedWrites = run.ok
    ? []
    : detectStrandedWrites(check.calls, tools, dispatchedToolNames);
  const notDispatchedWrites: NotDispatchedWrite[] = strandedWrites.map((tool) => ({
    tool,
    executed: false,
  }));
  const finalResult = run.ok ? parseFinalResult(run.result) : { summary: run.result };
  const generated = validateGeneratedImages(run.generatedImages);
  const media = [...(finalResult.media ?? []), ...generated.media];
  const effectiveOk = run.ok && !finalResult.error && !generated.error;
  return {
    ok: effectiveOk,
    summary: finalResult.summary,
    ...(media.length ? { media } : {}),
    ...(run.state ? { state: run.state } : {}),
    logs: run.logs,
    error: finalResult.error ?? generated.error ?? run.error,
    ...(unknownRefs && unknownRefs.length ? { unknownRefs } : {}),
    dryRun,
    dispatchCount,
    intermediateBytes,
    runtimeObservations: {
      authorizationObservationCount,
      authorityWideningDetected,
      midTurnPromptInjectionObservability: 'not-observable',
    },
    plannedMutations,
    ...(!dryRun && writeAttempts.length
      ? { writeAttempts: writeAttempts.map((attempt) => ({ ...attempt })) }
      : {}),
    okFalseMutations,
    childFailures,
    ...(rejectedMutations.length ? { rejectedMutations } : {}),
    ...(uncertainMutations.length ? { uncertainMutations } : {}),
    ...(strandedWrites.length ? { strandedWrites } : {}),
    ...(notDispatchedWrites.length ? { notDispatchedWrites } : {}),
    ...(run.fieldMisses?.length ? { fieldMisses: run.fieldMisses } : {}),
    ...(run.sleepCaps?.length ? { sleepCaps: run.sleepCaps } : {}),
    callRecords: callRecords.map((record) => ({
      ...record,
      outputReferences: record.outputReferences.map((reference) => ({ ...reference })),
    })),
    // EI-7784: surfaced independent of `ok` — see the field doc above.
    partial: effectiveOk && childFailures.length > 0,
  };
}
