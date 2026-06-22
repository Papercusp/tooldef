/**
 * Tool projection registry — the function-as-truth abstraction.
 *
 * A "projected tool" is a typed async function plus a manifest entry
 * declaring how that function should be exposed:
 *
 *   - `expose.http`: framework auto-mounts at the declared path.
 *   - `expose.mcp`:  framework auto-registers as an MCP tool.
 *
 * Both projections call the same function. Capability + role + quota
 * gates run identically. Tests target the function with a mock ctx;
 * neither transport needs to be running.
 *
 * This module is the registry + lookup APIs. Transport adapters
 * (the dynamic HTTP catch-all route, the MCP `tools/list` + `tools/call`
 * handlers) consume this registry to do their work.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */
import { type ZodTypeAny } from 'zod';
import type { EmitCallback, ProgressCallback, RolesQuota, ToolResult } from './wire';
import type { AgentRole, Capability, PluginSpawn } from './host-types';
import type { StandardSchemaV1 } from './standard-schema';
import type { Authorizer } from './authz';
import type { EligibilityResult } from '@papercusp/result-encoding';
/** Schema for a tool's typed event channel. Keys are wire-level event names. */
export type EventsSchema = Record<string, ZodTypeAny>;
/**
 * Reserved event names — names the framework emits internally OR has
 * semantics around. Tools declaring an `events` schema must not use
 * these as keys. The TS-level guard `UserEvents<T>` enforces this at
 * compile time on `defineTool`'s generic parameter.
 *
 * - `done`: framework auto-emits when the handler returns successfully.
 * - `progress`: emitted via `ctx.progress` (the alias); reserved so
 *   tools don't redefine its payload shape.
 * - `heartbeat`: @papercusp/sse emits this every 15s to keep the
 *   connection alive; never a tool event.
 * - `result`: legacy pre-2026-05-12 terminal-event name; reserved for
 *   collision avoidance even though the framework no longer emits it.
 *
 * `error` is intentionally NOT reserved — the framework auto-emits it
 * on handler throw, but tools may also emit it mid-stream for non-fatal
 * errors (dual-mode; canonical example is runAgentChat's mid-stream
 * 'error' yields). See ToolContext.emit doc for the contract.
 */
export type ReservedEventNames = 'done' | 'heartbeat' | 'result' | 'chunk' | 'card';
/** Compile-time guard: a user-declared events schema cannot contain reserved names. */
export type UserEvents<T extends EventsSchema> = T & {
    [K in ReservedEventNames]?: never;
};
/**
 * Runtime list of reserved event names. The compile-time `UserEvents<T>`
 * guard rejects them in TS, but the projection registry also checks at
 * register time so plugins (which can bypass the TS layer via JSON
 * manifests) get a loud failure. Phase 4 T2.3.
 */
export declare const RESERVED_EVENT_NAMES: readonly ReservedEventNames[];
/**
 * How an event's payload is encoded on the SSE wire:
 *  - `'string'`: the payload IS a string; emit as `data: <text>\n` (multi-line `data:`
 *    when text contains newlines, joined back by parseSseStream per SSE spec).
 *    Use for token streams (LLM deltas, log lines) where the event payload
 *    has no inherent structure and JSON-wrapping is overhead.
 *  - `'json'`: emit as `data: <JSON.stringify(payload)>\n`. Use for everything
 *    structured (suggestions, tool_calls, progress payloads).
 *
 * Inferred from the declared Zod schema at tool registration:
 *  - `z.string()` schemas → 'string'
 *  - everything else → 'json'
 *
 * The MCP transport always JSON-serializes (JSON-RPC carries strings as
 * JSON-quoted strings inside notifications/papercusp/event); the
 * classification only affects the HTTP/SSE wire shape.
 */
/**
 * On-wire encoding for a single event name.
 *
 * - `'string'` — payload is the raw text of the event (no JSON wrapping).
 *   Picked when the event schema is `z.string()`. SSE `data:` line, IPC
 *   EVENT_JSON frame with the string as the `data` field.
 * - `'json'` — payload is `JSON.stringify(data)`. The default for object
 *   / number / array event schemas.
 * - `'binary'` — payload is raw bytes (Uint8Array). On SSE this falls
 *   back to base64 + a `content-encoding: base64` header (not currently
 *   implemented; would be a separate addition). On the IPC transport,
 *   this triggers an EVENT_BIN self-describing frame. Picked when the
 *   event schema is `z.instanceof(Uint8Array)`.
 *
 * See `apps/operator/content/docs/endpoint-system/transports.mdx`
 * § "Schema-inferred wire format".
 */
export type EventWireKind = 'string' | 'json' | 'binary';
/**
 * Inspect a Zod schema and decide whether the wire payload for events
 * of that shape should be raw text (`'string'`) or JSON-encoded (`'json'`).
 *
 * Cheap one-time call per declared event at register time; result is
 * cached on the tool entry so emit-time has no schema-introspection cost.
 */
