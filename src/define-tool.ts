/**
 * defineTool — the simplification engine.
 *
 * Tools are declared via `defineTool({ capability, args, handler })` and
 * placed in `src/tools/<group>/<verb>.ts`. The helper:
 *   - Derives the tool name from the file path: `tools/tasks/list.ts` →
 *     `tasks:list`. Override via `name` if needed.
 *   - Composes the description from `guidance` (when/notWhen/chaining)
 *     when not passed explicitly — see `describeFromGuidance`.
 *   - Looks up the tier from the capability per §10.6.1.
 *   - Self-registers into the runtime catalog (`registry.ts`).
 *
 * The catalog is the result of importing `tools/**`. The MCP `tools/list`
 * response is generated from the catalog at startup. Adding a tool is
 * dropping a file; no manual list to maintain.
 */

import { type ZodTypeAny } from 'zod';
import { tierFor } from './capability-tiers';
import { toJsonSchema } from './schema-adapter';
import { standardValidate, formatIssues, issuesAreValueLevel, issueLeaves, type StandardSchemaV1 } from './standard-schema';
import { register } from './registry';
import { collectToolEmits } from './emits-registry';
import {
  PROJECTED_TOOL_REGISTRY_SOURCE,
  projectedToolRegistryRevision,
  renderProjectedToolCall,
  registerProjectedTool,
  recordToolShapers,
  type ProjectedToolCorrectiveCall,
  type ToolFn,
  type ToolExposure,
  type UnifiedToolContext,
} from './tool-projection';
import {
  UnauthorizedToolError,
  InvalidInputError,
  type InvalidInputCorrection,
  type InvalidInputMetadata,
} from './dispatch-projected';
import { serverVintageHint, constraintVintageHint } from './server-vintage';
import { serializeToolResponse, formatOptsFromCtx } from './serialize-result';
import { applyPayloadTier, extractPayloadTier, resolvePayloadTier } from './payload-tier';
import { boundWorkspaceTx } from './workspace-tx';
import {
  parseDeltaRequest,
  computeViewFingerprint,
  contentRevision,
  negotiateDelta,
  decodeDeltaCursor,
  computeRowDigest,
  computeViewChecksum,
  diffFromDigest,
  deltaCounts,
  isSemanticDeltaEnabled,
  DELTA_SMALL_RESPONSE_BYTES,
  computeRowDigestUncapped,
  type DeltaCapability,
  type DeltaNegotiation,
} from './delta-protocol';
import { putRowDigest, getRowDigest } from './delta-digest-store';
import {
  analyzeSchema,
  projectReadColumns,
  projectWriteColumns,
  reconstructArgs,
  isWritePositional,
  getPrePromptEntry,
  isObjectWithArrayField,
  type ColumnSpec,
  type EligibilityResult,
} from '@papercusp/result-encoding';
import type {
  RoleToolDefinition,
  RoleToolDefinitionInput,
  RouteDefinition,
  ToolContext,
  ToolDefinition,
  ToolDefinitionInput,
  ToolGuidance,
  ToolResponse,
} from './types';
import type { ToolResult } from './wire';

/**
 * The absolute path of the file that called `defineTool` — a tool's DEFINITION
 * SITE, captured from the call stack at registration time.
 *
 * Derived, never declared: a tool that had to hand-write its own source path
 * would be a second copy of a truth the module graph already owns, and it would
 * drift the first time a file moved (derived-truth-ladder rung 1). Nothing here
 * is host-specific — "where was this tool defined" is a property of any tool
 * registry, so it stays in the generic lib; what a HOST then does with the path
 * (resolve it against a repo, ask git whether it is stale) is the host's policy.
 *
 * ## Why the frame is SEARCHED rather than indexed
 *
 * The previous implementation took frame `[2]` with the comment
 * "[0]=this fn, [1]=defineTool, [2]=caller". That was off by one: this helper is
 * called from inside `definePrincipalGatedTool` / `defineRoleGatedTool`, which
 * `defineTool` delegates to, so the real caller sits at `[3]`. Frame `[2]` is
 * `defineTool` itself, whose path (`.../tooldef/src/define-tool.ts`) never
 * matches the `/tools/<group>/<verb>` convention below — so the derivation
 * silently returned `null` for every tool instead of throwing. It went unnoticed
 * because every first-party tool passes an explicit `name`.
 *
 * A hardcoded index is the wrong shape for a stack whose depth is an
 * implementation detail of this file. So: skip every frame belonging to THIS
 * file (identified from frame `[0]`, which is always this function — no
 * `import.meta.url`, which the CJS preflight seam can render differently) and
 * take the first frame outside it. Correct at any delegation depth, and it stays
 * correct when this file is refactored again.
 */
function captureDefinitionSite(): string | null {
  const ErrorAny = Error as unknown as {
    prepareStackTrace?: (err: Error, stack: unknown[]) => unknown;
  };
  const orig = ErrorAny.prepareStackTrace;
  const origLimit = Error.stackTraceLimit;
  try {
    ErrorAny.prepareStackTrace = (_err: Error, stack: unknown[]) => stack;
    // Bounded: we need the nearest few frames, not a full trace. Measured at
    // ~10.6µs per capture, ~8.7ms across a full 820-tool catalog boot.
    Error.stackTraceLimit = 12;
    const raw = new Error().stack as unknown as Array<{ getFileName?: () => string }>;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    // Frame [0] is this function, so its file IS this file.
    const selfFile = raw[0]?.getFileName?.() ?? null;
    for (const frame of raw) {
      const file = frame?.getFileName?.();
      if (!file) continue;
      if (selfFile && file === selfFile) continue;
      // Node internals ('node:internal/...') are never a definition site.
      if (file.startsWith('node:')) continue;
      return file;
    }
    return null;
  } catch {
    return null;
  } finally {
    ErrorAny.prepareStackTrace = orig;
    Error.stackTraceLimit = origLimit;
  }
}

/**
 * Derive a tool name from its definition site's path. Convention:
 *   .../tools/tasks/list.ts    → tasks:list
 *   .../tools/harness/get.ts   → harness:get
 *   .../tools/search/query.ts  → search:query
 *
 * If the file is `index.ts`, the parent directory contributes the verb;
 * useful for tools that need a directory of helpers.
 */
function deriveNameFromCallSite(site: string | null): string | null {
  if (!site) return null;
  // Find the segment after 'tools/'.
  const match = /\/tools\/([^/]+)\/([^/]+)\.[mc]?[jt]s$/.exec(site);
  if (!match) return null;
  const group = match[1];
  let verb = match[2];
  if (verb === 'index') {
    verb = 'default';
  }
  return `${group}:${verb}`;
}

/**
 * Compose a model-facing description from `guidance` for tools that omit
 * an explicit `description`. Nearly every first-party tool carries rich
 * when/notWhen/chaining guidance but no `description` — and the old
 * fallback was a useless `Tool <name>` placeholder. A model handed 200+
 * tools all described as "Tool X" cannot tell them apart: the operator
 * brain confabulated harness state rather than call tools it could not
 * distinguish (2026-05-21 P5 root cause; verified with a model-API proxy
 * — the brain received all 228 agentmcp tools but every description was
 * the placeholder). The `guidance` object stays separately available for
 * role system-prompt assembly — this only fills the `description` slot,
 * which is the only field the MCP `tools/list` wire actually carries.
 */
