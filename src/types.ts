/**
 * Core types for the Agent MCP server.
 */

import type { RolesQuota, ToolResult } from './wire';
import type { AgentRole } from './host-types';
import type { z, ZodTypeAny } from 'zod';
import type { StandardSchemaV1 } from './standard-schema';
import type { EventsSchema, UnifiedToolContext, UserEvents } from './tool-projection';
import type { Authorizer } from './authz';
import type { OpenCardSnapshot as WireOpenCardSnapshot } from '@papercusp/chat-protocol';

/** A Papercusp capability tier per spec/capabilities §10.6.1. */
export type CapabilityTier = 'low' | 'medium' | 'high';

/**
 * Principal kinds — who the caller is.
 *
 * Resolved Phase 3b 2026-05-20 (principal-rfc-2026-05-20.md). The plan
 * extended the original `'harness' | 'system' | 'pi'` triad with four
 * new kinds covering webapp users, mobile clients, external services,
 * and the legacy loopback-only trust path.
 */
export type PrincipalKind =
  | 'harness'   // sealed harness spawn URL (orchestrator-minted)
  | 'system'    // operator self-issued (e.g. background sweepers, superuser shell)
  | 'pi'        // shell-launched agent, bearer file
  | 'user'      // cookie-bearing browser session
  | 'device'    // JWT-bearing paired device (phone, CLI, kiosk, …)
  | 'service'   // bearer-token external integration (future webapp services)
  | 'loopback'; // host header is local; no token (legacy desktop-only gate)

/**
 * How the principal was authenticated. Orthogonal to `PrincipalKind` —
 * a `'service'` principal might be `'bearer-token'` OR `'jwt'`; a
 * `'user'` principal might be `'cookie-session'` today and `'jwt'`
 * later (Phase 8). Keeping these separate lets `kind` describe *who*
 * and `authMethod` describe *how we know*.
 */
export type PrincipalAuthMethod =
  | 'bearer-token'     // ~/.papercusp/superuser-token or external bearer
  | 'cookie-session'   // browser cookie
  | 'jwt'              // mobile JWT, future webapp tokens
  | 'spawn-url'        // HMAC-signed orchestrator URL
  | 'host-loopback'    // Host header is local; no token (legacy)
  | 'process-internal'; // in-process call (e.g. background sweeper)

/**
 * Trust ladder. Middleware reads this without having to know the full
 * method × kind matrix.
 *   - `'trusted'`               — process-internal, sealed spawn URL,
 *                                 bearer file with verified hash.
 *   - `'verified'`              — JWT signature checked, cookie session
 *                                 validated against PG.
 *   - `'unverified-loopback'`   — host header only; rejected when running
 *                                 on a network-reachable host (Phase 8
 *                                 bans these at boot when bindHost ≠
 *                                 127.0.0.1).
 */
export type PrincipalTrust = 'trusted' | 'verified' | 'unverified-loopback';

/** Resolved caller identity. */
export interface Principal<TKind extends string = PrincipalKind> {
  /** Who the caller is. Generic so a host can widen the kind union (RFC tooldef-auth Phase 2); defaults to the built-in `PrincipalKind`. */
  kind: TKind;
  /** e.g. `"system:operator"`, `"pi:abc123"`, `"harness-foo"`, user id, mobile deviceId. */
  slug: string;
  /** Workspace the call is scoped to. No global principals. */
  workspaceId: string;
  /** How the principal was authenticated. Set by the per-transport resolver. */
  authMethod: PrincipalAuthMethod;
  /**
   * Trust level. The single thing middleware reads when deciding whether
   * to allow a host-protected operation. See `PrincipalTrust`.
   */
  trust: PrincipalTrust;
  /** Granted capability strings (e.g. `tasks:read`). Freeform; namespacing convention only. */
  capabilities: ReadonlySet<string>;
  /**
   * RBAC roles the caller holds (e.g. `'staff'`, `'admin'`) — RFC tooldef-auth Phase 2.
   * A DISTINCT axis from `kind` (how the caller authenticated), from `capabilities`
   * (OAuth-scope-like grants), and from agent `tool.roles` (the orchestration allowlist
   * checked against `ctx.role`). This is what the declarative require-role gate checks —
   * the typed replacement for ad-hoc `requireAdminKey`/`requireStaff` checks. Optional +
   * freeform; the host's principal resolver populates it.
   */
  roles?: ReadonlySet<string>;
  /** Optional human-readable label for logging. Not load-bearing. */
  label?: string;
}

/**
 * Auth-gate requirements applied to a resolved `Principal`. Used by both
 * `requirePrincipal()` (the host-side resolver) and `defineTool`/
 * `defineTool` (the endpoint primitive's `auth` field).
 *
 * Lives in `@papercusp/agent-mcp` rather than `apps/operator/lib/auth` so
 * the endpoint primitive can reference it without creating an
 * app→package dependency inversion. `apps/operator/lib/auth/require-
 * principal.ts` re-exports.
 */