export declare function classifyEventWire(schema: ZodTypeAny): EventWireKind;
/**
 * Wire-kind-aware sink dispatch — the single source of truth for
 * "given a ctx.emit(name, data) and a tool's declared events schema,
 * how does that land on the SSE wire?"
 *
 * Used by:
 *   - HTTP transport adapter (`handleHttpToolRequestStreaming`).
 *   - Route shims that bypass the HTTP transport and call
 *     `dispatchProjectedToolStream` themselves (architect/brainstorm
 *     in `apps/operator/app/api/_hono/harness.ts`, operator-scan /
 *     operator-converse).
 *
 * Centralizing here prevents the wire-format-drift class of bug:
 *   - z.string() events going through JSON.stringify (round-2 silent
 *     mis-encoding for tools added new z.string() events post-pilot).
 *   - z.instanceof(Uint8Array) → JSON.stringify producing
 *     `{"0":..., "1":..., ...}` corruption (round-5 HTTP, round-6 MCP).
 *
 * Mirrored emit-shape per transport:
 *   - HTTP/SSE (this helper):           z.string() → sink.eventRaw raw text
 *                                       z.instanceof(Uint8Array) → sink.eventRaw base64
 *                                       else → sink.event JSON
 *   - MCP (notifications/papercusp/event in [transport]/route.ts):
 *                                       Uint8Array → {$papercuspBinary, encoding, data}
 *                                       else → params.data
 *   - IPC (server.ts):                  string event kind: EVENT_JSON with data as string
 *                                       binary: EVENT_BIN raw bytes
 *                                       else: EVENT_JSON JSON
 *
 * The shape of the SSE sink interface is the @papercusp/sse SseSink; we
 * don't import the type here to keep this file dependency-free, so
 * we declare a structural minimum: `eventRaw(name, string)` for raw-text
 * payloads and `event(name, value)` for JSON-encoded ones.
 */
export interface MinimalEventSink {
    event(name: string, value: unknown): void;
    eventRaw(name: string, value: string): void;
}
/**
 * Self-describing binary envelope. Same shape as the MCP transport's
 * notifications/papercusp/event params.data field for binary events.
 * Cross-transport unification (audit item 14) — consumers can use one
 * decoder regardless of wire format.
 */
export interface PapercuspBinaryEnvelope {
    $papercuspBinary: true;
    encoding: 'base64';
    /** Base64-encoded payload bytes. */
    data: string;
}
export declare function isPapercuspBinaryEnvelope(v: unknown): v is PapercuspBinaryEnvelope;
export declare function emitToSseSink(sink: MinimalEventSink, tool: Pick<ProjectedTool, 'eventWireKinds'>, name: string, data: unknown): void;
/**
 * The single context passed to every projected tool function — same shape
 * regardless of which transport invoked it. Fields are populated by the
 * relevant transport adapter:
 *
 *   - HTTP transport (built-in tools, in-process callers): populates
 *     `principal`, `tx`, `log`. Spawn fields are populated only if the
 *     caller sent the X-Papercusp-* headers (e.g. orchestrator-spawned
 *     OMP via the bridge).
 *
 *   - MCP transport (agent calls): populates `workspaceId`, `harnessSlug`,
 *     `role`, `featureId`, `chunkId`, `runId`, `spawnId`, `parentSpawnId`,
 *     `progress`, `spawn`, `secret`, `signal`. Built-in fields like
 *     `principal`/`tx` are populated when the bearer also resolves to one.
 *
 * Tool functions opt into whichever fields they need. The framework
 * doesn't care which transport triggered the call.
 */
/**
 * Per-gate bypass signals (plan P-014 / D-006). The dispatcher's role,
 * capability, and quota gates each skip enforcement when the matching flag is
 * true. This is the engine's *neutral* representation of "this caller is
 * privileged" — it deliberately knows nothing about *why* (superuser,
 * power-user, admin, …). The host's principal/auth layer decides the mapping
 * and sets `ctx.gateBypass`; the engine never infers it. Absent ⇒ no bypass
 * (fail-closed: every gate enforces).
 */