function describeFromGuidance(guidance: ToolGuidance | undefined): string | null {
  if (!guidance) return null;
  const parts: string[] = [];
  if (guidance.when) parts.push(`When to use: ${guidance.when}`);
  if (guidance.notWhen) parts.push(`When NOT to use: ${guidance.notWhen}`);
  if (guidance.chaining) parts.push(`Chaining: ${guidance.chaining}`);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * Compute the output-schema JSON projection + format eligibility once at
 * register time (token-efficient-tool-result-formats P-001/P-002). Returns
 * empties when the tool declared no output schema or the projection fails —
 * such tools fall back to the TOON runtime auto-encoder at serialize time.
 */
function computeOutputEligibility(
  resultSchema: StandardSchemaV1 | undefined,
): { jsonSchema?: Record<string, unknown>; eligibility?: EligibilityResult } {
  if (!resultSchema) return {};
  try {
    const js = toJsonSchema(resultSchema);
    delete (js as Record<string, unknown>).$schema;
    return { jsonSchema: js, eligibility: analyzeSchema(js) };
  } catch {
    return {};
  }
}

/**
 * Build the MCP `ToolResult` from a handler's `ToolResponse` using format-aware
 * serialization (P-005/P-006). The chosen format follows the request context
 * (explicit negotiation, else MCP→compact / others→JSON) intersected with the
 * tool's precomputed eligibility; the pagination/degraded envelope rides in
 * `_meta`. When `PAPERCUSP_VALIDATE_TOOL_OUTPUT=1` and an output schema is
 * declared, the returned `data` is validated against it and a mismatch is
 * logged (best-effort, never throws — D-003 payoff #3).
 */
/**
 * Resolve the freshness negotiation for one projected tool call (agent-tool-delta-
 * protocol-2026-06-22). Layers the Lane-E semantic upgrade on top of the Lane-B
 * view-level decision (`negotiateDelta`):
 *
 *   - no `_delta` request AND no `delta` capability → undefined (today's path).
 *   - `_delta` request, non-capable tool → full, `supported:false`.
 *   - capable tool: small-response bypass → full; else compute the view revision +
 *     (for a semantic tool) the row digest + checksum, run the Lane-B decision, and
 *     UPGRADE a `changed` outcome to `mode:'delta'` when the request wants it, the
 *     prior cursor carried a digest, the cursor is within `maxDeltaAge`, and the
 *     computed delta is actually smaller than a full resend.
 *
 * Never throws: a thrown `revision()`/`changesSince()` degrades to a full body.
 */
async function negotiateToolDelta(
  def: { name: string; delta?: DeltaCapability },
  ctx: UnifiedToolContext,
  args: unknown,
  response: ToolResponse,
): Promise<DeltaNegotiation | undefined> {
  const request = parseDeltaRequest(ctx.requestedDelta);
  if (!request && !def.delta) return undefined;
  if (!def.delta) return negotiateDelta({ request, capabilityDeclared: false });

  const cap = def.delta;
  const scope = cap.scope?.(args, ctx);
  const fingerprint = computeViewFingerprint({ toolName: def.name, args: args ?? null, scope, format: ctx.requestedFormat });
  const body = response && typeof response === 'object' ? (response as ToolResponse).data : undefined;
  const fullJsonLen = JSON.stringify(body ?? null).length;
  if (fullJsonLen < DELTA_SMALL_RESPONSE_BYTES) {
    return negotiateDelta({ request, capabilityDeclared: true, currentFingerprint: fingerprint, bypass: true });
  }

  // Semantic surface active when the tool can produce a diffable row array — via
  // the `rows` selector (e.g. flatten groups) or because the body IS the array —
  // AND declared `itemKey`. Otherwise it's a Lane-B (full | not_modified) tool.
  const rows = cap.rows ? cap.rows(body) ?? null : Array.isArray(body) ? (body as unknown[]) : null;
  const itemKey = cap.itemKey;
  let digest: Record<string, string> | null = null;
  let checksum: string | undefined;
  if (rows && itemKey) {
    digest = computeRowDigest(rows, itemKey, cap.rowRevision);
    checksum = computeViewChecksum(rows, itemKey, cap.rowRevision);
  }

  // Revision precedence: an explicit `cap.revision` (the cheapest signal) → the
  // view checksum for a semantic tool → a content hash of the whole body. Only the
  // explicit path can throw; the derived paths are pure over the handler's output.
  let currentRevision: string;
  try {
    currentRevision = cap.revision
      ? String(await cap.revision(args, ctx))
      : checksum !== undefined
        ? checksum
        : contentRevision(body ?? null);
  } catch (err) {
    ctx.log(`[delta] ${def.name} revision() threw; serving full: ${err instanceof Error ? err.message : String(err)}`);
    return { mode: 'full', supported: true, reason: 'revision_error' };
  }

  const nowMs = Date.now();
  // P-024: a view over DELTA_MAX_DIGEST_ENTRIES used to mint no digest at all, so it
  // could never delta — `plans.list` (933 rows) re-shipped ~822 KB per warm poll. The
  // cap is about what fits in a URL cursor, not about what can be diffed, so park the
  // full digest server-side and carry only an opaque id. Bound to the view fingerprint
  // (the cursor is client-supplied; see delta-digest-store safety property 2).
  let digestId: string | undefined;
  if (rows && itemKey && digest === null) {
    digestId = putRowDigest(
      computeRowDigestUncapped(rows, itemKey, cap.rowRevision),
      fingerprint,
      rows.length,
    );
  }
  const cursorExtra = digest
    ? { dg: digest, ts: nowMs }
    : digestId
      ? { di: digestId, ts: nowMs }
      : undefined;

  const base = negotiateDelta({
    request,
    capabilityDeclared: true,
    currentRevision,
    currentFingerprint: fingerprint,
    schemaVersion: cap.schemaVersion,
    cursorExtra,
  });
  // A semantic full/not_modified response carries the view checksum so the harness
  // can verify a later merge (and store it with the base).
  if (checksum && base.mode !== 'delta') base.checksum = checksum;

  // P-024: SAY that this endpoint can never serve a row-level delta, rather than
  // answering a bare `full` that is indistinguishable from "nothing changed" and
  // leaving the caller to pay for `_delta` round-trips forever. Size is no longer a
  // reason (large views park their digest server-side above) — only a missing semantic
  // surface is permanent.
  if (!rows || !itemKey) {
    base.semanticUnavailable = { reason: 'no_semantic_surface', needs: itemKey ? 'rows' : 'itemKey' };
  }

  // Convey the itemKey FIELD NAME so an OUT-OF-PROCESS client (the MCP proxy) can merge
  // a delta generically (`row[itemKeyField]`); in-process clients read `itemKey` from the
  // registry and ignore it. Only meaningful for a semantic (itemKey-declared) tool.
  if (cap.itemKeyField && itemKey && base.supported) base.itemKeyField = cap.itemKeyField;

  // Upgrade `changed` → `delta` only when the harness wants a delta body (mode
  // `auto`; an explicit `not_modified`/`full` is honored as-is) and it's safe.
  const wantsDelta = !!request && request.mode !== 'full' && request.mode !== 'not_modified';
  if (rows && itemKey && base.mode === 'full' && base.reason === 'changed' && wantsDelta) {
    // The semantic-delta upgrade is host-gated (FLAGS.TOOL_DELTA_PROTOCOL). The
    // flag read sits HERE — after the structural narrowing — so it runs only on a
    // changed-view + delta-request call (never per-call) and degrades to the
    // unconditionally-safe Lane-B `full` (reason `flag_off`) when off, never a
    // semantic delta. dormant-safe: OFF is byte-identical to a delta-unaware host.
    if (!(await isSemanticDeltaEnabled(ctx))) {
      base.reason = 'flag_off';
      return base;
    }
    // reason 'changed' ⇒ the request cursor decoded and its fp+sv matched.
    const decoded = decodeDeltaCursor(request!.cursor);
    // The prior state is either embedded (`dg`, small views) or parked server-side
    // (`di`, large views — P-024). A `di` miss (evicted, restarted, or a fingerprint
    // mismatch) is an ordinary miss: degrade to full, never to a wrong delta.
    const priorDigest = decoded?.dg ?? (decoded?.di ? getRowDigest(decoded.di, fingerprint) : undefined);
    if (!decoded || !priorDigest) {
      // Distinguish CAUSE from SYMPTOM (P-024). `no_digest` says only "the prior cursor
      // carried none", which is also what a first delta-capable call looks like.
      // `digest_expired` is the large-view path losing its parked digest — recoverable,
      // and the very next response re-parks one, unlike the old permanent degradation.
      base.reason = decoded?.di ? 'digest_expired' : 'no_digest';
    } else if (cap.maxDeltaAge !== undefined && decoded.ts !== undefined && nowMs - decoded.ts > cap.maxDeltaAge) {
      base.reason = 'max_age';
    } else {
      try {
        const changes = cap.changesSince
          ? await cap.changesSince(args, decoded, ctx)
          : diffFromDigest(priorDigest, rows, itemKey, { rowRevision: cap.rowRevision, rowType: cap.rowType });
        // The delta must actually be smaller than a full resend, else just send full.
        if (JSON.stringify(changes).length >= fullJsonLen) {
          base.reason = 'delta_too_large';
        } else {
          return { mode: 'delta', supported: true, cursor: base.cursor, changes, checksum, counts: deltaCounts(changes) };
        }
      } catch (err) {
        ctx.log(`[delta] ${def.name} changesSince() threw; serving full: ${err instanceof Error ? err.message : String(err)}`);
        base.reason = 'changesSince_error';
      }
    }
  }
  return base;
}

async function serializeProjectedResult(
  response: ToolResponse,
  ctx: UnifiedToolContext,
  eligibility: EligibilityResult | undefined,
  def: { name: string; result?: StandardSchemaV1; delta?: DeltaCapability },
  readColumns?: ColumnSpec[],
  args?: unknown,
): Promise<ToolResult> {
  if (
    def.result &&
    process.env.PAPERCUSP_VALIDATE_TOOL_OUTPUT === '1' &&
    response &&
    typeof response === 'object' &&
    response.data !== undefined
  ) {
    try {
      const v = await standardValidate(def.result, response.data);
      if (!v.ok) {
        ctx.log(`[output-schema] ${def.name} returned data not matching its declared result schema: ${formatIssues(v.issues)}`);
      }
    } catch {
      /* validation is best-effort; never fail the call on it */
    }
  }

  // Framework freshness negotiation (agent-tool-delta-protocol-2026-06-22, P-005 +
  // P-011/P-012 semantic deltas). No-op unless the call carries a `_delta` request
  // or the endpoint declared a `delta` capability; never fails a call (a thrown
  // revision()/changesSince() degrades to full).
  const delta = await negotiateToolDelta(def, ctx, args, response);

  const serialized = serializeToolResponse(response, {
    ...formatOptsFromCtx(ctx, eligibility),
    toolName: def.name,
    readColumns,
    ...(delta ? { delta } : {}),
  });
  const result: ToolResult = { content: serialized.content as never };
  if (Object.keys(serialized._meta).length > 0) result._meta = serialized._meta;
  if (serialized.structuredContent !== undefined) result.structuredContent = serialized.structuredContent;
  return result;
}

/**
 * P-002 (definetool-token-optimization-adoption): the ~407 first-party tools that
 * hand-roll `return { content: [{ type:'text', text: JSON.stringify(x) }] }` bypass
 * the compact encoder — a raw `ToolResult` passes through untouched. When such a
 * result is, ON THE AGENT-FACING MCP TRANSPORT, a single text item that parses as
 * JSON whose shape TOON actually shrinks (an array, or an object with an array
 * field), this returns the parsed payload so the caller can re-route it through the
 * SAME serializer a `{ data }` handler uses — zero per-tool churn, lossless JSON
 * fallback. Otherwise returns `undefined` ⇒ the raw result is passed through verbatim.
 *
 * Deliberately narrow so it can NEVER change what a NON-agent consumer sees:
 *   - ONLY `ctx.transport === 'mcp'`. Every other transport — in-process compounds
 *     (`inProcessCall`'s `unwrap` → `JSON.parse`), HTTP, IPC, the desktop UI / TUI
 *     Memory tab — keeps the EXACT raw bytes, preserving the memory:* verbatim-content
 *     contract (memory-taxonomy-and-debt-followups P-006; those consumers read over a
 *     non-mcp transport, and an MCP agent reads the body as text, never JSON-parses it).
 *   - single text content only; skip `isError`, `structuredContent`, multi-content /
 *     uiResources, and any already-`format:`-marked compact body (never double-encode).
 *   - parse the text FIRST, then wrap `{ data: parsed }` — NOT `{ data: theWholeResult }`,
 *     which is the double-wrap that broke the past blanket attempt (define-tool L548).
 *   - only array / object-with-array-field payloads (a scalar / plain object round-trips
 *     to identical JSON — no win — so leave it untouched).
 */
function reencodableJsonPayload(out: ToolResult, ctx: UnifiedToolContext): unknown | undefined {
  if (ctx.transport !== 'mcp') return undefined;
  if (out.isError) return undefined;
  if (out.structuredContent !== undefined) return undefined;
  const content = out.content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const item = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (!item || item.type !== 'text' || typeof item.text !== 'string') return undefined;
  const text = item.text;
  // Already a compact-encoded body (a `{data}` tool, or a hand-marked payload).
  if (/^format: (?:toon|csv|tsv|md)\n/.test(text)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined; // non-JSON text (a plain string / human message) — leave as-is
  }
  if (!Array.isArray(parsed) && !isObjectWithArrayField(parsed)) return undefined;
  return parsed;
}

/**
 * EI-20305133624359928: an object-rooted `result` schema is advertised to MCP
 * clients as `outputSchema`. The official SDK then requires `structuredContent`
 * whenever the caller opted into it, even when a legacy handler returned an
 * already-serialized JSON `ToolResult` instead of the canonical `{ data }`
 * envelope. Passing that raw result through unchanged makes a perfectly valid
 * business-level miss fail at the transport boundary with MCP -32600.
 *
 * Preserve the handler's text bytes, `isError`, resources, and metadata; only
 * add the schema-validated structured twin the caller explicitly requested.
 * Invalid/non-JSON raw results remain untouched so we never manufacture data
 * that the advertised schema does not actually describe.
 */
async function attachRequestedStructuredContent(
  out: ToolResult,
  ctx: UnifiedToolContext,
  def: { name: string; result?: StandardSchemaV1 },
): Promise<ToolResult> {
  if (
    ctx.transport !== 'mcp' ||
    ctx.requestedStructured !== true ||
    !def.result ||
    out.structuredContent !== undefined
  ) {
    return out;
  }
  const first = out.content?.[0] as { type?: unknown; text?: unknown } | undefined;
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return out;

  let parsed: unknown;
  try {
    parsed = JSON.parse(first.text);
  } catch {
    return out;
  }
  const validated = await standardValidate(def.result, parsed);
  if (!validated.ok) {
    ctx.log(
      `[output-schema] ${def.name} returned raw JSON not matching its declared result schema: ` +
        formatIssues(validated.issues),
    );
    return out;
  }
  return { ...out, structuredContent: validated.value };
}

/**
 * P-019 (fleet-leadership-continuity-and-actuation-2026-08-01) — an
 * explicitly-`undefined` value means NOT PROVIDED, at every depth.
 *
 * `{ harness: undefined }` is idiomatic JS for "I have no value for this" — it is
 * what every spread of an optional (`{ ...(x ? { k: x } : {}) }` written the short
 * way as `{ k: x }`), every destructured passthrough, and every `obj[k] = maybe`
 * produces. But the key IS present in `Object.keys()`, so the EI-10883 closed-shape
 * gate rejects it as an unrecognized key — a hard `invalid_args` failure for a call
 * that supplied nothing at all. JSON has no `undefined`, so this is unreachable over
 * the MCP wire and hits ONLY in-process callers: `code:run` scripts (whose whole
 * point is writing ordinary JS against the catalog) and `tools:invoke`. Under
 * `code:run` it is worse than a wasted round-trip: a read's arg typo aborts the
 * WHOLE script, so already-ordered writes never execute (P-020).
 *
 * The strip is DEEP because the strictness it compensates for is deep:
 * `deepStrictifyInPlace` closes every nested object in the tree, so a top-level-only
 * strip would leave the nested case — `work_items:checkpoint { items: [{ id,
 * checkpoint, harness: undefined }] }`, exactly the row shape agents build in a loop
 * — still failing, for the same reason, one level down. That asymmetry is the bug
 * EI-18723223344390510 already had to fix once for strictness itself; fixing only
 * the level that happened to bite is what leaves it live.
 *
 * Runs FIRST, innermost of the pre-validation shim chain, so every downstream shim
 * sees a clean object: `applyHarnessArgAlias` keys off `'harness' in rec`, which
 * would otherwise rename `{ harness: undefined }` to `{ harness_slug: undefined }`
 * and fail validation just the same, one key over.
 *
 * Deliberately narrow so it can only ever REMOVE a no-op key:
 *  • object KEYS only — an `undefined` ARRAY ELEMENT is a positional value, and
 *    dropping it would silently reindex the array (a different, worse bug);
 *  • plain objects only (`Object.prototype`/null-prototype) — never a Date, Map,
 *    Buffer, or class instance, whose internals are not ours to rebuild;
 *  • returns the input BY REFERENCE when there is nothing to strip, so the common
 *    case allocates nothing and callers keep identity;
 *  • never mutates the caller's object — a rebuilt copy is returned instead, since
 *    the same args object may be retained/reused by the caller.
 */
export function stripUndefinedArgKeys(input: unknown): unknown {
  return stripUndefinedDeep(input, new Set());
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function stripUndefinedDeep(input: unknown, active: Set<object>): unknown {
  if (!input || typeof input !== 'object') return input;
  // Cycle guard: an args object built by a script can legitimately self-reference.
  if (active.has(input as object)) return input;

  if (Array.isArray(input)) {
    active.add(input as object);
    try {
      let changed = false;
      const out = input.map((el) => {
        const next = stripUndefinedDeep(el, active);
        if (next !== el) changed = true;
        return next;
      });
      return changed ? out : input;
    } finally {
      active.delete(input as object);
    }
  }

  if (!isPlainObject(input)) return input;

  active.add(input as object);
  try {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input)) {
      const value = input[key];
      if (value === undefined) {
        changed = true; // drop it: an undefined value is an absent key
        continue;
      }
      const next = stripUndefinedDeep(value, active);
      if (next !== value) changed = true;
      out[key] = next;
    }
    return changed ? out : input;
  } finally {
    active.delete(input as object);
  }
}

