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
import { getCatalog } from './registry';
import { lookupGroup, getGroupCatalog } from './define-group';
/** The `<group>` of a tool name: `plans:get` → `plans`; an un-namespaced name groups under itself. */
export function groupOf(toolName) {
    const i = toolName.indexOf(':');
    return i > 0 ? toolName.slice(0, i) : toolName;
}
/** The verb of a tool name: `plans:get` → `get`; falls back to the whole name. */
function verbOf(toolName) {
    const i = toolName.indexOf(':');
    return i > 0 ? toolName.slice(i + 1) : toolName;
}
/** Max verbs listed in a derived summary before eliding to `+N more`. */
const MAX_DERIVED_VERBS = 8;
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
export function describeGroupFromMembers(members) {
    const verbs = members.map((m) => verbOf(m.name)).filter(Boolean);
    if (verbs.length === 0)
        return null;
    const shown = verbs.slice(0, MAX_DERIVED_VERBS);
    const more = verbs.length - shown.length;
    return shown.join(', ') + (more > 0 ? `, +${more} more` : '');
}
function orderOf(group) {
    return lookupGroup(group)?.order ?? Number.MAX_SAFE_INTEGER;
}
/**
 * Build the capability map: one row per namespace in the catalog. Pure — pass a
 * catalog for tests, defaults to the live `getCatalog()`.
 *
 * Sort: declared `order` first (lower wins), then larger namespaces, then alpha.
 */
export function catalogueProjection(catalog = getCatalog()) {
    const byGroup = new Map();
    for (const t of catalog) {
        const g = groupOf(t.name);
        const list = byGroup.get(g);
        if (list)
            list.push(t);
        else
            byGroup.set(g, [t]);
    }
    const entries = [];
    for (const [group, members] of byGroup) {
        const declared = lookupGroup(group)?.summary;
        const summary = declared ?? describeGroupFromMembers(members) ?? group;
        entries.push({
            group,
            summary,
            declared: declared != null,
            toolCount: members.length,
            exampleTools: members.slice(0, 3).map((m) => m.name),
        });
    }
    entries.sort((a, b) => orderOf(a.group) - orderOf(b.group) ||
        b.toolCount - a.toolCount ||
        a.group.localeCompare(b.group));
    return entries;
}
const DEFAULT_HEADER = 'Capability map — tool namespaces available in this workspace:';
const DEFAULT_FOOTER = 'To use a tool not in your core set, call tools:find("<what you need>") to load it.';
/**
 * Render the capability map as a compact text block for injection into an
 * always-loaded system prompt / primer. Aligned `group  summary` rows.
 */
export function renderCapabilityMap(entries = catalogueProjection(), opts = {}) {
    const { header = DEFAULT_HEADER, footer = DEFAULT_FOOTER, minTools = 1 } = opts;
    const rows = entries.filter((e) => e.toolCount >= minTools);
    const pad = Math.min(22, rows.reduce((w, e) => Math.max(w, e.group.length), 0));
    const body = rows.map((e) => `${e.group.padEnd(pad)}  ${e.summary}`);
    return [header, '', ...body, '', footer].join('\n');
}
/** Convenience: the set of namespaces that have an explicit `defineGroup` summary (for coverage checks). */
export function declaredGroupSlugs() {
    return getGroupCatalog()
        .filter((g) => g.summary != null)
        .map((g) => g.slug);
}
