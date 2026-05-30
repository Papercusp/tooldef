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

import { z, type ZodTypeAny } from 'zod';
import { tierFor } from './capability-tiers';
import { register } from './registry';
import { registerProjectedTool, type ToolFn } from './tool-projection';
import { UnauthorizedToolError } from './dispatch-projected';
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
export function defineTool<TArgs extends ZodTypeAny>(
  input: RoleToolDefinitionInput<TArgs>,
): RoleToolDefinition<TArgs>;
export function defineTool<TArgs extends ZodTypeAny>(
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
    | ToolDefinitionInput<ZodTypeAny>
    | RoleToolDefinitionInput<ZodTypeAny>
    | RouteDefinition<ZodTypeAny | undefined>,
): ToolDefinition<ZodTypeAny> | RoleToolDefinition<ZodTypeAny> | RouteDefinition<ZodTypeAny | undefined> {
  // Route-shaped — discriminated by `method` (tool inputs never carry it).
  if ('method' in input && 'path' in input) {
    return defineRouteShaped(input as RouteDefinition<ZodTypeAny | undefined>);
  }
  if ((input as RoleToolDefinitionInput<ZodTypeAny>).requirePrincipal === false) {
    return defineRoleGatedTool(input as RoleToolDefinitionInput<ZodTypeAny>);
  }
  return definePrincipalGatedTool(input as ToolDefinitionInput<ZodTypeAny>);
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

function definePrincipalGatedTool<TArgs extends ZodTypeAny>(
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
    handler: input.handler,
    guidance: input.guidance,
    profile: input.profile,
  };

  register(def);
  registerLegacyAsProjected(def);
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
function defineRoleGatedTool<TArgs extends ZodTypeAny>(
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
    roles: input.roles,
    rolesQuota: input.rolesQuota,
    timeoutSec: input.timeoutSec,
    idleTimeoutSec: input.idleTimeoutSec,
    replayBufferSize: input.replayBufferSize,
    modality: input.modality,
    args: input.args,
    events: input.events,
    state: input.state,
    handler: input.handler,
    guidance: input.guidance,
  };

  registerRoleGatedAsProjected(def);
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

function registerLegacyAsProjected<TArgs extends ZodTypeAny>(def: ToolDefinition<TArgs>): void {
  // tasks:list → /api/agent-tools/tasks/list
  const httpPath = `/api/agent-tools/${def.name.replaceAll(':', '/')}`;
  // Zod 4: use built-in z.toJSONSchema. zod-to-json-schema@3 returns just
  // `{ $schema }` for zod 4 schemas — produces empty input schemas.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawSchema = (z as any).toJSONSchema(def.args) as Record<string, unknown>;
  delete (rawSchema as Record<string, unknown>).$schema;
  const inputSchema = flattenForOpenAi(rawSchema);

  const projectedFn: ToolFn = async (input, ctx) => {
    if (!ctx.principal || !ctx.tx) {
      throw new UnauthorizedToolError(
        `built-in tool "${def.name}" requires authenticated request (bearer + workspace tx)`,
      );
    }
    const legacyCtx: ToolContext = {
      principal: ctx.principal as unknown as ToolContext['principal'],
      tx: ctx.tx,
      log: (level, msg, meta) => ctx.log(`[${level}] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`),
    };
    const parsed = def.args.safeParse(input);
    if (!parsed.success) {
      throw new Error(`invalid_args: ${parsed.error.message}`);
    }
    const response: ToolResponse = await def.handler(parsed.data, legacyCtx);
    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: JSON.stringify(response.data ?? response) },
    ];
    if (Array.isArray(response.uiResources)) {
      for (const ui of response.uiResources) {
        content.push(ui as unknown as Record<string, unknown>);
      }
    }
    return { content: content as never };
  };

  registerProjectedTool({
    pluginName: 'agent-mcp',
    description: def.description,
    inputSchema,
    capabilities: [def.capability as never],
    profile: def.profile,
    expose: {
      mcp: { name: def.name },
      http: { path: httpPath, methods: ['POST'] },
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
function registerRoleGatedAsProjected<TArgs extends ZodTypeAny>(
  def: RoleToolDefinition<TArgs>,
): void {
  const httpPath = `/api/agent-tools/${def.name.replaceAll(':', '/')}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawSchema = (z as any).toJSONSchema(def.args) as Record<string, unknown>;
  delete (rawSchema as Record<string, unknown>).$schema;
  const inputSchema = flattenForOpenAi(rawSchema);

  const projectedFn: ToolFn = async (input, ctx) => {
    const parsed = def.args.safeParse(input);
    if (!parsed.success) {
      throw new Error(`invalid_args: ${parsed.error.message}`);
    }
    const out = await def.handler(parsed.data, ctx);

    // Already a ToolResult? Pass through.
    if (out && typeof out === 'object' && Array.isArray((out as ToolResult).content)) {
      return out as ToolResult;
    }

    // Otherwise treat as ToolResponse envelope and adapt to MCP content[].
    const response = out as ToolResponse;
    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: JSON.stringify(response.data ?? response) },
    ];
    if (Array.isArray(response.uiResources)) {
      for (const ui of response.uiResources) {
        content.push(ui as unknown as Record<string, unknown>);
      }
    }
    return { content: content as never };
  };

  registerProjectedTool({
    pluginName: 'agent-mcp',
    description: def.description,
    inputSchema,
    capabilities: [def.capability as never],
    profile: (def as { profile?: 'engineer' | 'all' }).profile,
    roles: def.roles,
    rolesQuota: def.rolesQuota,
    timeoutSec: def.timeoutSec,
    idleTimeoutSec: def.idleTimeoutSec,
    replayBufferSize: def.replayBufferSize,
    modality: def.modality,
    events: def.events,
    state: def.state,
    expose: {
      mcp: { name: def.name },
      http: { path: httpPath, methods: ['POST'] },
    },
    fn: projectedFn,
    guidance: def.guidance as never,
  });
}
