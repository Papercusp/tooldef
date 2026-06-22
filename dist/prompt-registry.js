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
const slash_projection_1 = require("./slash-projection");
const CATALOG = new Map();
function registerPrompt(def) {
    // `tool:*` is reserved for the DYNAMIC slash projection of the tool
    // catalog (slash-exposure-tool-catalog-2026-06-12 D-006). A static prompt
    // there would collide unpredictably as tools come and go — fail loud at
    // registration instead.
    if (def.name.startsWith(slash_projection_1.SLASH_PROMPT_PREFIX)) {
        throw new Error(`Prompt name "${def.name}" uses the reserved "${slash_projection_1.SLASH_PROMPT_PREFIX}" namespace ` +
            '(dynamic slash projection of the tool catalog). Pick another group.');
    }
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