export interface GateBypass {
    /** Skip the role-allowlist gate. */
    role?: boolean;
    /** Skip the capability gate. */
    capability?: boolean;
    /** Skip the quota gate. */
    quota?: boolean;
    /**
     * Skip the harness-required gate. NOT set by Papercusp's superuser/
     * power-user mapping — a harness:'required' tool genuinely can't function
     * without a harness, so the gate fails closed even for privileged callers
     * (the point is to return the uniform "harness required" hint, not to push
     * the failure into the handler). Present as an explicit per-call escape hatch.
     */
    harness?: boolean;
    /**
     * Skip the resource-`authorize` gate (RFC tooldef-auth D-F). Default OFF and, unlike
     * the bypasses above, it is NOT implied by them — resource ownership is a *separate*
     * decision a host opts out of explicitly, per call (a host that maps superuser onto
     * `{role,capability,quota}` still runs `authorize` unless it ALSO sets this). When set,
     * the dispatcher does not run the tool's `authorize` hook — BUT it still emits an
     * `AuthAuditEvent` recording the bypass (an *audited* break-glass, never a silent
     * super-admin; break-glass best practice = "policy-governed + mandatorily logged").
     */
    policy?: boolean;
}
export interface UnifiedToolContext {
    /** Tool-bound logger. Always populated. */
    log: (msg: string) => void;
    /** Aborts on per-tool timeout, parent cancellation, or shutdown. */
    signal: AbortSignal;
    /**
     * Stream progress events. Thin alias over `emit('progress', { progress, total, message? })`.
     * Tools using the standard pct/msg shape should prefer this; tools
     * emitting richer typed events should use `emit` directly.
     * No-op when transport doesn't support streaming.
     */
    progress: ProgressCallback;
    /**
     * Emit a typed named event. The active transport adapter decides what
     * happens:
     *   - HTTP/SSE → `event: <name>\ndata: <JSON(data)>` via @papercusp/sse.
     *   - MCP → `notifications/papercusp/event` with `{ event: name, data }`.
     *   - In-process (`fnStream`) → next value of the async iterator.
     *   - Non-streaming HTTP → no-op.
     *
     * Reserved names: 'done' | 'progress' | 'heartbeat' | 'result'. The
     * framework emits 'done' automatically when the handler returns and
     * 'error' automatically when it throws. Handlers may also emit 'error'
     * mid-stream for non-fatal errors (dual-mode by design — preserves
     * runAgentChat's non-terminal error event semantics).
     *
     * Always populated; transport adapter installs the right impl.
     */
    emit: EmitCallback;
    /** Auth principal resolved from bearer. Null when caller is anonymous. */
    principal?: {
        slug: string;
        workspaceId: string;
        capabilities: Set<string>;
        roles?: ReadonlySet<string>;
    } | null;
    /**
     * Transaction-bound Sql client with `app.workspace_id` GUC set. Built-in
     * tools rely on this; plugin tools may use it. Null when call wasn't
     * wrapped in `withWorkspace`.
     */
    tx?: any;
    /**
     * Per-gate bypass signals — the engine's neutral "this caller is
     * privileged" input (plan P-014). The role/capability/quota gates read
     * THIS, not the `isSuperuser`/`isPowerUser` fields below. The host maps its
     * auth tiers onto it (Papercusp: `@papercusp/agent-mcp`'s `papercuspGateBypass`).
     * Absent ⇒ every gate enforces (fail-closed).
     */
    gateBypass?: GateBypass;
    /**
     * True when the call entered through the superuser endpoint
     * (loopback + bearer-token auth — see apps/operator/lib/superuser-token.ts
     * and apps/operator/content/docs/endpoint-system/superuser-mode.mdx).
     *
     * Host metadata only — the dispatcher no longer reads this for gating
     * (P-014 moved the bypass decision to `gateBypass`, set by the host). Still
     * consumed by profile resolution + host code (agent_tools:list, docs
     * adapters). The transport that sets this also sets `gateBypass`.
     */
    isSuperuser?: boolean;
    /**
     * True when the call entered through the `?power_user=1` endpoint
     * (loopback + a workspace-scoped HMAC access token — see
     * apps/operator/lib/power-user-token.ts and
     * apps/operator/docs/plans/omp-power-user-bundle-2026-05-20.md §4.1).
     *
     * Host metadata only (see `isSuperuser`). The Papercusp bypass mapping
     * (`papercuspGateBypass`) encodes the tier distinction the engine used to
     * hardcode: superuser bypasses quota, power-user does NOT — workspace
     * quotas apply to end users. The quota window is keyed on the stable auth
     * session (`uiClientId`), not the per-request `runId`.
     */
    isPowerUser?: boolean;
    /**
     * Active caller profile. Governs which tools appear in `tools/list`
     * and which `tools/call` invocations are accepted.
     *
     * - `'power'`    — power-engineer-on-any-harness. Only Group B + C
     *                  tools (`ProjectedTool.profile` omitted or `'all'`).
     *                  Group A (`profile: 'engineer'`) is hidden + rejected.
     * - `'engineer'` — Papercusp engineer/operator. All tools visible.
     *
     * Resolution order (highest wins):
     *   1. `isPowerUser` (power-user token) → always `'power'`.
     *   2. `isSuperuser` + `?profile=power` URL param → `'power'` (SU testing).
     *   3. Default → `'engineer'`.
     *
     * See: apps/operator/docs/plans/omp-profile-system-2026-05-24.md
     */
    profile?: 'engineer' | 'power';
    /**
     * Which transport adapter built this context. Recorded on the
     * `tool_invocations.transport` column so /dev → Sessions / Telemetry
     * can filter by transport.
     *
     * Set by transport adapters (HTTP, MCP, IPC). Left undefined for
     * in-process / shim callers that build a ctx directly without going
     * through an adapter — `recordInvocation` writes null in that case.
     */
    transport?: 'http' | 'mcp' | 'ipc' | 'in_process';
    /**
     * Client-negotiated result format (token-efficient-tool-result-formats D-005).
     * The RAW request token from the transport — `?format=`/`Accept` on HTTP,
     * `_meta.format` or `?format=` on MCP — parsed by the result serializer via
     * `parseFormatRequest` (`json|toon|csv|tsv|md|compact` + MIME types). The
     * format is set by the CLIENT PROCESS, never authored by the model. Absent ⇒
     * the serializer uses the transport default (MCP → compact, else JSON). On an
     * unsupported request the serializer falls back gracefully and labels it.
     */
    requestedFormat?: string;
    /**
     * Opt-in for MCP `structuredContent` (P-010) — set by the transport from
     * `?structured=1` / `_meta.structured`. When true, a result with a declared
     * output schema also carries the lossless structured `data` alongside the
     * compact text. OFF by default so the model never pays for both at once.
     */
    requestedStructured?: boolean;
    workspaceId?: string;
    harnessSlug?: string;
    projectDir?: string;
    stateDir?: string;
    role?: AgentRole;
    featureId?: string | null;
    chunkId?: string | null;
    runId?: string;
    spawnId?: string;
    parentSpawnId?: string | null;
    /**
     * True when the transport VERIFIED a signed per-spawn URL's signature for
     * this context (never set for unsigned / soft-allowed spawn URLs). Hosts
     * may key identity attribution on it for spawn callers that carry no
     * explicit client/owner id — e.g. attribute to the stable harness rather
     * than the per-call spawn id.
     */
    sigVerifiedSpawn?: boolean;
    /**
     * Set by the event-reaction system on a ctx it builds for a REACTION call
     * (a tool fired automatically by a rule). Absent on ordinary
     * agent/user-originated calls. Carries the cause-chain so the loop guard
     * (event-reaction-system D-005) can cap depth + detect cycles on the NEXT
     * post-invocation, and so telemetry can audit "why did this fire?"
     * (D-010). The dispatcher itself never reads this — it is host metadata
     * the host's `postInvoke` interprets.
     */
    reactionCause?: {
        /** Depth in the reaction cascade. An agent call is 0; its direct reactions are 1. */
        depth: number;
        /** Rule ids fired so far in this chain (cycle detection). */
        chain: string[];
        /** The rule that fired THIS call. */
        ruleId: string;
        /** The runId of the original (agent) trigger that rooted the chain. */
        rootRunId?: string | null;
    };
    /**
     * When the agent was spawned from a browser tab (chat surfaces), the
     * tab's UI client_id is passed through here so `ui:*` tools default
     * to it. Null/undefined for headless spawns and CLI callers.
     */
    uiClientId?: string | null;
    /**
     * The plan-run conversation that this call belongs to, when the
     * caller is an agent launched from a plan (`plans:launch` —
     * plan-agent-launch-2026-05-21). It is the `runAgentChat` session id
     * minted by the plan-agent runner and carried on the MCP endpoint
     * URL as `?plan_run=<uuid>`; the MCP transport folds that param
     * here. `plans:*` write verbs read it (via `resolvePlanSessionRef`)
     * so a revision made by a launched agent is attributed to its run.
     *
     * Null/undefined for every other caller — an SU engineer session, a
     * browser `/admin/plans` edit, an orchestrator spawn. It is a
     * provenance label only, never a security boundary (like
     * `uiClientId`).
     */
    planRunSessionId?: string | null;
    spawn?: PluginSpawn;
    secret?: (name: string) => Promise<string | null>;
    /**
     * Mid-run interactive prompt — opens a card on the STATE channel
     * and resolves when the user submits/declines/cancels (or the
     * timeoutMs fires).
     *
     * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md §4
     *
     * Returns:
     *   {action:'submit',  payload}   — user picked, Zod-validated against spec.dataSchema
     *   {action:'decline', reason?}   — user explicitly declined (allowDecline≠false)
     *   {action:'cancel'}             — run cancelled, workspace switched, or timeout
     *
     * Cards live on the STATE channel — they are NOT in the event ring
     * buffer, so reconnect-after-answer does NOT re-prompt (H2 from review).
     *
     * Available when the transport supports it (HTTP/SSE, IPC, in-process).
     * Falls back to immediate {action:'cancel'} when the transport has
     * no client to ask (e.g. non-streaming HTTP).
     */
    askUser?: AskUserCallback;
    /**
     * Publish the tool's current state snapshot to the state channel.
     *
     * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md §5
     *
     * The snapshot is validated against the tool's `state` schema and
     * replaces the run's current snapshot. Clients reconnecting receive
     * the latest snapshot — never event history (that's the whole point
     * of being on the state channel).
     *
     * v1: snapshot-only. Passing anything other than a full snapshot
     * throws. v1.1 will accept JSON-Patch arrays for delta updates
     * once we measure full-snapshot perf on real tools.
     *
     * Throws if the tool has no `state` schema declared, or if the
     * snapshot fails Zod validation.
     *
     * Installed by the dispatcher when (a) ctx has workspaceId + runId
     * and (b) the tool declared a `state` schema at register time.
     * Tools should check `if (ctx.publishState)` before calling.
     */
    publishState?: PublishStateCallback;
    /**
     * Attach per-call structured metadata for telemetry. The dispatcher
     * captures whatever payload the handler set MOST RECENTLY before the
     * call ends and persists it into `harness_shared.tool_invocations
     * .metadata_json` (added by migration 068).
     *
     * Used for shape-specific telemetry that doesn't fit the fixed
     * columns — e.g. docs:get emits `{ requested, found, truncated,
     * sliced }`, search:* emits `{ result_count, ranker }`. Lets
     * Phase-2 trigger predicates query specific JSONB paths without
     * adding new columns per tool.
     *
     * Best-effort: implementations that haven't run the migration
     * (older operator versions, IPC dev sandboxes) drop the payload
     * silently. Tools should NOT rely on this for correctness — only
     * for telemetry.
     *
     * Always installed by the dispatcher (no opt-out).
     */
    metadata?: (data: Record<string, unknown>) => void;
}
/** ctx.publishState — snapshot-only in v1. */
export type PublishStateCallback = (snapshot: unknown) => void;
/**
 * `ctx.askUser(spec)` — mid-run interactive prompt. Returns a `CardResponse`
 * shaped per the discriminated union in `./types`.
 */