/**
 * Write-side positional shim (token-efficient-agent-io P-008/D-006/D-007). When
 * the tool is registry write-positional and the model sent a single `row`
 * string, reconstruct the typed args from the prompt-declared column order and
 * run the misalignment guard BEFORE Zod validation. Returns the (possibly
 * reconstructed) input unchanged when the tool isn't positional or the caller
 * sent keyed args. Throws on a guard failure so a mis-emitted row fails LOUDLY
 * rather than writing wrong-but-valid data (Zod checks shape, not alignment).
 */
function applyPositionalWriteShim(name: string, argsJsonSchema: Record<string, unknown>, input: unknown): unknown {
  if (!isWritePositional(name)) return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const row = (input as Record<string, unknown>).row;
  if (typeof row !== 'string') return input; // keyed args (or no row) — leave as-is
  const entry = getPrePromptEntry(name);
  const cols = projectWriteColumns(argsJsonSchema, {
    freeTextName: entry?.freeTextArg,
    columnOverrides: entry?.columnOverrides,
    columnNames: entry?.writeColumnNames,
    requiredColumnNames: entry?.writeRequiredColumnNames,
  });
  if (!cols) return input; // tool doesn't actually fit the bounded positional shape
  const rec = reconstructArgs(row, cols);
  if (!rec.ok) throw new Error(`invalid_positional_row: ${rec.reason}`);
  return rec.args;
}

/**
 * EI-18729688357283797 — `harness` -> `harness_slug` arg alias, applied BEFORE validation.
 *
 * The catalog's dominant harness-scoping spelling is `harness` (work_items:*, docs:*,
 * plans:*, features:*, issues:*, harness:*, coord:orient, …) and the su persona
 * explicitly teaches it as THE way to scope a per-call ("name the harness on the
 * call: harness: '<slug>'"). A minority of tools (the search:* family — search:fulltext,
 * search:semantic) instead declare `harness_slug`. Because arg validation is STRICT
 * (EI-10883), the taught reflex produces a guaranteed-failing call against those
 * tools — a wasted round-trip every time, never a silent partial. Worse, the shared
 * did-you-mean hint (COMMON_ARG_ALIASES) can suggest the WRONG fix when the tool
 * separately declares an unrelated `scope` arg that happens to share a semantic-alias
 * slot with `harness` (search:fulltext's `scope` is the search-source list, not a
 * harness — confirmed live: the hint says "Did you mean `scope` for `harness`?", which
 * is actively misleading there).
 *
 * Rather than merely teach a better error, ACCEPT the call: when the tool's declared
 * shape has `harness_slug` but not `harness`, and the caller supplied `harness` without
 * `harness_slug`, transparently rename the key before validation. A caller who
 * (unusually) supplied BOTH keeps their explicit `harness_slug` untouched — this never
 * overrides an explicit value, and it is a no-op for every tool that already declares
 * `harness` itself (the common case).
 */
export function applyHarnessArgAlias(argsJsonSchema: Record<string, unknown>, input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const rec = input as Record<string, unknown>;
  if (!('harness' in rec) || 'harness_slug' in rec) return input;
  const props = (argsJsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!props || !('harness_slug' in props) || 'harness' in props) return input;
  const { harness, ...rest } = rec;
  return { ...rest, harness_slug: harness };
}

/**
 * EI-11621 — unwrap a client `__unparsedToolInput` envelope BEFORE validation.
 *
 * Some MCP clients (Claude Code) that cannot parse the model-emitted tool
 * arguments into structured JSON send `{ __unparsedToolInput: "<raw string>" }`
 * as the tool's arguments instead of the intended object — the raw string is the
 * JSON the model actually tried to emit. This hits tools with anyOf/nullable or
 * nested-object schemas (work_items:complete, session:request-compaction, …) the
 * hardest. Left as-is, the EI-10883 closed-shape gate rejects the reserved key
 * with a confusing "unrecognized key __unparsedToolInput", making those tools
 * unusable from that client without the code_run workaround (the reported bug).
 *
 * This transparently recovers the intended args: when the input object carries
 * `__unparsedToolInput`, JSON-parse its string value (or use it directly when the
 * client already handed us an object) and merge it UNDER any sibling keys the
 * client did parse (real sibling keys win — they are the caller's explicit
 * intent). A non-object / non-JSON payload is dropped so the real validation error
 * is about the actual args, not the framework envelope key. Never throws.
 */
export function unwrapUnparsedToolInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const rec = input as Record<string, unknown>;
  if (!('__unparsedToolInput' in rec)) return input;
  const { __unparsedToolInput: raw, ...rest } = rec;
  let recovered: unknown = raw;
  if (typeof raw === 'string') {
    try {
      recovered = JSON.parse(raw);
    } catch {
      // Not JSON — nothing to recover. Drop the reserved key so the failure is
      // reported against the real (remaining) args, not the envelope.
      return rest;
    }
  }
  if (recovered && typeof recovered === 'object' && !Array.isArray(recovered)) {
    return { ...(recovered as Record<string, unknown>), ...rest };
  }
  // Recovered a scalar / array — cannot be a tool-args object; strip the key.
  return rest;
}

/**
 * The unified endpoint primitive (Phase E6, endpoint-unification-2026-05-21).
 *
 * `defineTool` accepts THREE shapes, discriminated structurally:
 *   - **route-shaped** (`{ method, path, auth, handler }`) → returns a
 *     `RouteDefinition`. A plain Hono route; NOT in the agent catalog.
 *     The host mounts it via `registerRoute`. Authors call `defineTool`
 *     directly for routes (the former `defineRoute` alias is removed).
 *   - **role-gated tool** (`{ requirePrincipal: false, … }`) → a
 *     `RoleToolDefinition`, projected to MCP + the HTTP catch-all.
 *   - **principal-gated tool** (the default) → a `ToolDefinition`.
 *
 * One primitive, three projections — the route/tool duplication the
 * endpoint-unification plan set out to remove.
 */
export function defineTool<TArgs extends StandardSchemaV1>(
  input: RoleToolDefinitionInput<TArgs>,
): RoleToolDefinition<TArgs>;
export function defineTool<TArgs extends StandardSchemaV1>(
  input: ToolDefinitionInput<TArgs>,
): ToolDefinition<TArgs>;
// Route overload LAST: a tool-shaped call must resolve against the tool
// overloads first so its handler is contextually typed against the tool
// handler signature (a route-overload-first ordering widens the handler's
// return literals and then fails the tool overloads too). A genuine
// route-shaped call lacks `capability`/`args`/`requirePrincipal`, fails
// the two tool overloads structurally, and lands here.
// The `= undefined` default is load-bearing: a route file that declares
// no `input` schema and passes a standalone `handler` annotated
// `RouteContext<undefined>` gives TS nothing to infer `TInputSchema`
// from. Without the default it falls back to the constraint
// (`ZodTypeAny | undefined`) → `RouteContext<unknown>`, which the
// handler's `RouteContext<undefined>` param then rejects.
export function defineTool<TInputSchema extends ZodTypeAny | undefined = undefined>(
  input: RouteDefinition<TInputSchema>,
): RouteDefinition<TInputSchema>;
export function defineTool(
  input:
    | ToolDefinitionInput<StandardSchemaV1>
    | RoleToolDefinitionInput<StandardSchemaV1>
    | RouteDefinition<ZodTypeAny | undefined>,
): ToolDefinition<StandardSchemaV1> | RoleToolDefinition<StandardSchemaV1> | RouteDefinition<ZodTypeAny | undefined> {
  // Route-shaped — discriminated by `method` (tool inputs never carry it).
  if ('method' in input && 'path' in input) {
    return defineRouteShaped(input as RouteDefinition<ZodTypeAny | undefined>);
  }
  if ((input as RoleToolDefinitionInput<StandardSchemaV1>).requirePrincipal === false) {
    return defineRoleGatedTool(input as RoleToolDefinitionInput<StandardSchemaV1>);
  }
  return definePrincipalGatedTool(input as ToolDefinitionInput<StandardSchemaV1>);
}

/**
 * Route-shaped `defineTool`. Pure — returns the definition unchanged;
 * mounting happens host-side via `registerRoute`. A route declares its
 * own `auth` (incl. `kind: ['device']` if it admits paired devices) and
 * `cors` — there is no implicit folding.
 *
 * A route is deliberately NOT registered into the projection registry —
 * plumbing must not appear in the agent tool catalog.
 */
function defineRouteShaped<TInputSchema extends ZodTypeAny | undefined>(
  def: RouteDefinition<TInputSchema>,
): RouteDefinition<TInputSchema> {
  return def;
}

/**
 * Infer a tool's read/write effect (code-execution-tool-orchestration B-CX-PRE) from its
 * capability when not set explicitly: write-ish suffixes (`:write`/`:admin`/`:delete`/
 * `:manage`/`:execute`) ⇒ 'write'; everything else ⇒ 'read'. An explicit `effect` always
 * wins. Consumed by the code-execution sandbox's dry-run/confirm gate (read-only ⇒ no gate).
 */
export const WRITE_CAPABILITY_SUFFIXES = [':write', ':admin', ':delete', ':manage', ':execute'] as const;
/**
 * Known-mutating capabilities whose names don't end in a write-suffix — the
 * `capability:*` host-capability family (bash/fs-write/edit/write/git/computer/net/terminal) plus
 * dedicated control / side-effect capabilities (processes:kill, turn:interrupt,
 * ui:dispatch, tui:dispatch, operator:converse, activity:report).
 * Each is used ONLY by a mutating tool — where a read sibling exists it is a DISTINCT
 * `*:read` capability (ui:read, activity:read, operator:read) — so flipping the capability
 * is safe and self-documenting. Centralized here instead of backfilling each tool def.
 *
 * A tool can still override via an explicit `effect`; and a mutator that SHARES a `*:read`
 * capability with genuine readers (e.g. learning_packs:export, plans:export — both write
 * files under a `*:read` cap) sets `effect: 'write'` on its own def instead of polluting
 * this set (which would wrongly flip its read siblings). B-CX-EFFECT audit (2026-06-20).
 */
export const WRITE_CAPABILITIES = new Set<string>([
  'capability:bash',
  'capability:fs-write',
  'capability:edit',
  'capability:write',
  'capability:git',
  'capability:computer',
  'capability:net', // outbound HTTP (capability:fetch) — can POST/PUT/DELETE → external mutation
  'capability:terminal', // opens command/agent windows or headless agent processes
  'processes:kill',
  'processes:control', // freezes/thaws or re-budgets a live task's cgroup
  'turn:interrupt', // ends a peer agent's current turn
  'ui:dispatch', // performs a UI intent (click/navigate/submit) in a browser tab
  'tui:dispatch', // performs a control intent against a running pui workbench
  'operator:converse', // brain turn: spawns agents, records spend, mem0.add, dispatches <spawn>
  'activity:report', // inserts an agent-activity row
]);
/**
 * THE effect oracle. Exported (not merely used here) because it is the only
 * authoritative answer to "does this capability mutate?" in the tree, and callers
 * outside `defineTool` need it: a static scanner that cannot execute `defineTool`
 * — e.g. `scripts/check-no-bespoke-state-read.mjs`, whose whole bug class was
 * inferring effect from a tool's NAME while this function sat one lib away
 * (WI-6464: `processes:control` read as a state READ, so `processes:freeze` and
 * `processes:limit` were reported as undeclared state reads for hours).
 *
 * Anything re-deriving effect from naming is a second, drifting answer to a
 * question this owns. Consult it instead.
 */
