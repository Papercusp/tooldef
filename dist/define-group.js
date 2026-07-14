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
const GROUPS = new Map();
/**
 * Declare a namespace's one-line summary (and optional sort order). Idempotent:
 * re-declaring the same slug with the same summary is a benign re-eval
 * (HMR/double-import) and replaces silently. Group descriptors are advisory
 * metadata (never dispatch-load-bearing), so a differing re-declaration is also
 * last-wins rather than a hard throw — unlike `register()` for tools.
 */
export function defineGroup(slug, input = {}) {
    const summary = (input.summary ?? input.guidance?.when)?.trim() || undefined;
    const def = { slug, summary, order: input.order };
    registerGroup(def);
    return def;
}
export function registerGroup(def) {
    GROUPS.set(def.slug, def);
}
export function lookupGroup(slug) {
    return GROUPS.get(slug);
}
export function getGroupCatalog() {
    return [...GROUPS.values()];
}
/** Clears the group registry. Test-only. */
export function _resetGroupCatalogForTests() {
    GROUPS.clear();
}
