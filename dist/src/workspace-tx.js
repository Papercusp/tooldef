/**
 * Runtime enforcement for the explicit workspace-transaction contract.
 *
 * Hosts decide how a transaction is acquired; tooldef decides whether a
 * projected handler is allowed to observe it. Keeping this guard in the
 * generic dispatch stack covers MCP, HTTP, IPC, and in-process dispatches
 * uniformly instead of trusting every host adapter to remember the rule.
 */
import { WorkspaceTxNotDeclaredError, WorkspaceTxUnavailableError, } from './dispatch-types';
const GUARDED_TX_GETTER = Symbol.for('@papercusp/tooldef/guarded-workspace-tx-getter');
/**
 * Read a real bound transaction without triggering this module's fail-loud
 * getter. Nested-dispatch adapters use this to decide whether an already-bound
 * transaction can be reused.
 */
export function boundWorkspaceTx(ctx) {
    const descriptor = Object.getOwnPropertyDescriptor(ctx, 'tx');
    if (!descriptor)
        return undefined;
    if ('value' in descriptor)
        return descriptor.value ?? undefined;
    const getter = descriptor.get;
    if (!getter || getter[GUARDED_TX_GETTER] === true)
        return undefined;
    return getter.call(ctx) ?? undefined;
}
/**
 * Return a context whose `tx` property enforces the projected tool's contract.
 * The guard is non-enumerable so framework context decorators can spread the
 * object without accidentally invoking it; the dispatch stack reapplies this
 * helper after its final decorator spread before the handler runs.
 */
export function applyWorkspaceTxContract(tool, toolName, ctx) {
    const tx = boundWorkspaceTx(ctx);
    const descriptors = Object.getOwnPropertyDescriptors(ctx);
    delete descriptors.tx;
    const guarded = Object.defineProperties({}, descriptors);
    if (tool.needsWorkspaceTx === true && tx !== undefined) {
        Object.defineProperty(guarded, 'tx', {
            value: tx,
            enumerable: true,
            configurable: true,
            writable: false,
        });
        return guarded;
    }
    const getTx = (() => {
        if (tool.needsWorkspaceTx === true)
            throw new WorkspaceTxUnavailableError(toolName);
        throw new WorkspaceTxNotDeclaredError(toolName);
    });
    getTx[GUARDED_TX_GETTER] = true;
    Object.defineProperty(guarded, 'tx', {
        get: getTx,
        enumerable: false,
        configurable: true,
    });
    return guarded;
}
