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
export type { ToolResult, RolesQuota, ProgressCallback, EmitCallback, } from './wire';
export type { SeeAlso, SeeAlsoEntry, SeeAlsoPointer } from './see-also';
export { applySeeAlso, resolveSeeAlso, renderSeeAlsoText, readJsonResult, } from './see-also';
export type { ResultAnnotator } from './result-annotator';
export { setResultAnnotator, resetResultAnnotator, applyResultAnnotator, } from './result-annotator';
export type { AgentRole, RoleRegistry, Capability, PluginSpawn, PluginSpawnOptions, PluginSpawnResult, } from './host-types';
export { defineTool } from './define-tool';
export { applyPayloadTier, extractPayloadTier, parsePayloadTier, resolvePayloadTier, resetPayloadTierRatchet, PAYLOAD_TIERS, PAYLOAD_TIER_RATCHET_CHARS, type PayloadTier, type PayloadShapers, type PayloadShaperCtx, } from './payload-tier';
export { defineResource } from './define-resource';
export { definePrompt } from './define-prompt';
export { serializeToolResponse, formatOptsFromCtx, type SerializeFormatOpts, type SerializedToolResult, } from './serialize-result';
export { parseDeltaRequest, formatDeltaRequest, encodeDeltaCursor, decodeDeltaCursor, computeViewFingerprint, contentRevision, negotiateDelta, setSemanticDeltaEnabledResolver, resetSemanticDeltaEnabledResolver, isSemanticDeltaEnabled, computeRowDigest, computeViewChecksum, diffFromDigest, applySemanticDelta, deltaCounts, DELTA_SMALL_RESPONSE_BYTES, DELTA_MAX_DIGEST_ENTRIES, type DeltaMode, type DeltaRequest, type DeltaCursorPayload, type DeltaCapability, type DeltaChange, type DeltaNegotiation, type NegotiatedDeltaMode, type DeltaFullReason, } from './delta-protocol';
export { getCatalog, lookup, _resetCatalogForTests } from './registry';
export { defineGroup, registerGroup, lookupGroup, getGroupCatalog, _resetGroupCatalogForTests, type GroupDefinition, type GroupDefinitionInput, } from './define-group';
export { groupOf, describeGroupFromMembers, catalogueProjection, renderCapabilityMap, declaredGroupSlugs, type CatalogueEntry, type RenderCapabilityMapOptions, } from './catalogue-projection';
export * from './code-orchestration';
export { collectToolEmits, getCollectedToolEmits, _resetCollectedToolEmitsForTests, type CollectedToolEmits, } from './emits-registry';
export { getResourceCatalog, lookupResource, matchResource, _resetResourceCatalogForTests, } from './resource-registry';
export { getPromptCatalog, lookupPrompt, _resetPromptCatalogForTests, } from './prompt-registry';
export { SLASH_PROMPT_PREFIX, resolveSlashExposure, slashPromptNameFor, isSlashPromptName, slashPromptToolName, deriveSlashPromptArguments, slashPromptListingFor, renderSlashPrompt, } from './slash-projection';
export type { SlashPromptListing } from './slash-projection';
export { onWorkspaceSwitch, dispatchWorkspaceSwitch, } from './workspace-lifecycle';
export type { WorkspaceSwitchCallback } from './workspace-lifecycle';
export { openRun, closeRun, setOpenCards, setToolState, getSnapshot, subscribe as subscribeStateChannel, subscribeWorkspace, snapshotWorkspace, dropStateSnapshotsForWorkspaceSwitch, _resetStateChannelForTests, } from './state-channel';
export type { StateSnapshot, VersionedSnapshot, } from './state-channel';
export { diffSnapshot, applySnapshotDelta, chooseSnapshotEmission } from './state-delta';
export type { SnapshotDelta, SnapshotEmission } from './state-delta';
export { DeltaToolClient, dispatchWithDelta, dispatchWithConveyedDelta } from './delta-client';
export type { DeltaResponse, DeltaIngestResult, DeltaDispatch, DeltaDispatchResult } from './delta-client';
export { BasePresenceTracker, dispatchWithBasePresence } from './base-presence';
export type { BasePresenceOptions, DeltaMode as BasePresenceDeltaMode } from './base-presence';
export { negotiateRowsDelta } from './rows-delta';
export type { RowsDeltaResult } from './rows-delta';
export { registerCard, resolveCardResponse, cancelPendingCardsForRun, cancelPendingCardsForWorkspaceSwitch, _resetCardCorrelatorForTests, } from './card-correlator';
export { tierFor, setCapabilityTierResolver, defaultTierResolver, type CapabilityTierResolver, } from './capability-tiers';
export { toJsonSchema, setJsonSchemaAdapter, zodJsonSchemaAdapter, type JsonSchemaAdapter, } from './schema-adapter';
export { standardValidate, validateSync, formatIssues, type StandardSchemaV1, type ValidationResult, } from './standard-schema';
export { registerProjectedTool, unregisterProjectedToolsForPlugin, toolDeclaresGate, listUngatedProjectedTools, lookupByMcpName, lookupByHttpPath, listAllProjectedTools, listMcpProjections, ToolRegistrationError, emitToSseSink, isPapercuspBinaryEnvelope, _resetProjectionRegistryForTests, type ProjectedTool, type ToolFn, type ToolExposure, type ToolExposureHttp, type ToolExposureMcp, type ToolExposureSlash, type UnifiedToolContext, type GateBypass, type RequestOriginMetadata, type MinimalEventSink, type PapercuspBinaryEnvelope, type EventWireKind, } from './tool-projection';
export { dispatchProjectedTool, dispatchProjectedToolStream, defaultComputeQuotaWindow, UnauthorizedToolError, HarnessRequiredError, InvalidInputError, PASS_THROUGH, type QuotaWindow, type DispatchProjectedDeps, type DispatchProjectedResult, type DispatchProjectedErrorCode, type DispatchStreamEvent, type PostInvokeEvent, type CapabilityEnvelopeVerdict, type ToolDispatchOverrideFn, } from './dispatch-projected';
export { ownerOnly } from './authz';
export type { AuthzQuery, AuthDecision, PolicyDecisionPoint, AuthAuditEvent, Authorizer, } from './authz';
export type { Principal, PrincipalKind, PrincipalAuthMethod, PrincipalTrust, PrincipalRequirements, RouteAuth, RouteMethod, RouteContext, RouteDefinition, CapabilityTier, ToolContext, ToolDefinition, ToolDefinitionInput, ToolEmitSpec, ToolEventLike, ToolResponse, UIResourceContent, ResourceContext, ResourceContents, ResourceDefinition, ResourceListEntry, PromptContext, PromptDefinition, PromptMessage, PromptResult, CardSpec, CardResponse, CardPresentation, CardOption, OpenCardSnapshot, } from './types';
export type { ToolRequireSpec, ToolPreInvokeEvent, PreconditionFireRequest, } from './requires';
export { readBuffer as readReplayBuffer, closeBuffer as closeReplayBuffer, replayBufferStats, type BufferedEvent as ReplayBufferedEvent, type ReplayBufferWriter, } from './replay-buffer';
export { toolToOpenApiFragment, componentKey, standardResponseComponents, type OpenApiFragment, } from './openapi-fragments';
export { assembleOpenApiDocument, toolOperationName, type OpenApiDocumentOptions, } from './openapi-assemble';
