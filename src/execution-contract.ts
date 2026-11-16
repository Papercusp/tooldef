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
  const defaultWindowMs = mode === 'auto' && contract.lifecycle === 'independent'
    ? (ceiling === null ? 5000 : Math.min(5000, ceiling)) : ceiling;
  const responseWindowMs = requested === undefined ? defaultWindowMs : ceiling === null ? requested : Math.min(requested, ceiling);
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

/** Legacy receipts retain their original audited-runtime verification path. */
export interface ToolExecutionLegacyReceipt extends ToolExecutionAdmission {
  readonly schemaVersion: 'tool-execution-receipt-v1';
  readonly terminal: boolean;
  readonly mode: ToolExecutionMode;
  readonly responseWindowMs: number | null;
  readonly executionDeadlineMs: number | null;
}

export type ToolExecutionResponseState = 'open' | 'returned' | 'request-expired' | 'response-lost';
export type ToolExecutionOutcome = 'unknown' | ToolExecutionAdmission['state'];

export interface ToolExecutionObservation {
  readonly response: ToolExecutionResponseState;
  readonly outcome: ToolExecutionOutcome;
  readonly observedAtMs: number;
  readonly evidenceRef: string | null;
}

/** Unknown timestamps carry neither an invented time nor evidence. */
export interface ToolExecutionProgressTimestamp {
  readonly atMs: number | null;
  readonly sourceKind: string;
  readonly evidenceRef: string | null;
}

export type ToolExecutionProgressMeasurement =
  | { readonly kind: 'unknown'; readonly reason: string }
  | { readonly kind: 'measured'; readonly quantity: number; readonly units: string;
      readonly writer: string; readonly observedAtMs: number; readonly evidenceRef: string };

/** Evidence from the actual child; wrapper settlement never changes its phase. */
export interface ToolExecutionChildProgress {
  readonly jobId: string;
  readonly parentJobId: string;
  readonly rootJobId: string;
  readonly summary: {
    readonly text: string;
    readonly omittedChars: number;
    /** Required when the text is a preview, preserved intact for authorized recovery. */
    readonly fullRef?: string;
  };
  readonly phase: string;
  readonly started: ToolExecutionProgressTimestamp;
  readonly updated: ToolExecutionProgressTimestamp;
  readonly lastActivity: ToolExecutionProgressTimestamp;
  readonly resultRef: string | null;
  readonly logRef: string | null;
  readonly measurement: ToolExecutionProgressMeasurement;
}

interface ToolExecutionReceiptFields {
  readonly schemaVersion: 'tool-execution-receipt-v2';
  readonly invocationRef: string;
  readonly mode: ToolExecutionMode;
  readonly responseWindowMs: number | null;
  readonly executionDeadlineMs: number | null;
  /** References the persisted ORIGINAL authority; it is not current delivery custody. */
  readonly authority: { readonly bindingRef: string; readonly fingerprint: string };
  readonly observation: ToolExecutionObservation;
  readonly terminal: boolean;
  readonly progress?: ToolExecutionChildProgress;
  readonly resultRef?: string;
  readonly logRef?: string;
}

/** An observation cannot confer the independent runtime capabilities it describes. */
export type ToolExecutionReceiptV2 = ToolExecutionReceiptFields & (
  | { readonly lifecycle: 'request-bound'; readonly durability: 'none';
      readonly handle?: never; readonly ownerId?: never; readonly adapterId?: never }
  | { readonly lifecycle: 'independent'; readonly durability: 'session' | 'restart';
      readonly handle: string; readonly ownerId: string; readonly adapterId: string }
);

export type ToolExecutionReceipt = ToolExecutionLegacyReceipt | ToolExecutionReceiptV2;

function invalidReceipt(field: string): never {
  // Field names here are codec constants. Never echo a rejected payload or its values.
  throw new TypeError('Invalid tool execution receipt: ' + field);
}

function receiptObject(value: unknown, fields: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return invalidReceipt(field);
  }
  if (Object.keys(value).some(key => !fields.includes(key))) return invalidReceipt(field);
  return value as Record<string, unknown>;
}

function receiptRef(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) return invalidReceipt(field);
  return value;
}

function receiptBudget(value: unknown, field: string, positive: boolean): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) {
    return invalidReceipt(field);
  }
  return value;
}