export interface PrincipalRequirements {
  /** Allowed trust levels. Empty/undefined = any. */
  trust?: ReadonlyArray<PrincipalTrust>;
  /** Allowed kinds. Empty/undefined = any. */
  kind?: ReadonlyArray<PrincipalKind>;
  /** Required capabilities. The principal needs all of them (or '*'). */
  capabilities?: ReadonlyArray<string>;
  /**
   * Where a bearer-style credential may be read from. Default `['header']`
   * (`Authorization: Bearer`). A route whose caller cannot set headers —
   * e.g. a polling fetcher — opts into `['query']` to also accept the
   * token from `?token=`. General: applies to any kind, not device-only.
   * Query-string tokens leak into access logs, so this is opt-in per
   * route and never a silent global fallback.
   */
  tokenIn?: ReadonlyArray<'header' | 'query'>;
}

/**
 * Endpoint auth stance. `'public'` opts out of `requirePrincipal()`
 * (used for webhooks, OAuth callbacks, pair endpoints). Otherwise a
 * `PrincipalRequirements` object gates the call.
 */
export type RouteAuth = 'public' | PrincipalRequirements;

/* ─── Route projection (Phase E6, endpoint-unification-2026-05-21) ─────
 *
 * The route-shaped projection of the endpoint system. `defineTool`
 * (below / in `define-tool.ts`) accepts EITHER a tool-shaped definition
 * (→ MCP agent catalog + HTTP catch-all) OR a route-shaped one (→ a
 * plain Hono route, NOT in the agent catalog). These types describe the
 * route shape.
 *
 * They live here, in `@papercusp/agent-mcp`, so the package's
 * `defineTool` can accept a route without an app→package dependency
 * inversion. The Hono-coupled mounting (`registerRoute`, `route-stack`)
 * stays in `apps/operator/lib/endpoint-route/` — a route is *declared*
 * with the package primitive and *mounted* by the host.
 */

export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

/**
 * Per-call context handed to a route handler. Host-neutral: `req` and
 * the return value are Web-standard `Request`/`Response`. `params`
 * carries the path parameters (`:slug`) that aren't in the URL.
 */
export interface RouteContext<TInput = undefined> {
  /** Resolved principal, or null when `auth: 'public'`. */
  principal: Principal | null;
  /** Parsed + validated input when an `input` schema was declared; else undefined. */
  input: TInput;
  /** Path parameters (`/harness/:slug` → `{ slug }`). */
  params: Record<string, string>;
  /** Telemetry-bound logger. */
  log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
  /** Abort signal — fires at `timeoutSec`. Handlers racing I/O should pass it through. */
  signal: AbortSignal;
}

/**
 * A route-shaped endpoint definition. Produced by `defineTool` when it
 * is handed a route-shaped input (discriminated by the `method` field);
 * mounted onto the Hono app by `registerRoute` in the host.
 */
export interface RouteDefinition<TInputSchema extends ZodTypeAny | undefined = undefined> {
  method: RouteMethod;
  /**
   * Hono path. The Hono app's `.basePath('/api')` is implicit, so
   * `'/desktop/version'` serves at `/api/desktop/version`. Dynamic
   * segments use Hono syntax: `:slug`, `:path{.+}`.
   */
  path: string;
  /** Auth stance — required, see `RouteAuth`. */
  auth: RouteAuth;
  /**
   * Optional Zod input schema. POST/PUT/PATCH parse from the JSON body;
   * GET/DELETE parse from the query string. Absent → the handler gets
   * `ctx.input === undefined` and reads `req` directly (freeform routes:
   * file-serving, SSE).
   */
  input?: TInputSchema;
  /** Wall-clock timeout. Default 30s. A wedged handler aborts. */
  timeoutSec?: number;
  /**
   * Telemetry sample rate, 0..1. Default 1 (record every call). High-
   * frequency polled routes set this < 1; 0 = never record.
   */
  sampleRate?: number;
  /**
   * Cross-origin reachability. `registerRoute` mounts the CORS middleware
   * (OPTIONS preflight + headers) for `cors`-enabled routes. Orthogonal
   * to auth — a cross-origin route still declares its own `auth` (and, if
   * it admits paired devices, `kind: ['device']`). `true` uses the default
   * cross-origin allowlist (paired-device + tauri + localhost origins);
   * pass `{ origins }` to override.
   */
  cors?: boolean | { origins: readonly string[] };
  /** The handler. Web-standard in, Web-standard out. */
  handler: (
    req: Request,
    ctx: RouteContext<TInputSchema extends ZodTypeAny ? z.infer<TInputSchema> : undefined>,
  ) => Response | Promise<Response>;
}

