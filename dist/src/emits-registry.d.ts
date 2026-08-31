/**
 * emits-registry.ts — the generic collector for tools' intrinsic `emits`
 * declarations (coord-lifecycle-automation-2026-06-04 D-002).
 *
 * WHY a side-collector rather than reading the tool catalog: role-gated tools
 * (`requirePrincipal: false` — most coordination / work_items tools) are NOT
 * stored in `getCatalog()`; they project straight into the projected-tool
 * registry. So "iterate getCatalog() for emits" would miss exactly the
 * lifecycle tools that carry `emits`. Instead, `defineTool` records every
 * tool's `emits` HERE at definition time — regardless of gating path — and the
 * operator-core desugar reads this collector once at load and registers the
 * rules. Generic (no domain knowledge of what `fire` means) by design; the
 * meaning lives in the operator-core adapter.
 */
import type { ToolEmitSpec } from './types';
/** One tool's collected emits, keyed by the resolved tool name. */
export interface CollectedToolEmits {
    toolName: string;
    emits: readonly ToolEmitSpec[];
}
/**
 * Record a tool's `emits`. Called by `defineTool` for BOTH gating paths.
 * Idempotent by tool name: re-defining a tool (prompt hot-reload,
 * `PAPERCUSP_RELOAD_PROMPTS`, tests) replaces its prior entry rather than
 * duplicating it. A tool with no (or empty) `emits` is a no-op.
 */
export declare function collectToolEmits(toolName: string, emits: readonly ToolEmitSpec[] | undefined): void;
/** Every tool that declared `emits`, in declaration order. The desugar reads this. */
export declare function getCollectedToolEmits(): readonly CollectedToolEmits[];
/** Test seam — clear the collector between cases. */
export declare function _resetCollectedToolEmitsForTests(): void;
