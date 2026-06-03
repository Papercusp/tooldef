"use strict";
/**
 * Prompt catalog. Symmetric to registry.ts (tools) and
 * resource-registry.ts (resources).
 *
 * Prompts self-register via `definePrompt()`; importing `prompts/**`
 * once at server startup populates the catalog.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPrompt = registerPrompt;
exports.lookupPrompt = lookupPrompt;
exports.getPromptCatalog = getPromptCatalog;
exports._resetPromptCatalogForTests = _resetPromptCatalogForTests;
const CATALOG = new Map();
function registerPrompt(def) {
    if (CATALOG.has(def.name)) {
        const existing = CATALOG.get(def.name);
        if (existing === def)
            return;
        // Same name + same capability is HMR re-evaluation: replace silently.
        // Different capability is a real collision: throw so the bug surfaces.
        if (existing.capability === def.capability) {
            CATALOG.set(def.name, def);
            return;
        }
        throw new Error(`Prompt name collision: "${def.name}" registered twice. ` +
            `First registration's capability=${existing.capability}, second's=${def.capability}.`);
    }
    CATALOG.set(def.name, def);
}
function lookupPrompt(name) {
    return CATALOG.get(name);
}
function getPromptCatalog() {
    return [...CATALOG.values()];
}
/** Test-only — clear all registered prompts. */
function _resetPromptCatalogForTests() {
    CATALOG.clear();
}
