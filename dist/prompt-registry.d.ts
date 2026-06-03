/**
 * Prompt catalog. Symmetric to registry.ts (tools) and
 * resource-registry.ts (resources).
 *
 * Prompts self-register via `definePrompt()`; importing `prompts/**`
 * once at server startup populates the catalog.
 */
import type { PromptDefinition } from './types';
export declare function registerPrompt(def: PromptDefinition): void;
export declare function lookupPrompt(name: string): PromptDefinition | undefined;
export declare function getPromptCatalog(): readonly PromptDefinition[];
/** Test-only — clear all registered prompts. */
export declare function _resetPromptCatalogForTests(): void;
