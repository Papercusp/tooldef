"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectToolEmits = exports.declaredGroupSlugs = exports.renderCapabilityMap = exports.catalogueProjection = exports.describeGroupFromMembers = exports.groupOf = exports._resetGroupCatalogForTests = exports.getGroupCatalog = exports.lookupGroup = exports.registerGroup = exports.defineGroup = exports._resetCatalogForTests = exports.lookup = exports.getCatalog = exports.DELTA_MAX_DIGEST_ENTRIES = exports.DELTA_SMALL_RESPONSE_BYTES = exports.deltaCounts = exports.applySemanticDelta = exports.diffFromDigest = exports.computeViewChecksum = exports.computeRowDigest = exports.isSemanticDeltaEnabled = exports.resetSemanticDeltaEnabledResolver = exports.setSemanticDeltaEnabledResolver = exports.negotiateDelta = exports.contentRevision = exports.computeViewFingerprint = exports.decodeDeltaCursor = exports.encodeDeltaCursor = exports.formatDeltaRequest = exports.parseDeltaRequest = exports.formatOptsFromCtx = exports.serializeToolResponse = exports.definePrompt = exports.defineResource = exports.PAYLOAD_TIER_RATCHET_CHARS = exports.PAYLOAD_TIERS = exports.resetPayloadTierRatchet = exports.resolvePayloadTier = exports.parsePayloadTier = exports.extractPayloadTier = exports.applyPayloadTier = exports.defineTool = exports.applyResultAnnotator = exports.resetResultAnnotator = exports.setResultAnnotator = exports.readJsonResult = exports.renderSeeAlsoText = exports.resolveSeeAlso = exports.applySeeAlso = void 0;
exports.standardValidate = exports.zodJsonSchemaAdapter = exports.setJsonSchemaAdapter = exports.toJsonSchema = exports.defaultTierResolver = exports.setCapabilityTierResolver = exports.tierFor = exports._resetCardCorrelatorForTests = exports.cancelPendingCardsForWorkspaceSwitch = exports.cancelPendingCardsForRun = exports.resolveCardResponse = exports.registerCard = exports.negotiateRowsDelta = exports.dispatchWithBasePresence = exports.BasePresenceTracker = exports.dispatchWithConveyedDelta = exports.dispatchWithDelta = exports.DeltaToolClient = exports.chooseSnapshotEmission = exports.applySnapshotDelta = exports.diffSnapshot = exports._resetStateChannelForTests = exports.dropStateSnapshotsForWorkspaceSwitch = exports.snapshotWorkspace = exports.subscribeWorkspace = exports.subscribeStateChannel = exports.getSnapshot = exports.setToolState = exports.setOpenCards = exports.closeRun = exports.openRun = exports.dispatchWorkspaceSwitch = exports.onWorkspaceSwitch = exports.renderSlashPrompt = exports.slashPromptListingFor = exports.deriveSlashPromptArguments = exports.slashPromptToolName = exports.isSlashPromptName = exports.slashPromptNameFor = exports.resolveSlashExposure = exports.SLASH_PROMPT_PREFIX = exports._resetPromptCatalogForTests = exports.lookupPrompt = exports.getPromptCatalog = exports._resetResourceCatalogForTests = exports.matchResource = exports.lookupResource = exports.getResourceCatalog = exports._resetCollectedToolEmitsForTests = exports.getCollectedToolEmits = void 0;
exports.toolOperationName = exports.assembleOpenApiDocument = exports.standardResponseComponents = exports.componentKey = exports.toolToOpenApiFragment = exports.replayBufferStats = exports.closeReplayBuffer = exports.readReplayBuffer = exports.ownerOnly = exports.PASS_THROUGH = exports.InvalidInputError = exports.HarnessRequiredError = exports.UnauthorizedToolError = exports.defaultComputeQuotaWindow = exports.dispatchProjectedToolStream = exports.dispatchProjectedTool = exports._resetProjectionRegistryForTests = exports.isPapercuspBinaryEnvelope = exports.emitToSseSink = exports.ToolRegistrationError = exports.listMcpProjections = exports.listAllProjectedTools = exports.lookupByHttpPath = exports.lookupByMcpName = exports.listUngatedProjectedTools = exports.toolDeclaresGate = exports.unregisterProjectedToolsForPlugin = exports.registerProjectedTool = exports.formatIssues = exports.validateSync = void 0;
var see_also_1 = require("./see-also");
Object.defineProperty(exports, "applySeeAlso", { enumerable: true, get: function () { return see_also_1.applySeeAlso; } });
Object.defineProperty(exports, "resolveSeeAlso", { enumerable: true, get: function () { return see_also_1.resolveSeeAlso; } });
Object.defineProperty(exports, "renderSeeAlsoText", { enumerable: true, get: function () { return see_also_1.renderSeeAlsoText; } });
Object.defineProperty(exports, "readJsonResult", { enumerable: true, get: function () { return see_also_1.readJsonResult; } });
var result_annotator_1 = require("./result-annotator");
Object.defineProperty(exports, "setResultAnnotator", { enumerable: true, get: function () { return result_annotator_1.setResultAnnotator; } });
Object.defineProperty(exports, "resetResultAnnotator", { enumerable: true, get: function () { return result_annotator_1.resetResultAnnotator; } });
Object.defineProperty(exports, "applyResultAnnotator", { enumerable: true, get: function () { return result_annotator_1.applyResultAnnotator; } });
/* ─── defineTool + sibling authoring primitives ──────────────────────── */
var define_tool_1 = require("./define-tool");
Object.defineProperty(exports, "defineTool", { enumerable: true, get: function () { return define_tool_1.defineTool; } });
var payload_tier_1 = require("./payload-tier");
Object.defineProperty(exports, "applyPayloadTier", { enumerable: true, get: function () { return payload_tier_1.applyPayloadTier; } });
Object.defineProperty(exports, "extractPayloadTier", { enumerable: true, get: function () { return payload_tier_1.extractPayloadTier; } });
Object.defineProperty(exports, "parsePayloadTier", { enumerable: true, get: function () { return payload_tier_1.parsePayloadTier; } });
Object.defineProperty(exports, "resolvePayloadTier", { enumerable: true, get: function () { return payload_tier_1.resolvePayloadTier; } });
Object.defineProperty(exports, "resetPayloadTierRatchet", { enumerable: true, get: function () { return payload_tier_1.resetPayloadTierRatchet; } });
Object.defineProperty(exports, "PAYLOAD_TIERS", { enumerable: true, get: function () { return payload_tier_1.PAYLOAD_TIERS; } });
Object.defineProperty(exports, "PAYLOAD_TIER_RATCHET_CHARS", { enumerable: true, get: function () { return payload_tier_1.PAYLOAD_TIER_RATCHET_CHARS; } });
var define_resource_1 = require("./define-resource");
Object.defineProperty(exports, "defineResource", { enumerable: true, get: function () { return define_resource_1.defineResource; } });
var define_prompt_1 = require("./define-prompt");
Object.defineProperty(exports, "definePrompt", { enumerable: true, get: function () { return define_prompt_1.definePrompt; } });
/* ─── Result serialization (token-efficient formats) ─────────────────── */
var serialize_result_1 = require("./serialize-result");
Object.defineProperty(exports, "serializeToolResponse", { enumerable: true, get: function () { return serialize_result_1.serializeToolResponse; } });
Object.defineProperty(exports, "formatOptsFromCtx", { enumerable: true, get: function () { return serialize_result_1.formatOptsFromCtx; } });
/* ─── Delta protocol — agent tool result freshness negotiation ───────── */
var delta_protocol_1 = require("./delta-protocol");
Object.defineProperty(exports, "parseDeltaRequest", { enumerable: true, get: function () { return delta_protocol_1.parseDeltaRequest; } });
Object.defineProperty(exports, "formatDeltaRequest", { enumerable: true, get: function () { return delta_protocol_1.formatDeltaRequest; } });
Object.defineProperty(exports, "encodeDeltaCursor", { enumerable: true, get: function () { return delta_protocol_1.encodeDeltaCursor; } });
Object.defineProperty(exports, "decodeDeltaCursor", { enumerable: true, get: function () { return delta_protocol_1.decodeDeltaCursor; } });
Object.defineProperty(exports, "computeViewFingerprint", { enumerable: true, get: function () { return delta_protocol_1.computeViewFingerprint; } });
Object.defineProperty(exports, "contentRevision", { enumerable: true, get: function () { return delta_protocol_1.contentRevision; } });
Object.defineProperty(exports, "negotiateDelta", { enumerable: true, get: function () { return delta_protocol_1.negotiateDelta; } });
Object.defineProperty(exports, "setSemanticDeltaEnabledResolver", { enumerable: true, get: function () { return delta_protocol_1.setSemanticDeltaEnabledResolver; } });
Object.defineProperty(exports, "resetSemanticDeltaEnabledResolver", { enumerable: true, get: function () { return delta_protocol_1.resetSemanticDeltaEnabledResolver; } });
Object.defineProperty(exports, "isSemanticDeltaEnabled", { enumerable: true, get: function () { return delta_protocol_1.isSemanticDeltaEnabled; } });
Object.defineProperty(exports, "computeRowDigest", { enumerable: true, get: function () { return delta_protocol_1.computeRowDigest; } });
Object.defineProperty(exports, "computeViewChecksum", { enumerable: true, get: function () { return delta_protocol_1.computeViewChecksum; } });
Object.defineProperty(exports, "diffFromDigest", { enumerable: true, get: function () { return delta_protocol_1.diffFromDigest; } });
Object.defineProperty(exports, "applySemanticDelta", { enumerable: true, get: function () { return delta_protocol_1.applySemanticDelta; } });
Object.defineProperty(exports, "deltaCounts", { enumerable: true, get: function () { return delta_protocol_1.deltaCounts; } });
Object.defineProperty(exports, "DELTA_SMALL_RESPONSE_BYTES", { enumerable: true, get: function () { return delta_protocol_1.DELTA_SMALL_RESPONSE_BYTES; } });
Object.defineProperty(exports, "DELTA_MAX_DIGEST_ENTRIES", { enumerable: true, get: function () { return delta_protocol_1.DELTA_MAX_DIGEST_ENTRIES; } });
/* ─── Registries ─────────────────────────────────────────────────────── */
var registry_1 = require("./registry");
Object.defineProperty(exports, "getCatalog", { enumerable: true, get: function () { return registry_1.getCatalog; } });
Object.defineProperty(exports, "lookup", { enumerable: true, get: function () { return registry_1.lookup; } });
Object.defineProperty(exports, "_resetCatalogForTests", { enumerable: true, get: function () { return registry_1._resetCatalogForTests; } });
/* ─── Catalogue summaries (defineGroup + derived capability map) ──────── */
var define_group_1 = require("./define-group");
Object.defineProperty(exports, "defineGroup", { enumerable: true, get: function () { return define_group_1.defineGroup; } });
Object.defineProperty(exports, "registerGroup", { enumerable: true, get: function () { return define_group_1.registerGroup; } });
Object.defineProperty(exports, "lookupGroup", { enumerable: true, get: function () { return define_group_1.lookupGroup; } });
Object.defineProperty(exports, "getGroupCatalog", { enumerable: true, get: function () { return define_group_1.getGroupCatalog; } });
Object.defineProperty(exports, "_resetGroupCatalogForTests", { enumerable: true, get: function () { return define_group_1._resetGroupCatalogForTests; } });
var catalogue_projection_1 = require("./catalogue-projection");
Object.defineProperty(exports, "groupOf", { enumerable: true, get: function () { return catalogue_projection_1.groupOf; } });
Object.defineProperty(exports, "describeGroupFromMembers", { enumerable: true, get: function () { return catalogue_projection_1.describeGroupFromMembers; } });
Object.defineProperty(exports, "catalogueProjection", { enumerable: true, get: function () { return catalogue_projection_1.catalogueProjection; } });
Object.defineProperty(exports, "renderCapabilityMap", { enumerable: true, get: function () { return catalogue_projection_1.renderCapabilityMap; } });
Object.defineProperty(exports, "declaredGroupSlugs", { enumerable: true, get: function () { return catalogue_projection_1.declaredGroupSlugs; } });
/* ─── Code-execution tool-orchestration runtime (B-CX-1A / B-CX-2A) ────── */
__exportStar(require("./code-orchestration"), exports);
var emits_registry_1 = require("./emits-registry");
Object.defineProperty(exports, "collectToolEmits", { enumerable: true, get: function () { return emits_registry_1.collectToolEmits; } });
Object.defineProperty(exports, "getCollectedToolEmits", { enumerable: true, get: function () { return emits_registry_1.getCollectedToolEmits; } });
Object.defineProperty(exports, "_resetCollectedToolEmitsForTests", { enumerable: true, get: function () { return emits_registry_1._resetCollectedToolEmitsForTests; } });
var resource_registry_1 = require("./resource-registry");
Object.defineProperty(exports, "getResourceCatalog", { enumerable: true, get: function () { return resource_registry_1.getResourceCatalog; } });
Object.defineProperty(exports, "lookupResource", { enumerable: true, get: function () { return resource_registry_1.lookupResource; } });
Object.defineProperty(exports, "matchResource", { enumerable: true, get: function () { return resource_registry_1.matchResource; } });
Object.defineProperty(exports, "_resetResourceCatalogForTests", { enumerable: true, get: function () { return resource_registry_1._resetResourceCatalogForTests; } });
var prompt_registry_1 = require("./prompt-registry");
Object.defineProperty(exports, "getPromptCatalog", { enumerable: true, get: function () { return prompt_registry_1.getPromptCatalog; } });
Object.defineProperty(exports, "lookupPrompt", { enumerable: true, get: function () { return prompt_registry_1.lookupPrompt; } });
Object.defineProperty(exports, "_resetPromptCatalogForTests", { enumerable: true, get: function () { return prompt_registry_1._resetPromptCatalogForTests; } });
var slash_projection_1 = require("./slash-projection");
Object.defineProperty(exports, "SLASH_PROMPT_PREFIX", { enumerable: true, get: function () { return slash_projection_1.SLASH_PROMPT_PREFIX; } });
Object.defineProperty(exports, "resolveSlashExposure", { enumerable: true, get: function () { return slash_projection_1.resolveSlashExposure; } });
Object.defineProperty(exports, "slashPromptNameFor", { enumerable: true, get: function () { return slash_projection_1.slashPromptNameFor; } });
Object.defineProperty(exports, "isSlashPromptName", { enumerable: true, get: function () { return slash_projection_1.isSlashPromptName; } });
Object.defineProperty(exports, "slashPromptToolName", { enumerable: true, get: function () { return slash_projection_1.slashPromptToolName; } });
Object.defineProperty(exports, "deriveSlashPromptArguments", { enumerable: true, get: function () { return slash_projection_1.deriveSlashPromptArguments; } });
Object.defineProperty(exports, "slashPromptListingFor", { enumerable: true, get: function () { return slash_projection_1.slashPromptListingFor; } });
Object.defineProperty(exports, "renderSlashPrompt", { enumerable: true, get: function () { return slash_projection_1.renderSlashPrompt; } });
/* ─── Run / workspace lifecycle ──────────────────────────────────────── */
var workspace_lifecycle_1 = require("./workspace-lifecycle");
Object.defineProperty(exports, "onWorkspaceSwitch", { enumerable: true, get: function () { return workspace_lifecycle_1.onWorkspaceSwitch; } });
Object.defineProperty(exports, "dispatchWorkspaceSwitch", { enumerable: true, get: function () { return workspace_lifecycle_1.dispatchWorkspaceSwitch; } });
/* ─── State channel (publishState, snapshots) ────────────────────────── */
var state_channel_1 = require("./state-channel");
Object.defineProperty(exports, "openRun", { enumerable: true, get: function () { return state_channel_1.openRun; } });
Object.defineProperty(exports, "closeRun", { enumerable: true, get: function () { return state_channel_1.closeRun; } });
Object.defineProperty(exports, "setOpenCards", { enumerable: true, get: function () { return state_channel_1.setOpenCards; } });
Object.defineProperty(exports, "setToolState", { enumerable: true, get: function () { return state_channel_1.setToolState; } });
Object.defineProperty(exports, "getSnapshot", { enumerable: true, get: function () { return state_channel_1.getSnapshot; } });
Object.defineProperty(exports, "subscribeStateChannel", { enumerable: true, get: function () { return state_channel_1.subscribe; } });
Object.defineProperty(exports, "subscribeWorkspace", { enumerable: true, get: function () { return state_channel_1.subscribeWorkspace; } });
Object.defineProperty(exports, "snapshotWorkspace", { enumerable: true, get: function () { return state_channel_1.snapshotWorkspace; } });
Object.defineProperty(exports, "dropStateSnapshotsForWorkspaceSwitch", { enumerable: true, get: function () { return state_channel_1.dropStateSnapshotsForWorkspaceSwitch; } });
Object.defineProperty(exports, "_resetStateChannelForTests", { enumerable: true, get: function () { return state_channel_1._resetStateChannelForTests; } });
/* ─── State-channel deltas (agent-tool-delta-protocol P-009) ─────────────── */
var state_delta_1 = require("./state-delta");
Object.defineProperty(exports, "diffSnapshot", { enumerable: true, get: function () { return state_delta_1.diffSnapshot; } });
Object.defineProperty(exports, "applySnapshotDelta", { enumerable: true, get: function () { return state_delta_1.applySnapshotDelta; } });
Object.defineProperty(exports, "chooseSnapshotEmission", { enumerable: true, get: function () { return state_delta_1.chooseSnapshotEmission; } });
/* ─── Tool-result delta CLIENT (agent-tool-delta-protocol follow-up — the missing half) ─── */
var delta_client_1 = require("./delta-client");
Object.defineProperty(exports, "DeltaToolClient", { enumerable: true, get: function () { return delta_client_1.DeltaToolClient; } });
Object.defineProperty(exports, "dispatchWithDelta", { enumerable: true, get: function () { return delta_client_1.dispatchWithDelta; } });
Object.defineProperty(exports, "dispatchWithConveyedDelta", { enumerable: true, get: function () { return delta_client_1.dispatchWithConveyedDelta; } });
// Harness-side base-presence tracker (the D-006 "harness owns the base" half — when is not_modified/delta safe) — P-003.
// `dispatchWithBasePresence` is the one-call turn-wrapper integration seam (tracker + client + guarded dispatch).
var base_presence_1 = require("./base-presence");
Object.defineProperty(exports, "BasePresenceTracker", { enumerable: true, get: function () { return base_presence_1.BasePresenceTracker; } });
Object.defineProperty(exports, "dispatchWithBasePresence", { enumerable: true, get: function () { return base_presence_1.dispatchWithBasePresence; } });
// Server-side rows-array delta negotiation (the sync-resolver/SSE sibling of negotiateToolDelta) — P-006.
var rows_delta_1 = require("./rows-delta");
Object.defineProperty(exports, "negotiateRowsDelta", { enumerable: true, get: function () { return rows_delta_1.negotiateRowsDelta; } });
/* ─── Card correlator (ctx.askUser) ──────────────────────────────────── */
var card_correlator_1 = require("./card-correlator");
Object.defineProperty(exports, "registerCard", { enumerable: true, get: function () { return card_correlator_1.registerCard; } });
Object.defineProperty(exports, "resolveCardResponse", { enumerable: true, get: function () { return card_correlator_1.resolveCardResponse; } });
Object.defineProperty(exports, "cancelPendingCardsForRun", { enumerable: true, get: function () { return card_correlator_1.cancelPendingCardsForRun; } });
Object.defineProperty(exports, "cancelPendingCardsForWorkspaceSwitch", { enumerable: true, get: function () { return card_correlator_1.cancelPendingCardsForWorkspaceSwitch; } });
Object.defineProperty(exports, "_resetCardCorrelatorForTests", { enumerable: true, get: function () { return card_correlator_1._resetCardCorrelatorForTests; } });
/* ─── Capability tiers ───────────────────────────────────────────────── */
var capability_tiers_1 = require("./capability-tiers");
Object.defineProperty(exports, "tierFor", { enumerable: true, get: function () { return capability_tiers_1.tierFor; } });
Object.defineProperty(exports, "setCapabilityTierResolver", { enumerable: true, get: function () { return capability_tiers_1.setCapabilityTierResolver; } });
Object.defineProperty(exports, "defaultTierResolver", { enumerable: true, get: function () { return capability_tiers_1.defaultTierResolver; } });
/* ─── Schema → JSON-Schema adapter (pluggable; default Zod) ───────────── */
var schema_adapter_1 = require("./schema-adapter");
Object.defineProperty(exports, "toJsonSchema", { enumerable: true, get: function () { return schema_adapter_1.toJsonSchema; } });
Object.defineProperty(exports, "setJsonSchemaAdapter", { enumerable: true, get: function () { return schema_adapter_1.setJsonSchemaAdapter; } });
Object.defineProperty(exports, "zodJsonSchemaAdapter", { enumerable: true, get: function () { return schema_adapter_1.zodJsonSchemaAdapter; } });
/* ─── Standard Schema validation (validator-agnostic) ────────────────── */
var standard_schema_1 = require("./standard-schema");
Object.defineProperty(exports, "standardValidate", { enumerable: true, get: function () { return standard_schema_1.standardValidate; } });
Object.defineProperty(exports, "validateSync", { enumerable: true, get: function () { return standard_schema_1.validateSync; } });
Object.defineProperty(exports, "formatIssues", { enumerable: true, get: function () { return standard_schema_1.formatIssues; } });
/* ─── Projected-tool registry (the function-as-truth core) ───────────── */
var tool_projection_1 = require("./tool-projection");
Object.defineProperty(exports, "registerProjectedTool", { enumerable: true, get: function () { return tool_projection_1.registerProjectedTool; } });
Object.defineProperty(exports, "unregisterProjectedToolsForPlugin", { enumerable: true, get: function () { return tool_projection_1.unregisterProjectedToolsForPlugin; } });
Object.defineProperty(exports, "toolDeclaresGate", { enumerable: true, get: function () { return tool_projection_1.toolDeclaresGate; } });
Object.defineProperty(exports, "listUngatedProjectedTools", { enumerable: true, get: function () { return tool_projection_1.listUngatedProjectedTools; } });
Object.defineProperty(exports, "lookupByMcpName", { enumerable: true, get: function () { return tool_projection_1.lookupByMcpName; } });
Object.defineProperty(exports, "lookupByHttpPath", { enumerable: true, get: function () { return tool_projection_1.lookupByHttpPath; } });
Object.defineProperty(exports, "listAllProjectedTools", { enumerable: true, get: function () { return tool_projection_1.listAllProjectedTools; } });
Object.defineProperty(exports, "listMcpProjections", { enumerable: true, get: function () { return tool_projection_1.listMcpProjections; } });
Object.defineProperty(exports, "ToolRegistrationError", { enumerable: true, get: function () { return tool_projection_1.ToolRegistrationError; } });
Object.defineProperty(exports, "emitToSseSink", { enumerable: true, get: function () { return tool_projection_1.emitToSseSink; } });
Object.defineProperty(exports, "isPapercuspBinaryEnvelope", { enumerable: true, get: function () { return tool_projection_1.isPapercuspBinaryEnvelope; } });
Object.defineProperty(exports, "_resetProjectionRegistryForTests", { enumerable: true, get: function () { return tool_projection_1._resetProjectionRegistryForTests; } });
/* ─── Dispatcher ─────────────────────────────────────────────────────── */
var dispatch_projected_1 = require("./dispatch-projected");
Object.defineProperty(exports, "dispatchProjectedTool", { enumerable: true, get: function () { return dispatch_projected_1.dispatchProjectedTool; } });
Object.defineProperty(exports, "dispatchProjectedToolStream", { enumerable: true, get: function () { return dispatch_projected_1.dispatchProjectedToolStream; } });
Object.defineProperty(exports, "defaultComputeQuotaWindow", { enumerable: true, get: function () { return dispatch_projected_1.defaultComputeQuotaWindow; } });
Object.defineProperty(exports, "UnauthorizedToolError", { enumerable: true, get: function () { return dispatch_projected_1.UnauthorizedToolError; } });
Object.defineProperty(exports, "HarnessRequiredError", { enumerable: true, get: function () { return dispatch_projected_1.HarnessRequiredError; } });
Object.defineProperty(exports, "InvalidInputError", { enumerable: true, get: function () { return dispatch_projected_1.InvalidInputError; } });
Object.defineProperty(exports, "PASS_THROUGH", { enumerable: true, get: function () { return dispatch_projected_1.PASS_THROUGH; } });
/* ─── Resource authorization (RFC tooldef-auth-rfc Phase 1 — contract only) ─── */
var authz_1 = require("./authz");
Object.defineProperty(exports, "ownerOnly", { enumerable: true, get: function () { return authz_1.ownerOnly; } });
/* ─── Replay buffer ──────────────────────────────────────────────────── */
var replay_buffer_1 = require("./replay-buffer");
Object.defineProperty(exports, "readReplayBuffer", { enumerable: true, get: function () { return replay_buffer_1.readBuffer; } });
Object.defineProperty(exports, "closeReplayBuffer", { enumerable: true, get: function () { return replay_buffer_1.closeBuffer; } });
Object.defineProperty(exports, "replayBufferStats", { enumerable: true, get: function () { return replay_buffer_1.replayBufferStats; } });
/* ─── OpenAPI assembly ───────────────────────────────────────────────── */
var openapi_fragments_1 = require("./openapi-fragments");
Object.defineProperty(exports, "toolToOpenApiFragment", { enumerable: true, get: function () { return openapi_fragments_1.toolToOpenApiFragment; } });
Object.defineProperty(exports, "componentKey", { enumerable: true, get: function () { return openapi_fragments_1.componentKey; } });
Object.defineProperty(exports, "standardResponseComponents", { enumerable: true, get: function () { return openapi_fragments_1.standardResponseComponents; } });
var openapi_assemble_1 = require("./openapi-assemble");
Object.defineProperty(exports, "assembleOpenApiDocument", { enumerable: true, get: function () { return openapi_assemble_1.assembleOpenApiDocument; } });
Object.defineProperty(exports, "toolOperationName", { enumerable: true, get: function () { return openapi_assemble_1.toolOperationName; } });
