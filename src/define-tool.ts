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
import { UnauthorizedToolError } from './dispatch-projected';
import { serializeToolResponse, formatOptsFromCtx } from './serialize-result';
import { analyzeSchema, type EligibilityResult } from '@papercusp/result-encoding';
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
async function serializeProjectedResult(
  response: ToolResponse,
  ctx: UnifiedToolContext,
  eligibility: EligibilityResult | undefined,
  def: { name: string; result?: StandardSchemaV1 },
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
  const serialized = serializeToolResponse(response, formatOptsFromCtx(ctx, eligibility));
  const result: ToolResult = { content: serialized.content as never };
  if (Object.keys(serialized._meta).length > 0) result._meta = serialized._meta;
  return result;
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
    args: input.args,
    result: input.result ?? input.output,
    handler: input.handler,
    guidance: input.guidance,
    profile: input.profile,
    harness: input.harness,
    authorize: input.authorize,
    requireRoles: input.requireRoles,
    public: input.public,
    emits: input.emits,
    requires: input.requires,
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
    events: input.events,
    state: input.state,
    handler: input.handler,
    guidance: input.guidance,
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
    const legacyCtx: ToolContext = {
      principal: ctx.principal as unknown as ToolContext['principal'],
      tx: ctx.tx,
      log: (level, msg, meta) => ctx.log(`[${level}] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`),
    };
    const parsed = await standardValidate(def.args, input);
    if (!parsed.ok) {
      throw new Error(`invalid_args: ${formatIssues(parsed.issues)}`);
    }
    const response: ToolResponse = await def.handler(parsed.value, legacyCtx);
    return serializeProjectedResult(response, ctx, eligibility, def);
  };

  registerProjectedTool({
    pluginName: 'agent-mcp',
    description: def.description,
    inputSchema,
    capabilities: [def.capability as never],
    profile: def.profile,
    harness: def.harness,
    authorize: def.authorize,
    requireRoles: def.requireRoles,
    public: def.public,
    requires: def.requires,
    outputSchema: def.result,
    outputJsonSchema,
    resultEligibility: eligibility,
    expose: {
      mcp: { name: def.name },
      http: { path: httpPath, methods: ['POST'] },
      // IPC-eligibility (the typed endpoint_invoke / sys:http allowlist) is
      // opt-in per tool via `expose: { ipc: true }` in defineTool — read off
      // the projected registry by the host's IPC server (Phase E8).
      ...(expose?.ipc ? { ipc: true as const } : {}),
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

  const projectedFn: ToolFn = async (input, ctx) => {
    const parsed = await standardValidate(def.args, input);
    if (!parsed.ok) {
      throw new Error(`invalid_args: ${formatIssues(parsed.issues)}`);
    }
    const out = await def.handler(parsed.value, ctx);

    // Already a ToolResult? The handler self-serialized its content — pass it
    // through untouched (format-aware serialization only applies to handlers
    // that return a ToolResponse envelope with structured `data`).
    if (out && typeof out === 'object' && Array.isArray((out as ToolResult).content)) {
      return out as ToolResult;
    }

    // ToolResponse envelope → format-aware MCP content[] + _meta.
    return serializeProjectedResult(out as ToolResponse, ctx, eligibility, def);
  };

  registerProjectedTool({
    pluginName: 'agent-mcp',
    description: def.description,
    inputSchema,
    capabilities: [def.capability as never],
    profile: def.profile,
    harness: def.harness,
    outputSchema: def.result,
    outputJsonSchema,
    resultEligibility: eligibility,
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
    },
    fn: projectedFn,
    guidance: def.guidance as never,
  });
}
