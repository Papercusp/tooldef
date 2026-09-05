/**
 * Host-neutral kernel enforcement contract (identities-v1 / D-030).
 *
 * The tool framework owns the *seat* at which a decision is observed; a host
 * owns the policy that produces the decision.  Keeping this contract here is
 * intentional: direct MCP calls, in-process re-dispatch, reactions, and
 * native/shell adapters can all use one typed port without importing an
 * operator-specific policy engine.
 *
 * There are two dispatch phases with different safety properties:
 *
 *  - `preflight` runs before decorators/handler side effects and is where a
 *    host can validate ownership, the current activation, and revocation.
 *  - `enforce` runs immediately before the operation crosses its execution
 *    boundary.  A permission reduction that arrives while a handler is being
 *    prepared is therefore observed here, rather than being deferred until a
 *    prompt or acknowledgement catches up.
 *
 * `observe` is a phase for non-blocking shadow observations (and is also a
 * useful boundary label for native adapters).  The generic layer never turns
 * an unavailable optional policy into a denial; an explicit `decision:'deny'`
 * is always preserved and is fail-closed by callers.
 */
export const KERNEL_ENFORCEMENT_SCHEMA = 'kernel-enforcement-v1';
const EMPTY_ALLOW = Object.freeze({
    decision: 'allow',
    availability: 'unavailable',
    applied: false,
});
function validRevision(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const row = value;
    return typeof row.specificationRevision === 'string' &&
        row.specificationRevision.trim().length > 0 &&
        typeof row.stateRevision === 'string' &&
        row.stateRevision.trim().length > 0;
}
/** Compare revisions without allowing a desired/prepared value to masquerade as applied. */
export function sameKernelRevision(a, b) {
    return Boolean(a && b && a.specificationRevision === b.specificationRevision && a.stateRevision === b.stateRevision);
}
export const sameExecutionRevision = sameKernelRevision;
export function kernelRevisionKey(revision) {
    return validRevision(revision)
        ? `${revision.specificationRevision}:${revision.stateRevision}`
        : null;
}
export const executionRevisionKey = kernelRevisionKey;
/**
 * Canonicalize an untrusted host result.  A malformed/absent optional result
 * becomes an unavailable allow; an explicit deny is never weakened.  A
 * prepared/desired revision is intentionally removed from an enforce result
 * so telemetry cannot claim that a revision ran before the host applied it.
 */
export function normalizeKernelEnforcementResult(value, phase) {
    if (!value || typeof value !== 'object')
        return EMPTY_ALLOW;
    const decision = value.decision === 'deny' || value.decision === 'observe'
        ? value.decision
        : 'allow';
    const normalized = {
        decision,
        ...(typeof value.code === 'string' && value.code.trim() ? { code: value.code.trim() } : {}),
        ...(typeof value.reason === 'string' && value.reason.trim() ? { reason: value.reason.trim() } : {}),
        availability: value.availability === 'available' || value.availability === 'unknown'
            ? value.availability
            : 'unavailable',
        ...(typeof value.applied === 'boolean' ? { applied: value.applied } : {}),
        ...(typeof value.policyRevision === 'string' || value.policyRevision === null
            ? { policyRevision: value.policyRevision }
            : {}),
        ...(value.obligations && typeof value.obligations === 'object' && !Array.isArray(value.obligations)
            ? { obligations: value.obligations }
            : {}),
    };
    const source = value.revisionSource;
    if (source === 'applied' || source === 'prepared' || source === 'desired' || source === 'unknown') {
        normalized.revisionSource = source;
    }
    if (validRevision(value.executionRevision) &&
        (phase !== 'enforce' || normalized.revisionSource === 'applied')) {
        normalized.executionRevision = {
            specificationRevision: value.executionRevision.specificationRevision,
            stateRevision: value.executionRevision.stateRevision,
        };
    }
    else if (value.executionRevision === null) {
        normalized.executionRevision = null;
    }
    return normalized;
}
/**
 * Ask the host port, preserving the fail-soft rule for unavailable optional
 * state.  A host that needs fail-closed behavior returns an explicit deny (and
 * may use `code:'revoked'` / `code:'stale-activation'`); it must not throw and
 * rely on callers to guess whether the throw was policy or infrastructure.
 */
export async function evaluateKernelEnforcement(port, request) {
    if (!port)
        return EMPTY_ALLOW;
    try {
        return normalizeKernelEnforcementResult(await port(request), request.phase);
    }
    catch {
        return EMPTY_ALLOW;
    }
}
export const evaluateKernelDecision = evaluateKernelEnforcement;
/** True only for an explicit policy denial. */
export function isKernelDenied(result) {
    return result?.decision === 'deny';
}
/**
 * Return a revision suitable for execution telemetry.  Desired/prepared
 * values, and revisions from a preflight-only result, are deliberately not
 * accepted.  This is the small guard that keeps "what was requested" from
 * being reported as "what actually ran".
 */
export function appliedExecutionRevision(result, phase = 'enforce') {
    if (!result || phase !== 'enforce' || result.revisionSource !== 'applied' || !validRevision(result.executionRevision)) {
        return null;
    }
    return {
        specificationRevision: result.executionRevision.specificationRevision,
        stateRevision: result.executionRevision.stateRevision,
    };
}
export const actualExecutionRevision = appliedExecutionRevision;
/** Stable error used by native/shell wrappers when the boundary is revoked. */
export class KernelEnforcementDeniedError extends Error {
    name = 'KernelEnforcementDeniedError';
    result;
    constructor(result) {
        super(result.reason || result.code || 'kernel enforcement denied this operation');
        this.result = result;
    }
}
/**
 * Run an operation at a non-dispatch boundary (native tool or shell).  The
 * operation is never called after an explicit denial.  The resolved result is
 * handed to the callback so a caller can stamp its own completion record.
 */
export async function enforceKernelBoundary(port, request, operation) {
    const phase = request.phase ?? 'enforce';
    const decision = await evaluateKernelEnforcement(port, { ...request, phase });
    if (isKernelDenied(decision))
        throw new KernelEnforcementDeniedError(decision);
    return operation(decision);
}
export const runAtKernelBoundary = enforceKernelBoundary;
/**
 * Wrap a host subprocess executor.  This is deliberately opt-in: a generic
 * host that has no policy port keeps the exact old spawn behavior, while an
 * operator can install the same enforcement decision used by dispatch.
 */
export function wrapKernelSpawn(spawn, port, request) {
    return async (bin, args, opts) => enforceKernelBoundary(port, {
        ...request(bin, args, opts),
        phase: 'enforce',
        boundary: 'shell',
        operation: `${bin} ${args.join(' ')}`.trim(),
    }, () => spawn(bin, args, opts));
}
export const wrapNativeSpawn = wrapKernelSpawn;
/**
 * Build a small adapter from a resolver.  It is useful for hosts whose policy
 * is synchronous (cached activation/revocation state) and keeps the generic
 * dispatcher independent from that store.  Returning null means optional
 * state is unavailable and therefore does not block the operation.
 */
export function createKernelEnforcementPort(resolver) {
    return async (request) => resolver(request);
}
export const createKernelPolicyPort = createKernelEnforcementPort;
/** A reusable no-op port for standalone hosts and tests. */
export function allowKernelEnforcement() {
    return EMPTY_ALLOW;
}
