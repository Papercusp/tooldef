/**
 * defineGroup — the catalogue analogue of `defineTool`, for NAMESPACE-level
 * one-line summaries.
 *
 * Tools self-register via `defineTool` and are grouped by the `<group>` segment
 * of their name (`plans:get` → group `plans`). A group's capability summary is,
 * by default, DERIVED from its member tools at projection time
 * (`catalogueProjection`). `defineGroup` lets a namespace declare that summary
 * explicitly — co-located as `tools/<group>/_group.ts`, exactly as `defineTool`
 * lets a tool override its `guidance`-derived `description`.
 *
 * Precedence mirrors `defineTool`'s `description = input.description ??
 * describeFromGuidance(guidance) ?? \`Tool ${name}\``:
 *
 *   group summary = input.summary               // explicit, wins
 *               ?? input.guidance.when           // composed from the group's own guidance
 *               ?? describeGroupFromMembers(...)  // derived from member tools (catalogue-projection.ts)
 *               ?? slug                           // last-resort placeholder
 *
 * The first two legs resolve here (at define time); the last two resolve in
 * `catalogueProjection()` because member tools register independently.
 *
 * Mirrors `registry.ts` (a tiny in-memory registry populated by importing the
 * `tools/**` tree once at startup).
 */
import type { ToolGuidance } from './types';
/** Input shape for `defineGroup` — what a `_group.ts` file declares. */
export interface GroupDefinitionInput {
    /** Explicit one-line capability summary. Overrides the derived one. */
    summary?: string;
    /**
     * Structured guidance for the namespace — only `when` is used, composed into
     * `summary` when `summary` is omitted (mirrors `describeFromGuidance`).
     */
    guidance?: Pick<ToolGuidance, 'when'>;
    /** Display-order hint for the rendered map (lower first). Optional. */
    order?: number;
}
/** A registered namespace descriptor. */
export interface GroupDefinition {
    slug: string;
    /**
     * Resolved summary from the explicit/guidance legs, or `undefined` when the
     * namespace declared neither — in which case `catalogueProjection()` derives
     * it from the member tools.
     */
    summary?: string;
    order?: number;
}
/**
 * Declare a namespace's one-line summary (and optional sort order). Idempotent:
 * re-declaring the same slug with the same summary is a benign re-eval
 * (HMR/double-import) and replaces silently. Group descriptors are advisory
 * metadata (never dispatch-load-bearing), so a differing re-declaration is also
 * last-wins rather than a hard throw — unlike `register()` for tools.
 */
export declare function defineGroup(slug: string, input?: GroupDefinitionInput): GroupDefinition;
export declare function registerGroup(def: GroupDefinition): void;
export declare function lookupGroup(slug: string): GroupDefinition | undefined;
export declare function getGroupCatalog(): readonly GroupDefinition[];
/** Clears the group registry. Test-only. */
export declare function _resetGroupCatalogForTests(): void;
