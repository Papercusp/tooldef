/**
 * Host-independent execution classification and adapter admission.
 * This module selects an existing runtime; it never starts a scheduler.
 */
export type ToolExecutionMode = 'sync' | 'async' | 'auto';
export type ToolExecutionProgress = 'none' | 'reported' | 'measured';

export interface AuditedToolExecutionAdapter {
  /** Registered adapter identity and the durable review establishing its contract. */
  readonly id: string;
  readonly auditRef: string;
  readonly ownsExecution: true;
  readonly transactionScope: 'independent';
  readonly outcome: 'business';
  readonly durability: 'session' | 'restart';
  readonly cancellation: 'owner-managed' | 'unsupported';
  readonly progress: ToolExecutionProgress;
}

export type ToolExecutionDeclaration =
  | {
      readonly lifecycle?: 'request-bound';
      readonly liveInteraction?: boolean;
      readonly cancellation?: 'cooperative' | 'unsupported';
      readonly progress?: ToolExecutionProgress;
      readonly adapter?: never;
    }
  | {
      readonly lifecycle: 'independent';
      readonly liveInteraction?: false;
      readonly adapter: AuditedToolExecutionAdapter;
    };

export interface ToolExecutionContract {
  readonly defaultMode: 'auto';
  readonly supportedModes: readonly ToolExecutionMode[];
  readonly lifecycle: 'request-bound' | 'independent';
  readonly durability: 'none' | 'session' | 'restart';
  readonly cancellation: 'cooperative' | 'owner-managed' | 'unsupported';
  readonly progress: ToolExecutionProgress;
  readonly liveInteraction: boolean;
  readonly adapter?: AuditedToolExecutionAdapter;
}

export const REQUEST_BOUND_EXECUTION: ToolExecutionContract = Object.freeze({
  defaultMode: 'auto',
  supportedModes: Object.freeze(['sync', 'auto'] as const),
  lifecycle: 'request-bound',
  durability: 'none',
  cancellation: 'cooperative',
  progress: 'none',
  liveInteraction: false,
});

function invalid(message: string): never {
  throw new TypeError('Invalid tool execution contract: ' + message);
}

function progress(value: unknown): ToolExecutionProgress {
  if (value === 'none' || value === 'reported' || value === 'measured') return value;
  return invalid('unknown progress capability');
}

/** Missing declarations always resolve to the restrictive request lifetime. */
export function resolveToolExecutionContract(
  declaration?: ToolExecutionDeclaration | ToolExecutionContract,
): ToolExecutionContract {
  if (declaration === undefined || declaration === REQUEST_BOUND_EXECUTION) return REQUEST_BOUND_EXECUTION;
  if (!declaration || typeof declaration !== 'object') return invalid('expected an object');
  const value = declaration as unknown as Record<string, unknown>;
  if (value.defaultMode !== undefined && value.defaultMode !== 'auto') return invalid('default mode must be auto');
  let contract: ToolExecutionContract;
  if (value.lifecycle === undefined || value.lifecycle === 'request-bound') {
    if (value.adapter !== undefined) return invalid('request-bound tools cannot declare an independent adapter');
    if (value.durability !== undefined && value.durability !== 'none') return invalid('request-bound tools are not durable');
    if (value.cancellation !== undefined && value.cancellation !== 'cooperative' && value.cancellation !== 'unsupported') {
      return invalid('request-bound cancellation must use the request owner');
    }
    if (value.liveInteraction !== undefined && typeof value.liveInteraction !== 'boolean') return invalid('invalid interaction capability');
    contract = Object.freeze({
      ...REQUEST_BOUND_EXECUTION,
      cancellation: value.cancellation === 'unsupported' ? 'unsupported' : 'cooperative',
      progress: progress(value.progress ?? 'none'),
      liveInteraction: value.liveInteraction === true,
    });
  } else if (value.lifecycle === 'independent') {
    if (value.liveInteraction !== undefined && value.liveInteraction !== false) return invalid('live interaction cannot detach');
    const adapter = value.adapter as AuditedToolExecutionAdapter | undefined;
    if (!adapter || typeof adapter !== 'object' ||
        typeof adapter.id !== 'string' || !adapter.id.trim() ||
        typeof adapter.auditRef !== 'string' || !adapter.auditRef.trim() ||
        adapter.ownsExecution !== true || adapter.transactionScope !== 'independent' ||
        adapter.outcome !== 'business' ||
        (adapter.durability !== 'session' && adapter.durability !== 'restart') ||
        (adapter.cancellation !== 'owner-managed' && adapter.cancellation !== 'unsupported')) {
      return invalid('detachment requires an audited independent owner, transaction scope and business outcome');
    }
    const adapterProgress = progress(adapter.progress);
    if (value.durability !== undefined && value.durability !== adapter.durability) return invalid('durability disagrees with adapter');
    if (value.cancellation !== undefined && value.cancellation !== adapter.cancellation) return invalid('cancellation disagrees with adapter');
    if (value.progress !== undefined && value.progress !== adapterProgress) return invalid('progress disagrees with adapter');
    contract = Object.freeze({
      defaultMode: 'auto',
      supportedModes: Object.freeze(['sync', 'async', 'auto'] as const),
      lifecycle: 'independent',
      durability: adapter.durability,
      cancellation: adapter.cancellation,
      progress: adapterProgress,
      liveInteraction: false,
      adapter: Object.freeze({
        id: adapter.id, auditRef: adapter.auditRef, ownsExecution: true,
        transactionScope: 'independent', outcome: 'business',
        durability: adapter.durability, cancellation: adapter.cancellation, progress: adapterProgress,
      }),
    });
  } else {
    return invalid('unknown lifecycle');
  }
  if (value.supportedModes !== undefined &&
      (!Array.isArray(value.supportedModes) ||
       value.supportedModes.length !== contract.supportedModes.length ||
       value.supportedModes.some((mode, index) => mode !== contract.supportedModes[index]))) {
    return invalid('supported modes must agree with the lifecycle');
  }
  return contract;
}

