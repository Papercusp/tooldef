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
import { standardValidate, formatIssues, type StandardSchemaV1 } from './standard-schema';
import { register } from './registry';
import { collectToolEmits } from './emits-registry';
import { registerProjectedTool, type ToolFn, type ToolExposure, type UnifiedToolContext } from './tool-projection';
import { UnauthorizedToolError, InvalidInputError } from './dispatch-projected';
import { serializeToolResponse, formatOptsFromCtx } from './serialize-result';
import { applyPayloadTier, extractPayloadTier, resolvePayloadTier } from './payload-tier';
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
  type DeltaCapability,
  type DeltaNegotiation,
} from './delta-protocol';
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
 * Walk up the call stack to find the file that called defineTool, then
 * derive a tool name from that file's path. Convention:
 *   .../tools/tasks/list.ts    → tasks:list
 *   .../tools/harness/get.ts   → harness:get
 *   .../tools/search/query.ts  → search:query
 *
 * If the file is `index.ts`, the parent directory contributes the verb;
 * useful for tools that need a directory of helpers.
 */
function deriveNameFromCallSite(): string | null {
  const ErrorAny = Error as unknown as {
    prepareStackTrace?: (err: Error, stack: unknown[]) => unknown;
  };
  const orig = ErrorAny.prepareStackTrace;
  try {
    ErrorAny.prepareStackTrace = (_err: Error, stack: unknown[]) => stack;
    const raw = new Error().stack as unknown as Array<{ getFileName?: () => string }>;
    // [0]=this fn, [1]=defineTool, [2]=caller (the tool file).
    const callerFile = raw?.[2]?.getFileName?.();
    if (!callerFile) return null;
    // Find the segment after 'tools/'.
    const match = /\/tools\/([^/]+)\/([^/]+)\.[mc]?[jt]s$/.exec(callerFile);
    if (!match) return null;
    const group = match[1];
    let verb = match[2];
    if (verb === 'index') {
      verb = 'default';
    }
    return `${group}:${verb}`;
  } catch {
    return null;
  } finally {
    ErrorAny.prepareStackTrace = orig;
  }
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
  const cursorExtra = digest ? { dg: digest, ts: nowMs } : undefined;

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
    if (!decoded?.dg) {
      base.reason = 'no_digest';
    } else if (cap.maxDeltaAge !== undefined && decoded.ts !== undefined && nowMs - decoded.ts > cap.maxDeltaAge) {
      base.reason = 'max_age';
    } else {
      try {
        const changes = cap.changesSince
          ? await cap.changesSince(args, decoded, ctx)
          : diffFromDigest(decoded.dg, rows, itemKey, { rowRevision: cap.rowRevision, rowType: cap.rowType });
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
const WRITE_CAPABILITY_SUFFIXES = [':write', ':admin', ':delete', ':manage', ':execute'] as const;
/**
 * Known-mutating capabilities whose names don't end in a write-suffix — the
 * `capability:*` host-capability family (bash/fs-write/edit/write/git/computer/net) plus
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
const WRITE_CAPABILITIES = new Set<string>([
  'capability:bash',
  'capability:fs-write',
  'capability:edit',
  'capability:write',
  'capability:git',
  'capability:computer',
  'capability:net', // outbound HTTP (capability:fetch) — can POST/PUT/DELETE → external mutation
  'processes:kill',
  'turn:interrupt', // ends a peer agent's current turn
  'ui:dispatch', // performs a UI intent (click/navigate/submit) in a browser tab
  'tui:dispatch', // performs a control intent against a running pui workbench
  'operator:converse', // brain turn: spawns agents, records spend, mem0.add, dispatches <spawn>
  'activity:report', // inserts an agent-activity row
]);
function inferEffect(capability: string, explicit?: 'read' | 'write'): 'read' | 'write' {
  if (explicit) return explicit;
  const cap = capability.toLowerCase();
  if (WRITE_CAPABILITIES.has(cap)) return 'write';
  return WRITE_CAPABILITY_SUFFIXES.some((s) => cap.endsWith(s)) ? 'write' : 'read';
}

function definePrincipalGatedTool<TArgs extends StandardSchemaV1>(
  input: ToolDefinitionInput<TArgs>,
): ToolDefinition<TArgs> {
  const name = input.name ?? deriveNameFromCallSite();
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
    effect: inferEffect(input.capability, input.effect),
    idempotent: input.idempotent,
    replaces: input.replaces,
    composition: (input.replaces?.length ?? 0) > 0 ? 'composite' : 'primitive',
    args: input.args,
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
  };

  // The catalog stores defs with their schema type erased (handlers run on
  // post-validation values); a specific TArgs isn't assignable to the
  // unknown-output base under Standard Schema's variance, so widen explicitly.
  register(def as unknown as ToolDefinition);
  registerLegacyAsProjected(def, input.expose);
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
  const name = input.name ?? deriveNameFromCallSite();
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

  const def: RoleToolDefinition<TArgs> = {
    name,
    description,
    capability: input.capability,
    tier,
    effect: inferEffect(input.capability, input.effect),
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
    modality: input.modality,
    args: input.args,
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

  registerRoleGatedAsProjected(def, input.expose);
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
function flattenForOpenAi(schema: Record<string, unknown>): Record<string, unknown> {
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
      if (!(pk in mergedProps)) mergedProps[pk] = pv;
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

function registerLegacyAsProjected<TArgs extends StandardSchemaV1>(
  def: ToolDefinition<TArgs>,
  expose?: ToolExposure,
): void {
  // tasks:list → /api/agent-tools/tasks/list
  const httpPath = `/api/agent-tools/${def.name.replaceAll(':', '/')}`;
  // Pluggable schema→JSON-Schema (P-021); default adapter is Zod 4's
  // toJSONSchema. zod-to-json-schema@3 returned just `{ $schema }` for zod 4
  // schemas (empty input schemas) — the built-in path fixed that.
  const rawSchema = toJsonSchema(def.args);
  delete (rawSchema as Record<string, unknown>).$schema;
  const inputSchema = flattenForOpenAi(rawSchema);
  const { jsonSchema: outputJsonSchema, eligibility } = computeOutputEligibility(def.result);
  const readColumns = projectReadColumns(outputJsonSchema);

  const projectedFn: ToolFn = async (input, ctx) => {
    if (!ctx.principal || !ctx.tx) {
      // Almost always this is a workspace-SCOPING gap, not an auth failure:
      // the caller is bearer-authenticated but the session carries no
      // concrete workspace, so the host synthesized no workspace
      // transaction. Say so — "requires authenticated request" sent
      // authenticated callers down the wrong debugging path (EI-30).
      throw new UnauthorizedToolError(
        `built-in tool "${def.name}" requires a workspace-scoped call — this session has no workspace transaction. ` +
          `Scope the session to a workspace, or pass a per-call workspace where the host/tool supports one.`,
      );
    }
    // Framework-reserved per-call tier override — stripped BEFORE validation
    // (context-trimming-tiers D-004; not part of any tool's schema).
    const { input: tierlessInput, callTier } = extractPayloadTier(input);
    const legacyCtx: ToolContext & { contextTier?: string } = {
      principal: ctx.principal as unknown as ToolContext['principal'],
      tx: ctx.tx,
      log: (level, msg, meta) => ctx.log(`[${level}] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`),
      // Thread the RESOLVED payload tier so principal-gated tools that keep a
      // hand-rolled JSON ToolResult (byte-stable contracts — memory:search)
      // can adapt their defaults off ctx.contextTier, same as the role-gated
      // wrapper below (context-trimming-tiers P-024).
      ...(callTier ?? ctx.contextTier ? { contextTier: callTier ?? ctx.contextTier } : {}),
    };
    const shimmed = applyPositionalWriteShim(def.name, rawSchema, tierlessInput);
    const parsed = await standardValidate(def.args, shimmed);
    if (!parsed.ok) {
      throw new InvalidInputError(`invalid_args: ${formatIssues(parsed.issues)}`);
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
      return response as ToolResult;
    }
    // Payload-tier shaping (context-trimming-tiers D-004): shape the DATA per
    // the session/call tier before format-aware serialization. Unshaped tools
    // pass through byte-identical.
    const shaped = applyPayloadTier({
      toolName: def.name,
      shape: def.shape,
      response: response as ToolResponse,
      tier: resolvePayloadTier(callTier, ctx.contextTier),
      args: parsed.value,
      log: (m) => ctx.log(m),
    });
    return serializeProjectedResult(shaped, ctx, eligibility, def, readColumns, parsed.value);
  };

  registerProjectedTool({
    pluginName: 'agent-mcp',
    description: def.description,
    inputSchema,
    capabilities: [def.capability as never],
    effect: def.effect,
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
): void {
  const httpPath = `/api/agent-tools/${def.name.replaceAll(':', '/')}`;
  const rawSchema = toJsonSchema(def.args);
  delete (rawSchema as Record<string, unknown>).$schema;
  const inputSchema = flattenForOpenAi(rawSchema);
  const { jsonSchema: outputJsonSchema, eligibility } = computeOutputEligibility(def.result);
  const readColumns = projectReadColumns(outputJsonSchema);

  const projectedFn: ToolFn = async (input, ctx) => {
    // Framework-reserved per-call tier override — stripped BEFORE validation
    // (context-trimming-tiers D-004; not part of any tool's schema).
    const { input: tierlessInput, callTier } = extractPayloadTier(input);
    const shimmed = applyPositionalWriteShim(def.name, rawSchema, tierlessInput);
    const parsed = await standardValidate(def.args, shimmed);
    if (!parsed.ok) {
      throw new InvalidInputError(`invalid_args: ${formatIssues(parsed.issues)}`);
    }
    // Thread the per-call tier override into the HANDLER's ctx too: tools that
    // must keep a hand-rolled JSON ToolResult (hook-consumed — coord:inbox /
    // coord:plan-events / coord:glance) adapt their DEFAULTS off
    // ctx.contextTier instead of declaring `shape`, and without this overlay a
    // per-call `payloadTier:"full"` would be stripped above and silently
    // ignored by that pattern (context-trimming-tiers P-022).
    const handlerCtx = callTier !== undefined ? { ...ctx, contextTier: callTier } : ctx;
    const out = await def.handler(parsed.value, handlerCtx);

    // Already a ToolResult? The handler self-serialized its content — pass it
    // through untouched (format-aware serialization only applies to handlers
    // that return a ToolResponse envelope with structured `data`). EXCEPT: on
    // the MCP transport, a single-text JSON body whose shape TOON shrinks is
    // re-encoded for the token win (P-002); see `reencodableJsonPayload` — it is
    // a no-op on every non-mcp transport, so verbatim-content consumers are safe.
    if (out && typeof out === 'object' && Array.isArray((out as ToolResult).content)) {
      const reencodable = reencodableJsonPayload(out as ToolResult, ctx);
      if (reencodable !== undefined) {
        return serializeProjectedResult({ data: reencodable } as ToolResponse, ctx, eligibility, def, readColumns, parsed.value);
      }
      return out as ToolResult;
    }

    // Payload-tier shaping (context-trimming-tiers D-004): shape the DATA per
    // the session/call tier before format-aware serialization. Unshaped tools
    // pass through byte-identical.
    const shaped = applyPayloadTier({
      toolName: def.name,
      shape: def.shape,
      response: out as ToolResponse,
      tier: resolvePayloadTier(callTier, ctx.contextTier),
      args: parsed.value,
      log: (m) => ctx.log(m),
    });
    // ToolResponse envelope → format-aware MCP content[] + _meta.
    return serializeProjectedResult(shaped, ctx, eligibility, def, readColumns, parsed.value);
  };

  registerProjectedTool({
    pluginName: 'agent-mcp',
    description: def.description,
    inputSchema,
    capabilities: [def.capability as never],
    effect: def.effect,
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
    authorize: def.authorize,
    requireRoles: def.requireRoles,
    public: def.public,
    requires: def.requires,
    timeoutSec: def.timeoutSec,
    idleTimeoutSec: def.idleTimeoutSec,
    replayBufferSize: def.replayBufferSize,
    crossWorkspace: def.crossWorkspace,
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
