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
export { applyDenominator, resolveDenominator, renderDenominatorText, } from './denominator';
export { applySeeAlso, resolveSeeAlso, renderSeeAlsoText, readJsonResult, } from './see-also';
export { setResultAnnotator, resetResultAnnotator, applyResultAnnotator, } from './result-annotator';
export { setServerVintageResolver, resetServerVintageResolver, readServerVintage, formatVintageAge, serverVintageHint, constraintVintageHint, } from './server-vintage';
// Host-registered list of dispatch-level arg keys the transport strips before a
// tool's own schema ever validates (EI-22174225494240206) — folded into
// `unknownArgHint`'s "accepts ONLY" list so a genuinely-accepted key never reads
// as rejected. Default unregistered (empty list); see ambient-args.ts.
export { setAmbientArgKeysResolver, resetAmbientArgKeysResolver, readAmbientArgKeys, } from './ambient-args';
/* ─── Kernel enforcement / identity activation seam (D-030) ──────────── */
export { KERNEL_ENFORCEMENT_SCHEMA, sameKernelRevision, sameExecutionRevision, kernelRevisionKey, executionRevisionKey, normalizeKernelEnforcementResult, evaluateKernelEnforcement, evaluateKernelDecision, isKernelDenied, appliedExecutionRevision, actualExecutionRevision, enforceKernelBoundary, runAtKernelBoundary, wrapKernelSpawn, wrapNativeSpawn, createKernelEnforcementPort, createKernelPolicyPort, allowKernelEnforcement, KernelEnforcementDeniedError, } from './kernel-enforcement';
/* ─── defineTool + sibling authoring primitives ──────────────────────── */
export { defineTool, toArgsJsonSchema, 
// The effect oracle — for static scanners that cannot execute defineTool (WI-6464).
inferCapabilityEffect, WRITE_CAPABILITIES, WRITE_CAPABILITY_SUFFIXES, 
// P-002: lets a tool's own contract test assert that each authored
// `argRedirects` target really resolves to a declared key on that tool —
// the difference between the relocation phrasing and wrongly telling the
// caller another tool owns their data.
isLocalSchemaTarget, splitLocalSchemaTarget, } from './define-tool';
// EI-19408488769901676: the HARD ceiling was defined but never re-exported, while its
// softer sibling (the ratchet) was — so a shaper wanting to hit the budget ITSELF, and
// thereby avoid the blind generic fall-through, had no way to reference the number it
// must stay under except by copying it. Export it so that check can be a real assertion.
export { applyPayloadTier, extractPayloadTier, parsePayloadTier, resolvePayloadTier, resetPayloadTierRatchet, projectBoundedPayload, PAYLOAD_TIERS, PAYLOAD_TIER_RATCHET_CHARS, PAYLOAD_TIER_HARD_CEILING_CHARS, } from './payload-tier';
export { defineResource } from './define-resource';
export { definePrompt } from './define-prompt';
/* ─── Result serialization (token-efficient formats) ─────────────────── */
export { serializeToolResponse, formatOptsFromCtx, } from './serialize-result';
/* ─── Delta protocol — agent tool result freshness negotiation ───────── */
export { parseDeltaRequest, formatDeltaRequest, encodeDeltaCursor, decodeDeltaCursor, computeViewFingerprint, contentRevision, negotiateDelta, setSemanticDeltaEnabledResolver, resetSemanticDeltaEnabledResolver, isSemanticDeltaEnabled, computeRowDigest, computeRowDigestUncapped, computeViewChecksum, diffFromDigest, applySemanticDelta, deltaCounts, DELTA_SMALL_RESPONSE_BYTES, DELTA_MAX_DIGEST_ENTRIES, } from './delta-protocol';
/* ─── Server-held row digests for large views (P-024) ─────────────────── */
export { putRowDigest, getRowDigest, resetRowDigestStore, rowDigestStoreStats, DIGEST_STORE_MAX_ROWS, } from './delta-digest-store';
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
/* ─── Entity-reference args (referential integrity at dispatch) ───────── */
export { entityRef, entityRefMeta, collectEntityRefs, setEntityResolver, clearEntityResolvers, hasEntityResolver, resolveEntityRefs, formatEntityRefViolations, setEntityEnum, clearEntityEnums, applyEntityRefEnums, entityEnumRevision, DEFAULT_MAX_ENUM_VALUES, } from './entity-ref';
/* ─── Schema → JSON-Schema adapter (pluggable; default Zod) ───────────── */
export { toJsonSchema, setJsonSchemaAdapter, zodJsonSchemaAdapter, } from './schema-adapter';
/* ─── Standard Schema validation (validator-agnostic) ────────────────── */
export { standardValidate, validateSync, formatIssues, } from './standard-schema';
/* ─── Projected-tool registry (the function-as-truth core) ───────────── */
export { registerProjectedTool, unregisterProjectedToolsForPlugin, toolDeclaresGate, listUngatedProjectedTools, lookupByMcpName, resolveMcpName, normalizeMcpName, lookupByHttpPath, listAllProjectedTools, projectedToolSourceFile, listDeclaredToolShapers, recordToolShapers, PROJECTED_TOOL_REGISTRY_SOURCE, projectedToolRegistryRevision, projectedToolCallContract, projectedToolAdmitted, assertProjectedToolCallContract, renderProjectedToolCall, projectedToolCorrectiveCalls, isProjectedToolDrop, assertProjectedToolGuidanceConformance, ProjectedToolContractError, listMcpProjections, ToolRegistrationError, emitToSseSink, isPapercuspBinaryEnvelope, _resetProjectionRegistryForTests, } from './tool-projection';
/* ─── Dispatcher ─────────────────────────────────────────────────────── */
export { dispatchProjectedTool, dispatchProjectedToolStream, defaultComputeQuotaWindow, UnauthorizedToolError, HarnessRequiredError, WorkspaceTxNotDeclaredError, WorkspaceTxUnavailableError, InvalidInputError, PASS_THROUGH, } from './dispatch-projected';
/**
 * P-015 — the shared refusal helper. Exported so a host can render or act on the corrected
 * call itself; every tool defined through this library already inherits it in the refusal
 * message with no per-verb wiring, which is the property the item asked for.
 */
export { buildCorrectedCall, correctedCallHint, } from './corrected-call';
/**
 * P-016 — the EXECUTE half of D-104. A tool declares `argReencodings` and the dispatcher
 * repairs-and-RUNS those calls, disclosing each correction. Exported so a host can author
 * a rule beside the schema it repairs; see `reencode-args.ts` for the boundary that keeps
 * this narrower than the refusal helper above.
 */
export { applyArgReencodings, correctedDisclosure, boundValue, } from './reencode-args';
/** Explicit workspace-transaction contract helpers for host/nested adapters. */
export { boundWorkspaceTx, applyWorkspaceTxContract } from './workspace-tx';
/* ─── Resource authorization (RFC tooldef-auth-rfc Phase 1 — contract only) ─── */
export { ownerOnly } from './authz';
/* ─── Replay buffer ──────────────────────────────────────────────────── */
export { readBuffer as readReplayBuffer, closeBuffer as closeReplayBuffer, replayBufferStats, } from './replay-buffer';
/* ─── OpenAPI assembly ───────────────────────────────────────────────── */
export { toolToOpenApiFragment, componentKey, standardResponseComponents, } from './openapi-fragments';
export { assembleOpenApiDocument, toolOperationName, } from './openapi-assemble';