export type AskUserCallback = <TSchema extends StandardSchemaV1>(spec: import('./types').CardSpec<TSchema>) => Promise<import('./types').CardResponse<TSchema>>;
/** A tool function — one shape for every transport. */
export type ToolFn<TInput = unknown> = (input: TInput, ctx: UnifiedToolContext) => Promise<ToolResult>;
export interface ToolExposureHttp {
    /** Path the catch-all HTTP route serves; e.g. '/api/plugins/repomix/pack'. */
    path: string;
    /** Allowed methods. Default: ['POST']. */
    methods?: ReadonlyArray<'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'>;
    /**
     * Single-method sugar. Equivalent to `methods: [method]`. Accepted alongside
     * `methods` for ergonomics — the route-shaped callsites prefer the singular
     * form (mirrors the now-collapsed `defineTool({ method })` shape). When both
     * are set, `methods` wins.
     *
     * Phase E1 (endpoint-unification-2026-05-21).
     */
    method?: 'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
}
export interface ToolExposureMcp {
    /** MCP tool name; must use dotted naming (e.g. 'repomix.pack'). */
    name: string;
    /**
     * If true, the tool may emit progress events via `ctx.progress(...)`.
     * The MCP transport translates them to `notifications/progress` events.
     * No effect on the HTTP transport (which uses SSE differently).
     */
    streaming?: boolean;
    /**
     * If true, the tool may produce an output too large to inline; result
     * shaping should write to `<stateDir>/scratch/<...>` and return `{ path }`.
     * Hint to the framework's content-shaper, not enforced.
     */
    largeOutput?: boolean;
}
/**
 * Slash-exposure overrides (slash-exposure-tool-catalog-2026-06-12). The
 * slash surface projects an MCP-exposed tool onto the MCP **prompts**
 * primitive so agent clients (Claude Code, …) surface it as a slash
 * command. Unlike `http`/`mcp` this is NOT a dispatch transport — the
 * rendered prompt instructs the agent, and the agent's tool call rides the
 * session's existing MCP transport (D-001 on the plan).
 */
