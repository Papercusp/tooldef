/**
 * @papercusp/tooldef — a function-as-truth tool framework.
 *
 * Write one typed `(input, ctx) => ToolResult` function; the framework
 * projects it onto HTTP, MCP, IPC, and in-process transports with uniform
 * auth/role/quota/telemetry/streaming. Schema-agnostic (Standard Schema),
 * host-agnostic (every side effect is injected via deps).
 *
 * Status: extraction in progress — see plan
 * `apps/operator/docs/plans/papercusp-tooldef-extraction-2026-05-29.md`.
 * Phase 1 lands the wire types (this re-export); the dispatcher, registry,
 * and `defineTool` move in subsequent commits.
 */

export type {
  ToolResult,
  RolesQuota,
  ProgressCallback,
  EmitCallback,
} from './wire';
