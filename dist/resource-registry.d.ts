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
import type { ResourceDefinition } from './types';
export declare function registerResource(def: ResourceDefinition): void;
export declare function lookupResource(name: string): ResourceDefinition | undefined;
export declare function getResourceCatalog(): readonly ResourceDefinition[];
/**
 * Find the resource definition whose template/uri matches `uri`. Returns
 * the resource and any extracted path variables, or null if no match.
 */
export declare function matchResource(uri: string): {
    def: ResourceDefinition;
    vars: Record<string, string>;
} | null;
/** Test-only — clear all registered resources. */
export declare function _resetResourceCatalogForTests(): void;
