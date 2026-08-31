/**
 * code-execution-tool-orchestration B-CX-API — typed signatures for the code-mode facade.
 *
 * The COMPILE-TIME companion to `tool-facade.ts` (the RUNTIME). It renders the TypeScript
 * surface the model writes against:
 *
 *     declare const tools: {
 *       workItems: {
 *         // List work-items across kinds …
 *         list(args?: { harness?: string; kind?: "feature" | "bug"; limit?: number }): Promise<unknown>;
 *       };
 *       call(toolName: string, args?: unknown): Promise<unknown>;
 *     };
 *
 * Each signature is derived from a tool's projected `inputSchema` — which is ALREADY a JSON
 * Schema object (the projection ran the schema→JSON-Schema adapter, `toJsonSchema`, at
 * `defineTool` time; see schema-adapter.ts + define-tool.ts). So this module never touches a
 * validator library: it walks JSON-Schema objects and emits strings. That keeps it dependency-
 * free and host-agnostic, exactly like the rest of `@papercusp/tooldef`.
 *
 * WHY: the model can already name tools from the normal catalog, but explicit typed signatures
 * (a) cut `code:run` script errors (it sees the real arg shapes, not a guess) and (b) enable the
 * Anthropic "on-demand tool discovery" token win — the `code:tools` lookup serves signatures for
 * only the namespaces a task needs, instead of dumping every tool def into every prompt.
 *
 * Namespace + verb naming are shared with the runtime via `camelNamespace` / `camelVerb`
 * (tool-facade.ts) so the generated `tools.<ns>.<verb>` names ALWAYS match what the runtime
 * facade actually exposes.
 *
 * Scoping mirrors the runtime: pass the agent's `allowed` set and tools outside it are omitted —
 * the model never sees a signature for a tool it cannot call.
 */
import type { ProjectedTool } from '../tool-projection';
export interface ToolArgsType {
    /** The rendered TS type for the tool's args object. */
    type: string;
    /** True when no arg is required — the call may be made with no argument. */
    optional: boolean;
}
/**
 * Render a tool's `inputSchema` (a JSON Schema object) to its TS args type + whether all
 * fields are optional (so the generated signature can mark `args?`).
 */
export declare function toolArgsType(tool: ProjectedTool, maxDepth?: number): ToolArgsType;
/**
 * EI-13298 — render the tool's RETURN shape, not just its args.
 *
 * The root cause of the bug this fixes: a `code:run` script author sees only the arg
 * signature (`Promise<unknown>` for the return) and so guesses response keys — a guess
 * that fails SILENTLY (an optional-chained `||`-fallback over a wrong key just collapses
 * to `[]`/`undefined`, never an error), which then reads as a true negative ("no data")
 * instead of the mapping bug it actually is. Two independent sources feed this, since
 * most tools declare only one of them:
 *
 *   1. `tool.outputJsonSchema` — a REAL JSON-Schema (present when the tool declared a
 *      Zod `result`, i.e. `defineTool({ result: z.object({...}) })`) — rendered to a
 *      precise TS type via the same `schemaToTs` walker `toolArgsType` uses for args.
 *   2. `tool.guidance.returns` — a free-text description of the shape (EI-10882),
 *      already authored on ~many tools for `tools:find`'s `returns` field but never
 *      surfaced anywhere a `code:run` script is actually being WRITTEN.
 *
 * When neither is declared, the return type stays `unknown` (honest — better than a
 * confident-looking but made-up shape) and no `@returns` comment is emitted.
 */
export declare function toolResultType(tool: ProjectedTool, maxDepth?: number): string;
export interface GenerateFacadeTypesOptions {
    /** The agent's capability envelope (full `ns:verb` names). Absent ⇒ all tools. */
    allowed?: ReadonlySet<string>;
    /** Render only these namespaces (on-demand discovery). Combined with `names` as a union. */
    namespaces?: readonly string[];
    /** Render only these exact tool names. Combined with `namespaces` as a union. */
    names?: readonly string[];
    /** Nesting depth cap before nested objects collapse to Record<string, unknown>. */
    maxDepth?: number;
    /** Override the `declare const tools` header (e.g. omit for an embedded snippet). */
    header?: string;
}
/**
 * Generate the `declare const tools: { … }` TypeScript surface for the code-mode facade,
 * scoped to `allowed` (and optionally to a `namespaces`/`names` subset for on-demand loading).
 * The universal `call(toolName, args?)` escape hatch is always included.
 */
export declare function generateToolFacadeTypes(tools: readonly ProjectedTool[], opts?: GenerateFacadeTypesOptions): string;
export interface FacadeNamespaceIndexEntry {
    ns: string;
    /** Camel-cased verbs available under this namespace (sorted). */
    verbs: string[];
    /** Full `ns:verb` names (sorted) — pass any to `code:tools { names }`. */
    toolNames: string[];
}
/**
 * The cheap index for on-demand discovery: every allowed namespace with its verb list, WITHOUT
 * full arg types. The model reads this first, then requests `generateToolFacadeTypes` for the
 * one or two namespaces it actually needs — the token win.
 */
export declare function listFacadeNamespaces(tools: readonly ProjectedTool[], allowed?: ReadonlySet<string>): FacadeNamespaceIndexEntry[];