export interface ToolExposureSlash {
    /**
     * Override the prompt's name SUFFIX. The full prompt name is always
     * `tool:<name>`; default `<name>` = the tool's `expose.mcp.name`.
     */
    name?: string;
    /** Override the slash listing's description. Default: `guidance.when` ?? `description`. */
    description?: string;
    /**
     * Restrict which top-level input fields surface as MCP prompt arguments.
     * Default: every top-level scalar (string/number/integer/boolean/enum)
     * property of the input schema. Non-scalar fields never become prompt
     * arguments — the rendered instruction has the agent elicit them (D-004).
     */
    args?: readonly string[];
}
/** Per-tool exposure config — at least one of `http`/`mcp`/`ipc` must be set. */
export interface ToolExposure {
    http?: ToolExposureHttp;
    mcp?: ToolExposureMcp;
    /**
     * Mark this endpoint as IPC-eligible. When `true`, the endpoint-IPC
     * adapter exposes it over the UDS framing (in-process + Rust callers).
     * Default false — IPC opt-in mirrors HTTP/MCP opt-in. Phase E8.
     */
    ipc?: true;
    /**
     * Slash-command exposure via MCP prompts. DEFAULT ON for every
     * MCP-exposed tool (owner-ratified D-003, slash-exposure-tool-catalog-
     * 2026-06-12): absent/`true` ⇒ projected; `false` ⇒ hidden from the
     * slash surface; an object ⇒ projected with overrides.
     */
    slash?: boolean | ToolExposureSlash;
}
/**
 * One entry in the projection registry. Combines the function (truth)
 * with manifest metadata (gates + exposure).
 */