export function inferCapabilityEffect(capability: string, explicit?: 'read' | 'write'): 'read' | 'write' {
  if (explicit) return explicit;
  const cap = capability.toLowerCase();
  if (WRITE_CAPABILITIES.has(cap)) return 'write';
  return WRITE_CAPABILITY_SUFFIXES.some((s) => cap.endsWith(s)) ? 'write' : 'read';
}

function definePrincipalGatedTool<TArgs extends StandardSchemaV1>(
  input: ToolDefinitionInput<TArgs>,
): ToolDefinition<TArgs> {
  const definitionSite = captureDefinitionSite();
  const name = input.name ?? deriveNameFromCallSite(definitionSite);
  if (!name) {
    throw new Error(
      'defineTool: could not derive tool name from call site. ' +
      'Pass `name` explicitly or place the file under `tools/<group>/<verb>.ts`.',
    );
  }
  const description =
    input.description ??
    describeFromGuidance(input.guidance) ??
    `Tool ${name}`;
  const tier = tierFor(input.capability);

  const def: ToolDefinition<TArgs> = {
    name,
    description,
    capability: input.capability,
    tier,
    effect: inferCapabilityEffect(input.capability, input.effect),
    effectForCall: input.effectForCall,
    idempotent: input.idempotent,
    replaces: input.replaces,
    composition: (input.replaces?.length ?? 0) > 0 ? 'composite' : 'primitive',
    // EI-10883: closed shape — an undeclared arg errors instead of being silently dropped.
    args: strictArgs(input.args),
    result: input.result ?? input.output,
    delta: input.delta,
    handler: input.handler,
    guidance: input.guidance,
    shape: input.shape,
    profile: input.profile,
    harness: input.harness,
    authorize: input.authorize,
    requireRoles: input.requireRoles,
    public: input.public,
    emits: input.emits,
    requires: input.requires,
    // P-062: cross-workspace opt-out, threaded so PRINCIPAL-gated tools (e.g.
    // memory:*) can run from an unscoped superuser session. The role-gated path
    // already threads this; the principal-gated path previously dropped it, so a
    // principal-gated cross-workspace tool failed `workspace_required`. See the field doc.
    crossWorkspace: input.crossWorkspace,
    // EI-18808330244321407: transaction retention is explicit opt-in.
    needsWorkspaceTx: input.needsWorkspaceTx,
    // Legacy no-op metadata retained for older plugin/source compatibility.
    skipWorkspaceTx: input.skipWorkspaceTx,
    // EI-19386201256023240: see ToolDefinition.skipResultDoor.
    skipResultDoor: input.skipResultDoor,
    // WI-37843: see ToolDefinition.payloadTierCeilingChars.
    payloadTierCeilingChars: input.payloadTierCeilingChars,
    // WI-37843: see ToolDefinition.ignoreSessionPayloadTier.
    ignoreSessionPayloadTier: input.ignoreSessionPayloadTier,
  };

  // EI-20803112372029993: make the declared shapers reachable from the catalog.
  // `def.shape` is otherwise closed over by the dispatch handler below and by
  // nothing else, so no guard could enumerate the tools that rebuild rows at the
  // trimmed tier. Recorded with the `returns` prose because the contract check
  // derives its field list from that promise rather than a second hand-typed list.
  recordToolShapers(name, input.shape, input.guidance?.returns);

  // ORDER IS LOAD-BEARING: project FIRST (its first act is the guarded
  // args→JSON-Schema conversion), and only then enter the catalog.
  //
  // These two lines used to be reversed, which left a real hole: `register()`
  // seated the tool in the catalog and THEN the guard threw. While the throw is
  // fatal that is invisible — the process dies either way. But any caller that
  // CATCHES a module-import error (HMR re-eval, a test harness, a plugin loader)
  // resumes with an unrepresentable-schema tool still sitting in the catalog, and
  // the next tools/list serves it straight into `toArgsJsonSchema` — the exact
  // anonymous catalog-wide crash this guard exists to prevent. Projecting first
  // means a tool that cannot be represented never becomes catalog state at all.
  //
  // The catalog stores defs with their schema type erased (handlers run on
  // post-validation values); a specific TArgs isn't assignable to the
  // unknown-output base under Standard Schema's variance, so widen explicitly.
  registerLegacyAsProjected(def, input.expose, definitionSite);
  register(def as unknown as ToolDefinition);
  // Co-located intrinsic emissions → the generic collector; the operator-core
  // desugar registers them as event-reaction rules at load (D-002).
  collectToolEmits(name, input.emits);
  return def;
}

/**
 * Role-gated first-party tool — registers into the same projection
 * registry as principal-gated tools but skips the `principal+tx`
 * requirement in the wrapper. Gating happens via the dispatcher's
 * `roles` allowlist + `rolesQuota`, exactly as for plugin tools.
 *
 * The handler receives `UnifiedToolContext` directly (workspaceId,
 * harnessSlug, role, runId, etc.) — no `Principal`, no transaction.
 * If the tool needs PG, open its own connection from the workspace-
 * resolved pool; do not assume `tx` is set.
 */
function defineRoleGatedTool<TArgs extends StandardSchemaV1>(
  input: RoleToolDefinitionInput<TArgs>,
): RoleToolDefinition<TArgs> {
  const definitionSite = captureDefinitionSite();
  const name = input.name ?? deriveNameFromCallSite(definitionSite);
  if (!name) {
    throw new Error(
      'defineTool: could not derive tool name from call site. ' +
      'Pass `name` explicitly or place the file under `tools/<group>/<verb>.ts`.',
    );
  }
  // EI-20803112372029993 — see the twin call in `definePrincipalGatedTool`.
  // Recorded per-branch rather than once in the `defineTool` dispatcher because
  // the name is only resolved here: a tool that omits `name` and lets it be
  // derived from the call site is invisible upstream, and the SU tools this
  // guard exists for (routines:list among them) all take this branch.
  recordToolShapers(name, input.shape, input.guidance?.returns);
  const description =
    input.description ??
    describeFromGuidance(input.guidance) ??
    `Tool ${name}`;
  const tier = tierFor(input.capability);

  const def: RoleToolDefinition<TArgs> = {
    name,
    description,
    capability: input.capability,
    tier,
    effect: inferCapabilityEffect(input.capability, input.effect),
    effectForCall: input.effectForCall,
    idempotent: input.idempotent,
    replaces: input.replaces,
    composition: (input.replaces?.length ?? 0) > 0 ? 'composite' : 'primitive',
    requirePrincipal: false,
    authorize: input.authorize,
    requireRoles: input.requireRoles,
    public: input.public,
    agentRoles: input.agentRoles,
    rolesQuota: input.rolesQuota,
    timeoutSec: input.timeoutSec,
    idleTimeoutSec: input.idleTimeoutSec,
    replayBufferSize: input.replayBufferSize,
    crossWorkspace: input.crossWorkspace,
    // EI-18808330244321407: see RoleToolDefinition.needsWorkspaceTx.
    needsWorkspaceTx: input.needsWorkspaceTx,
    // Legacy no-op metadata retained for older plugin/source compatibility.
    skipWorkspaceTx: input.skipWorkspaceTx,
    // EI-19386201256023240: see RoleToolDefinition.skipResultDoor.
    skipResultDoor: input.skipResultDoor,
    // WI-37843: see RoleToolDefinition.payloadTierCeilingChars.
    payloadTierCeilingChars: input.payloadTierCeilingChars,
    // WI-37843: see RoleToolDefinition.ignoreSessionPayloadTier.
    ignoreSessionPayloadTier: input.ignoreSessionPayloadTier,
    modality: input.modality,
    // EI-10883: closed shape — an undeclared arg errors instead of being silently dropped.
    args: strictArgs(input.args),
    result: input.result ?? input.output,
    delta: input.delta,
    events: input.events,
    state: input.state,
    handler: input.handler,
    guidance: input.guidance,
    shape: input.shape,
    profile: input.profile,
    harness: input.harness,
    emits: input.emits,
    requires: input.requires,
  };

  registerRoleGatedAsProjected(def, input.expose, definitionSite);
  // Co-located intrinsic emissions → the generic collector; the operator-core
  // desugar registers them as event-reaction rules at load (D-002).
  collectToolEmits(name, input.emits);
  return def;
}

/**
 * Auto-register a legacy `defineTool` entry in the projected-tool
 * registry so it appears alongside plugin-contributed tools and gets
 * HTTP exposure for free.
 *
 * Conventions:
 *   - MCP name unchanged (e.g. `tasks:list`).
 *   - HTTP path: `/api/agent-tools/<group>/<verb>` (group/verb derived
 *     from the colon in the legacy name).
 *   - Single capability from legacy `tool.capability` becomes a
 *     one-element capabilities[] array.
 *   - JSON Schema derived from Zod schema via zodToJsonSchema.
 *   - Handler wrapped so the legacy (args, ToolContext) signature
 *     adapts to the unified (args, UnifiedToolContext) shape:
 *       · ctx.principal + ctx.tx must be populated (built-in tools
 *         don't work without them; the route attaches them via bearer
 *         auth + withWorkspace).
 *       · ToolResponse.data → ToolResult.content[text(JSON)].
 *       · ToolResponse.uiResources → trailing content items.
 */
/**
 * Flatten a JSON schema for OpenAI's function-calling validator.
 *
 * OpenAI Codex (strict mode) requires:
 *   1. `type: "object"` at root.
 *   2. NO `oneOf`/`anyOf`/`allOf`/`enum`/`not` at root.
 *
 * Zod's `discriminatedUnion` (and `z.union`) produces a top-level
 * `{oneOf: [...]}` or `{anyOf: [...]}` — both rejected.
 *
 * Fix: when we see root-level oneOf/anyOf with all-object variants,
 * merge each variant's `properties` into a single object schema.
 * The discriminator field (`mode`, `op`, etc.) stays required; every
 * variant-specific field becomes optional. Handler-level validation
 * (via def.args.safeParse) re-enforces the per-variant required fields
 * at runtime, so loosening the schema for OpenAI doesn't compromise
 * input safety.
 *
 * Schemas that already have `type: "object"` and no problematic
 * top-level keys pass through unchanged.
 */
/**
 * Zod serializes `z.never()` as `{ not: {} }`. A union branch often uses that
 * schema to forbid a field (for example, `resume` on the fresh-launch branch).
 * Treat only an empty `not` schema as impossible; a constrained `not` remains a
 * meaningful validation rule and must not be discarded while flattening.
 */
function isNeverJsonSchema(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const schema = value as Record<string, unknown>;
  const negated = schema.not;
  return (
    negated !== null &&
    typeof negated === 'object' &&
    !Array.isArray(negated) &&
    Object.keys(negated as Record<string, unknown>).length === 0
  );
}

export function flattenForOpenAi(schema: Record<string, unknown>): Record<string, unknown> {
  // Already shaped right.
  const PROHIBITED_AT_ROOT = ['oneOf', 'anyOf', 'allOf', 'not'];
  const hasProhibited = PROHIBITED_AT_ROOT.some((k) => k in schema);
  if (schema.type === 'object' && !hasProhibited) return schema;

  // Pull the discriminator unions out of root.
  const variants: Array<Record<string, unknown>> = [];
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[key])) {
      for (const v of schema[key] as Array<Record<string, unknown>>) {
        if (v && typeof v === 'object') variants.push(v);
      }
    }
  }

  if (variants.length === 0) {
    // No unions — just ensure type:"object" + strip problematic keys.
    const out = { ...schema };
    for (const k of PROHIBITED_AT_ROOT) delete out[k];
    if (out.type !== 'object') out.type = 'object';
    return out;
  }

  // Merge variant properties. Each property keeps its first definition;
  // a property required by EVERY variant stays required (typically the
  // discriminator); others become optional.
  const mergedProps: Record<string, unknown> = {};
  const requiredSets: Set<string>[] = [];
  for (const v of variants) {
    const props = (v.properties as Record<string, unknown>) ?? {};
    for (const [pk, pv] of Object.entries(props)) {
      // A field can be present in every union variant but intentionally be
      // `z.never()` in one of them. Keeping that first impossible definition
      // makes the flattened OpenAI contract reject the valid variant too.
      // Preserve first-declaration-wins for real schemas, while replacing a
      // never placeholder with the first satisfiable definition we encounter.
      if (!(pk in mergedProps) || (isNeverJsonSchema(mergedProps[pk]) && !isNeverJsonSchema(pv))) {
        mergedProps[pk] = pv;
      }
    }
    const req = Array.isArray(v.required) ? new Set(v.required as string[]) : new Set<string>();
    requiredSets.push(req);
  }
  const required = [...requiredSets[0]].filter((p) =>
    requiredSets.every((s) => s.has(p)),
  );

  return {
    type: 'object',
    properties: mergedProps,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
    description: typeof schema.description === 'string' ? schema.description : undefined,
  };
}