function receiptTime(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return invalidReceipt(field);
  return value;
}

function receiptProgressTimestamp(value: unknown, field: string): ToolExecutionProgressTimestamp {
  const timestamp = receiptObject(value, ['atMs', 'sourceKind', 'evidenceRef'], field);
  const sourceKind = receiptRef(timestamp.sourceKind, field);
  if (sourceKind === 'unknown') {
    if (timestamp.atMs !== null || timestamp.evidenceRef !== null) return invalidReceipt(field);
    return Object.freeze({ atMs: null, sourceKind, evidenceRef: null });
  }
  return Object.freeze({
    atMs: receiptTime(timestamp.atMs, field), sourceKind,
    evidenceRef: receiptRef(timestamp.evidenceRef, field),
  });
}

function receiptChildProgress(value: unknown): ToolExecutionChildProgress {
  const child = receiptObject(value, [
    'jobId', 'parentJobId', 'rootJobId', 'summary', 'phase', 'started', 'updated',
    'lastActivity', 'resultRef', 'logRef', 'measurement',
  ], 'progress');
  const summary = receiptObject(child.summary, ['text', 'omittedChars', 'fullRef'], 'progress.summary');
  if (typeof summary.text !== 'string' || !Number.isSafeInteger(summary.omittedChars) ||
      (summary.omittedChars as number) < 0) return invalidReceipt('progress.summary');
  const fullRef = summary.fullRef === undefined
    ? undefined : receiptRef(summary.fullRef, 'progress.summary.fullRef');
  if ((summary.omittedChars as number) > 0 && fullRef === undefined) return invalidReceipt('progress.summary.fullRef');

  // Select the variant before validating its fields: an unknown instrument cannot
  // smuggle a fabricated quantity, writer or timestamp into the snapshot.
  const instrument = receiptObject(child.measurement,
    ['kind', 'reason', 'quantity', 'units', 'writer', 'observedAtMs', 'evidenceRef'], 'progress.measurement');
  let measurement: ToolExecutionProgressMeasurement;
  if (instrument.kind === 'unknown') {
    receiptObject(instrument, ['kind', 'reason'], 'progress.measurement');
    measurement = Object.freeze({ kind: 'unknown', reason: receiptRef(instrument.reason, 'progress.measurement.reason') });
  } else if (instrument.kind === 'measured') {
    receiptObject(instrument, ['kind', 'quantity', 'units', 'writer', 'observedAtMs', 'evidenceRef'], 'progress.measurement');
    if (typeof instrument.quantity !== 'number' || !Number.isFinite(instrument.quantity)) {
      return invalidReceipt('progress.measurement.quantity');
    }
    measurement = Object.freeze({
      kind: 'measured', quantity: instrument.quantity,
      units: receiptRef(instrument.units, 'progress.measurement.units'),
      writer: receiptRef(instrument.writer, 'progress.measurement.writer'),
      observedAtMs: receiptTime(instrument.observedAtMs, 'progress.measurement.observedAtMs'),
      evidenceRef: receiptRef(instrument.evidenceRef, 'progress.measurement.evidenceRef'),
    });
  } else {
    return invalidReceipt('progress.measurement.kind');
  }
  return Object.freeze({
    jobId: receiptRef(child.jobId, 'progress.jobId'),
    parentJobId: receiptRef(child.parentJobId, 'progress.parentJobId'),
    rootJobId: receiptRef(child.rootJobId, 'progress.rootJobId'),
    summary: Object.freeze({ text: summary.text, omittedChars: summary.omittedChars as number,
      ...(fullRef !== undefined ? { fullRef } : {}) }),
    phase: receiptRef(child.phase, 'progress.phase'),
    started: receiptProgressTimestamp(child.started, 'progress.started'),
    updated: receiptProgressTimestamp(child.updated, 'progress.updated'),
    lastActivity: receiptProgressTimestamp(child.lastActivity, 'progress.lastActivity'),
    resultRef: child.resultRef === null ? null : receiptRef(child.resultRef, 'progress.resultRef'),
    logRef: child.logRef === null ? null : receiptRef(child.logRef, 'progress.logRef'),
    measurement,
  });
}