export interface ProjectedTool {
    /** Owning plugin name. Built-in tools use 'agent-mcp' or similar. */
    pluginName: string;
    /** One-line description shown in tool listings. */
    description: string;
    /** JSON Schema for tool input. Validated before invocation. */
    inputSchema: Record<string, unknown>;
    /**
     * Capabilities required to invoke. The dispatcher checks these against
     * the calling principal's grants (built-in path) AND against the
     * plugin's manifest-declared `capabilities` (plugin path). Empty array
     * means no capability gate.
     */
    capabilities: Capability[];
    /**
     * Read/write effect (code-execution-tool-orchestration B-CX-PRE). 'write' = the tool
     * mutates state; 'read' = side-effect-free. Inferred from the capability suffix at
     * `defineTool` time (overridable per tool). Read by the code-execution sandbox to decide
     * whether a tool call needs a dry-run/confirm gate (read-only ⇒ no gate). Optional for
     * back-compat; absent ⇒ unknown (the gate may default-deny a mutating call).
     */
    effect?: 'read' | 'write';
    /**
     * Canonical tool names this COMPOSITE tool bundles (tool-call-batching-wrappers
     * P-010). Empty/undefined ⇒ a primitive. Read by agent_tools:list (the queryable
     * composition tag) and prompt-assembly's renderToolsCatalog (the bounded
     * back-pointer that points each bundled primitive at this composite).
     */
    replaces?: readonly string[];
    /** Composition tag derived from `replaces` at defineTool time: 'composite' when
     *  `replaces` is non-empty, else 'primitive'. Queryable via agent_tools:list. */
    composition?: 'primitive' | 'composite';
    /**
     * Allowed agent roles. Empty/undefined means any role can call. Used
     * primarily by the MCP transport (agent calls); HTTP callers gate via
     * principal capabilities instead.
     */
    agentRoles?: AgentRole[];
    /** Per-role quota windows. Roles without an entry are unlimited. */
    rolesQuota?: Partial<Record<AgentRole, RolesQuota>>;
    /**
     * Resource-authorization hook (RFC tooldef-auth Phase 1b). When set, the dispatcher
     * runs it after the coarse gates and before the handler — fail-closed, audited, and
     * bypassable only via `GateBypass.policy`. Unset = no resource gate (the legacy
     * default; default-deny is RFC Phase 3). See `Authorizer`.
     */
    authorize?: Authorizer<unknown, UnifiedToolContext, UnifiedToolContext['principal']>;
    /**
     * RBAC role requirement (RFC tooldef-auth Phase 2). The caller's `principal.roles`
     * must include at least ONE of these (any-of). Checked by the dispatcher's
     * `role-requirement` gate — fail-closed (denied when there is no principal), audited,
     * and bypassed by `GateBypass.role` (a superuser passes RBAC role gates too). Distinct
     * from `roles` above, which is the AGENT-orchestration allowlist checked against
     * `ctx.role`. The declarative, typed replacement for ad-hoc `requireAdminKey` /
     * `requireStaff`-style checks.
     */
    requireRoles?: readonly string[];
    /**
     * Opt out of default-deny (RFC tooldef-auth Phase 3). When the host enables
     * `deps.defaultDeny`, a tool that declares NO gate (no capabilities, roles,
     * requireRoles, or authorize) is denied as `ungated` UNLESS it sets `public: true` —
     * the explicit "this tool intentionally needs no auth" marker (the `[AllowAnonymous]`
     * equivalent). Default-deny is NOT bypassable: an ungated tool is a declaration gap
     * regardless of caller, so the fix is to declare a gate or mark it public.
     */
    public?: boolean;
    /**
     * Declarative preconditions (autoloop-pot-operator-rebuild D-006) — the
     * preInvoke mirror of `emits:`. Evaluated by the dispatcher's
     * `preconditions` step (after `authorize`, before `timeout`): each spec's
     * condition must hold over `{ tool, args, ctx, state }` or the call rejects
     * (`precondition_failed`) / auto-corrects (`{ fire, then: 'retry' }` via
     * `deps.firePrecondition`). Functional preconditions ONLY — safety
     * invariants stay imperative code (D-007). See `ToolRequireSpec`.
     */
    requires?: readonly import('./requires').ToolRequireSpec[];
    /** Per-call wall-clock timeout, default 60s. */
    timeoutSec?: number;
    /**
     * Idle timeout — abort if no event has been emitted for this many
     * seconds. Augments `timeoutSec` (the wall-clock cap). 0 or undefined
     * disables idle-watchdog. Default off. Useful for streaming tools that
     * spawn child processes — wedged children stop emitting; this catches
     * them sooner than the wall-clock cap.
     */
    idleTimeoutSec?: number;
    /**
     * Per-call replay ring-buffer size. When > 0, the dispatcher keeps
     * the last N emitted events keyed on (workspaceId, toolName, runId)
     * for ~5 min past stream-end. A reconnecting client sending
     * `Last-Event-ID` + `X-Papercusp-Run-Id` headers gets the buffered
     * tail replayed before the cold sink continues. Eviction is FIFO
     * with a one-line warn log per evicted event. Phase 4 T2.2.
     *
     * Disconnect semantics: tool ABORTS on disconnect; replay serves
     * only the pre-disconnect buffer (model "(b)" in the plan). See
     * phase-4-endpoint-system-2026-05-12.md § T2.2 for the rationale.
     */
    replayBufferSize?: number;
    /**
     * Cross-workspace opt-out (P-062 Phase 4). Read by the HTTP host's
     * `runScoped` scoping seam: when true the tool runs on the admin
     * (rolbypassrls) handle rather than a workspace-scoped RLS transaction,
     * so it can read/write across workspaces. Absent/false ⇒ workspace-
     * isolated (the default). See RoleToolDefinition.crossWorkspace.
     */
    crossWorkspace?: boolean;
    /**
     * Surfaces this tool is meaningful from. Phase 4 T3.1. The prompt-
     * assembly catalog renderer filters by the caller's modality so
     * voice surfaces only see voice-capable tools. Absent → callers
     * treat it as "both surfaces" so legacy tools surface in either
     * catalog without an explicit opt-in. Use ['text'] or ['voice']
     * when a tool genuinely doesn't make sense in the other surface
     * (e.g. chat:ask_choice renders clickable buttons that are
     * invisible to a voice user).
     */
    modality?: ReadonlyArray<'text' | 'voice'>;
    /**
     * Profile gate. Controls which caller profile sees this tool in
     * `tools/list` and can invoke it via `tools/call`.
     *
     * - `'engineer'` — Papercusp-engineer/operator profile only. Hidden
     *   from `?profile=power` (power-engineer-on-any-harness) sessions.
     *   Group A tools (harness:*, operator:*, features:*, etc.) carry
     *   this tag. Default for new tools if uncertain.
     * - `'all'` (or omitted) — visible to every profile. Group B + C.
     *
     * Absent / undefined → treated as `'all'` for backward compatibility:
     * existing tools with no profile field remain visible until explicitly
     * tagged. New tools should always set this field.
     *
     * See: apps/operator/docs/plans/omp-profile-system-2026-05-24.md
     */
    profile?: 'engineer' | 'all';
    /**
     * Harness-scope requirement (su-prompt-audit-fixes P-020 / D-007).
     *
     * - `'required'` — the tool needs a resolved harness in `ctx.harnessSlug`
     *   (a non-wildcard slug). The dispatcher's `harness-check` step returns a
     *   uniform `harness_required` error when it's absent or `'*'`, replacing
     *   the per-handler grab-bag (harness_not_registered / require-slug /
     *   primary-fallback / stub). Intended for CTX-ONLY tools (no slug arg);
     *   tools that accept an explicit slug self-resolve and stay `'optional'`.
     * - `'optional'` (or absent) — no gate; the handler resolves a harness
     *   from an arg and/or `ctx.harnessSlug` as it sees fit. Default.
     * - `'none'` — the tool is harness-agnostic. Informational; no gate.
     *
     * The gate fails closed even for superuser/power callers (it's a functional
     * requirement, not a permission) — see `GateBypass.papercusp`.
     */
    harness?: 'required' | 'optional' | 'none';
    /**
     * State-shaped tool schema (bespoke-card-improvements #1 / T4.3).
     *
     * When set, the tool is on the STATE channel: it publishes its
     * current snapshot via `ctx.publishState(snapshot)`, and clients
     * reconnecting receive the latest snapshot rather than an event-
     * history replay. State-shaped tools opt OUT of the replay ring
     * buffer (M5 — declared at register time, no per-call branch).
     *
     * Reconnect semantics fall out for free: state outlives any single
     * connection while the run is open (5-min retention after run-end).
     * This is what absorbs the original T4.3 "long-lived disconnected"
     * design — declare a state schema and reconnect-resilience is
     * automatic.
     *
     * v1 ships SNAPSHOT-ONLY publishState. JSON Patch deltas are
     * deferred to v1.1 once we measure snapshot-only perf on real tools.
     *
     * Any Standard Schema validator (P-020); the snapshot is validated via
     * `~standard.validate` at `ctx.publishState` time.
     */
    state?: StandardSchemaV1;
    /**
     * Output-`data` schema (token-efficient-tool-result-formats D-003). The raw
     * Standard-Schema validator a tool declared for its `ToolResponse.data`.
     * Source for runtime output validation + `structuredContent`. Absent when the
     * tool declared none (it still gets the TOON runtime auto-encoder).
     */
    outputSchema?: StandardSchemaV1;
    /**
     * JSON-Schema projection of `outputSchema`, computed once at register time.
     * Advertised as MCP `outputSchema` in `tools/list` (P-010); also the input to
     * the eligibility walk below.
     */
    outputJsonSchema?: Record<string, unknown>;
    /**
     * Precomputed format eligibility for the output `data` shape (D-004): the set
     * of formats the result can be rendered in + the best compact default. Read
     * by the result serializer on every call and advertised in `tools/list`.
     * Absent ⇒ no output schema ⇒ the serializer uses the runtime auto-encoder.
     */
    resultEligibility?: EligibilityResult;
    /**
     * Typed event channel — Zod schemas keyed by event name. Surfaced
     * via tools/list as JSON-Schema for client discovery. No runtime
     * validation of outgoing events (trusted code path). Undefined for
     * tools that don't stream typed events; they may still call
     * `ctx.progress` (the alias) which goes through the 'progress' wire
     * event reserved for that purpose.
     *
     * Plugins declaring this on their JSON manifest go through
     * `eventsJsonSchema` below — the plugin loader populates that
     * field after validating the JSON-Schema subset (T3.2).
     */
    events?: EventsSchema;
    /**
     * Plugin-side event schemas declared as raw JSON-Schema. Used by
     * plugin tools that ship their `papercusp.json` manifest with an
     * `events` block. The plugin loader validates against the
     * supported subset (`packages/agent-mcp/src/plugin-events.ts`),
     * classifies wire kinds, and populates this field alongside the
     * computed `eventWireKinds`. Built-in tools (via `defineTool`)
     * use `events` (Zod) above; the two fields are mutually exclusive.
     * Phase 4 T3.2.
     */
    eventsJsonSchema?: Record<string, Record<string, unknown>>;
    /**
     * Per-event wire classification — `'string'` for z.string() schemas
     * (raw text on SSE), `'json'` for everything else. Computed once at
     * register time from `events` OR `eventsJsonSchema`; cached so
     * emit-time is constant-cost. Absent when neither is declared.
     */
    eventWireKinds?: Record<string, EventWireKind>;
    /** Where to project this function — at least one of http/mcp required. */
    expose: ToolExposure;
    /** The function. Source of truth. */
    fn: ToolFn;
    /**
     * Per-tool guidance for system-prompt assembly + `agent_tools:list`
     * introspection. Plumbed from `defineTool({ guidance })` (or the
     * plugin SDK's same slot). See `ToolGuidance` in types.ts.
     *
     * Shape mirrors `ToolGuidance` but without a `byRole` type-import to
     * keep this module free of role-enum imports. Plumbed-through opaque.
     */
    guidance?: {
        when?: string;
        notWhen?: string;
        chaining?: string;
        byRole?: Record<string, {
            when?: string;
            notWhen?: string;
            chaining?: string;
        }>;
    };
}
export declare class ToolRegistrationError extends Error {
    constructor(message: string);
}
/**
 * Register a projected tool. Validates the manifest:
 *   - At least one of `expose.http` / `expose.mcp` must be set.
 *   - `expose.mcp.name` must use dotted naming and be unique across the
 *     registry.
 *   - `expose.http.path` must be unique across the registry.
 */