/**
 * EI-10883 / EI-18723223344390510 — an unknown arg must be a HARD ERROR, never
 * a silent drop, AT ANY DEPTH.
 *
 * Zod object schemas STRIP unknown keys by default. So a caller who passes an
 * arg the tool does not declare (`sessions:read { order:'asc' }`) gets back
 * `ok:true` and the tool's DEFAULT behaviour — a result that is byte-identical
 * to success while doing something other than what was asked. That is the worst
 * possible failure mode: it cannot be detected by the caller, it cannot be
 * detected by the tool-efficiency telemetry (which only counts hard failures),
 * and it silently teaches the model a wrong mental model of the tool.
 *
 * Observed cost (agent-DX audit 2026-07-13, session 5c5a2f50): `order:'asc'` was
 * accepted and ignored by sessions:read; the agent concluded the tool had no head
 * read, burned two more calls, and drew a wrong conclusion about the data.
 *
 * EI-18723223344390510 — the ORIGINAL fix above only ever called `.strict()` on
 * the OUTERMOST object schema. `.strict()` does NOT cascade: a row schema
 * nested inside an array/optional/record/union field (e.g. `loop:checkpoint`'s
 * `checks: z.array(z.object({ claim, recheck, verified }))`) stayed in Zod's
 * default STRIP mode, so `{ claim, status:'verified', evidence:'Y' }` silently
 * dropped `status`/`evidence` and returned `ok:true` — the exact EI-10883 failure
 * mode, one level down, still live. Confirmed live: a verified external-state
 * check with real evidence degraded to an unverified `PREDICTED` row on the next
 * wake, with the evidence destroyed and no signal it had guessed the field names
 * wrong (`verified` reads like a boolean; `status`+`evidence` is the natural,
 * wrong guess).
 *
 * Fix: walk the WHOLE schema tree — object/array/optional/nullable/default/
 * readonly/catch/prefault/record/union/pipe (the pipe case covers
 * `z.preprocess`, which is exactly how `checks` is wired) — and `.strict()`
 * every object schema found, not just the root. The walk mutates each wrapper's
 * inner-schema slot (`def.element`/`def.innerType`/`def.shape[k]`/`def.options`/
 * `def.out`) IN PLACE before the schema is ever parsed; Zod 4 reads `_zod.def`
 * fresh at parse time rather than baking a closure over the original reference
 * at construction time, so the mutation takes effect for every subsequent call
 * (verified directly, including for `z.discriminatedUnion`'s per-variant
 * dispatch). Any `def.type` this walker doesn't recognize (tuple, intersection,
 * lazy, …) is left completely untouched — fail-open, exactly like the original
 * "no `.strict()` ⇒ pass through" behavior for unions.
 *
 * Runs HERE, once, at registration — closing the class for the whole catalog
 * rather than tool-by-tool or field-by-field. It also runs BEFORE
 * `toJsonSchema`, so the published input schema now advertises
 * `additionalProperties: false` at every level and the model can SEE the shape
 * is closed instead of discovering it by accident.
 */
function deepStrictifyInPlace(schema: unknown, active: Set<object>): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  // Stack-based (enter/exit) cycle guard, NOT a permanent "ever visited" set:
  // a sub-schema legitimately gets reused BY REFERENCE across multiple sibling
  // fields (e.g. the same row schema wrapped by both .optional() and
  // .nullable()) — that must be processed on each path it's reached from, so
  // only a schema currently on the ACTIVE recursion stack (a true cycle, e.g. a
  // self-referential z.lazy()) short-circuits; a shared reference already
  // popped off the stack by the time a sibling field reaches it recurses fine.
  if (active.has(schema as object)) return schema;
  active.add(schema as object);
  try {
    const s = schema as { strict?: () => unknown; _zod?: { def?: Record<string, unknown> } };
    const def = s._zod?.def;
    if (!def || typeof def.type !== 'string') return schema;

    switch (def.type) {
      case 'object': {
        const shape = def.shape as Record<string, unknown> | undefined;
        if (shape) {
          for (const key of Object.keys(shape)) {
            shape[key] = deepStrictifyInPlace(shape[key], active);
          }
        }
        return typeof s.strict === 'function' ? s.strict() : schema;
      }
      case 'array':
        def.element = deepStrictifyInPlace(def.element, active);
        return schema;
      case 'optional':
      case 'nullable':
      case 'default':
      case 'readonly':
      case 'catch':
      case 'prefault':
        def.innerType = deepStrictifyInPlace(def.innerType, active);
        return schema;
      case 'record':
        def.valueType = deepStrictifyInPlace(def.valueType, active);
        return schema;
      case 'union':
        // Covers z.union AND z.discriminatedUnion (same def.type in Zod 4) — each
        // variant gets strictified too, closing the same class one level further
        // than the pre-existing top-level-union pass-through did.
        def.options = (def.options as unknown[]).map((o) => deepStrictifyInPlace(o, active));
        return schema;
      case 'pipe':
        // z.preprocess(fn, target) compiles to a pipe { in: <transform>, out: <target> };
        // `out` is what actually gets validated post-transform.
        def.out = deepStrictifyInPlace(def.out, active);
        return schema;
      default:
        return schema;
    }
  } finally {
    active.delete(schema as object);
  }
}

export function strictArgs<T>(schema: T): T {
  try {
    return deepStrictifyInPlace(schema, new Set()) as unknown as T;
  } catch {
    return schema;
  }
}

/** Bounded render of a tool's full args JSON schema, appended to invalid_args errors (P-004,
 *  code-run-batch-adoption-2026-07-12). A terse per-issue message alone leaves a schema-blind
 *  caller (e.g. a tools:invoke route with no loaded schema) probing solo, call-by-call — the
 *  2026-07-11 release-fleet burst repeated the identical wrong arg shape twice in a row. With the
 *  schema in the failure, ONE failed call teaches the whole shape, so batching becomes the cheapest
 *  way to learn it. Rendered lazily on first failure (failures are rare), cached per registration. */
const ARGS_SCHEMA_HINT_MAX = 1800;

/**
 * EI-10883 — make the closed-shape rejection TEACH, not merely fail.
 *
 * Zod renders an undeclared key as `Unrecognized key(s) in object: "order"`, which
 * says what was wrong but not what to do instead. Naming the accepted keys turns
 * ONE failed call into a corrected call — the same principle as `argsSchemaHint`
 * (P-004), and the reason the strictness change is a net WIN for agents rather
 * than a new tax: the old behaviour cost a silent wrong answer, the new behaviour
 * costs one loud, self-correcting error.
 */
const COMMON_ARG_ALIASES: Readonly<Record<string, readonly string[]>> = {
  assignee: ['assign_to', 'assignTo', 'owner', 'ownerId'],
  assignto: ['assign_to', 'assignee', 'owner', 'ownerId'],
  body: ['content', 'summary', 'comment', 'text'],
  code: ['script'],
  comment: ['body', 'summary', 'text'],
  content: ['body', 'description', 'summary', 'text'],
  completionref: ['completionRef', 'completion_ref', 'completion'],
  description: ['content', 'summary', 'body', 'text'],
  foundduring: ['foundDuring', 'found_during'],
  harness: ['scope', 'harnessSlug', 'harness_slug'],
  itemid: ['item'],
  linkedfeatureid: ['linkedFeatureId', 'linked_feature_id'],
  owner: ['ownerEmail', 'ownerId', 'assignee', 'assign_to'],
  ownerid: ['ownerEmail', 'owner', 'assignee', 'assign_to'],
  planitem: ['plan_item', 'itemId', 'item'],
  rubricid: ['rubricRef'],
  rubricids: ['rubricRefs'],
  scope: ['harness'],
  script: ['code'],
  summary: ['body', 'comment', 'text', 'content'],
  // ── Additions from a MEASURED rejection burst (WI-38059 / EI-20204653748131789):
  // eight arg-shape rejections in ~35 min of one agent's ordinary work, every one
  // correct-intent/wrong-spelling. These four were each verified to fall OUTSIDE
  // `suggestArgName`'s edit-distance threshold, so no suggestion was produced and
  // the caller had to re-read a schema. e.g. compact('ttldays') vs compact('ttlsec')
  // = distance 3, threshold 2. They are the obvious natural-language names for the
  // concept, which is exactly why agents reach for them.
  category: ['kind', 'type', 'lane'],
  kind: ['category', 'type'],
  text: ['content', 'body', 'summary', 'comment'],
  ttl: ['ttlSec', 'ttl_sec', 'ttlMs', 'ttl_ms'],
  ttldays: ['ttlSec', 'ttl_sec', 'ttlMs'],
  ttlseconds: ['ttlSec', 'ttl_sec'],
  type: ['kind', 'category'],
  value: ['body', 'content', 'summary'],
  // ── EI-20246935995110683: `q` vs `query` is a CROSS-TOOL near-synonym, not a typo —
  // both spellings are live in this catalogue (`issues:list` declares `q`,
  // `search:fulltext`/`search:semantic` declare `query`), so a caller that learned one
  // reaches for it on the other and gets no suggestion at all: compact('q') -> compact('query')
  // is edit distance 4 against a threshold of 1 (max(1, min(3, floor(5/3)))), so it falls
  // outside `suggestArgName`'s distance rescue the same way the WI-38059 additions above did.
  // Both directions are listed because the confusion runs both ways; the exact-declared-match
  // precedence in `suggestArgName` means a tool that genuinely declares `q` (or `query`) still
  // wins over its own alias entry, so neither line can override a tool's real vocabulary.
  q: ['query', 'search', 'text'],
  query: ['q', 'search', 'text'],
  search: ['query', 'q'],
};

function compactArgName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/** Return the closest declared field for an unknown arg, when confidence is high. */
export function suggestArgName(unknown: string, accepted: readonly string[]): string | null {
  const compactUnknown = compactArgName(unknown);
  // An EXACT declared match outranks every alias. Latent via `unknownArgHint`
  // (which filters declared keys before asking), but `suggestArgName` is exported
  // and used directly, and without this a tool that genuinely declares `text` or
  // `value` would be told to use `content`/`body` instead — the alias map
  // confidently overriding the tool's own vocabulary. Widening the alias map in
  // WI-38059 is what made that reachable enough to matter.
  const exact = accepted.find((candidate) => compactArgName(candidate) === compactUnknown);
  if (exact) return exact;
  const semanticAliases = COMMON_ARG_ALIASES[compactUnknown] ?? [];
  const semantic = semanticAliases.find((alias) =>
    accepted.some((candidate) => compactArgName(candidate) === compactArgName(alias)),
  );
  if (semantic) {
    return accepted.find((candidate) => compactArgName(candidate) === compactArgName(semantic)) ?? semantic;
  }

  const ranked = accepted
    .map((candidate) => ({ candidate, distance: editDistance(compactUnknown, compactArgName(candidate)) }))
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));
  const best = ranked[0];
  if (!best) return null;
  const threshold = Math.max(1, Math.min(3, Math.floor(Math.max(compactUnknown.length, compactArgName(best.candidate).length) / 3)));
  return best.distance <= threshold ? best.candidate : null;
}

/**
 * Map each key declared on a NESTED object schema to its dotted path
 * (`observation.refs`), one level deep.
 *
 * WHY (WI-38059): `unknownArgHint` built its candidate list from TOP-LEVEL
 * properties only, so a key that genuinely exists — just one level down —
 * had nothing to match against and produced NO suggestion. The rejection
 * then read as "this tool has no `refs` concept" when the truth was "`refs`
 * lives inside `observation`". The caller's natural inference from that is
 * to DROP the arg, silently losing whatever it carried (attribution, in the
 * observed case), rather than to relocate it. That is strictly worse than a
 * round-trip: it fails quietly.
 *
 * One level only, and first-declaration-wins on a collision: this exists to
 * name an obvious relocation, not to search a schema tree. A deeper or
 * ambiguous match is left to the full schema hint that follows it.
 */
export function nestedArgPaths(props: Record<string, unknown> | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!props) return out;
  for (const [parent, rawChild] of Object.entries(props)) {
    const childProps = (rawChild as { properties?: Record<string, unknown> } | undefined)?.properties;
    if (!childProps) continue;
    for (const child of Object.keys(childProps)) {
      if (!out.has(child)) out.set(child, `${parent}.${child}`);
    }
  }
  return out;
}