export interface ToolExecutionRequest {
  readonly mode?: ToolExecutionMode;
  /** Response scheduling only; never changes the original execution deadline. */
  readonly responseWindowMs?: number;
  /** An original runtime handle for reattachment; never a request to admit replacement work. */
  readonly handle?: string;
}

/** Shared wire parser. Execution preferences are metadata, never business arguments or authority. */
export function parseToolExecutionRequest(value: unknown): ToolExecutionRequest {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid execution metadata: expected an object');
  }
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some(key => !['mode', 'responseWindowMs', 'handle'].includes(key)) ||
      (request.mode !== undefined && !['sync', 'async', 'auto'].includes(request.mode as string)) ||
      (request.responseWindowMs !== undefined && (typeof request.responseWindowMs !== 'number' ||
        !Number.isFinite(request.responseWindowMs) || request.responseWindowMs <= 0)) ||
      (request.handle !== undefined && (typeof request.handle !== 'string' || !request.handle.trim()))) {
    throw new TypeError('Invalid execution metadata: mode, responseWindowMs or handle');
  }
  return Object.freeze({
    ...(request.mode !== undefined ? { mode: request.mode as ToolExecutionMode } : {}),
    ...(request.responseWindowMs !== undefined ? { responseWindowMs: request.responseWindowMs as number } : {}),
    ...(request.handle !== undefined ? { handle: request.handle as string } : {}),
  });
}

export interface ToolExecutionBudgets {
  readonly nowMs: number;
  /** Absolute original execution deadline; null means the owner disabled it. */
  readonly executionDeadlineMs: number | null;
  /** Remaining ceiling derived by the host from its loaded per-call transport deadline. */
  readonly transportResponseBudgetMs: number | null;
  readonly requestAborted?: boolean;
}

export interface ToolExecutionSelection {
  readonly ok: true;
  readonly mode: ToolExecutionMode;
  readonly lifecycle: ToolExecutionContract['lifecycle'];
  readonly responseWindowMs: number | null;
  readonly executionDeadlineMs: number | null;
  /** Only the independently owned adapter may yield; request-bound auto stays inline. */
  readonly autoYieldAfterMs: number | null;
}

export interface ToolExecutionRefusal {
  readonly ok: false;
  readonly error: 'unsupported_execution_mode' | 'execution_budget_exceeded' | 'request_expired' | 'execution_adapter_unavailable' | 'execution_receipt_invalid';
  readonly reason: string;
  readonly supportedModes: readonly ToolExecutionMode[];
}

