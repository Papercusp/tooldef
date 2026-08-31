/**
 * In-memory tool catalog. Tools self-register via `defineTool`.
 *
 * Importing `tools/**` once at server startup is enough to populate this;
 * after that, `getCatalog()` returns the full catalog and `lookup(name)`
 * fetches a specific tool.
 */
import type { ToolDefinition } from './types';
export declare function register(def: ToolDefinition): void;
export declare function lookup(name: string): ToolDefinition | undefined;
export declare function getCatalog(): readonly ToolDefinition[];
/** Clears the catalog. Test-only. */
export declare function _resetCatalogForTests(): void;
