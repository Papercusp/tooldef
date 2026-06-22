/**
 * code-execution-tool-orchestration B-CX-API — typed signatures for the code-mode facade.
 *
 * The COMPILE-TIME companion to `tool-facade.ts` (the RUNTIME). It renders the TypeScript
 * surface the model writes against:
 *
 *     declare const tools: {
 *       work_items: {
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
 * Verb naming is shared with the runtime via `camelVerb` (tool-facade.ts) so the generated
 * `tools.<ns>.<verb>` names ALWAYS match what the runtime facade actually exposes.
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