/** Admission is pure: a refusal happens before either dispatch callback is reached. */
export function selectToolExecution(
  declaration: ToolExecutionDeclaration | ToolExecutionContract | undefined,
  request: ToolExecutionRequest,
  budgets: ToolExecutionBudgets,
): ToolExecutionSelection | ToolExecutionRefusal {
  const contract = resolveToolExecutionContract(declaration);
  const refuse = (error: ToolExecutionRefusal['error'], reason: string): ToolExecutionRefusal =>
    ({ ok: false, error, reason, supportedModes: contract.supportedModes });
  const mode = request.mode === undefined ? contract.defaultMode : request.mode;
  if (!contract.supportedModes.includes(mode)) return refuse('unsupported_execution_mode', 'The declared lifecycle does not support ' + String(mode));
  if (!Number.isFinite(budgets.nowMs) ||
      (budgets.executionDeadlineMs !== null && !Number.isFinite(budgets.executionDeadlineMs)) ||
      (budgets.transportResponseBudgetMs !== null &&
       (!Number.isFinite(budgets.transportResponseBudgetMs) || budgets.transportResponseBudgetMs < 0))) {
    return refuse('execution_budget_exceeded', 'Invalid original execution or derived transport budget');
  }
  const remaining = budgets.executionDeadlineMs === null ? null : Math.max(0, budgets.executionDeadlineMs - budgets.nowMs);
  if (budgets.requestAborted || remaining === 0 || budgets.transportResponseBudgetMs === 0) {
    return refuse('request_expired', 'The original request or execution budget has expired');
  }
  const finiteBounds = [remaining, budgets.transportResponseBudgetMs].filter((bound): bound is number => bound !== null);
  const ceiling = finiteBounds.length === 0 ? null : Math.min(...finiteBounds);
  const requested = request.responseWindowMs;
  if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) {
    return refuse('execution_budget_exceeded', 'Response window must be a positive finite duration');
  }
  if (mode === 'sync' && requested !== undefined && ceiling !== null && requested > ceiling) {
    return refuse('execution_budget_exceeded', 'Strict sync exceeds the original execution or derived transport response budget');
  }
  const responseWindowMs = requested === undefined ? ceiling : ceiling === null ? requested : Math.min(requested, ceiling);
  return Object.freeze({
    ok: true, mode, lifecycle: contract.lifecycle, responseWindowMs,
    executionDeadlineMs: budgets.executionDeadlineMs,
    autoYieldAfterMs: mode === 'auto' && contract.lifecycle === 'independent'
      ? Math.min(5000, responseWindowMs ?? Infinity) : null,
  });
}

/** An admission acknowledged by the independently owning runtime, not a launcher id. */
export interface ToolExecutionAdmission {
  readonly handle: string;
  readonly ownerId: string;
  readonly state: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled';
}

export interface ToolExecutionReceipt extends ToolExecutionAdmission {
  readonly schemaVersion: 'tool-execution-receipt-v1';
  readonly terminal: boolean;
  readonly mode: ToolExecutionMode;
  readonly responseWindowMs: number | null;
  readonly executionDeadlineMs: number | null;
}

export interface ToolExecutionDispatch<T> {
  /** Identity resolved from the original authenticated context, never tool arguments. */
  readonly ownerId?: string;
  readonly inline: (selection: ToolExecutionSelection) => Promise<T>;
  readonly adapter?: {
    readonly id: string;
    readonly dispatch: (selection: ToolExecutionSelection) => Promise<{ result: T; admission: ToolExecutionAdmission }>;
    /** Read the owning runtime's admission; an arbitrary nonempty id is not evidence. */
    readonly verifyAdmission: (admission: ToolExecutionAdmission) => Promise<boolean>;
  };
}

/**
 * Adapter entry point. The host supplies already-authorized callbacks and the
 * original budgets. The adapter owns actual execution, yielding and settlement.
 */
export async function dispatchWithToolExecution<T>(
  declaration: ToolExecutionDeclaration | ToolExecutionContract | undefined,
  request: ToolExecutionRequest,
  budgets: ToolExecutionBudgets,
  dispatch: ToolExecutionDispatch<T>,
): Promise<ToolExecutionRefusal | { ok: true; selection: ToolExecutionSelection; result: T; receipt?: ToolExecutionReceipt }> {
  const selection = selectToolExecution(declaration, request, budgets);
  if (!selection.ok) return selection;
  const contract = resolveToolExecutionContract(declaration);
  let result: T;
  if (selection.lifecycle === 'independent') {
    if (!dispatch.ownerId?.trim() || !dispatch.adapter || dispatch.adapter.id !== contract.adapter?.id ||
        typeof dispatch.adapter.verifyAdmission !== 'function') {
      return { ok: false, error: 'execution_adapter_unavailable', reason: 'The audited adapter is not bound to this dispatch', supportedModes: contract.supportedModes };
    }
    const admitted = await dispatch.adapter.dispatch(selection);
    const admission = admitted?.admission && Object.freeze({ ...admitted.admission });
    const state = admission?.state;
    const terminal = state === 'succeeded' || state === 'failed' || state === 'cancelled';
    if (!admission || typeof admission.handle !== 'string' || !admission.handle.trim() ||
        admission.ownerId !== dispatch.ownerId ||
        (!terminal && state !== 'accepted' && state !== 'running') ||
        (selection.mode === 'sync' && !terminal) ||
        !await dispatch.adapter.verifyAdmission(admission)) {
      return { ok: false, error: 'execution_receipt_invalid', reason: 'The owning runtime did not confirm this handle, owner and execution outcome', supportedModes: contract.supportedModes };
    }
    const receipt: ToolExecutionReceipt = Object.freeze({
      schemaVersion: 'tool-execution-receipt-v1', handle: admission.handle,
      ownerId: admission.ownerId, state, terminal, mode: selection.mode,
      responseWindowMs: selection.responseWindowMs, executionDeadlineMs: selection.executionDeadlineMs,
    });
    return { ok: true, selection, result: admitted.result, receipt };
  } else {
    result = await dispatch.inline(selection);
  }
  return { ok: true, selection, result };
}