export function invalidInputCorrections(
  issues: ReadonlyArray<{ message?: string; keys?: readonly string[] }> | undefined,
  rawSchema: unknown,
  argRedirects?: Record<string, string | ProjectedToolCorrectiveCall>,
): InvalidInputCorrection[] {
  const msgs = (issues ?? []).map((i) => i?.message ?? '').join(' ');
  if (!/nrecognized key/i.test(msgs)) return [];
  const props = (rawSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  const keys = props ? Object.keys(props) : [];
  if (keys.length === 0) return [];
  const nested = nestedArgPaths(props);
  const unknownKeys = [
    ...new Set([
      ...(issues ?? []).flatMap((issue) => issue.keys ?? []),
      ...Array.from(msgs.matchAll(/["']([^"']+)["']/g), (match) => match[1]),
    ]),
  ].filter((key) => !keys.includes(key));
  // EI-20281509195248260: an AUTHORED cross-tool redirect outranks both guesses
  // below. A key whose real home is a different TOOL matches neither the nested
  // relocation nor an edit-distance near-name, so without this the caller reads
  // only "this tool accepts ONLY: …" and concludes the capability is missing —
  // the measured failure mode (`tags` on work_items:update, filed 10+ times).
  // Redirected keys are withheld from `corrections` so the same key cannot also
  // draw a string-distance guess that contradicts the authored answer.
  return unknownKeys.flatMap((rejectedArg): InvalidInputCorrection[] => {
    const redirect = argRedirects?.[rejectedArg];
    if (typeof redirect === 'string' && redirect.length > 0) {
      return [{ rejectedArg, target: redirect, kind: 'authored-redirect' }];
    }
    if (redirect && typeof redirect === 'object') {
      const registryRevision = projectedToolRegistryRevision();
      const rendered = renderProjectedToolCall(redirect.tool, redirect.args);
      return [{
        rejectedArg,
        target: `${rendered}${redirect.note ? ` — ${redirect.note}` : ''}`,
        kind: 'authored-redirect',
        call: {
          tool: redirect.tool,
          args: redirect.args,
          source: PROJECTED_TOOL_REGISTRY_SOURCE,
          registryRevision,
        },
      }];
    }
    const nestedTarget = nested.get(rejectedArg);
    if (nestedTarget) return [{ rejectedArg, target: nestedTarget, kind: 'nested-path' }];
    const nearName = suggestArgName(rejectedArg, keys);
    return nearName ? [{ rejectedArg, target: nearName, kind: 'near-name' }] : [];
  });
}

// Exported for direct unit test alongside its sibling correction sources
// (`nestedArgPaths`, `suggestArgName`) — see strict-args.test.ts.
export function unknownArgHint(
  issues: ReadonlyArray<{ message?: string; keys?: readonly string[] }> | undefined,
  rawSchema: unknown,
  argRedirects?: Record<string, string | ProjectedToolCorrectiveCall>,
): string {
  const msgs = (issues ?? []).map((i) => i?.message ?? '').join(' ');
  if (!/nrecognized key/i.test(msgs)) return '';
  const props = (rawSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  const keys = props ? Object.keys(props) : [];
  if (keys.length === 0) return '';
  const corrections = invalidInputCorrections(issues, rawSchema, argRedirects);
  const redirected = corrections.filter((correction) => correction.kind === 'authored-redirect');
  const redirectText = redirected
    .map(({ rejectedArg, target }) => ` \`${rejectedArg}\` is not an arg of this tool — it is written by ${target}.`)
    .join('');
  const localCorrections = corrections.filter((correction) => correction.kind !== 'authored-redirect');
  const correctionText = localCorrections.length > 0
    ? ` Did you mean ${localCorrections.map(({ rejectedArg, target }) => `\`${target}\` for \`${rejectedArg}\``).join('; ')}?`
    : '';
  return (
    ` — this tool accepts ONLY: ${keys.join(', ')}.${redirectText}${correctionText}` +
    ' An undeclared arg is REJECTED, not silently ignored (EI-10883): passing an arg a tool does not declare used to return ok:true' +
    ' while quietly doing something else, which is indistinguishable from success. Re-send using only the keys above.' +
    // EI-19953470656367880: an unrecognized-key rejection is ALSO the exact shape a
    // caller sees when it (or the UI sending on its behalf) is newer than the server
    // it's talking to — a long-lived process (e.g. a Tauri desktop's own spawned
    // operator) has no file-watch and serves whatever code it booted with. When the
    // host has registered a vintage resolver, say so, so that reads as "restart the
    // app" instead of "I typo'd an arg".
    serverVintageHint()
  );
}

function makeInvalidInputError(
  toolName: string,
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
  input: unknown,
  rawSchema: unknown,
  argRedirects: Record<string, string | ProjectedToolCorrectiveCall> | undefined,
  schemaHintCache: { hint?: string },
): InvalidInputError {
  const metadata: InvalidInputMetadata = {
    source: PROJECTED_TOOL_REGISTRY_SOURCE,
    registryRevision: projectedToolRegistryRevision(),
    toolName,
    corrections: invalidInputCorrections(issues, rawSchema, argRedirects),
  };
  return new InvalidInputError(
    `invalid_args: ${formatIssues(issues, input)}${unknownArgHint(issues, rawSchema, argRedirects)}` +
      // EI-21353729155349111: the value-level branch appends no SCHEMA (EI-10943 — a
      // caller who knows the shape and sent a bad value learns nothing from a 1,800-char
      // dump), but "the constraint that just refused you may not exist in the tree any
      // more" is the one thing it cannot work out for itself. One conditional sentence,
      // and only when the host registered a vintage resolver.
      (issuesAreValueLevel(issues)
        ? constraintVintageHint()
        : failingFieldSchemaHint(issues, rawSchema) || argsSchemaHint(rawSchema, schemaHintCache)),
    metadata,
  );
}

/**
 * EI-20087434994864624 (+7 more filings of the same friction on 2026-08-10 alone) —
 * make a NESTED validation failure teach the shape it actually needs.
 *
 * `argsSchemaHint` below dumps the tool's WHOLE args schema, bounded at
 * ARGS_SCHEMA_HINT_MAX. For a top-level shape error that is exactly right. For a failure
 * several levels down it is simultaneously TOO LONG and TOO SHORT: long enough to crowd
 * the result budget, yet truncated thousands of characters before reaching the field that
 * actually failed. The caller then cannot learn the shape from the error at all.
 *
 * The observed dead end (coord:send, eight independent agents): a section field rejects a
 * string, then rejects an array of strings, and the appended "full args schema" cuts off
 * mid-way through an unrelated sibling's description. The only route left is to send a
 * deliberate `[{}]` so the validator enumerates the required keys — a probe purely to
 * extract a schema the error was already trying to show. Agents who did not think of the
 * probe dropped the field and inlined the content as prose, which silently destroys the
 * structured signal the field exists to capture.
 *
 * So: when an issue points at a nested path, resolve THAT node in the JSON schema and
 * render it alone. Two details carry the value here:
 *
 *  - We render the deepest ancestor that has `properties`, not the failing leaf. For
 *    `couldNotDetermine.0.what: expected string`, the leaf's schema is `{"type":"string"}`
 *    — true and useless. The PARENT object's schema lists every accepted key, which is
 *    precisely what the `[{}]` probe was reverse-engineering.
 *  - We follow `anyOf`/`oneOf`/`allOf` branches, because the union is why the path was
 *    unreachable in the flat dump to begin with (`body` is a string OR an array of
 *    richly-described sections).
 *
 * Falls back to the full dump whenever a path cannot be resolved, so this can only add
 * precision, never remove information.
 */
const FIELD_SCHEMA_HINT_MAX = 700;
const FIELD_SCHEMA_HINT_MAX_FIELDS = 3;

function schemaUnionBranches(node: unknown): unknown[] {
  if (!node || typeof node !== 'object') return [];
  const rec = node as Record<string, unknown>;
  const out: unknown[] = [];
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branch = rec[key];
    if (Array.isArray(branch)) out.push(...branch);
  }
  return out;
}

/**
 * Build a small, valid value for a JSON-Schema node. This is intentionally a
 * teaching example, not a validator: nested validation hints must expose the
 * COMPLETE set of accepted keys before their verbose field descriptions, or a
 * result cap can cut off the only field the caller needs to discover.
 */
function compactSchemaExampleValue(node: unknown, depth = 0): unknown {
  if (!node || typeof node !== 'object' || depth > 4) return '<value>';
  const rec = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rec, 'const')) return rec.const;
  if (Array.isArray(rec.enum) && rec.enum.length > 0) return rec.enum[0];

  for (const branch of schemaUnionBranches(node)) {
    const value = compactSchemaExampleValue(branch, depth + 1);
    if (value !== '<value>') return value;
  }

  switch (rec.type) {
    case 'string':
      return '<string>';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array': {
      // An empty teaching example is not accepted by schemas with minItems.
      // Keep optional/unbounded arrays compact, but include the minimum number
      // of item examples whenever the schema requires a non-empty array.
      const minItems =
        typeof rec.minItems === 'number' && Number.isFinite(rec.minItems)
          ? Math.max(0, Math.ceil(rec.minItems))
          : 0;
      if (minItems === 0) return [];
      const itemExample = compactSchemaExampleValue(rec.items, depth + 1);
      return Array.from({ length: minItems }, () => itemExample);
    }
    case 'object':
      return hasProperties(node) ? compactAcceptedObjectExample(node, depth + 1) : {};
    default:
      return hasProperties(node) ? compactAcceptedObjectExample(node, depth + 1) : '<value>';
  }
}

/**
 * Render a complete accepted object shape without copying its descriptions.
 * The full schema remains useful for limits and prose, but it comes AFTER this
 * example so a bounded error can never hide a later optional field (notably
 * `checks[].verified`).
 */
function compactAcceptedObjectExample(node: unknown, depth = 0): unknown {
  if (!node || typeof node !== 'object' || depth > 4) return '<value>';
  const rec = node as Record<string, unknown>;
  const props = rec.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return '<value>';

  const properties = props as Record<string, unknown>;
  const example: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    example[key] = compactSchemaExampleValue(value, depth + 1);
  }
  return example;
}

function compactAcceptedObjectHint(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const rec = node as Record<string, unknown>;
  const props = rec.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return null;
  const properties = props as Record<string, unknown>;
  const keys = Object.keys(properties);
  if (keys.length === 0) return null;

  const example = compactAcceptedObjectExample(node);
  if (!example || typeof example !== 'object') return null;
  const required = Array.isArray(rec.required) ? rec.required.filter((key): key is string => typeof key === 'string') : [];
  const optional = keys.filter((key) => !required.includes(key));
  const qualifiers = [
    required.length > 0 ? `required: ${required.join(', ')}` : '',
    optional.length > 0 ? `optional: ${optional.join(', ')}` : '',
  ].filter(Boolean);
  return `${JSON.stringify(example)}${qualifiers.length > 0 ? ` (${qualifiers.join('; ')})` : ''}`;
}

function hasProperties(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const props = (node as Record<string, unknown>).properties;
  return !!props && typeof props === 'object' && Object.keys(props as object).length > 0;
}

/** Step one path segment, descending through any union branches. Returns every candidate. */
function stepSchema(nodes: readonly unknown[], seg: PropertyKey): unknown[] {
  const key = typeof seg === 'object' && seg !== null ? String((seg as { key: PropertyKey }).key) : String(seg);
  const isIndex = /^\d+$/.test(key);
  const next: unknown[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 4) return;
    const rec = node as Record<string, unknown>;
    if (isIndex) {
      const prefixItems = rec.prefixItems;
      if (Array.isArray(prefixItems) && prefixItems[Number(key)]) next.push(prefixItems[Number(key)]);
      else if (rec.items) next.push(rec.items);
    } else {
      const props = rec.properties as Record<string, unknown> | undefined;
      if (props && Object.prototype.hasOwnProperty.call(props, key)) next.push(props[key]);
      else if (rec.additionalProperties && typeof rec.additionalProperties === 'object') {
        next.push(rec.additionalProperties);
      }
    }
    for (const branch of schemaUnionBranches(node)) visit(branch, depth + 1);
  };
  for (const node of nodes) visit(node, 0);
  return next;
}

function failingFieldSchemaHint(
  issues: ReadonlyArray<StandardSchemaV1.Issue> | undefined,
  rawSchema: unknown,
): string {
  const rendered = new Map<string, string>();
  // Read LEAF paths, not `issue.path`. For a union the issue's own path stops at the
  // union node (`body`) while the real diagnosis — and the path the error message
  // prints — is several levels deeper. Reading `issue.path` here silently never fires.
  for (const { segs } of issueLeaves(issues ?? [])) {
    const path = segs as ReadonlyArray<PropertyKey>;
    // A primitive top-level arg is already adequately described by its own type
    // error, and the full dump is still the useful fallback for it. A top-level
    // OBJECT (or union branch with properties), however, can be far enough into a
    // large schema that the flat dump cuts off before the field's accepted keys —
    // exactly the coord:send `why: "..."` dead end. Render that object's shape too.
    if (path.length < 1) continue;

    // Walk the path, remembering the deepest prefix whose node actually lists properties.
    let nodes: unknown[] = [rawSchema];
    let bestNode: unknown;
    let bestLabel = '';
    const labelParts: string[] = [];
    for (const seg of path) {
      nodes = stepSchema(nodes, seg);
      if (nodes.length === 0) break;
      const segKey = typeof seg === 'object' && seg !== null ? String((seg as { key: PropertyKey }).key) : String(seg);
      labelParts.push(/^\d+$/.test(segKey) ? '[]' : segKey);
      const objectish = nodes.find((node) => hasProperties(node))
        ?? nodes.flatMap((node) => schemaUnionBranches(node)).find((node) => hasProperties(node));
      if (objectish) {
        bestNode = objectish;
        bestLabel = labelParts.join('.').replace(/\.\[\]/g, '[]');
      }
    }
    if (bestNode === undefined || rendered.has(bestLabel)) continue;

    let json = '';
    try {
      json = JSON.stringify(bestNode) ?? '';
    } catch {
      json = '';
    }
    if (json.length === 0) continue;
    if (json.length > FIELD_SCHEMA_HINT_MAX) json = `${json.slice(0, FIELD_SCHEMA_HINT_MAX)} …(truncated)`;
    // Keep a complete accepted example ahead of the verbose descriptions. A
    // nested object such as loop:checkpoint's checks[] row has a long
    // `verified` description; serializing the raw schema first can hit the
    // bounded hint before that optional field appears, leaving the caller to
    // guess the contract (EI-20232348713050420).
    const compact = compactAcceptedObjectHint(bestNode);
    rendered.set(bestLabel, compact ? `e.g. ${compact}; verbose schema: ${json}` : json);
    if (rendered.size >= FIELD_SCHEMA_HINT_MAX_FIELDS) break;
  }
  if (rendered.size === 0) return '';
  const body = [...rendered.entries()].map(([label, json]) => `\`${label}\` accepts ${json}`).join(' · ');
  return ` — the field(s) that failed, in full: ${body}`;
}

