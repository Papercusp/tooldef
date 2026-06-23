/**
 * @papercusp/tooldef — a function-as-truth tool framework.
 *
 * Write one typed `(input, ctx) => ToolResult` function; the framework
 * projects it onto HTTP, MCP, IPC, and in-process transports with uniform
 * auth/role/quota/telemetry/streaming. Schema-agnostic (Standard Schema is
 * Phase 3), host-agnostic (every side effect is injected via deps).
 *
 * Extraction status — plan
 * `apps/operator/docs/plans/papercusp-tooldef-extraction-2026-05-29.md`.
 * Phase 1 landed the wire types; Phase 2 (this) moves the engine here. The
 * Papercusp host adapter (`@papercusp/agent-mcp`) re-exports this surface and
 * supplies the deps (PG tx, telemetry, role config, HMAC signing, …).
 */

/* ─── Wire + host seams ──────────────────────────────────────────────── */
export type {
  ToolResult,
  RolesQuota,
  ProgressCallback,
  EmitCallback,
} from './wire';
export type {
  AgentRole,
  RoleRegistry,
  Capability,
  PluginSpawn,
  PluginSpawnOptions,
  PluginSpawnResult,
} from './host-types';

/* ─── defineTool + sibling authoring primitives ──────────────────────── */
export { defineTool } from './define-tool';
export { defineResource } from './define-resource';
export { definePrompt } from './define-prompt';

/* ─── Result serialization (token-efficient formats) ─────────────────── */
export {
  serializeToolResponse,
  formatOptsFromCtx,
  type SerializeFormatOpts,
  type SerializedToolResult,
} from './serialize-result';

/* ─── Delta protocol — agent tool result freshness negotiation ───────── */
export {
  parseDeltaRequest,
  formatDeltaRequest,
  encodeDeltaCursor,
  decodeDeltaCursor,
  computeViewFingerprint,
  contentRevision,
  negotiateDelta,
  setSemanticDeltaEnabledResolver,
  resetSemanticDeltaEnabledResolver,
  isSemanticDeltaEnabled,
  computeRowDigest,
  computeViewChecksum,
  diffFromDigest,
  applySemanticDelta,
  deltaCounts,
  DELTA_SMALL_RESPONSE_BYTES,
  DELTA_MAX_DIGEST_ENTRIES,
  type DeltaMode,
  type DeltaRequest,
  type DeltaCursorPayload,
  type DeltaCapability,
  type DeltaChange,
  type DeltaNegotiation,
  type NegotiatedDeltaMode,
  type DeltaFullReason,
} from './delta-protocol';

/* ─── Registries ─────────────────────────────────────────────────────── */
export { getCatalog, lookup, _resetCatalogForTests } from './registry';

/* ─── Code-execution tool-orchestration runtime (B-CX-1A / B-CX-2A) ────── */
export * from './code-orchestration';
export {
  collectToolEmits,
  getCollectedToolEmits,
  _resetCollectedToolEmitsForTests,
  type CollectedToolEmits,
} from './emits-registry';
export {
  getResourceCatalog,
  lookupResource,
  matchResource,
  _resetResourceCatalogForTests,
} from './resource-registry';
export {
  getPromptCatalog,
  lookupPrompt,
  _resetPromptCatalogForTests,
} from './prompt-registry';
export {
  SLASH_PROMPT_PREFIX,
  resolveSlashExposure,
  slashPromptNameFor,
  isSlashPromptName,
  slashPromptToolName,
  deriveSlashPromptArguments,
  slashPromptListingFor,
  renderSlashPrompt,
} from './slash-projection';
export type { SlashPromptListing } from './slash-projection';

/* ─── Run / workspace lifecycle ──────────────────────────────────────── */
export {
  onWorkspaceSwitch,
  dispatchWorkspaceSwitch,
} from './workspace-lifecycle';
export type { WorkspaceSwitchCallback } from './workspace-lifecycle';

/* ─── State channel (publishState, snapshots) ────────────────────────── */
export {
  openRun,
  closeRun,
  setOpenCards,
  setToolState,
  getSnapshot,
  subscribe as subscribeStateChannel,
  subscribeWorkspace,
  snapshotWorkspace,
  dropStateSnapshotsForWorkspaceSwitch,
  _resetStateChannelForTests,
} from './state-channel';
export type {
  StateSnapshot,
  VersionedSnapshot,
} from './state-channel';

/* ─── State-channel deltas (agent-tool-delta-protocol P-009) ─────────────── */
export { diffSnapshot, applySnapshotDelta, chooseSnapshotEmission } from './state-delta';
export type { SnapshotDelta, SnapshotEmission } from './state-delta';

