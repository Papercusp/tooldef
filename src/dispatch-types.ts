/**
 * Shared types + sentinels for the projected-tool dispatcher pipeline.
 *
 * Extracted from `dispatch-projected.ts` so `dispatch-stack.ts` (the
 * named-step pipeline) and `dispatch-projected.ts` (the entrypoint
 * dispatchProjectedTool / dispatchProjectedToolStream wrappers) can
 * both depend on these without a circular import.
 *
 * Nothing in this file is host- or transport-specific. Everything that
 * does I/O — quota reads, telemetry writes, override registries — is
 * threaded in through `DispatchProjectedDeps` by the host.
 */

import type { ToolResult } from './wire';
import type { UnifiedToolContext } from './tool-projection';

/* ─── Quota window keying ────────────────────────────────────────────── */

/** Compute the quota window key from a context. */
export function computeProjectedQuotaWindowKey(ctx: UnifiedToolContext): string | null {
  if (ctx.role === 'worker') {
    if (!ctx.chunkId) return null;
    return `chunk:${ctx.chunkId}`;
  }
  // Power-user (`?power_user=1`) sessions get a fresh `runId` per MCP
  // request — a run-keyed window would reset every call and never
  // accumulate. Key on the stable auth session (`uiClientId` carries
  // the `auth_session_id`) so the workspace's operator-tier quota
  // actually applies across the session. See
  // docs/plans/omp-power-user-bundle-2026-05-20.md §4.1.
  if (ctx.isPowerUser && ctx.uiClientId) {
    return `power-user:${ctx.uiClientId}`;
  }
  if (!ctx.runId) return null;
  return `run:${ctx.runId}`;
}

/* ─── Dispatcher result ──────────────────────────────────────────────── */

export type DispatchProjectedErrorCode =
  | 'unknown_tool'
  | 'unauthorized'
  | 'role_not_allowed'
  | 'missing_capability'
  | 'quota_exceeded'
  | 'invalid_input'
  | 'handler_error'
  | 'timeout';

/**
 * Throw to signal that the request lacks the authentication the tool
 * requires (no principal, no workspace tx, etc). The dispatcher
 * surfaces this as `unauthorized` so HTTP transports return 401
 * instead of a generic 500.
 */
export class UnauthorizedToolError extends Error {
  override readonly name = 'UnauthorizedToolError';
}

export interface DispatchProjectedResult {
  ok: boolean;
  result?: ToolResult;
  error?: { code: DispatchProjectedErrorCode; message: string; meta?: Record<string, unknown> };
}

/* ─── Dispatch deps (DI surface) ─────────────────────────────────────── */

/** Sentinel — return this from overrideTool to let the real handler run. */
export const PASS_THROUGH = Symbol('PASS_THROUGH');

/**
 * Per-call dispatcher override. When set, the dispatcher consults this
 * BEFORE invoking the tool handler — if it returns a ToolResult, that
 * is used in place of the handler's return value. PASS_THROUGH lets
 * the handler run normally.
 */
export type ToolDispatchOverrideFn = (
  toolName: string,
  args: unknown,
  ctx: UnifiedToolContext,
) =>
  | Promise<{ content: Array<{ text?: string; [k: string]: unknown }>; isError?: boolean } | typeof PASS_THROUGH>
  | { content: Array<{ text?: string; [k: string]: unknown }>; isError?: boolean }
  | typeof PASS_THROUGH;

export interface DispatchProjectedDeps {
  /** Read current quota usage. Return null to disable quota enforcement. */
  readQuotaState?(
    toolName: string,
    ctx: UnifiedToolContext,
    windowKey: string,
  ): Promise<{ count: number } | null>;
  /**
   * Per-call override. Consulted before tool.fn runs. Used by the
   * llm-testing framework's ToolDispatchOverride registry to inject
   * failures / slow responses / canned results for deterministic
   * scenario testing. Optional; pass-through is the default.
   */
  overrideTool?: ToolDispatchOverrideFn;
  /** Persist a tool-invocation record. Best-effort. */
  recordInvocation?(input: {
    toolName: string;
    pluginName: string;
    ctx: UnifiedToolContext;
    windowKey: string;
    durationMs: number;
    status: 'ok' | 'error' | 'quota-exceeded' | 'role-not-allowed' | 'timeout' | 'invalid-input';
    outputRef?: string | null;
    outputSize?: number | null;
    errorMessage?: string | null;
    /**
     * The validated arguments the tool was called with (post-zod parse).
     * Used by the /dev Sessions drilldown to enable exact-replay reruns.
     */
    args?: unknown;
    /**
     * Number of events the tool emitted via ctx.emit / ctx.progress
     * before completion. Used to size replay buffers from empirical
     * p99 (Phase 4 T2.2).
     */
    eventCount?: number;
    /**
     * Per-call structured metadata set by the handler via
     * ctx.metadata({...}). The dispatcher captures the last payload
     * before completion and passes it here.
     */
    metadataJson?: Record<string, unknown> | null;
  }): Promise<void>;
}
