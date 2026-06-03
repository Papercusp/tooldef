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
import { type StandardSchemaV1 } from './standard-schema';
import type { RoleToolDefinition, RoleToolDefinitionInput, RouteDefinition, ToolDefinition, ToolDefinitionInput } from './types';
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
export declare function defineTool<TArgs extends StandardSchemaV1>(input: RoleToolDefinitionInput<TArgs>): RoleToolDefinition<TArgs>;
export declare function defineTool<TArgs extends StandardSchemaV1>(input: ToolDefinitionInput<TArgs>): ToolDefinition<TArgs>;
export declare function defineTool<TInputSchema extends ZodTypeAny | undefined = undefined>(input: RouteDefinition<TInputSchema>): RouteDefinition<TInputSchema>;