/* ─── Tool-result delta CLIENT (agent-tool-delta-protocol follow-up — the missing half) ─── */
export { DeltaToolClient, dispatchWithDelta, dispatchWithConveyedDelta } from './delta-client';
export type { DeltaResponse, DeltaIngestResult, DeltaDispatch, DeltaDispatchResult } from './delta-client';
// Harness-side base-presence tracker (the D-006 "harness owns the base" half — when is not_modified/delta safe) — P-003.
export { BasePresenceTracker } from './base-presence';
export type { BasePresenceOptions, DeltaMode } from './base-presence';
// Server-side rows-array delta negotiation (the sync-resolver/SSE sibling of negotiateToolDelta) — P-006.
export { negotiateRowsDelta } from './rows-delta';
export type { RowsDeltaResult } from './rows-delta';

/* ─── Card correlator (ctx.askUser) ──────────────────────────────────── */
export {
  registerCard,
  resolveCardResponse,
  cancelPendingCardsForRun,
  cancelPendingCardsForWorkspaceSwitch,
  _resetCardCorrelatorForTests,
} from './card-correlator';

/* ─── Capability tiers ───────────────────────────────────────────────── */
export {
  tierFor,
  setCapabilityTierResolver,
  defaultTierResolver,
  type CapabilityTierResolver,
} from './capability-tiers';

/* ─── Schema → JSON-Schema adapter (pluggable; default Zod) ───────────── */
export {
  toJsonSchema,
  setJsonSchemaAdapter,
  zodJsonSchemaAdapter,
  type JsonSchemaAdapter,
} from './schema-adapter';

/* ─── Standard Schema validation (validator-agnostic) ────────────────── */
export {
  standardValidate,
  validateSync,
  formatIssues,
  type StandardSchemaV1,
  type ValidationResult,
} from './standard-schema';

/* ─── Projected-tool registry (the function-as-truth core) ───────────── */
export {
  registerProjectedTool,
  unregisterProjectedToolsForPlugin,
  toolDeclaresGate,
  listUngatedProjectedTools,
  lookupByMcpName,
  lookupByHttpPath,
  listAllProjectedTools,
  listMcpProjections,
  ToolRegistrationError,
  emitToSseSink,
  isPapercuspBinaryEnvelope,
  _resetProjectionRegistryForTests,
  type ProjectedTool,
  type ToolFn,
  type ToolExposure,
  type ToolExposureHttp,
  type ToolExposureMcp,
  type ToolExposureSlash,
  type UnifiedToolContext,
  type GateBypass,
  type MinimalEventSink,
  type PapercuspBinaryEnvelope,
  type EventWireKind,
} from './tool-projection';

/* ─── Dispatcher ─────────────────────────────────────────────────────── */
export {
  dispatchProjectedTool,
  dispatchProjectedToolStream,
  defaultComputeQuotaWindow,
  UnauthorizedToolError,
  HarnessRequiredError,
  InvalidInputError,
  PASS_THROUGH,
  type QuotaWindow,
  type DispatchProjectedDeps,
  type DispatchProjectedResult,
  type DispatchProjectedErrorCode,
  type DispatchStreamEvent,
  type PostInvokeEvent,
  type CapabilityEnvelopeVerdict,
  type ToolDispatchOverrideFn,
} from './dispatch-projected';

/* ─── Resource authorization (RFC tooldef-auth-rfc Phase 1 — contract only) ─── */
export { ownerOnly } from './authz';
export type {
  AuthzQuery,
  AuthDecision,
  PolicyDecisionPoint,
  AuthAuditEvent,
  Authorizer,
} from './authz';

/* ─── Core types ─────────────────────────────────────────────────────── */
export type {
  Principal,
  PrincipalKind,
  PrincipalAuthMethod,
  PrincipalTrust,
  PrincipalRequirements,
  RouteAuth,
  RouteMethod,
  RouteContext,
  RouteDefinition,
  CapabilityTier,
  ToolContext,
  ToolDefinition,
  ToolDefinitionInput,
  ToolEmitSpec,
  ToolEventLike,
  ToolResponse,
  UIResourceContent,
  ResourceContext,
  ResourceContents,
  ResourceDefinition,
  ResourceListEntry,
  PromptContext,
  PromptDefinition,
  PromptMessage,
  PromptResult,
  CardSpec,
  CardResponse,
  CardPresentation,
  CardOption,
  OpenCardSnapshot,
} from './types';

/* ─── Declarative preconditions (`requires:` — D-006) ────────────────── */
export type {
  ToolRequireSpec,
  ToolPreInvokeEvent,
  PreconditionFireRequest,
} from './requires';

/* ─── Replay buffer ──────────────────────────────────────────────────── */
export {
  readBuffer as readReplayBuffer,
  closeBuffer as closeReplayBuffer,
  replayBufferStats,
  type BufferedEvent as ReplayBufferedEvent,
  type ReplayBufferWriter,
} from './replay-buffer';

/* ─── OpenAPI assembly ───────────────────────────────────────────────── */
export {
  toolToOpenApiFragment,
  componentKey,
  standardResponseComponents,
  type OpenApiFragment,
} from './openapi-fragments';
export {
  assembleOpenApiDocument,
  toolOperationName,
  type OpenApiDocumentOptions,
} from './openapi-assemble';
