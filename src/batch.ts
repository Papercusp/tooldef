/** Canonical same-tool wire contracts. Execution stays in the admitted dispatcher. */
import { toList } from './_bulk';
import { standardValidate, type StandardSchemaV1 } from './standard-schema';
import type { UnifiedToolContext } from './tool-projection';
import type { ToolResponse } from './types';
import type { ToolResult } from './wire';

export const BATCH_MAX_ITEMS = 100;
export const BATCH_ITEM_ID_MAX_LENGTH = 128;
// Match the existing MCP input-frame ceiling; every transport shares this guard.
const BATCH_MAX_INPUT_BYTES = 4 * 1024 * 1024;

export interface BatchRequestItem<TArgs = Record<string, unknown>> {
  readonly itemId?: string;
  readonly args: TArgs;
}

export interface BatchRequest<TArgs = Record<string, unknown>> {
  readonly _batch?: 1;
  readonly items: readonly BatchRequestItem<TArgs>[] | BatchRequestItem<TArgs>;
}

export interface NormalizedBatchItem {
  readonly itemId: string;
  /** Original operation input; ordinary child validation still runs before effects. */
  readonly args: Record<string, unknown>;
}

export interface NormalizedBatchRequest {
  readonly source: 'envelope' | 'singleton' | 'legacy';
  readonly items: readonly NormalizedBatchItem[];
}

export type BatchItemStatus = 'completed' | 'failed' | 'cancelled' | 'not-started' | 'unknown-effect';

export interface BatchItemResult {
  readonly itemId: string;
  readonly ok: boolean;
  readonly status: BatchItemStatus;
  readonly output?: ToolResult;
  readonly error?: unknown;
  readonly receipt?: unknown;
}

export interface BatchResult {
  readonly ok: boolean;
  readonly batchId: string;
  readonly results: readonly BatchItemResult[];
  readonly counts: { readonly ok: number; readonly failed: number };
}

/** Only the innermost, host-enforced invocation continuation may create these. */
export interface AdmittedBatchItem<TArgs, TContext = UnifiedToolContext> {
  readonly itemId: string;
  readonly args: TArgs;
  readonly ctx: TContext;
  readonly callId: string;
  readonly signal: AbortSignal;
}

export type NativeBatchResult =
  | { readonly itemId: string; readonly response: ToolResponse | ToolResult }
  | { readonly itemId: string; readonly error: unknown; readonly receipt?: unknown };

export interface ToolBatchDeclaration<TArgs = unknown, TContext = UnifiedToolContext> {
  readonly maxItems?: number;
  /** UTF-8 JSON bytes for the whole request, before validation or admission. May lower the 4 MiB ceiling. */
  readonly maxInputBytes?: number;
  /** More than one requires an explicit independence declaration. */
  readonly maxConcurrency?: number;
  readonly independent?: boolean;
  /** Logical wire operation; an explicit adapter may target a different legacy handler input. */
  readonly operation?: StandardSchemaV1;
  readonly toHandlerArgs?: (args: unknown) => TArgs;
  readonly result?: (response: ToolResponse | ToolResult, args: TArgs) => ToolResponse | ToolResult;
  readonly legacy?: {
    readonly schema: StandardSchemaV1;
    readonly toOperation: (args: unknown) => unknown;
  };
  /** Never called by normalization or registration; admission is a dispatch concern. */
  readonly execute?: (
    items: readonly AdmittedBatchItem<TArgs, TContext>[],
    parent: { readonly signal: AbortSignal },
  ) => Promise<readonly NativeBatchResult[]>;
}

export type ResolvedToolBatchDeclaration<TArgs = unknown, TContext = UnifiedToolContext> =
  ToolBatchDeclaration<TArgs, TContext> & {
    readonly maxItems: number;
    readonly maxInputBytes: number;
    readonly maxConcurrency: number;
    readonly independent: boolean;
  };