function argsSchemaHint(rawSchema: unknown, cache: { hint?: string }): string {
  if (cache.hint === undefined) {
    let json = '';
    try {
      json = JSON.stringify(rawSchema) ?? '';
    } catch {
      json = '';
    }
    if (json.length > ARGS_SCHEMA_HINT_MAX) json = `${json.slice(0, ARGS_SCHEMA_HINT_MAX)} …(truncated)`;
    cache.hint = json.length > 0 ? ` — full args schema: ${json}` : '';
  }
  return cache.hint;
}

/**
 * Convert a tool's `args` to JSON Schema — failing LOUD and, crucially, NAMED.
 *
 * A tool's args schema is its CALLABLE CONTRACT, so unlike an unrepresentable *event*
 * schema (which degrades to a placeholder, keeping the tool usable) there is nothing to
 * degrade to: an args schema that cannot be advertised is a fatal authoring error.
 *
 * But it must fail with the TOOL'S NAME. This conversion runs at REGISTRATION — i.e.
 * during module import — and the same unguarded conversion runs again in the MCP
 * tools/list handlers. So one bad schema does not break one tool: it throws mid-import
 * and takes down the WHOLE catalog, surfacing as a bare, anonymous adapter error with no
 * tool, no file, nothing to grep (observed: `Transforms cannot be represented in JSON
 * Schema`, which reads like an unrelated infra/zod break and was mis-triaged as one).
 *
 * The overwhelmingly common cause is a TRAILING `.transform()` in the args schema, whose
 * output type JSON Schema cannot express. Refinements (`.refine` / `.superRefine`) and
 * `preprocess` are all representable and fine.
 */
export function toArgsJsonSchema(toolName: string, args: StandardSchemaV1): Record<string, unknown> {
  try {
    return toJsonSchema(args);
  } catch (err) {
    throw new Error(
      `Tool "${toolName}": its \`args\` schema cannot be represented in JSON Schema — ` +
        `${(err as Error).message}. This is FATAL FOR THE WHOLE TOOL CATALOG, not just this tool: ` +
        `the conversion runs at registration and again (unguarded) when tools/list is served, so a ` +
        `single unrepresentable schema breaks tool discovery for every client. ` +
        `The usual cause is a trailing \`.transform()\` — do that normalization in the HANDLER instead ` +
        `(read the value, resolve it there), or, if a transform is genuinely required, terminate it with ` +
        `\`.pipe(<schema>)\` so the OUTPUT stays representable. Refinements are always fine.`,
    );
  }
}

function registerLegacyAsProjected<TArgs extends StandardSchemaV1>(
  def: ToolDefinition<TArgs>,
  expose?: ToolExposure,
  sourceFile?: string | null,
): void {
  // tasks:list → /api/agent-tools/tasks/list
  const httpPath = `/api/agent-tools/${def.name.replaceAll(':', '/')}`;
  // Pluggable schema→JSON-Schema (P-021); default adapter is Zod 4's
  // toJSONSchema. zod-to-json-schema@3 returned just `{ $schema }` for zod 4
  // schemas (empty input schemas) — the built-in path fixed that.
  const rawSchema = toArgsJsonSchema(def.name, def.args);
  delete (rawSchema as Record<string, unknown>).$schema;
  const inputSchema = flattenForOpenAi(rawSchema);
  const { jsonSchema: outputJsonSchema, eligibility } = computeOutputEligibility(def.result);
  const readColumns = projectReadColumns(outputJsonSchema);
  const schemaHintCache: { hint?: string } = {};

  const projectedFn: ToolFn = async (input, ctx) => {
    // The dispatch stack may expose `tx` as a fail-loud getter for tools that
    // did not declare `needsWorkspaceTx`. Never probe that property directly:
    // the descriptor-aware helper returns only a real bound transaction.
    const workspaceTx = boundWorkspaceTx(ctx);
    if (!ctx.principal || (def.needsWorkspaceTx === true && workspaceTx === undefined)) {
      // Almost always this is a workspace-SCOPING gap, not an auth failure:
      // either the principal is missing or a declared transaction consumer
      // has no concrete workspace from which the host can bind a transaction.
      // Say so — "requires authenticated request" sent authenticated callers
      // down the wrong debugging path (EI-30).
      throw new UnauthorizedToolError(
        `built-in tool "${def.name}" requires a workspace-scoped call — this session has no workspace transaction. ` +
          `Scope the session to a workspace, or pass a per-call workspace where the host/tool supports one.`,
      );
    }
    // EI-11621: recover a client `__unparsedToolInput` envelope FIRST, so the
    // per-call tier extraction + closed-shape validation see the intended args.
    // Framework-reserved per-call tier override is stripped next — BEFORE
    // validation (context-trimming-tiers D-004; not part of any tool's schema).
    const { input: tierlessInput, callTier } = extractPayloadTier(unwrapUnparsedToolInput(input));
    const legacyCtx = {
      principal: ctx.principal as unknown as ToolContext['principal'],
      // EI-18808330244321407: transaction-free tools receive no `tx` key at
      // all. A declared consumer reaches this point only with a real bound tx.
      ...(def.needsWorkspaceTx === true
        ? { tx: workspaceTx as ToolContext['tx'] }
        : {}),
      log: (level, msg, meta) => ctx.log(`[${level}] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`),
      // Thread the RESOLVED payload tier so principal-gated tools that keep a
      // hand-rolled JSON ToolResult (byte-stable contracts — memory:search)
      // can adapt their defaults off ctx.contextTier, same as the role-gated
      // wrapper below (context-trimming-tiers P-024).
      ...((callTier ?? ctx.contextTier) ? { contextTier: callTier ?? ctx.contextTier } : {}),
      // Keep the explicit-vs-ambient distinction available to raw ToolResult
      // handlers. `contextTier` alone cannot tell a caller's `full` override
      // from the default session tier.
      ...(callTier !== undefined ? { payloadTierOverride: callTier } : {}),
      // EI-10358: thread the caller's role + per-session id through — the outer
      // `ctx` (UnifiedToolContext) already carries both (populated by the MCP
      // dispatch layer from the spawn/su URL context), but this legacy shim
      // previously dropped them, leaving every principal-gated handler
      // (memory:remember, …) unable to attribute a write to a real session —
      // `ctx.principal` alone collapses every su session to the single shared
      // `system:superuser` principal.
      ...(ctx.role ? { role: ctx.role } : {}),
      ...(ctx.uiClientId ? { uiClientId: ctx.uiClientId } : {}),
      // WI-4549: thread the ctx-borne telemetry surface. A compound's
      // inProcessCall stamps `telemetrySurface` on the inner ctx so its folded
      // sub-call self-identifies (coord:orient's memory:search fold records under
      // 'orient', not generic 'search'). memory:search is PRINCIPAL-gated, so it
      // lands in THIS shim — which dropped the stamp, and its recall telemetry
      // blended back into 'search' for weeks. orient had ZERO rows in
      // memory_recall_stats while demonstrably folding recall on every call.
      //
      // ⚠ THIS ALLOWLIST IS THE BUG, AND THIS IS ITS THIRD VICTIM (contextTier,
      // then role/uiClientId per EI-10358, now telemetrySurface). The role-gated
      // wrapper below passes the WHOLE ctx (`{ ...ctx }`); only this legacy shim
      // rebuilds it field-by-field, so every ctx-borne field must be re-threaded
      // here BY HAND or it vanishes silently — no type error, no runtime error,
      // just a handler reading `undefined` and taking its fallback. If you add a
      // ctx-borne field, add it here too, and pin it with a test that drives the
      // REAL dispatch path (inProcessCall → dispatchProjectedTool → handler) —
      // a test that calls `handler(input, ctxLiteral)` directly proves only that
      // the handler READS the field, never that dispatch DELIVERS it. That gap is
      // exactly why this shipped green.
      ...(ctx.telemetrySurface ? { telemetrySurface: ctx.telemetrySurface } : {}),
    } as ToolContext & {
      contextTier?: string;
      payloadTierOverride?: string;
      telemetrySurface?: string;
    };
    const shimmed = applyHarnessArgAlias(
      rawSchema,
      applyPositionalWriteShim(def.name, rawSchema, stripUndefinedArgKeys(tierlessInput)),
    );
    const parsed = await standardValidate(def.args, shimmed);
    if (!parsed.ok) {
      throw makeInvalidInputError(
        def.name,
        parsed.issues,
        shimmed,
        rawSchema,
        def.guidance?.argRedirects,
        schemaHintCache,
      );
    }
    const response = await def.handler(parsed.value, legacyCtx);
    // A raw ToolResult (MCP content shape) normally passes through untouched —
    // parity with the role-gated wrapper below. EXCEPT: on the agent-facing MCP
    // transport, a single-text-item JSON body whose shape TOON shrinks is
    // transparently re-encoded for the token win (P-002). The narrow guards in
    // `reencodableJsonPayload` keep this off every NON-mcp transport, so the
    // memory:* family + the TUI Memory tab (which read content[0].text as the
    // handler's own JSON over a non-mcp transport) are byte-for-byte unchanged
    // — preserving the contract a past blanket re-encode broke
    // (memory-taxonomy-and-debt-followups P-006).
    if (response && typeof response === 'object' && Array.isArray((response as ToolResult).content)) {
      const reencodable = reencodableJsonPayload(response as ToolResult, ctx);
      if (reencodable !== undefined) {
        return serializeProjectedResult({ data: reencodable } as ToolResponse, ctx, eligibility, def, readColumns, parsed.value);
      }
      return attachRequestedStructuredContent(response as ToolResult, ctx, def);
    }
    // Payload-tier shaping (context-trimming-tiers D-004): shape the DATA per
    // the session/call tier before format-aware serialization. Unshaped tools
    // pass through byte-identical.
    const shaped = applyPayloadTier({
      toolName: def.name,
      shape: def.shape,
      response: response as ToolResponse,
      // WI-37843: a tool may opt OUT of routine per-session shaping, in which
      // case the session tier is discarded and an un-overridden call resolves
      // to 'full'. An explicit per-call payloadTier still wins either way.
      tier: resolvePayloadTier(callTier, ctx.contextTier, {
        ignoreSessionTier: def.ignoreSessionPayloadTier,
      }),
      // An explicit per-call payloadTier:'full' is the documented escape hatch
      // out of shaping AND the hard ceiling (WI-5078) — only the arg counts,
      // never a defaulted/session 'full'. A ctx-borne `transportCapExempt`
      // consumer (code:run's inner dispatch — the result never reaches an
      // agent's context) gets the same exemption (EI-18719561823587590).
      explicitFullRequest: callTier === 'full' || ctx.transportCapExempt === true,
      // WI-37843: a tool may raise its OWN hard ceiling (coord:orient, the
      // session-bootstrap read, whose full payload IS the value). Absent ⇒ the
      // shared PAYLOAD_TIER_HARD_CEILING_CHARS, unchanged for every other tool.
      ceilingChars: def.payloadTierCeilingChars,
      args: parsed.value,
      log: (m) => ctx.log(m),
      // EI-20720054720826414: the host's executable raw-dispatch spelling for
      // the recovery `next` — absent ⇒ the generic host-neutral wording.
      rawDispatchTemplate: ctx.rawDispatchTemplate,
    });
    return serializeProjectedResult(shaped, ctx, eligibility, def, readColumns, parsed.value);
  };

  registerProjectedTool({
    pluginName: 'agent-mcp',
    description: def.description,
    // Where this tool was defined (absolute, captured from the call stack).
    // Null when the stack was unreadable — never guessed.
    sourceFile: sourceFile ?? undefined,
    inputSchema,
    // Keep the complete branch requirements for discovery/introspection while
    // retaining the flattened schema above for strict OpenAI/MCP callers.
    discoveryInputSchema: rawSchema,
    capabilities: [def.capability as never],
    effect: def.effect,
    effectForCall: def.effectForCall as ((args: unknown) => 'read' | 'write') | undefined,
    idempotent: def.idempotent,
    replaces: def.replaces,
    composition: def.composition,
    profile: def.profile,
    harness: def.harness,
    authorize: def.authorize,
    requireRoles: def.requireRoles,
    public: def.public,
    requires: def.requires,
    // P-062 / EI-2378: thread crossWorkspace into the PROJECTED def. The `def`
    // already carries it (definePrincipalGatedTool L341), but this projection —
    // what the host dispatch + the scoped-superuser clamp read via lookupByMcpName —
    // previously dropped it, so a principal-gated crossWorkspace tool (memory:* etc.)
    // ran on a workspace-scoped tx and failed `workspace_required` from an unscoped
    // ('*') psu session. The role-gated projection already threads it; this restores
    // parity. crossWorkspace tools self-derive workspaceId (never rely on the tx's
    // RLS), so the admin-handle path is behavior-preserving for concrete callers.
    crossWorkspace: def.crossWorkspace,
    // EI-18808330244321407: host transaction retention is explicit opt-in.
    needsWorkspaceTx: def.needsWorkspaceTx,
    // Legacy no-op metadata: projected for compatibility, ignored by hosts.
    skipWorkspaceTx: def.skipWorkspaceTx,
    // EI-19386201256023240: thread skipResultDoor the same way — read by the
    // host's result-door choke point. See ProjectedTool.skipResultDoor.
    skipResultDoor: def.skipResultDoor,
    // WI-37843: thread the per-tool payload-tier ceiling the same way — read
    // where applyPayloadTier is invoked. See ProjectedTool.payloadTierCeilingChars.
    payloadTierCeilingChars: def.payloadTierCeilingChars,
    // WI-37843: and the session-tier opt-out — read where resolvePayloadTier
    // is invoked. See ProjectedTool.ignoreSessionPayloadTier.
    ignoreSessionPayloadTier: def.ignoreSessionPayloadTier,
    outputSchema: def.result,
    outputJsonSchema,
    resultEligibility: eligibility,
    delta: def.delta,
    expose: {
      mcp: { name: def.name },
      http: { path: httpPath, methods: ['POST'] },
      // IPC-eligibility (the typed endpoint_invoke / sys:http allowlist) is
      // opt-in per tool via `expose: { ipc: true }` in defineTool — read off
      // the projected registry by the host's IPC server (Phase E8).
      ...(expose?.ipc ? { ipc: true as const } : {}),
      // Slash exposure (MCP-prompts slash commands) defaults ON when absent;
      // thread the declared value so `false`/overrides survive projection.
      ...(expose?.slash !== undefined ? { slash: expose.slash } : {}),
    },
    fn: projectedFn,
    guidance: def.guidance as never,
  });
}

