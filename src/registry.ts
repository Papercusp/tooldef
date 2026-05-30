/**
 * In-memory tool catalog. Tools self-register via `defineTool`.
 *
 * Importing `tools/**` once at server startup is enough to populate this;
 * after that, `getCatalog()` returns the full catalog and `lookup(name)`
 * fetches a specific tool.
 */

import type { ToolDefinition } from './types';

const CATALOG = new Map<string, ToolDefinition>();

export function register(def: ToolDefinition): void {
  if (CATALOG.has(def.name)) {
    const existing = CATALOG.get(def.name)!;
    if (existing === def) return;
    // Same name + same capability is HMR re-evaluation: replace silently.
    // Different capability is a real collision: still throw so the bug
    // surfaces in dev rather than silently masking the wrong code path.
    if (existing.capability === def.capability) {
      CATALOG.set(def.name, def);
      return;
    }
    throw new Error(
      `Tool name collision: "${def.name}" registered twice. ` +
      `First registration's capability=${existing.capability}, second's=${def.capability}.`,
    );
  }
  CATALOG.set(def.name, def);
}

export function lookup(name: string): ToolDefinition | undefined {
  return CATALOG.get(name);
}

export function getCatalog(): readonly ToolDefinition[] {
  return [...CATALOG.values()];
}

import { _resetProjectionRegistryForTests } from './tool-projection';

/** Clears the catalog. Test-only. */
export function _resetCatalogForTests(): void {
  CATALOG.clear();
  // Also flush the projection registry — defineTool now auto-registers
  // legacy tools as projected, so a test that resets the legacy catalog
  // must also flush the projected mirror to avoid duplicate-name errors
  // when the same tool is re-defined.
  _resetProjectionRegistryForTests();
}