/**
 * Decode a v2 wire observation into a detached immutable snapshot. This validates
 * the wire contract, not authority or runtime admission: consumers must resolve
 * the original binding and evidence before using protected data or delivering.
 * Legacy v1 has no scoped binding and is never implicitly upgraded by this codec.
 */
export function parseToolExecutionReceipt(value: unknown): ToolExecutionReceiptV2 {
  const receipt = receiptObject(value, [
    'schemaVersion', 'invocationRef', 'mode', 'responseWindowMs', 'executionDeadlineMs',
    'authority', 'observation', 'terminal', 'resultRef', 'logRef',
    'lifecycle', 'durability', 'handle', 'ownerId', 'adapterId', 'progress',
  ], 'fields');
  if (receipt.schemaVersion !== 'tool-execution-receipt-v2') return invalidReceipt('schemaVersion');
  if (receipt.mode !== 'sync' && receipt.mode !== 'async' && receipt.mode !== 'auto') return invalidReceipt('mode');
  const authority = receiptObject(receipt.authority, ['bindingRef', 'fingerprint'], 'authority');
  const observation = receiptObject(receipt.observation,
    ['response', 'outcome', 'observedAtMs', 'evidenceRef'], 'observation');
  const response = observation.response;
  if (response !== 'open' && response !== 'returned' &&
      response !== 'request-expired' && response !== 'response-lost') return invalidReceipt('observation.response');
  const outcome = observation.outcome;
  if (outcome !== 'unknown' && outcome !== 'accepted' && outcome !== 'running' &&
      outcome !== 'succeeded' && outcome !== 'failed' && outcome !== 'cancelled') {
    return invalidReceipt('observation.outcome');
  }
  if (typeof observation.observedAtMs !== 'number' || !Number.isFinite(observation.observedAtMs) ||
      observation.observedAtMs < 0) return invalidReceipt('observation.observedAtMs');
  const evidenceRef = observation.evidenceRef === null
    ? null : receiptRef(observation.evidenceRef, 'observation.evidenceRef');
  if (outcome !== 'unknown' && evidenceRef === null) return invalidReceipt('observation.evidenceRef');
  const terminal = outcome === 'succeeded' || outcome === 'failed' || outcome === 'cancelled';
  if (receipt.terminal !== terminal) return invalidReceipt('terminal');
  const common: ToolExecutionReceiptFields = {
    schemaVersion: 'tool-execution-receipt-v2',
    invocationRef: receiptRef(receipt.invocationRef, 'invocationRef'),
    mode: receipt.mode,
    responseWindowMs: receiptBudget(receipt.responseWindowMs, 'responseWindowMs', true),
    executionDeadlineMs: receiptBudget(receipt.executionDeadlineMs, 'executionDeadlineMs', false),
    authority: Object.freeze({
      bindingRef: receiptRef(authority.bindingRef, 'authority.bindingRef'),
      fingerprint: receiptRef(authority.fingerprint, 'authority.fingerprint'),
    }),
    observation: Object.freeze({ response, outcome, observedAtMs: observation.observedAtMs, evidenceRef }),
    terminal,
    ...(receipt.progress !== undefined ? { progress: receiptChildProgress(receipt.progress) } : {}),
    ...(receipt.resultRef !== undefined ? { resultRef: receiptRef(receipt.resultRef, 'resultRef') } : {}),
    ...(receipt.logRef !== undefined ? { logRef: receiptRef(receipt.logRef, 'logRef') } : {}),
  };
  if (receipt.lifecycle === 'request-bound') {
    if (receipt.durability !== 'none' || receipt.mode === 'async' ||
        'handle' in receipt || 'ownerId' in receipt || 'adapterId' in receipt) {
      return invalidReceipt('request-bound capabilities');
    }
    return Object.freeze({ ...common, lifecycle: 'request-bound', durability: 'none' });
  }
  if (receipt.lifecycle !== 'independent' ||
      (receipt.durability !== 'session' && receipt.durability !== 'restart')) {
    return invalidReceipt('independent capabilities');
  }
  return Object.freeze({
    ...common, lifecycle: 'independent', durability: receipt.durability,
    handle: receiptRef(receipt.handle, 'handle'),
    ownerId: receiptRef(receipt.ownerId, 'ownerId'),
    adapterId: receiptRef(receipt.adapterId, 'adapterId'),
  });
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
