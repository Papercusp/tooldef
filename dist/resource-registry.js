/**
 * Resource catalog. Symmetric to registry.ts (tools).
 *
 * Resources self-register via `defineResource()`; importing
 * `resources/**` once at server startup populates the catalog.
 *
 * `match(uri)` resolves an incoming `resources/read` request to the
 * resource definition whose template the URI matches. Templates use
 * RFC 6570 `{var}` segments; this is a deliberately small subset
 * (named segments only — no operators, no level-2 expansions).
 */
const CATALOG = new Map();
const MATCHERS = new Map();
/** Compile a template like `papercusp://harness/{slug}/issues` into a regex. */
function compileMatcher(template) {
    // Escape regex metas, then turn `{name}` into a named capture group
    // matching one URI segment (no `/`).
    const escaped = template.replace(/[.+*?^$()|[\]\\]/g, '\\$&');
    const pattern = escaped.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, '(?<$1>[^/]+)');
    return new RegExp(`^${pattern}$`);
}
export function registerResource(def) {
    if (CATALOG.has(def.name)) {
        const existing = CATALOG.get(def.name);
        if (existing === def)
            return;
        // Same name + same uri is HMR re-evaluation: replace silently.
        // Different uri is a real collision: throw so the bug surfaces.
        if (existing.uri === def.uri) {
            CATALOG.set(def.name, def);
            MATCHERS.set(def.name, compileMatcher(def.uri));
            return;
        }
        throw new Error(`Resource name collision: "${def.name}" registered twice. ` +
            `First registration's uri=${existing.uri}, second's=${def.uri}.`);
    }
    CATALOG.set(def.name, def);
    MATCHERS.set(def.name, compileMatcher(def.uri));
}
export function lookupResource(name) {
    return CATALOG.get(name);
}
export function getResourceCatalog() {
    return [...CATALOG.values()];
}
/**
 * Find the resource definition whose template/uri matches `uri`. Returns
 * the resource and any extracted path variables, or null if no match.
 */
export function matchResource(uri) {
    for (const [name, matcher] of MATCHERS) {
        const m = matcher.exec(uri);
        if (m) {
            const def = CATALOG.get(name);
            const vars = (m.groups ?? {});
            return { def, vars };
        }
    }
    return null;
}
/** Test-only — clear all registered resources. */
export function _resetResourceCatalogForTests() {
    CATALOG.clear();
    MATCHERS.clear();
}
