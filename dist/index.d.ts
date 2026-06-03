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
export type { AgentRole, RoleRegistry, Capability, PluginSpawn, PluginSpawnOptions, PluginSpawnResult, } from './host-types';
export { defineTool } from './define-tool';
export { defineResource } from './define-resource';
export { definePrompt } from './define-prompt';
export { getCatalog, lookup, _resetCatalogForTests } from './registry';
export { getResourceCatalog, lookupResource, matchResource, _resetResourceCatalogForTests, } from './resource-registry';
export { getPromptCatalog, lookupPrompt, _resetPromptCatalogForTests, } from './prompt-registry';
export { onWorkspaceSwitch, dispatchWorkspaceSwitch, } from './workspace-lifecycle';
export type { WorkspaceSwitchCallback } from './workspace-lifecycle';
export { openRun, closeRun, setOpenCards, setToolState, getSnapshot, subscribe as subscribeStateChannel, subscribeWorkspace, snapshotWorkspace, dropStateSnapshotsForWorkspaceSwitch, _resetStateChannelForTests, } from './state-channel';
export type { StateSnapshot, VersionedSnapshot, } from './state-channel';
export { registerCard, resolveCardResponse, cancelPendingCardsForRun, cancelPendingCardsForWorkspaceSwitch, _resetCardCorrelatorForTests, } from './card-correlator';
export { tierFor, setCapabilityTierResolver, defaultTierResolver, type CapabilityTierResolver, } from './capability-tiers';
export { toJsonSchema, setJsonSchemaAdapter, zodJsonSchemaAdapter, type JsonSchemaAdapter, } from './schema-adapter';
export { standardValidate, validateSync, formatIssues, type StandardSchemaV1, type ValidationResult, } from './standard-schema';
export { registerProjectedTool, unregisterProjectedToolsForPlugin, toolDeclaresGate, listUngatedProjectedTools, lookupByMcpName, lookupByHttpPath, listAllProjectedTools, listMcpProjections, ToolRegistrationError, emitToSseSink, isPapercuspBinaryEnvelope, _resetProjectionRegistryForTests, type ProjectedTool, type ToolFn, type ToolExposure, type ToolExposureHttp, type ToolExposureMcp, type UnifiedToolContext, type GateBypass, type MinimalEventSink, type PapercuspBinaryEnvelope, type EventWireKind, } from './tool-projection';
export { dispatchProjectedTool, dispatchProjectedToolStream, defaultComputeQuotaWindow, UnauthorizedToolError, HarnessRequiredError, PASS_THROUGH, type QuotaWindow, type DispatchProjectedDeps, type DispatchProjectedResult, type DispatchProjectedErrorCode, type DispatchStreamEvent, type ToolDispatchOverrideFn, } from './dispatch-projected';
export { ownerOnly } from './authz';
export type { AuthzQuery, AuthDecision, PolicyDecisionPoint, AuthAuditEvent, Authorizer, } from './authz';
export type { Principal, PrincipalKind, PrincipalAuthMethod, PrincipalTrust, PrincipalRequirements, RouteAuth, RouteMethod, RouteContext, RouteDefinition, CapabilityTier, ToolContext, ToolDefinition, ToolDefinitionInput, ToolResponse, UIResourceContent, ResourceContext, ResourceContents, ResourceDefinition, ResourceListEntry, PromptContext, PromptDefinition, PromptMessage, PromptResult, CardSpec, CardResponse, CardPresentation, CardOption, OpenCardSnapshot, } from './types';
export { readBuffer as readReplayBuffer, closeBuffer as closeReplayBuffer, replayBufferStats, type BufferedEvent as ReplayBufferedEvent, type ReplayBufferWriter, } from './replay-buffer';
export { toolToOpenApiFragment, componentKey, standardResponseComponents, type OpenApiFragment, } from './openapi-fragments';
export { assembleOpenApiDocument, toolOperationName, type OpenApiDocumentOptions, } from './openapi-assemble';