/**
 * Project a role-gated first-party tool into the registry. Unlike the
 * legacy wrapper, the handler is invoked WITHOUT requiring `principal`
 * or `tx` on the context — gating is the dispatcher's role + quota
 * check.
 *
 * The handler may return either a `ToolResult` (MCP shape) or a
 * `ToolResponse` envelope; this wrapper normalises to `ToolResult` so
 * both transports see the same content[] array.
 */
function registerRoleGatedAsProjected<TArgs extends StandardSchemaV1>(
  def: RoleToolDefinition<TArgs>,
  expose?: ToolExposure,
  sourceFile?: string | null,
): void {
  const httpPath = `/api/agent-tools/${def.name.replaceAll(':', '/')}`;
  const rawSchema = toArgsJsonSchema(def.name, def.args);
  delete (rawSchema as Record<string, unknown>).$schema;
  const inputSchema = flattenForOpenAi(rawSchema);
  const { jsonSchema: outputJsonSchema, eligibility } = computeOutputEligibility(def.result);
  const readColumns = projectReadColumns(outputJsonSchema);
  const schemaHintCache: { hint?: string } = {};

  const projectedFn: ToolFn = async (input, ctx) => {
    // EI-11621: recover a client `__unparsedToolInput` envelope FIRST, so the
    // per-call tier extraction + closed-shape validation see the intended args.
    // Framework-reserved per-call tier override is stripped next — BEFORE
    // validation (context-trimming-tiers D-004; not part of any tool's schema).
    const { input: tierlessInput, callTier } = extractPayloadTier(unwrapUnparsedToolInput(input));
    const shimmed = applyHarnessArgAlias(
      rawSchema,
      applyPositionalWriteShim(def.name, rawSchema, stripUndefinedArgKeys(tierlessInput)),
    );
    const parsed = await standardValidate(def.args, shimmed);
    if (!parsed.ok) {
      throw makeInvalidInputError(
        def.name,
        parsed.issues,
        shimmed,
        rawSchema,
        def.guidance?.argRedirects,
        schemaHintCache,
      );
    }
    // Thread the per-call tier override into the HANDLER's ctx too: tools that
    // must keep a hand-rolled JSON ToolResult (hook-consumed — coord:inbox /
    // coord:plan-events / coord:glance) adapt their DEFAULTS off
    // ctx.contextTier instead of declaring `shape`, and without this overlay a
    // per-call `payloadTier:"full"` would be stripped above and silently
    // ignored by that pattern (context-trimming-tiers P-022).
    const handlerCtx =
      callTier !== undefined
        ? { ...ctx, contextTier: callTier, payloadTierOverride: callTier }
        : ctx;
    const out = await def.handler(parsed.value, handlerCtx);

    // Already a ToolResult? The handler self-serialized its content — pass it
    // through untouched (format-aware serialization only applies to handlers
    // that return a ToolResponse envelope with structured `data`). EXCEPT: on
    // the MCP transport, a single-text JSON body whose shape TOON shrinks is
    // re-encoded for the token win (P-002); see `reencodableJsonPayload` — it is
    // a no-op on every non-mcp transport, so verbatim-content consumers are safe.
    if (out && typeof out === 'object' && Array.isArray((out as ToolResult).content)) {
      const reencodable = reencodableJsonPayload(out as ToolResult, handlerCtx);
      if (reencodable !== undefined) {
        return serializeProjectedResult({ data: reencodable } as ToolResponse, handlerCtx, eligibility, def, readColumns, parsed.value);
      }
      return attachRequestedStructuredContent(out as ToolResult, handlerCtx, def);
    }

    // Payload-tier shaping (context-trimming-tiers D-004): shape the DATA per
    // the session/call tier before format-aware serialization. Unshaped tools
    // pass through byte-identical.
    const shaped = applyPayloadTier({
      toolName: def.name,
      shape: def.shape,
      response: out as ToolResponse,
      // WI-37843: a tool may opt OUT of routine per-session shaping, in which
      // case the session tier is discarded and an un-overridden call resolves
      // to 'full'. An explicit per-call payloadTier still wins either way.
      tier: resolvePayloadTier(callTier, handlerCtx.contextTier, {
        ignoreSessionTier: def.ignoreSessionPayloadTier,
      }),
      // An explicit per-call payloadTier:'full' is the documented escape hatch
      // out of shaping AND the hard ceiling (WI-5078) — only the arg counts,
      // never a defaulted/session 'full'. A ctx-borne `transportCapExempt`
      // consumer (code:run's inner dispatch — the result never reaches an
      // agent's context) gets the same exemption (EI-18719561823587590).
      explicitFullRequest: callTier === 'full' || handlerCtx.transportCapExempt === true,
      // WI-37843: a tool may raise its OWN hard ceiling (coord:orient, the
      // session-bootstrap read, whose full payload IS the value). Absent ⇒ the
      // shared PAYLOAD_TIER_HARD_CEILING_CHARS, unchanged for every other tool.
      ceilingChars: def.payloadTierCeilingChars,
      args: parsed.value,
      log: (m) => handlerCtx.log(m),
      // EI-20720054720826414: the host's executable raw-dispatch spelling for
      // the recovery `next` — absent ⇒ the generic host-neutral wording.
      rawDispatchTemplate: handlerCtx.rawDispatchTemplate,
    });
    // ToolResponse envelope → format-aware MCP content[] + _meta.
    return serializeProjectedResult(shaped, handlerCtx, eligibility, def, readColumns, parsed.value);
  };

  registerProjectedTool({
    pluginName: 'agent-mcp',
    description: def.description,
    // Where this tool was defined (absolute, captured from the call stack).
    // Null when the stack was unreadable — never guessed.
    sourceFile: sourceFile ?? undefined,
    inputSchema,
    // Keep the complete branch requirements for discovery/introspection while
    // retaining the flattened schema above for strict OpenAI/MCP callers.
    discoveryInputSchema: rawSchema,
    capabilities: [def.capability as never],
    effect: def.effect,
    effectForCall: def.effectForCall as ((args: unknown) => 'read' | 'write') | undefined,
    idempotent: def.idempotent,
    replaces: def.replaces,
    composition: def.composition,
    profile: def.profile,
    harness: def.harness,
    outputSchema: def.result,
    outputJsonSchema,
    resultEligibility: eligibility,
    delta: def.delta,
    agentRoles: def.agentRoles,
    rolesQuota: def.rolesQuota,
    requirePrincipal: false,
    authorize: def.authorize,
    requireRoles: def.requireRoles,
    public: def.public,
    requires: def.requires,
    timeoutSec: def.timeoutSec,
    idleTimeoutSec: def.idleTimeoutSec,
    replayBufferSize: def.replayBufferSize,
    crossWorkspace: def.crossWorkspace,
    // EI-18808330244321407: see ProjectedTool.needsWorkspaceTx.
    needsWorkspaceTx: def.needsWorkspaceTx,
    // Legacy no-op metadata: projected for compatibility, ignored by hosts.
    skipWorkspaceTx: def.skipWorkspaceTx,
    // EI-19386201256023240: see ProjectedTool.skipResultDoor.
    skipResultDoor: def.skipResultDoor,
    // WI-37843: see ProjectedTool.payloadTierCeilingChars.
    payloadTierCeilingChars: def.payloadTierCeilingChars,
    // WI-37843: see ProjectedTool.ignoreSessionPayloadTier.
    ignoreSessionPayloadTier: def.ignoreSessionPayloadTier,
    modality: def.modality,
    events: def.events,
    state: def.state,
    expose: {
      mcp: { name: def.name },
      http: { path: httpPath, methods: ['POST'] },
      // IPC-eligibility (the typed endpoint_invoke / sys:http allowlist) is
      // opt-in per tool via `expose: { ipc: true }` in defineTool — read off
      // the projected registry by the host's IPC server (Phase E8).
      ...(expose?.ipc ? { ipc: true as const } : {}),
      // Slash exposure (MCP-prompts slash commands) defaults ON when absent;
      // thread the declared value so `false`/overrides survive projection.
      ...(expose?.slash !== undefined ? { slash: expose.slash } : {}),
    },
    fn: projectedFn,
    guidance: def.guidance as never,
  });
}