export declare function registerProjectedTool(tool: ProjectedTool): void;
/**
 * Remove all entries for a plugin from the registry. Used by the host's
 * `/api/plugins/host/refresh` flow so re-discovery can re-register without
 * tripping the cross-plugin name-collision guard against its own prior
 * entries.
 */
export declare function unregisterProjectedToolsForPlugin(pluginName: string): number;
/** Look up by MCP name (e.g. 'repomix.pack'). */
export declare function lookupByMcpName(name: string): ProjectedTool | undefined;
/** Look up by HTTP path (e.g. '/api/plugins/repomix/pack'). */
export declare function lookupByHttpPath(path: string): ProjectedTool | undefined;
/** Snapshot of all registered projected tools. */
export declare function listAllProjectedTools(): readonly ProjectedTool[];
/**
 * True if a tool declares ANY auth gate — a capability, an agent-role allowlist, an RBAC
 * role requirement, or an `authorize` hook. The single predicate behind both the
 * default-deny dispatch gate and `listUngatedProjectedTools` (RFC tooldef-auth Phase 3),
 * so the enforcement and the migration aid can't drift.
 */
export declare function toolDeclaresGate(tool: Pick<ProjectedTool, 'capabilities' | 'agentRoles' | 'requireRoles' | 'authorize'>): boolean;
/**
 * Tools that would be denied once `deps.defaultDeny` is flipped on: they declare no gate
 * and are not marked `public`. The migration aid for RFC tooldef-auth Phase 3 (§8 D1) —
 * run it (with the full tool registry loaded) BEFORE enabling default-deny, triage each
 * (declare a gate or mark `public`), then flip. Empty result = safe to flip.
 */