export interface ToolBatchContract {
  readonly requestJsonSchema: Record<string, unknown>;
  readonly resultJsonSchema: Record<string, unknown>;
  readonly normalize: (input: unknown) => Promise<NormalizedBatchRequest>;
}

export class BatchEnvelopeError extends Error {
  readonly code = 'invalid_batch_envelope';
  constructor(message: string) {
    super(message);
    this.name = 'BatchEnvelopeError';
  }
}

export function resolveToolBatchDeclaration<TArgs, TContext>(
  declaration: ToolBatchDeclaration<TArgs, TContext> = {},
): ResolvedToolBatchDeclaration<TArgs, TContext> {
  const maxItems = declaration.maxItems ?? BATCH_MAX_ITEMS;
  const maxInputBytes = declaration.maxInputBytes ?? BATCH_MAX_INPUT_BYTES;
  const maxConcurrency = declaration.maxConcurrency ?? 1;
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > BATCH_MAX_ITEMS) {
    throw new Error('batch.maxItems must be an integer between 1 and ' + BATCH_MAX_ITEMS);
  }
  if (!Number.isInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > BATCH_MAX_INPUT_BYTES) {
    throw new Error('batch.maxInputBytes must be an integer between 1 and ' + BATCH_MAX_INPUT_BYTES);
  }
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > maxItems) {
    throw new Error('batch.maxConcurrency must be an integer between 1 and batch.maxItems');
  }
  if (maxConcurrency > 1 && declaration.independent !== true) {
    throw new Error('batch.maxConcurrency > 1 requires batch.independent:true');
  }
  return Object.freeze({ ...declaration, maxItems, maxInputBytes, maxConcurrency, independent: declaration.independent === true });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function envelopeItems(input: Record<string, unknown>, maxItems: number): readonly NormalizedBatchItem[] {
  if (!onlyKeys(input, ['_batch', 'items']) || !Object.hasOwn(input, 'items')) {
    throw new BatchEnvelopeError('Batch accepts only _batch:1 and items; use nested args for business fields.');
  }
  const entries = toList(input.items);
  if (entries.length < 1 || entries.length > maxItems) {
    throw new BatchEnvelopeError('Batch items must contain 1–' + maxItems + ' operations.');
  }
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!isObject(entry) || !onlyKeys(entry, ['itemId', 'args']) || !isObject(entry.args)) {
      throw new BatchEnvelopeError('Each batch item accepts exactly { itemId?: string, args: object }.');
    }
    if (Object.hasOwn(entry, 'itemId')) {
      if (typeof entry.itemId !== 'string' || entry.itemId.length === 0 || entry.itemId.length > BATCH_ITEM_ID_MAX_LENGTH) {
        throw new BatchEnvelopeError('itemId must be a nonempty string of at most 128 characters.');
      }
      if (ids.has(entry.itemId)) throw new BatchEnvelopeError('Duplicate itemId: ' + entry.itemId);
      ids.add(entry.itemId);
    }
  }
  // Reserve every caller ID before allocation, including IDs supplied by later items.
  let ordinal = 1;
  return Object.freeze(entries.map((entry) => {
    const item = entry as { itemId?: string; args: Record<string, unknown> };
    let itemId = item.itemId;
    if (itemId === undefined) {
      do { itemId = 'item-' + ordinal++; } while (ids.has(itemId));
      ids.add(itemId);
    }
    return Object.freeze({ itemId, args: item.args });
  }));
}

