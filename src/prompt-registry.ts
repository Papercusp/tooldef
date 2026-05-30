/**
 * Prompt catalog. Symmetric to registry.ts (tools) and
 * resource-registry.ts (resources).
 *
 * Prompts self-register via `definePrompt()`; importing `prompts/**`
 * once at server startup populates the catalog.
 */

import type { PromptDefinition } from './types';

const CATALOG = new Map<string, PromptDefinition>();

export function registerPrompt(def: PromptDefinition): void {
  if (CATALOG.has(def.name)) {
    const existing = CATALOG.get(def.name)!;
    if (existing === def) return;
    // Same name + same capability is HMR re-evaluation: replace silently.
    // Different capability is a real collision: throw so the bug surfaces.
    if (existing.capability === def.capability) {
      CATALOG.set(def.name, def);
      return;
    }
    throw new Error(
      `Prompt name collision: "${def.name}" registered twice. ` +
      `First registration's capability=${existing.capability}, second's=${def.capability}.`,
    );
  }
  CATALOG.set(def.name, def);
}

export function lookupPrompt(name: string): PromptDefinition | undefined {
  return CATALOG.get(name);
}

export function getPromptCatalog(): readonly PromptDefinition[] {
  return [...CATALOG.values()];
}

/** Test-only — clear all registered prompts. */
export function _resetPromptCatalogForTests(): void {
  CATALOG.clear();
}
