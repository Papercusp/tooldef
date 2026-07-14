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
export { applySeeAlso, resolveSeeAlso, renderSeeAlsoText, readJsonResult, } from './see-also';
export { setResultAnnotator, resetResultAnnotator, applyResultAnnotator, } from './result-annotator';
/* ─── defineTool + sibling authoring primitives ──────────────────────── */
export { defineTool, toArgsJsonSchema } from './define-tool';
export { applyPayloadTier, extractPayloadTier, parsePayloadTier, resolvePayloadTier, resetPayloadTierRatchet, PAYLOAD_TIERS, PAYLOAD_TIER_RATCHET_CHARS, } from './payload-tier';
export { defineResource } from './define-resource';
export { definePrompt } from './define-prompt';
/* ─── Result serialization (token-efficient formats) ─────────────────── */
export { serializeToolResponse, formatOptsFromCtx, } from './serialize-result';
/* ─── Delta protocol — agent tool result freshness negotiation ───────── */
export { parseDeltaRequest, formatDeltaRequest, encodeDeltaCursor, decodeDeltaCursor, computeViewFingerprint, contentRevision, negotiateDelta, setSemanticDeltaEnabledResolver, resetSemanticDeltaEnabledResolver, isSemanticDeltaEnabled, computeRowDigest, computeViewChecksum, diffFromDigest, applySemanticDelta, deltaCounts, DELTA_SMALL_RESPONSE_BYTES, DELTA_MAX_DIGEST_ENTRIES, } from './delta-protocol';
/* ─── Registries ─────────────────────────────────────────────────────── */
export { getCatalog, lookup, _resetCatalogForTests } from './registry';
/* ─── Catalogue summaries (defineGroup + derived capability map) ──────── */
export { defineGroup, registerGroup, lookupGroup, getGroupCatalog, _resetGroupCatalogForTests, } from './define-group';
export { groupOf, describeGroupFromMembers, catalogueProjection, renderCapabilityMap, declaredGroupSlugs, } from './catalogue-projection';
/* ─── Code-execution tool-orchestration runtime (B-CX-1A / B-CX-2A) ────── */
export * from './code-orchestration';
export { collectToolEmits, getCollectedToolEmits, _resetCollectedToolEmitsForTests, } from './emits-registry';
export { getResourceCatalog, lookupResource, matchResource, _resetResourceCatalogForTests, } from './resource-registry';
export { getPromptCatalog, lookupPrompt, _resetPromptCatalogForTests, } from './prompt-registry';
export { SLASH_PROMPT_PREFIX, resolveSlashExposure, slashPromptNameFor, isSlashPromptName, slashPromptToolName, deriveSlashPromptArguments, slashPromptListingFor, renderSlashPrompt, } from './slash-projection';
/* ─── Run / workspace lifecycle ──────────────────────────────────────── */
export { onWorkspaceSwitch, dispatchWorkspaceSwitch, } from './workspace-lifecycle';
/* ─── State channel (publishState, snapshots) ────────────────────────── */
export { openRun, closeRun, setOpenCards, setToolState, getSnapshot, subscribe as subscribeStateChannel, subscribeWorkspace, snapshotWorkspace, dropStateSnapshotsForWorkspaceSwitch, _resetStateChannelForTests, } from './state-channel';
/* ─── State-channel deltas (agent-tool-delta-protocol P-009) ─────────────── */
export { diffSnapshot, applySnapshotDelta, chooseSnapshotEmission } from './state-delta';
/* ─── Tool-result delta CLIENT (agent-tool-delta-protocol follow-up — the missing half) ─── */
export { DeltaToolClient, dispatchWithDelta, dispatchWithConveyedDelta } from './delta-client';
// Harness-side base-presence tracker (the D-006 "harness owns the base" half — when is not_modified/delta safe) — P-003.
// `dispatchWithBasePresence` is the one-call turn-wrapper integration seam (tracker + client + guarded dispatch).
export { BasePresenceTracker, dispatchWithBasePresence } from './base-presence';
// Server-side rows-array delta negotiation (the sync-resolver/SSE sibling of negotiateToolDelta) — P-006.
export { negotiateRowsDelta } from './rows-delta';
/* ─── Card correlator (ctx.askUser) ──────────────────────────────────── */
export { registerCard, resolveCardResponse, cancelPendingCardsForRun, cancelPendingCardsForWorkspaceSwitch, _resetCardCorrelatorForTests, } from './card-correlator';
/* ─── Capability tiers ───────────────────────────────────────────────── */
export { tierFor, setCapabilityTierResolver, defaultTierResolver, } from './capability-tiers';
/* ─── Schema → JSON-Schema adapter (pluggable; default Zod) ───────────── */
export { toJsonSchema, setJsonSchemaAdapter, zodJsonSchemaAdapter, } from './schema-adapter';
/* ─── Standard Schema validation (validator-agnostic) ────────────────── */
export { standardValidate, validateSync, formatIssues, } from './standard-schema';
/* ─── Projected-tool registry (the function-as-truth core) ───────────── */
export { registerProjectedTool, unregisterProjectedToolsForPlugin, toolDeclaresGate, listUngatedProjectedTools, lookupByMcpName, resolveMcpName, normalizeMcpName, lookupByHttpPath, listAllProjectedTools, listMcpProjections, ToolRegistrationError, emitToSseSink, isPapercuspBinaryEnvelope, _resetProjectionRegistryForTests, } from './tool-projection';
/* ─── Dispatcher ─────────────────────────────────────────────────────── */
export { dispatchProjectedTool, dispatchProjectedToolStream, defaultComputeQuotaWindow, UnauthorizedToolError, HarnessRequiredError, InvalidInputError, PASS_THROUGH, } from './dispatch-projected';
/* ─── Resource authorization (RFC tooldef-auth-rfc Phase 1 — contract only) ─── */
export { ownerOnly } from './authz';
/* ─── Replay buffer ──────────────────────────────────────────────────── */
export { readBuffer as readReplayBuffer, closeBuffer as closeReplayBuffer, replayBufferStats, } from './replay-buffer';
/* ─── OpenAPI assembly ───────────────────────────────────────────────── */
export { toolToOpenApiFragment, componentKey, standardResponseComponents, } from './openapi-fragments';
export { assembleOpenApiDocument, toolOperationName, } from './openapi-assemble';