/**
 * Per-call request context.
 *
 * Generic over `Tx`, the host-supplied transaction/storage handle (plan
 * P-010 / D-009). Defaults to `any` so the framework stays storage-agnostic
 * and existing consumers that read `ctx.tx.<whatever>()` keep compiling; a
 * host that wants type-safe storage re-exports `ToolContext<MyClient>` (e.g.
 * a workspace-scoped SQL client) and gets a checked `ctx.tx`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolContext<Tx = any> {
  principal: Principal;
  /**
   * Host-supplied transaction handle. In Papercusp this is a workspace-scoped
   * SQL client with the `app.workspace_id` GUC set. The framework never
   * touches it — `Tx` defaults to `any` (storage-agnostic) and the host
   * narrows it by binding the type parameter.
   */
  tx: Tx;
  /** Logger bound to the tool name + principal. */
  log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * mcp-ui UIResource — interactive UI fragment a tool can return alongside
 * its data. Spec: https://github.com/idosal/mcp-ui. Shape mirrors
 * `@mcp-ui/server`'s `UIResource` so it round-trips through the MCP
 * transport without rewriting.
 */
export interface UIResourceContent {
  type: 'resource';
  resource: {
    uri: string;
    mimeType: string;
    text?: string;
    blob?: string;
    _meta?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/** Standard envelope for any tool response. */
export interface ToolResponse<T = unknown> {
  data: T;
  /** True when one or more sources were unavailable; partial result still useful. */
  degraded?: boolean;
  degradedReasons?: string[];
  /** Pagination cursor (for list tools that support it). */
  nextCursor?: string;
  /**
   * Optional mcp-ui UI fragments returned alongside the JSON `data`.
   * The HTTP MCP transport pushes these into the tool result's `content`
   * array; clients with a UIResource renderer (Oracle dock, Claude
   * Desktop, Cline, …) display them inline. Null/empty for tools that
   * only return data.
   */
  uiResources?: UIResourceContent[];
}

/**
 * Per-tool guidance for the role's system prompt. Lives next to the tool
 * (single source of truth) and is projected into the prompt for every
 * role that's allowed to call it. Cross-tool patterns and workflows live
 * in `<role>.tools.md`; this slot is for the per-tool answer to:
 *   "When should the agent reach for me, when should it reach for a
 *    sibling instead, and what should it pair me with?"
 *
 * All fields are optional in v1. CI sync flips `when` to required after
 * the catalog-wide backfill lands.
 */
export interface ToolGuidance {
  /**
   * Primary trigger — "When user asks 'X' or 'Y'", or "When you need to
   * Z". 1-2 lines. The MOST important field; aim to populate this first.
   */
  when?: string;
  /**
   * Disambiguation — "NOT for X; use `<other_tool>` instead". 1-2 lines.
   * Populate when there's a sibling tool the model might confuse with
   * this one (e.g. `harness:status` vs `harness_health` vs
   * `escalations_get` all surface "what's going on with X").
   */
  notWhen?: string;
  /**
   * Pairing hint — "Chain after `<tool_a>` to get the id, then call
   * me", or "Pair with `*_get` to drill down". Only when relevant.
   */
  chaining?: string;
  /**
   * Per-role override. Set ONLY the fields that differ from the base
   * guidance; shallowly merged at projection time. Use sparingly — most
   * tools share guidance across roles.
   *
   * Example: `harness:list` is used by operator as "show me my work"
   * and by worker as "find the chunk I'm assigned to" — same tool,
   * different framing.
   */
  byRole?: Partial<Record<AgentRole, Partial<Omit<ToolGuidance, 'byRole'>>>>;
}

/**
 * Structural tool-invocation event — the value an `emits` rule's `when` /
 * `render` reads (coord-lifecycle-automation-2026-06-04 D-002). Defined here,
 * minimal + domain-free, so the generic `tooldef` lib never depends on the
 * operator-core event-reaction engine. It is structurally assignable to the
 * engine's richer `ToolInvocationEvent` (event-reaction-system-2026-06-04), so
 * the desugar layer passes it through without a cast.
 */
export interface ToolEventLike {
  /** The trigger tool's MCP name (e.g. `'work_items:complete'`). */
  tool: string;
  /** The (already-validated) args the trigger was invoked with. */
  args: Record<string, unknown>;
  /** The trigger's result envelope. */
  result: { ok: boolean; data?: unknown; error?: unknown };
  /** Invocation context — the fields a `when`/`render` commonly reads. Structural/open. */
  ctx: {
    uiClientId?: string | null;
    harnessSlug?: string | null;
    workspaceId?: string | null;
    role?: string | null;
    runId?: string | null;
    spawnId?: string | null;
    [key: string]: unknown;
  };
  /** Cause-chain for loop protection — set by the engine, not the author. */
  cause?: { depth: number; chain: string[]; ruleId?: string };
}

/**
 * One INTRINSIC emission a tool always performs as part of its contract
 * (coord-lifecycle-automation-2026-06-04 D-002). `emits: [ToolEmitSpec, …]` on
 * a `defineTool` is co-location SUGAR that the operator-core desugar
 * (`emitsEntryToRule`) registers as an event-reaction rule — one engine, two
 * authoring forms (the rules file for contextual reactions; `emits:` for
 * intrinsic lifecycle emissions). It is NEVER a parallel dispatch path: the
 * field carries no execution, only the `(on=this tool, when, fire, args)`
 * descriptor the engine runs.
 *
 * (D-002 names the field's target the "surface"; it desugars to the reaction
 * rule's `fire` — the tool the emission invokes, e.g. `coord:emit`.)
 */
export interface ToolEmitSpec {
  /**
   * The reaction tool to fire — its MCP name, e.g. `'coord:emit'`. Desugars to
   * `ReactionRule.fire`. The reaction runs through the NORMAL dispatcher
   * (auth-gated, quota'd, audited), exactly like any other tool call.
   */
  fire: string;
  /**
   * Condition over the invocation event. Omitted ⇒ fires whenever the trigger
   * matches (subject to `onlyOnSuccess`). Desugars to `ReactionRule.when`.
   */
  when?: (event: ToolEventLike) => boolean;
  /**
   * Derive the fired tool's args from the event. Desugars to
   * `ReactionRule.args`. Keep it PURE — no I/O; the engine owns dispatch.
   */
  render: (event: ToolEventLike) => Record<string, unknown>;
  /** Only fire when the trigger SUCCEEDED. Default true. */
  onlyOnSuccess?: boolean;
  /**
   * Reaction execution mode — `'durable'` (DBOS-queued, off the hot path,
   * default) or `'sync'` (in-process await; only when the trigger needs the
   * value). Desugars to `ReactionRule.mode`.
   */
  mode?: 'durable' | 'sync';
  /**
   * Optional explicit id suffix for the generated rule. Defaults to the
   * entry's index in the `emits` array; the full rule id is
   * `emits:<toolName>#<id>`.
   */
  id?: string;
}

/** Tool definition produced by `defineTool`. */
export interface ToolDefinition<TArgs extends StandardSchemaV1 = StandardSchemaV1> {
  /** Tool name, e.g. `"tasks:list"`. Defaults to file-path-derived. */
  name: string;
  /** Resource-authorization hook (RFC tooldef-auth Phase 1b) — see `Authorizer`. */
  authorize?: Authorizer<StandardSchemaV1.InferOutput<TArgs>, UnifiedToolContext, UnifiedToolContext['principal']>;
  /** RBAC role requirement (RFC tooldef-auth Phase 2): caller's `principal.roles` must include one of these (any-of). See `ProjectedTool.requireRoles`. */
  requireRoles?: readonly string[];
  /** Opt out of default-deny (RFC tooldef-auth Phase 3): a tool that intentionally needs no auth gate (the `[AllowAnonymous]` equivalent). See `ProjectedTool.public`. */
  public?: boolean;
  /** TSDoc-derived description for MCP `tools/list`. */
  description: string;
  /** Capability gate (e.g. `"tasks:read"`). One per tool. */
  capability: string;
  /** Tier looked up from the capability per §10.6.1's table. */
  tier: CapabilityTier;
  /** Argument schema (any Standard Schema validator). Runtime validation + JSON-schema source. */
  args: TArgs;
  /** Implementation. Tools may return any data shape inside ToolResponse. */
  handler: (args: StandardSchemaV1.InferOutput<TArgs>, ctx: ToolContext) => Promise<ToolResponse>;
  /**
   * Optional per-tool guidance for the role's system prompt.
   * Projected into the prompt assembly by `assembleRolePrompt`.
   * See `ToolGuidance` for shape.
   */
  guidance?: ToolGuidance;
  /** See `ToolDefinitionInput.profile`. */
  profile?: 'engineer' | 'all';
  /** See `ToolDefinitionInput.papercusp`. */
  harness?: 'required' | 'optional' | 'none';
  /** Intrinsic lifecycle emissions — see `ToolEmitSpec`. Desugared to event rules at load. */
  emits?: readonly ToolEmitSpec[];
}

/** Input shape for `defineTool` — same as ToolDefinition minus derived fields. */
export interface ToolDefinitionInput<TArgs extends StandardSchemaV1 = StandardSchemaV1> {
  /** Optional explicit name; defaults to file-path-derived. */
  name?: string;
  /** Resource-authorization hook (RFC tooldef-auth Phase 1b) — see `Authorizer`. */
  authorize?: Authorizer<StandardSchemaV1.InferOutput<TArgs>, UnifiedToolContext, UnifiedToolContext['principal']>;
  /** RBAC role requirement (RFC tooldef-auth Phase 2): caller's `principal.roles` must include one of these (any-of). See `ProjectedTool.requireRoles`. */
  requireRoles?: readonly string[];
  /** Opt out of default-deny (RFC tooldef-auth Phase 3): a tool that intentionally needs no auth gate (the `[AllowAnonymous]` equivalent). See `ProjectedTool.public`. */
  public?: boolean;
  /** Optional explicit description; defaults to caller's TSDoc. */
  description?: string;
  capability: string;
  args: TArgs;
  handler: (args: StandardSchemaV1.InferOutput<TArgs>, ctx: ToolContext) => Promise<ToolResponse>;
  /** See `ToolGuidance`. */
  guidance?: ToolGuidance;
  /* ─── Unified-primitive forward-compat fields (Phase E1, no behavior change) ─────
   * These accept the future `defineTool`-collapsed shape without changing
   * runtime behavior. Phase E2 wires them into dispatch. Phase E1 just makes
   * sure callsites adopting the new shape compile.
   *
   * Plan: apps/operator/docs/plans/endpoint-unification-2026-05-21.md
   */
  /**
   * Auth gate. When set, overrides the legacy single-capability gate
   * (`capability`) with a full `PrincipalRequirements`. `'public'` opts
   * out of `requirePrincipal()`. Phase E2 makes this load-bearing; in
   * E1 it is accepted but not yet read by the dispatcher.
   */
  auth?: RouteAuth;
  /**
   * Alias for `args`. The unified primitive prefers `input` (matches
   * `defineTool`'s field name + the body/query duality). When both are
   * set, `args` wins (back-compat). New callsites should use `input`.
   */
  input?: TArgs;
  /**
   * Telemetry sample rate, 0..1. Default 1 (record every call). High-
   * frequency tools set this < 1 so `tool_invocations` doesn't flood.
   * Phase E2 wires this into the telemetry sink.
   */
  sampleRate?: number;
  /**
   * Explicit exposure override. When absent, `defineTool` auto-derives
   * MCP name from filename + HTTP path `/api/agent-tools/<group>/<verb>`.
   * Setting `expose` here lets a tool declare arbitrary path/methods,
   * or expose itself over IPC.
   */
  expose?: import('./tool-projection').ToolExposure;
  /**
   * Profile gate. `'engineer'` = Group A (Papercusp-only, hidden from
   * power-engineer sessions). Omit / `'all'` = visible to every profile.
   * See `ProjectedTool.profile` and omp-profile-system-2026-05-24 plan.
   */
  profile?: 'engineer' | 'all';
  /**
   * Harness-scope requirement. `'required'` makes the dispatcher return a
   * uniform `harness_required` error when `ctx.harnessSlug` is absent or
   * `'*'` — for CTX-ONLY tools (no slug arg). Tools that take an explicit
   * slug self-resolve; leave them `'optional'` (default) or `'none'`.
   * See `ProjectedTool.papercusp` (su-prompt-audit-fixes P-020 / D-007).
   */
  harness?: 'required' | 'optional' | 'none';
  /**
   * Intrinsic lifecycle emissions (coord-lifecycle-automation D-002). Each
   * entry desugars to an event-reaction rule registered at load — co-location
   * sugar for "this tool always emits X", never a parallel dispatch path.
   * See `ToolEmitSpec`.
   */
  emits?: readonly ToolEmitSpec[];
}

/**
 * Role-gated first-party tool definition.
 *
 * Same registry as principal-gated `defineTool`, different gate. Used for
 * first-party operator behavior that spawned agents must be able to call
 * (operator scan, harness phases, voice config, …) — those callers have
 * a URL spawn-context but no bearer token, so principal+capability gating
 * doesn't apply.
 *
 * Keep first-party tools in `packages/agent-mcp/src/tools/<group>/<verb>.ts`
 * even when role-gated; do NOT shape-shift them into a fake "operator-core"
 * plugin (that would mix removable third-party plugins with core papercusp
 * code in the catalog forever).
 */
export interface RoleToolDefinition<
  TArgs extends StandardSchemaV1 = StandardSchemaV1,
  TEvents extends EventsSchema = EventsSchema,
> {
  name: string;
  /** Resource-authorization hook (RFC tooldef-auth Phase 1b) — see `Authorizer`. */
  authorize?: Authorizer<StandardSchemaV1.InferOutput<TArgs>, UnifiedToolContext, UnifiedToolContext['principal']>;
  /** RBAC role requirement (RFC tooldef-auth Phase 2): caller's `principal.roles` must include one of these (any-of). See `ProjectedTool.requireRoles`. */
  requireRoles?: readonly string[];
  /** Opt out of default-deny (RFC tooldef-auth Phase 3): a tool that intentionally needs no auth gate (the `[AllowAnonymous]` equivalent). See `ProjectedTool.public`. */
  public?: boolean;
  description: string;
  /** Capability string for tier classification + descriptive listings. Not enforced. */
  capability: string;
  tier: CapabilityTier;
  /**
   * Visibility profile gate. 'engineer' = engineer-only surfaces (hidden +
   * rejected for the 'all' profile); 'all'/undefined = visible everywhere.
   * Read by registerRoleGatedAsProjected → the projection profile filter.
   */
  profile?: 'engineer' | 'all';
  /** See `ToolDefinitionInput.papercusp`. */
  harness?: 'required' | 'optional' | 'none';
  /** Marker — read by the projection wrapper to skip the principal check. */
  requirePrincipal: false;
  /** Allowed agent roles. Empty/undefined means any role. */
  agentRoles?: AgentRole[];
  /** Per-role quota windows. Roles without an entry are unlimited. */
  rolesQuota?: Partial<Record<AgentRole, RolesQuota>>;
  /** Per-call wall-clock timeout, default 60s. */
  timeoutSec?: number;
  /** Idle timeout — abort if no event emitted for this many seconds. See ProjectedTool.idleTimeoutSec. */
  idleTimeoutSec?: number;
  /**
   * Replay ring-buffer size, 0/undefined to disable (default).
   * When set, the dispatcher keeps the last N emitted events for the
   * call so a client reconnecting with `Last-Event-ID + X-Papercusp-Run-Id`
   * can pick up where it left off. Buffer evicted FIFO when full
   * (warn log fires); buffer survives 5 minutes past stream-end.
   * Per-tool sizing should target 1.5× p99 event_count from production
   * telemetry (Phase 4 T2.2 — see plan).
   */
  replayBufferSize?: number;
  /**
   * Cross-workspace opt-out (P-062 Phase 4). When the HTTP host runs tools
   * inside a workspace-scoped (RLS-subject) transaction by default, a tool
   * that genuinely spans workspaces sets `crossWorkspace: true` so the host
   * gives it the admin (rolbypassrls) handle instead. Absent/false ⇒ the
   * tool is workspace-isolated. Set this ONLY for tools that legitimately
   * read/write outside the caller's own workspace (e.g. listing every
   * workspace, cross-workspace aggregation) — it disables RLS isolation for
   * that tool. Read by the host's `runScoped` seam off `ProjectedTool`.
   */
  crossWorkspace?: boolean;
  /**
   * Surfaces this tool is meaningful from. Phase 4 T3.1. The prompt-
   * assembly catalog renderer filters by the caller's modality so voice
   * surfaces only see voice-capable tools. Default — when absent — is
   * `['text', 'voice']` (visible everywhere) so legacy tools surface
   * in both catalogs without a code change; opt out via `['text']` or
   * `['voice']` only when the tool genuinely doesn't make sense in
   * the other surface.
   */
  modality?: ReadonlyArray<'text' | 'voice'>;
  args: TArgs;
  /** Typed event channel. See ProjectedTool.events. */
  events?: TEvents;
  /**
   * State channel schema. Tools that publish snapshots via
   * `ctx.publishState` declare the snapshot's Zod shape here; the
   * dispatcher validates each snapshot against it and surfaces the
   * schema on tools/list for clients. Tools without `state` get
   * `ctx.publishState === undefined` and must use `ctx.emit` instead.
   *
   * See ProjectedTool.state.
   */
  state?: StandardSchemaV1;
  /**
   * Handler receives the unified context (no principal). May return either
   * a raw `ToolResult` (MCP shape) or a `ToolResponse` envelope; the
   * wrapper adapts both.
   */
  handler: (
    args: StandardSchemaV1.InferOutput<TArgs>,
    ctx: UnifiedToolContext,
  ) => Promise<ToolResult | ToolResponse>;
  /** See `ToolGuidance`. */
  guidance?: ToolGuidance;
  /** Intrinsic lifecycle emissions — see `ToolEmitSpec`. Desugared to event rules at load. */
  emits?: readonly ToolEmitSpec[];
}

/** Input shape for role-gated `defineTool` — same as RoleToolDefinition minus derived fields. */
export interface RoleToolDefinitionInput<
  TArgs extends StandardSchemaV1 = StandardSchemaV1,
  TEvents extends EventsSchema = EventsSchema,
> {
  name?: string;
  /** Resource-authorization hook (RFC tooldef-auth Phase 1b) — see `Authorizer`. */
  authorize?: Authorizer<StandardSchemaV1.InferOutput<TArgs>, UnifiedToolContext, UnifiedToolContext['principal']>;
  /** RBAC role requirement (RFC tooldef-auth Phase 2): caller's `principal.roles` must include one of these (any-of). See `ProjectedTool.requireRoles`. */
  requireRoles?: readonly string[];
  /** Opt out of default-deny (RFC tooldef-auth Phase 3): a tool that intentionally needs no auth gate (the `[AllowAnonymous]` equivalent). See `ProjectedTool.public`. */
  public?: boolean;
  description?: string;
  capability: string;
  /** Visibility profile gate — see RoleToolDefinition.profile. */
  profile?: 'engineer' | 'all';
  /** Harness-scope requirement — see `ToolDefinitionInput.papercusp`. */
  harness?: 'required' | 'optional' | 'none';
  requirePrincipal: false;
  agentRoles?: AgentRole[];
  rolesQuota?: Partial<Record<AgentRole, RolesQuota>>;
  timeoutSec?: number;
  /** See RoleToolDefinition.idleTimeoutSec. */
  idleTimeoutSec?: number;
  /** See RoleToolDefinition.replayBufferSize. */
  replayBufferSize?: number;
  /** See RoleToolDefinition.crossWorkspace. */
  crossWorkspace?: boolean;
  /** See RoleToolDefinition.modality. */
  modality?: ReadonlyArray<'text' | 'voice'>;
  /** See RoleToolDefinition.state. */
  state?: StandardSchemaV1;
  args: TArgs;
  /**
   * Typed event channel — Zod schemas keyed by event name. The
   * `UserEvents` guard rejects reserved names at compile time.
   * Reserved names: 'done' | 'progress' | 'heartbeat' | 'result'.
   */
  events?: UserEvents<TEvents>;
  handler: (
    args: StandardSchemaV1.InferOutput<TArgs>,
    ctx: UnifiedToolContext,
  ) => Promise<ToolResult | ToolResponse>;
  /** See `ToolGuidance`. */
  guidance?: ToolGuidance;
  /* ─── Unified-primitive forward-compat fields (Phase E1) — see ToolDefinitionInput. */
  /** See `ToolDefinitionInput.auth`. Phase E2 wiring. */
  auth?: RouteAuth;
  /** Alias for `args`. New callsites prefer `input`. */
  input?: TArgs;
  /** Telemetry sample rate, 0..1. */
  sampleRate?: number;
  /** Explicit exposure override. See `ToolDefinitionInput.expose`. */
  expose?: import('./tool-projection').ToolExposure;
  /**
   * Intrinsic lifecycle emissions (coord-lifecycle-automation D-002). Each
   * entry desugars to an event-reaction rule registered at load. See
   * `ToolEmitSpec`.
   */
  emits?: readonly ToolEmitSpec[];
}

// ──────────────────────────────────────────────────────────────────────
// Resources (MCP `resources/*`).
//
// Symmetric to tools, but for read-only browsable URIs. A resource is
// either:
//   - concrete: one URI, e.g. `papercusp://workspace/harnesses`
//   - templated: an RFC 6570-style URI with `{var}` segments that the
//     `list` callback expands at runtime, e.g.
//       template `papercusp://harness/{slug}/issues`
//       expanded `papercusp://harness/foo/issues`,
//                `papercusp://harness/bar/issues`, …
// ──────────────────────────────────────────────────────────────────────

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

export interface ResourceListEntry {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** Per-call resource read context. Same shape as ToolContext. */
export type ResourceContext = ToolContext;

/** Resource definition produced by `defineResource`. */
export interface ResourceDefinition {
  /** Concrete URI or RFC 6570 template (`{var}` segments). */
  uri: string;
  /** Stable name for `resources/list` UX. */
  name: string;
  description: string;
  /** Default mime, e.g. `application/json`. */
  mimeType: string;
  /** Capability gate; same vocabulary as tools. */
  capability: string;
  /** Tier inferred from capability per §10.6.1. */
  tier: CapabilityTier;
  /**
   * For templated resources: expand the template into concrete URIs
   * for `resources/list`. Omit for concrete (single-URI) resources.
   */
  list?: (ctx: ResourceContext) => Promise<ResourceListEntry[]>;
  /** Read a specific URI matching this resource's template/uri. */
  read: (uri: string, ctx: ResourceContext) => Promise<ResourceContents>;
}

/** Input shape for `defineResource`. */
export interface ResourceDefinitionInput {
  /** Optional explicit name; defaults to file-path-derived. */
  name?: string;
  /** Optional explicit description; defaults to caller's TSDoc. */
  description?: string;
  uri: string;
  mimeType?: string;
  capability: string;
  list?: (ctx: ResourceContext) => Promise<ResourceListEntry[]>;
  read: (uri: string, ctx: ResourceContext) => Promise<ResourceContents>;
}

// ──────────────────────────────────────────────────────────────────────
// Prompts (MCP `prompts/*`).
//
// Discoverable, parameterized prompt templates. Clients call
// `prompts/list` to see what's available, then `prompts/get(name, args)`
// to instantiate one. A prompt renders to an array of role/content
// messages — same shape MCP itself uses for completion requests.
// ──────────────────────────────────────────────────────────────────────

export interface PromptArgumentSchema {
  /** Stable name (used in `prompts/get` arg map). */
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptMessage {
  role: 'user' | 'assistant' | 'system';
  content: { type: 'text'; text: string };
}

export interface PromptResult {
  description?: string;
  messages: PromptMessage[];
}

/** Per-call prompt render context. Same shape as ToolContext. */
export type PromptContext = ToolContext;

export interface PromptDefinition {
  name: string;
  description: string;
  /**
   * Capability gate. Optional — many prompts are public (no gate).
   * If present, callers without the capability won't see the prompt
   * in `prompts/list` and `prompts/get` will deny.
   */
  capability?: string;
  /** Tier inferred from capability per §10.6.1, or 'low' if no capability. */
  tier: CapabilityTier;
  /** Argument schema as MCP prompts/list expects. */
  arguments?: PromptArgumentSchema[];
  /** Render the prompt with provided arguments. */
  render: (
    args: Record<string, string>,
    ctx: PromptContext,
  ) => Promise<PromptResult>;
}

export type { UIResourceContent as UIResource };

// ──────────────────────────────────────────────────────────────────────
// Cards — interactive prompts a tool can issue mid-run.
//
// Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md
//
// `ctx.askUser(spec)` server-side. Cards live on the STATE channel, NOT
// the event ring buffer (H2). Renderer reads schema/UI separately (#3).
// Response actions: submit | decline | cancel (#2 / L4).
// ──────────────────────────────────────────────────────────────────────

/**
 * Visual presentation hint. Voice surfaces consume `fallbackText` (and,
 * for `radio` with `voiceAnswerable === true`, the option set for spoken
 * answering). All other kinds stay announce-only for voice.
 */
export type CardPresentation =
  | { kind: 'radio'; options: CardOption[]; voiceAnswerable?: boolean }
  | { kind: 'checkbox'; options: CardOption[] }
  | { kind: 'text'; placeholder?: string; multiline?: boolean }
  | { kind: 'date'; min?: string; max?: string }
  | { kind: 'slider'; min: number; max: number; step?: number };

export interface CardOption {
  id: string;
  label: string;
  hint?: string;
  style?: 'default' | 'primary' | 'danger';
}

/** Card specification passed to `ctx.askUser`. */
export interface CardSpec<TSchema extends StandardSchemaV1 = StandardSchemaV1> {
  /** Human-readable prompt. Voice surfaces read this verbatim. */
  prompt: string;
  /** Standard Schema validator for the response payload. Validated server-side before resolving. */
  dataSchema: TSchema;
  /** Optional visual presentation hint. Voice surfaces ignore. */
  presentation?: CardPresentation;
  /** Plain-text fallback for voice / MCP elicitation bridge. */
  fallbackText?: string;
  /** Wall-clock timeout. Rejects with `{action:'cancel'}` if user does not respond. */
  timeoutMs?: number;
  /** Per-run idempotency key. Same key returns cached response within the run. */
  idempotencyKey?: string;
  /** When false, the renderer hides any decline affordance. Default true. */
  allowDecline?: boolean;
  /**
   * Fired synchronously once the card is registered, with the freshly-minted
   * `correlationId` (and the run/workspace it's scoped to). Lets a caller link
   * the live card to an external durable record — e.g. inbox-cards-unification
   * Phase D writes a coord escalation carrying this id so the inbox and the
   * live card resolve each other. Optional; existing callers are unaffected.
   * NOT called on an idempotency-cache hit (no card is registered).
   */
  onCard?: (info: { correlationId: string; runId: string; workspaceId: string }) => void;
}

/**
 * Response from a card.
 *   submit  — user provided a payload matching dataSchema.
 *   decline — user explicitly skipped this card (allowDecline must be ≠ false).
 *   cancel  — run was cancelled OR user dismissed OR timeoutMs fired.
 */
export type CardResponse<TSchema extends StandardSchemaV1 = StandardSchemaV1> =
  | { action: 'submit'; payload: StandardSchemaV1.InferOutput<TSchema> }
  | { action: 'decline'; reason?: string }
  | { action: 'cancel' };

/**
 * The streaming-chat wire event union — re-exported from the shared
 * `@papercusp/chat-protocol` contract so a papercup client and a Scout client
 * speak the same SSE protocol (Phase 6, option A —
 * `scout-convergence-papercup-2026-05-30` D-002). papercup's richer server-side
 * card types stay internal; only the wire contract is shared.
 */
export type { ChatEvent } from '@papercusp/chat-protocol';

/**
 * The wire-serializable form of an open card, included in `state-snapshot`
 * payloads under `openCards[]`. Zod schemas are serialized as JSON Schema.
 *
 * Adopts the shared `@papercusp/chat-protocol` `OpenCardSnapshot` wire contract
 * (Phase 6, option A — D-002/D-003): inherits the shared wire fields, but keeps
 * papercup's richer *discriminated* `CardPresentation` and a *required*
 * `dataSchemaJson` (papercup always serializes the zod schema server-side). The
 * discriminated presentation is a structural subtype of the shared flat one, so
 * this interface stays assignable to the shared wire snapshot — a shared client
 * can parse papercup's card payloads (`_assertOpenCardSnapshotIsWireCompatible`
 * below proves it at compile time; a diff that breaks wire-compat fails here).
 */
export interface OpenCardSnapshot
  extends Omit<WireOpenCardSnapshot, 'presentation' | 'dataSchemaJson'> {
  presentation?: CardPresentation;
  dataSchemaJson: Record<string, unknown>;
}

// Compile-time guarantee: papercup's OpenCardSnapshot satisfies the shared wire
// contract. Errors here mean the card wire types drifted out of compatibility.
// Type-only; zero runtime cost.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertWireCompatible<_T extends WireOpenCardSnapshot> = never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _assertOpenCardSnapshotIsWireCompatible = _AssertWireCompatible<OpenCardSnapshot>;

export interface PromptDefinitionInput {
  name?: string;
  description?: string;
  capability?: string;
  arguments?: PromptArgumentSchema[];
  render: (
    args: Record<string, string>,
    ctx: PromptContext,
  ) => Promise<PromptResult>;
}