/** Shallow, operation-first normalization. It does not dispatch or repair arguments. */
export async function normalizeBatchRequest(
  input: unknown,
  operation: StandardSchemaV1,
  declaration: ToolBatchDeclaration = {},
): Promise<NormalizedBatchRequest> {
  const { maxItems, maxInputBytes } = resolveToolBatchDeclaration(declaration);
  if (!isObject(input)) throw new BatchEnvelopeError('Tool input must be an operation object or batch envelope.');
  let serialized: string | undefined;
  try { serialized = JSON.stringify(input); }
  catch { throw new BatchEnvelopeError('Tool input must be JSON serializable.'); }
  if (serialized === undefined) throw new BatchEnvelopeError('Tool input must be JSON serializable.');
  if (new TextEncoder().encode(serialized).byteLength > maxInputBytes) {
    throw new BatchEnvelopeError('Tool input exceeds the ' + maxInputBytes + ' byte input limit.');
  }
  if (Object.hasOwn(input, '_batch')) {
    if (input._batch !== 1) throw new BatchEnvelopeError('The reserved root _batch marker must equal 1.');
    return Object.freeze({ source: 'envelope', items: envelopeItems(input, maxItems) });
  }
  // Validation is only for grammar selection. Retain raw values for the ordinary
  // per-item validator, including unknown keys and business arrays.
  if ((await standardValidate(operation, input)).ok) {
    return Object.freeze({ source: 'singleton', items: Object.freeze([Object.freeze({ itemId: 'item-1', args: input })]) });
  }
  if (declaration.legacy) {
    const parsed = await standardValidate(declaration.legacy.schema, input);
    if (parsed.ok) {
      const args = declaration.legacy.toOperation(parsed.value);
      if (!isObject(args)) throw new BatchEnvelopeError('Legacy adapter must return one operation object.');
      return Object.freeze({ source: 'legacy', items: Object.freeze([Object.freeze({ itemId: 'item-1', args })]) });
    }
  }
  if (Object.hasOwn(input, 'items')) {
    // Recognizable framework containers reject malformed metadata globally;
    // business objects that are not containers still reach child validation.
    const candidates = toList(input.items);
    if (Array.isArray(input.items) || (isObject(input.items) && Object.hasOwn(input.items, 'args'))) {
      if (candidates.every((item) => isObject(item) && Object.hasOwn(item, 'args'))) {
        return Object.freeze({ source: 'envelope', items: envelopeItems(input, maxItems) });
      }
    }
  }
  return Object.freeze({ source: 'singleton', items: Object.freeze([Object.freeze({ itemId: 'item-1', args: input })]) });
}

/** Rebase local JSON pointers when nesting the existing operation schema. */
function nestSchema(value: unknown, prefix: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => nestSchema(entry, prefix));
  if (!isObject(value)) return value;
  // A resource with its own $id already has the correct local reference scope.
  // Literal business data in annotations must never be treated as schema nodes.
  if (typeof value.$id === 'string') return structuredClone(value);
  const literalKeys = new Set(['default', 'examples', 'example', 'const', 'enum']);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    literalKeys.has(key) ? structuredClone(child)
      : (key === '$ref' || key === '$dynamicRef') && typeof child === 'string' && (child === '#' || child.startsWith('#/'))
      ? prefix + child.slice(1)
      : nestSchema(child, prefix),
  ]));
}

/** Root union/ref branches may not claim the framework marker as business data. */
function declaresMarker(schema: Record<string, unknown>, root = schema, seen = new Set<unknown>()): boolean {
  if (seen.has(schema)) return false;
  seen.add(schema);
  if (isObject(schema.properties) && Object.hasOwn(schema.properties, '_batch')) return true;
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    let target: unknown = root;
    for (const segment of schema.$ref.slice(2).split('/')) {
      target = isObject(target) ? target[segment.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined;
    }
    if (isObject(target) && declaresMarker(target, root, seen)) return true;
  }
  return ['allOf', 'anyOf', 'oneOf'].some((key) => Array.isArray(schema[key]) &&
    (schema[key] as unknown[]).some((branch) => isObject(branch) && declaresMarker(branch, root, seen))) ||
    ['if', 'then', 'else'].some((key) => isObject(schema[key]) && declaresMarker(schema[key], root, seen));
}

