import type { ProjectedTool, UnifiedToolContext } from './tool-projection';
/**
 * Read a real bound transaction without triggering this module's fail-loud
 * getter. Nested-dispatch adapters use this to decide whether an already-bound
 * transaction can be reused.
 */
export declare function boundWorkspaceTx(ctx: UnifiedToolContext): unknown | undefined;
/**
 * Return a context whose `tx` property enforces the projected tool's contract.
 * The guard is non-enumerable so framework context decorators can spread the
 * object without accidentally invoking it; the dispatch stack reapplies this
 * helper after its final decorator spread before the handler runs.
 */
export declare function applyWorkspaceTxContract(tool: Pick<ProjectedTool, 'needsWorkspaceTx'>, toolName: string, ctx: UnifiedToolContext): UnifiedToolContext;