export declare function listUngatedProjectedTools(): readonly ProjectedTool[];
/**
 * MCP-protocol tool listings, optionally filtered by calling role.
 * Returns only tools with `expose.mcp` set; tools that are HTTP-only are
 * invisible to the agent.
 *
 * The `events` field surfaces the tool's typed event vocabulary as
 * JSON-Schema entries — discoverable by any MCP client. This is the
 * Papercusp MCP extension that lets clients render typed event streams
 * (deltas, suggestions, etc.) without out-of-band knowledge of each
 * tool. Standard MCP clients that don't know about this field simply
 * ignore it.
 */
export interface McpToolListing {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    /**
     * JSON-Schema for the tool's result `data` (MCP `outputSchema`, P-010).
     * Spec-aligned advertisement; present only when the tool declared an output
     * schema. Clients can validate `structuredContent` against it.
     */
    outputSchema?: Record<string, unknown>;
    /**
     * The token-efficient formats this tool's result can be rendered in
     * (token-efficient-tool-result-formats P-010 / D-005). A Papercusp extension
     * so a client knows which `_meta.format` values it may negotiate; absent ⇒
     * `['json']` (the always-available default). Also mirrored onto `_meta`
     * (`papercusp/resultFormats`) because the MCP SDK strips unknown TOP-LEVEL
     * tool fields during validation — `_meta` is the spec's passthrough slot, so
     * that copy is the one that actually reaches a strict client.
     */
    resultFormats?: ReadonlyArray<'json' | 'toon' | 'csv' | 'tsv' | 'md'>;
    /**
     * MCP `_meta` passthrough — survives strict SDK validation (unlike unknown
     * top-level fields). Carries `papercusp/resultFormats` (the capability set).
     */
    _meta?: Record<string, unknown>;
    /** Map of event-name → JSON-Schema. Absent when the tool declares no events. */
    events?: Record<string, Record<string, unknown>>;
    /**
     * Surfaces this tool is meaningful from. Absent → callers treat
     * it as `['text', 'voice']` so legacy tools surface in either
     * catalog. Phase 4 T3.1; clients can filter by their caller
     * modality.
     */
    modality?: ReadonlyArray<'text' | 'voice'>;
}
export declare function listMcpProjections(role?: AgentRole, profile?: 'engineer' | 'power'): McpToolListing[];
/** Test-only — flushes the registry between tests. */
export declare function _resetProjectionRegistryForTests(): void;
