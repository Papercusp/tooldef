/**
 * catalogueProjection — a derived "capability map" of the tool catalog, grouped
 * by namespace. The catalogue analogue of how `tools/list` is generated from the
 * registry: it reads `getCatalog()` and emits one summarized row per `<group>`.
 *
 * Purpose: small-context / weaker models can't load the full ~551-tool catalog
 * (~141k tokens) and won't reliably keyword-search for tools they don't know
 * exist. A compact namespace map (~1-2k tokens) in the always-loaded context
 * tells them WHAT exists and the vocabulary to search — pairing with `tools:find`
 * (intent search) to fetch the specifics.
 *
 * Single source of truth: every summary derives from the same `defineTool`
 * definitions that produce `tools/list`, so it never drifts. A namespace can
 * declare an explicit one-liner via `defineGroup` (`tools/<group>/_group.ts`);
 * otherwise the summary is derived from the member tools here — mirroring
 * `defineTool`'s `description = explicit ?? describeFromGuidance ?? placeholder`.
 */
import type { ToolDefinition } from './types';
/** The `<group>` of a tool name: `plans:get` → `plans`; an un-namespaced name groups under itself. */
export declare function groupOf(toolName: string): string;
/**
 * Compose a namespace summary from its member tools when no `defineGroup`
 * summary was declared. Mirrors `describeFromGuidance(guidance)` for tools.
 *
 * Strategy: list the member verbs (the actions available in the namespace) —
 * deterministic, informative, and exactly what a model needs to know "what can
 * I do here". A declared `defineGroup` summary (the human one-liner) is always
 * preferred over this; this guarantees a useful row for every namespace with
 * zero authoring.
 */
export declare function describeGroupFromMembers(members: readonly ToolDefinition[]): string | null;
export interface CatalogueEntry {
    /** Namespace slug, e.g. `plans`. */
    group: string;
    /** One-line summary: declared (`defineGroup`) ?? derived (`describeGroupFromMembers`) ?? slug. */
    summary: string;
    /** Whether `summary` came from an explicit `defineGroup` (vs. derived). */
    declared: boolean;
    /** Number of tools in the namespace. */
    toolCount: number;
    /** A few representative tool names (for the model + debugging). */
    exampleTools: string[];
}
/**
 * Build the capability map: one row per namespace in the catalog. Pure — pass a
 * catalog for tests, defaults to the live `getCatalog()`.
 *
 * Sort: declared `order` first (lower wins), then larger namespaces, then alpha.
 */
export declare function catalogueProjection(catalog?: readonly ToolDefinition[]): CatalogueEntry[];
export interface RenderCapabilityMapOptions {
    /** Header line above the map. */
    header?: string;
    /** Footer line (e.g. the discovery hint). */
    footer?: string;
    /** Drop namespaces with fewer than this many tools (default 1 — keep all). */
    minTools?: number;
}
/**
 * Render the capability map as a compact text block for injection into an
 * always-loaded system prompt / primer. Aligned `group  summary` rows.
 */
export declare function renderCapabilityMap(entries?: CatalogueEntry[], opts?: RenderCapabilityMapOptions): string;
/** Convenience: the set of namespaces that have an explicit `defineGroup` summary (for coverage checks). */
export declare function declaredGroupSlugs(): string[];