/** Refuse operation contracts that cannot accept the required args object. */
export function assertBatchOperationSchema(schema: Record<string, unknown>): void {
  const permitsObject = (node: unknown, seen = new Set<unknown>()): boolean => {
    if (node === false) return false;
    if (!isObject(node) || seen.has(node)) return true;
    const visited = new Set(seen).add(node);
    if (node.type !== undefined && node.type !== 'object' &&
      !(Array.isArray(node.type) && node.type.includes('object'))) return false;
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
      let target: unknown = schema;
      for (const segment of node.$ref.slice(2).split('/')) {
        target = isObject(target) ? target[segment.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined;
      }
      if (!permitsObject(target, visited)) return false;
    }
    if (Array.isArray(node.allOf) && !node.allOf.every((branch) => permitsObject(branch, visited))) return false;
    return ['anyOf', 'oneOf'].every((key) => !Array.isArray(node[key]) ||
      (node[key] as unknown[]).some((branch) => permitsObject(branch, visited)));
  };
  if (!permitsObject(schema)) throw new Error('Batch operations require an object args schema; declare an explicit object operation adapter.');
}

export function createToolBatchContract(
  operation: StandardSchemaV1,
  operationJsonSchema: Record<string, unknown>,
  declaration: ToolBatchDeclaration = {},
  legacyJsonSchema?: Record<string, unknown>,
): ToolBatchContract {
  const resolved = resolveToolBatchDeclaration(declaration);
  assertBatchOperationSchema(operationJsonSchema);
  if (declaresMarker(operationJsonSchema) || (legacyJsonSchema && declaresMarker(legacyJsonSchema))) {
    throw new Error('Root _batch is reserved; declare a nested-args operation adapter for business _batch data.');
  }
  const itemSchema = {
    type: 'object',
    properties: {
      itemId: { type: 'string', minLength: 1, maxLength: BATCH_ITEM_ID_MAX_LENGTH },
      args: { type: 'object', allOf: [{ $ref: '#/$defs/operation' }] },
    },
    required: ['args'],
    additionalProperties: false,
  };
  const envelopeSchema = {
    type: 'object',
    properties: {
      _batch: { const: 1 },
      items: { anyOf: [{ type: 'array', minItems: 1, maxItems: resolved.maxItems, items: itemSchema }, itemSchema] },
    },
    required: ['items'],
    additionalProperties: false,
  };
  const withoutMarker = { not: { required: ['_batch'] } };
  const requestJsonSchema = {
    type: 'object',
    $defs: {
      operation: nestSchema(operationJsonSchema, '#/$defs/operation'),
      ...(legacyJsonSchema ? { legacy: nestSchema(legacyJsonSchema, '#/$defs/legacy') } : {}),
    },
    anyOf: [
      envelopeSchema,
      { allOf: [{ $ref: '#/$defs/operation' }, withoutMarker] },
      ...(legacyJsonSchema ? [{ allOf: [{ $ref: '#/$defs/legacy' }, withoutMarker] }] : []),
    ],
  };
  return Object.freeze({
    requestJsonSchema,
    resultJsonSchema: batchResultJsonSchema(),
    normalize: (input: unknown) => normalizeBatchRequest(input, operation, resolved),
  });
}

/** Only the framework envelope is specified here; child ToolResults remain intact. */
export function batchResultJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      batchId: { type: 'string', minLength: 1 },
      results: { type: 'array', items: {
        type: 'object',
        properties: {
          itemId: { type: 'string', minLength: 1, maxLength: BATCH_ITEM_ID_MAX_LENGTH },
          ok: { type: 'boolean' },
          status: { enum: ['completed', 'failed', 'cancelled', 'not-started', 'unknown-effect'] },
          output: { type: 'object' },
          error: {},
          receipt: {},
        },
        required: ['itemId', 'ok', 'status'],
        additionalProperties: false,
      } },
      counts: {
        type: 'object',
        properties: { ok: { type: 'integer', minimum: 0 }, failed: { type: 'integer', minimum: 0 } },
        required: ['ok', 'failed'],
        additionalProperties: false,
      },
    },
    required: ['ok', 'batchId', 'results', 'counts'],
    additionalProperties: false,
  };
}
