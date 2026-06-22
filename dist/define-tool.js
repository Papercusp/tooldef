"use strict";
/**
 * defineTool — the simplification engine.
 *
 * Tools are declared via `defineTool({ capability, args, handler })` and
 * placed in `src/tools/<group>/<verb>.ts`. The helper:
 *   - Derives the tool name from the file path: `tools/tasks/list.ts` →
 *     `tasks:list`. Override via `name` if needed.
 *   - Composes the description from `guidance` (when/notWhen/chaining)
 *     when not passed explicitly — see `describeFromGuidance`.
 *   - Looks up the tier from the capability per §10.6.1.
 *   - Self-registers into the runtime catalog (`registry.ts`).
 *
 * The catalog is the result of importing `tools/**`. The MCP `tools/list`
 * response is generated from the catalog at startup. Adding a tool is
 * dropping a file; no manual list to maintain.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.defineTool = defineTool;
const capability_tiers_1 = require("./capability-tiers");
const schema_adapter_1 = require("./schema-adapter");
const standard_schema_1 = require("./standard-schema");
const registry_1 = require("./registry");
const emits_registry_1 = require("./emits-registry");
const tool_projection_1 = require("./tool-projection");
const dispatch_projected_1 = require("./dispatch-projected");
const serialize_result_1 = require("./serialize-result");
const result_encoding_1 = require("@papercusp/result-encoding");
/**
 * Walk up the call stack to find the file that called defineTool, then
 * derive a tool name from that file's path. Convention:
 *   .../tools/tasks/list.ts    → tasks:list
 *   .../tools/harness/get.ts   → harness:get
 *   .../tools/search/query.ts  → search:query
 *
 * If the file is `index.ts`, the parent directory contributes the verb;
 * useful for tools that need a directory of helpers.
 */
function deriveNameFromCallSite() {
    const ErrorAny = Error;
    const orig = ErrorAny.prepareStackTrace;
    try {
        ErrorAny.prepareStackTrace = (_err, stack) => stack;
        const raw = new Error().stack;
        // [0]=this fn, [1]=defineTool, [2]=caller (the tool file).
        const callerFile = raw?.[2]?.getFileName?.();
        if (!callerFile)
            return null;
        // Find the segment after 'tools/'.
        const match = /\/tools\/([^/]+)\/([^/]+)\.[mc]?[jt]s$/.exec(callerFile);
        if (!match)
            return null;
        const group = match[1];
        let verb = match[2];
        if (verb === 'index') {
            verb = 'default';
        }
        return `${group}:${verb}`;
    }
    catch {
        return null;
    }
    finally {
        ErrorAny.prepareStackTrace = orig;
    }
}
/**
 * Compose a model-facing description from `guidance` for tools that omit
 * an explicit `description`. Nearly every first-party tool carries rich
 * when/notWhen/chaining guidance but no `description` — and the old
 * fallback was a useless `Tool <name>` placeholder. A model handed 200+
 * tools all described as "Tool X" cannot tell them apart: the operator
 * brain confabulated harness state rather than call tools it could not
 * distinguish (2026-05-21 P5 root cause; verified with a model-API proxy
 * — the brain received all 228 agentmcp tools but every description was
 * the placeholder). The `guidance` object stays separately available for
 * role system-prompt assembly — this only fills the `description` slot,
 * which is the only field the MCP `tools/list` wire actually carries.
 */
function describeFromGuidance(guidance) {
    if (!guidance)
        return null;
    const parts = [];
    if (guidance.when)
        parts.push(`When to use: ${guidance.when}`);
    if (guidance.notWhen)
        parts.push(`When NOT to use: ${guidance.notWhen}`);
    if (guidance.chaining)
        parts.push(`Chaining: ${guidance.chaining}`);
    return parts.length > 0 ? parts.join('\n\n') : null;
}
/**
 * Compute the output-schema JSON projection + format eligibility once at
 * register time (token-efficient-tool-result-formats P-001/P-002). Returns
 * empties when the tool declared no output schema or the projection fails —
 * such tools fall back to the TOON runtime auto-encoder at serialize time.
 */
function computeOutputEligibility(resultSchema) {
    if (!resultSchema)
        return {};
    try {
        const js = (0, schema_adapter_1.toJsonSchema)(resultSchema);
        delete js.$schema;
        return { jsonSchema: js, eligibility: (0, result_encoding_1.analyzeSchema)(js) };
    }
    catch {
        return {};
    }
}
/**
 * Build the MCP `ToolResult` from a handler's `ToolResponse` using format-aware
 * serialization (P-005/P-006). The chosen format follows the request context
 * (explicit negotiation, else MCP→compact / others→JSON) intersected with the
 * tool's precomputed eligibility; the pagination/degraded envelope rides in
 * `_meta`. When `PAPERCUSP_VALIDATE_TOOL_OUTPUT=1` and an output schema is
 * declared, the returned `data` is validated against it and a mismatch is
 * logged (best-effort, never throws — D-003 payoff #3).
 */
async function serializeProjectedResult(response, ctx, eligibility, def, readColumns) {
    if (def.result &&
        process.env.PAPERCUSP_VALIDATE_TOOL_OUTPUT === '1' &&
        response &&
        typeof response === 'object' &&
        response.data !== undefined) {
        try {
            const v = await (0, standard_schema_1.standardValidate)(def.result, response.data);
            if (!v.ok) {
                ctx.log(`[output-schema] ${def.name} returned data not matching its declared result schema: ${(0, standard_schema_1.formatIssues)(v.issues)}`);
            }
        }
        catch {
            /* validation is best-effort; never fail the call on it */
        }
    }
    const serialized = (0, serialize_result_1.serializeToolResponse)(response, {
        ...(0, serialize_result_1.formatOptsFromCtx)(ctx, eligibility),
        toolName: def.name,
        readColumns,
    });
    const result = { content: serialized.content };
    if (Object.keys(serialized._meta).length > 0)
        result._meta = serialized._meta;
    if (serialized.structuredContent !== undefined)
        result.structuredContent = serialized.structuredContent;
    return result;
}
/**
 * P-002 (definetool-token-optimization-adoption): the ~407 first-party tools that
 * hand-roll `return { content: [{ type:'text', text: JSON.stringify(x) }] }` bypass
 * the compact encoder — a raw `ToolResult` passes through untouched. When such a
 * result is, ON THE AGENT-FACING MCP TRANSPORT, a single text item that parses as
 * JSON whose shape TOON actually shrinks (an array, or an object with an array
 * field), this returns the parsed payload so the caller can re-route it through the
 * SAME serializer a `{ data }` handler uses — zero per-tool churn, lossless JSON
 * fallback. Otherwise returns `undefined` ⇒ the raw result is passed through verbatim.
 *
 * Deliberately narrow so it can NEVER change what a NON-agent consumer sees:
 *   - ONLY `ctx.transport === 'mcp'`. Every other transport — in-process compounds
 *     (`inProcessCall`'s `unwrap` → `JSON.parse`), HTTP, IPC, the desktop UI / TUI
 *     Memory tab — keeps the EXACT raw bytes, preserving the memory:* verbatim-content
 *     contract (memory-taxonomy-and-debt-followups P-006; those consumers read over a
 *     non-mcp transport, and an MCP agent reads the body as text, never JSON-parses it).
 *   - single text content only; skip `isError`, `structuredContent`, multi-content /
 *     uiResources, and any already-`format:`-marked compact body (never double-encode).
 *   - parse the text FIRST, then wrap `{ data: parsed }` — NOT `{ data: theWholeResult }`,
 *     which is the double-wrap that broke the past blanket attempt (define-tool L548).
 *   - only array / object-with-array-field payloads (a scalar / plain object round-trips
 *     to identical JSON — no win — so leave it untouched).
 */
function reencodableJsonPayload(out, ctx) {
    if (ctx.transport !== 'mcp')
        return undefined;
    if (out.isError)
        return undefined;
    if (out.structuredContent !== undefined)
        return undefined;
    const content = out.content;
    if (!Array.isArray(content) || content.length !== 1)
        return undefined;
    const item = content[0];
    if (!item || item.type !== 'text' || typeof item.text !== 'string')
        return undefined;
    const text = item.text;
    // Already a compact-encoded body (a `{data}` tool, or a hand-marked payload).
    if (/^format: (?:toon|csv|tsv|md)\n/.test(text))
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return undefined; // non-JSON text (a plain string / human message) — leave as-is
    }
    if (!Array.isArray(parsed) && !(0, result_encoding_1.isObjectWithArrayField)(parsed))
        return undefined;
    return parsed;
}
/**
 * Write-side positional shim (token-efficient-agent-io P-008/D-006/D-007). When
 * the tool is registry write-positional and the model sent a single `row`
 * string, reconstruct the typed args from the prompt-declared column order and
 * run the misalignment guard BEFORE Zod validation. Returns the (possibly
 * reconstructed) input unchanged when the tool isn't positional or the caller
 * sent keyed args. Throws on a guard failure so a mis-emitted row fails LOUDLY
 * rather than writing wrong-but-valid data (Zod checks shape, not alignment).
 */
function applyPositionalWriteShim(name, argsJsonSchema, input) {
    if (!(0, result_encoding_1.isWritePositional)(name))
        return input;
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return input;
    const row = input.row;
    if (typeof row !== 'string')
        return input; // keyed args (or no row) — leave as-is
    const cols = (0, result_encoding_1.projectWriteColumns)(argsJsonSchema, { freeTextName: (0, result_encoding_1.getPrePromptEntry)(name)?.freeTextArg });
    if (!cols)
        return input; // tool doesn't actually fit the bounded positional shape
    const rec = (0, result_encoding_1.reconstructArgs)(row, cols);
    if (!rec.ok)
        throw new Error(`invalid_positional_row: ${rec.reason}`);
    return rec.args;
}
function defineTool(input) {
    // Route-shaped — discriminated by `method` (tool inputs never carry it).
    if ('method' in input && 'path' in input) {
        return defineRouteShaped(input);
    }
    if (input.requirePrincipal === false) {
        return defineRoleGatedTool(input);
    }
    return definePrincipalGatedTool(input);
}
/**
 * Route-shaped `defineTool`. Pure — returns the definition unchanged;
 * mounting happens host-side via `registerRoute`. A route declares its
 * own `auth` (incl. `kind: ['device']` if it admits paired devices) and
 * `cors` — there is no implicit folding.
 *
 * A route is deliberately NOT registered into the projection registry —
 * plumbing must not appear in the agent tool catalog.
 */
function defineRouteShaped(def) {
    return def;
}
/**
 * Infer a tool's read/write effect (code-execution-tool-orchestration B-CX-PRE) from its
 * capability when not set explicitly: write-ish suffixes (`:write`/`:admin`/`:delete`/
 * `:manage`/`:execute`) ⇒ 'write'; everything else ⇒ 'read'. An explicit `effect` always
 * wins. Consumed by the code-execution sandbox's dry-run/confirm gate (read-only ⇒ no gate).
 */
const WRITE_CAPABILITY_SUFFIXES = [':write', ':admin', ':delete', ':manage', ':execute'];
/**
 * Known-mutating capabilities whose names don't end in a write-suffix — the
 * `capability:*` host-capability family (bash/fs-write/edit/write/git/computer/net) plus
 * dedicated control / side-effect capabilities (processes:kill, turn:interrupt,
 * ui:dispatch, tui:dispatch, operator:converse, activity:report).
 * Each is used ONLY by a mutating tool — where a read sibling exists it is a DISTINCT
 * `*:read` capability (ui:read, activity:read, operator:read) — so flipping the capability
 * is safe and self-documenting. Centralized here instead of backfilling each tool def.
 *
 * A tool can still override via an explicit `effect`; and a mutator that SHARES a `*:read`
 * capability with genuine readers (e.g. learning_packs:export, plans:export — both write
 * files under a `*:read` cap) sets `effect: 'write'` on its own def instead of polluting
 * this set (which would wrongly flip its read siblings). B-CX-EFFECT audit (2026-06-20).
 */
const WRITE_CAPABILITIES = new Set([
    'capability:bash',
    'capability:fs-write',
    'capability:edit',
    'capability:write',
    'capability:git',
    'capability:computer',
    'capability:net', // outbound HTTP (capability:fetch) — can POST/PUT/DELETE → external mutation
    'processes:kill',
    'turn:interrupt', // ends a peer agent's current turn
    'ui:dispatch', // performs a UI intent (click/navigate/submit) in a browser tab
    'tui:dispatch', // performs a control intent against a running pui workbench
    'operator:converse', // brain turn: spawns agents, records spend, mem0.add, dispatches <spawn>
    'activity:report', // inserts an agent-activity row
]);
function inferEffect(capability, explicit) {
    if (explicit)
        return explicit;
    const cap = capability.toLowerCase();
    if (WRITE_CAPABILITIES.has(cap))
        return 'write';
    return WRITE_CAPABILITY_SUFFIXES.some((s) => cap.endsWith(s)) ? 'write' : 'read';
}
function definePrincipalGatedTool(input) {
    const name = input.name ?? deriveNameFromCallSite();
    if (!name) {
        throw new Error('defineTool: could not derive tool name from call site. ' +
            'Pass `name` explicitly or place the file under `tools/<group>/<verb>.ts`.');
    }
    const description = input.description ??
        describeFromGuidance(input.guidance) ??
        `Tool ${name}`;
    const tier = (0, capability_tiers_1.tierFor)(input.capability);
    const def = {
        name,
        description,
        capability: input.capability,
        tier,
        effect: inferEffect(input.capability, input.effect),
        replaces: input.replaces,
        composition: (input.replaces?.length ?? 0) > 0 ? 'composite' : 'primitive',
        args: input.args,
        result: input.result ?? input.output,
        handler: input.handler,
        guidance: input.guidance,
        profile: input.profile,
        harness: input.harness,
        authorize: input.authorize,
        requireRoles: input.requireRoles,
        public: input.public,
        emits: input.emits,
        requires: input.requires,
        // P-062: cross-workspace opt-out, threaded so PRINCIPAL-gated tools (e.g.
        // memory:*) can run from an unscoped superuser session. The role-gated path
        // already threads this; the principal-gated path previously dropped it, so a
        // principal-gated cross-workspace tool failed `workspace_required`. See the field doc.
        crossWorkspace: input.crossWorkspace,
    };
    // The catalog stores defs with their schema type erased (handlers run on
    // post-validation values); a specific TArgs isn't assignable to the
    // unknown-output base under Standard Schema's variance, so widen explicitly.
    (0, registry_1.register)(def);
    registerLegacyAsProjected(def, input.expose);
    // Co-located intrinsic emissions → the generic collector; the operator-core
    // desugar registers them as event-reaction rules at load (D-002).
    (0, emits_registry_1.collectToolEmits)(name, input.emits);
    return def;
}
/**
 * Role-gated first-party tool — registers into the same projection
 * registry as principal-gated tools but skips the `principal+tx`
 * requirement in the wrapper. Gating happens via the dispatcher's
 * `roles` allowlist + `rolesQuota`, exactly as for plugin tools.
 *
 * The handler receives `UnifiedToolContext` directly (workspaceId,
 * harnessSlug, role, runId, etc.) — no `Principal`, no transaction.
 * If the tool needs PG, open its own connection from the workspace-
 * resolved pool; do not assume `tx` is set.
 */
function defineRoleGatedTool(input) {
    const name = input.name ?? deriveNameFromCallSite();
    if (!name) {
        throw new Error('defineTool: could not derive tool name from call site. ' +
            'Pass `name` explicitly or place the file under `tools/<group>/<verb>.ts`.');
    }
    const description = input.description ??
        describeFromGuidance(input.guidance) ??
        `Tool ${name}`;
    const tier = (0, capability_tiers_1.tierFor)(input.capability);
    const def = {
        name,
        description,
        capability: input.capability,
        tier,
        effect: inferEffect(input.capability, input.effect),
        replaces: input.replaces,
        composition: (input.replaces?.length ?? 0) > 0 ? 'composite' : 'primitive',
        requirePrincipal: false,
        authorize: input.authorize,
        requireRoles: input.requireRoles,
        public: input.public,
        agentRoles: input.agentRoles,
        rolesQuota: input.rolesQuota,
        timeoutSec: input.timeoutSec,
        idleTimeoutSec: input.idleTimeoutSec,
        replayBufferSize: input.replayBufferSize,
        crossWorkspace: input.crossWorkspace,
        modality: input.modality,
        args: input.args,
        result: input.result ?? input.output,
        events: input.events,
        state: input.state,
        handler: input.handler,
        guidance: input.guidance,
        profile: input.profile,
        harness: input.harness,
        emits: input.emits,
        requires: input.requires,
    };
    registerRoleGatedAsProjected(def, input.expose);
    // Co-located intrinsic emissions → the generic collector; the operator-core
    // desugar registers them as event-reaction rules at load (D-002).
    (0, emits_registry_1.collectToolEmits)(name, input.emits);
    return def;
}
/**
 * Auto-register a legacy `defineTool` entry in the projected-tool
 * registry so it appears alongside plugin-contributed tools and gets
 * HTTP exposure for free.
 *
 * Conventions:
 *   - MCP name unchanged (e.g. `tasks:list`).
 *   - HTTP path: `/api/agent-tools/<group>/<verb>` (group/verb derived
 *     from the colon in the legacy name).
 *   - Single capability from legacy `tool.capability` becomes a
 *     one-element capabilities[] array.
 *   - JSON Schema derived from Zod schema via zodToJsonSchema.
 *   - Handler wrapped so the legacy (args, ToolContext) signature
 *     adapts to the unified (args, UnifiedToolContext) shape:
 *       · ctx.principal + ctx.tx must be populated (built-in tools
 *         don't work without them; the route attaches them via bearer
 *         auth + withWorkspace).
 *       · ToolResponse.data → ToolResult.content[text(JSON)].
 *       · ToolResponse.uiResources → trailing content items.
 */
/**
 * Flatten a JSON schema for OpenAI's function-calling validator.
 *
 * OpenAI Codex (strict mode) requires:
 *   1. `type: "object"` at root.
 *   2. NO `oneOf`/`anyOf`/`allOf`/`enum`/`not` at root.
 *
 * Zod's `discriminatedUnion` (and `z.union`) produces a top-level
 * `{oneOf: [...]}` or `{anyOf: [...]}` — both rejected.
 *
 * Fix: when we see root-level oneOf/anyOf with all-object variants,
 * merge each variant's `properties` into a single object schema.
 * The discriminator field (`mode`, `op`, etc.) stays required; every
 * variant-specific field becomes optional. Handler-level validation
 * (via def.args.safeParse) re-enforces the per-variant required fields
 * at runtime, so loosening the schema for OpenAI doesn't compromise
 * input safety.
 *
 * Schemas that already have `type: "object"` and no problematic
 * top-level keys pass through unchanged.
 */
function flattenForOpenAi(schema) {
    // Already shaped right.
    const PROHIBITED_AT_ROOT = ['oneOf', 'anyOf', 'allOf', 'not'];
    const hasProhibited = PROHIBITED_AT_ROOT.some((k) => k in schema);
    if (schema.type === 'object' && !hasProhibited)
        return schema;
    // Pull the discriminator unions out of root.
    const variants = [];
    for (const key of ['oneOf', 'anyOf']) {
        if (Array.isArray(schema[key])) {
            for (const v of schema[key]) {
                if (v && typeof v === 'object')
                    variants.push(v);
            }
        }
    }
    if (variants.length === 0) {
        // No unions — just ensure type:"object" + strip problematic keys.
        const out = { ...schema };
        for (const k of PROHIBITED_AT_ROOT)
            delete out[k];
        if (out.type !== 'object')
            out.type = 'object';
        return out;
    }
    // Merge variant properties. Each property keeps its first definition;
    // a property required by EVERY variant stays required (typically the
    // discriminator); others become optional.
    const mergedProps = {};
    const requiredSets = [];
    for (const v of variants) {
        const props = v.properties ?? {};
        for (const [pk, pv] of Object.entries(props)) {
            if (!(pk in mergedProps))
                mergedProps[pk] = pv;
        }
        const req = Array.isArray(v.required) ? new Set(v.required) : new Set();
        requiredSets.push(req);
    }
    const required = [...requiredSets[0]].filter((p) => requiredSets.every((s) => s.has(p)));
    return {
        type: 'object',
        properties: mergedProps,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
        description: typeof schema.description === 'string' ? schema.description : undefined,
    };
}
function registerLegacyAsProjected(def, expose) {
    // tasks:list → /api/agent-tools/tasks/list
    const httpPath = `/api/agent-tools/${def.name.replaceAll(':', '/')}`;
    // Pluggable schema→JSON-Schema (P-021); default adapter is Zod 4's
    // toJSONSchema. zod-to-json-schema@3 returned just `{ $schema }` for zod 4
    // schemas (empty input schemas) — the built-in path fixed that.
    const rawSchema = (0, schema_adapter_1.toJsonSchema)(def.args);
    delete rawSchema.$schema;
    const inputSchema = flattenForOpenAi(rawSchema);
    const { jsonSchema: outputJsonSchema, eligibility } = computeOutputEligibility(def.result);
    const readColumns = (0, result_encoding_1.projectReadColumns)(outputJsonSchema);
    const projectedFn = async (input, ctx) => {
        if (!ctx.principal || !ctx.tx) {
            // Almost always this is a workspace-SCOPING gap, not an auth failure:
            // the caller is bearer-authenticated but the session carries no
            // concrete workspace, so the host synthesized no workspace
            // transaction. Say so — "requires authenticated request" sent
            // authenticated callers down the wrong debugging path (EI-30).
            throw new dispatch_projected_1.UnauthorizedToolError(`built-in tool "${def.name}" requires a workspace-scoped call — this session has no workspace transaction. ` +
                `Scope the session to a workspace, or pass a per-call workspace where the host/tool supports one.`);
        }
        const legacyCtx = {
            principal: ctx.principal,
            tx: ctx.tx,
            log: (level, msg, meta) => ctx.log(`[${level}] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`),
        };
        const shimmed = applyPositionalWriteShim(def.name, rawSchema, input);
        const parsed = await (0, standard_schema_1.standardValidate)(def.args, shimmed);
        if (!parsed.ok) {
            throw new dispatch_projected_1.InvalidInputError(`invalid_args: ${(0, standard_schema_1.formatIssues)(parsed.issues)}`);
        }
        const response = await def.handler(parsed.value, legacyCtx);
        // A raw ToolResult (MCP content shape) normally passes through untouched —
        // parity with the role-gated wrapper below. EXCEPT: on the agent-facing MCP
        // transport, a single-text-item JSON body whose shape TOON shrinks is
        // transparently re-encoded for the token win (P-002). The narrow guards in
        // `reencodableJsonPayload` keep this off every NON-mcp transport, so the
        // memory:* family + the TUI Memory tab (which read content[0].text as the
        // handler's own JSON over a non-mcp transport) are byte-for-byte unchanged
        // — preserving the contract a past blanket re-encode broke
        // (memory-taxonomy-and-debt-followups P-006).
        if (response && typeof response === 'object' && Array.isArray(response.content)) {
            const reencodable = reencodableJsonPayload(response, ctx);
            if (reencodable !== undefined) {
                return serializeProjectedResult({ data: reencodable }, ctx, eligibility, def, readColumns);
            }
            return response;
        }
        return serializeProjectedResult(response, ctx, eligibility, def, readColumns);
    };
    (0, tool_projection_1.registerProjectedTool)({
        pluginName: 'agent-mcp',
        description: def.description,
        inputSchema,
        capabilities: [def.capability],
        effect: def.effect,
        replaces: def.replaces,
        composition: def.composition,
        profile: def.profile,
        harness: def.harness,
        authorize: def.authorize,
        requireRoles: def.requireRoles,
        public: def.public,
        requires: def.requires,
        // P-062 / EI-2378: thread crossWorkspace into the PROJECTED def. The `def`
        // already carries it (definePrincipalGatedTool L341), but this projection —
        // what the host dispatch + the scoped-superuser clamp read via lookupByMcpName —
        // previously dropped it, so a principal-gated crossWorkspace tool (memory:* etc.)
        // ran on a workspace-scoped tx and failed `workspace_required` from an unscoped
        // ('*') psu session. The role-gated projection already threads it; this restores
        // parity. crossWorkspace tools self-derive workspaceId (never rely on the tx's
        // RLS), so the admin-handle path is behavior-preserving for concrete callers.
        crossWorkspace: def.crossWorkspace,
        outputSchema: def.result,
        outputJsonSchema,
        resultEligibility: eligibility,
        expose: {
            mcp: { name: def.name },
            http: { path: httpPath, methods: ['POST'] },
            // IPC-eligibility (the typed endpoint_invoke / sys:http allowlist) is
            // opt-in per tool via `expose: { ipc: true }` in defineTool — read off
            // the projected registry by the host's IPC server (Phase E8).
            ...(expose?.ipc ? { ipc: true } : {}),
            // Slash exposure (MCP-prompts slash commands) defaults ON when absent;
            // thread the declared value so `false`/overrides survive projection.
            ...(expose?.slash !== undefined ? { slash: expose.slash } : {}),
        },
        fn: projectedFn,
        guidance: def.guidance,
    });
}
/**
 * Project a role-gated first-party tool into the registry. Unlike the
 * legacy wrapper, the handler is invoked WITHOUT requiring `principal`
 * or `tx` on the context — gating is the dispatcher's role + quota
 * check.
 *
 * The handler may return either a `ToolResult` (MCP shape) or a
 * `ToolResponse` envelope; this wrapper normalises to `ToolResult` so
 * both transports see the same content[] array.
 */
function registerRoleGatedAsProjected(def, expose) {
    const httpPath = `/api/agent-tools/${def.name.replaceAll(':', '/')}`;
    const rawSchema = (0, schema_adapter_1.toJsonSchema)(def.args);
    delete rawSchema.$schema;
    const inputSchema = flattenForOpenAi(rawSchema);
    const { jsonSchema: outputJsonSchema, eligibility } = computeOutputEligibility(def.result);
    const readColumns = (0, result_encoding_1.projectReadColumns)(outputJsonSchema);
    const projectedFn = async (input, ctx) => {
        const shimmed = applyPositionalWriteShim(def.name, rawSchema, input);
        const parsed = await (0, standard_schema_1.standardValidate)(def.args, shimmed);
        if (!parsed.ok) {
            throw new dispatch_projected_1.InvalidInputError(`invalid_args: ${(0, standard_schema_1.formatIssues)(parsed.issues)}`);
        }
        const out = await def.handler(parsed.value, ctx);
        // Already a ToolResult? The handler self-serialized its content — pass it
        // through untouched (format-aware serialization only applies to handlers
        // that return a ToolResponse envelope with structured `data`). EXCEPT: on
        // the MCP transport, a single-text JSON body whose shape TOON shrinks is
        // re-encoded for the token win (P-002); see `reencodableJsonPayload` — it is
        // a no-op on every non-mcp transport, so verbatim-content consumers are safe.
        if (out && typeof out === 'object' && Array.isArray(out.content)) {
            const reencodable = reencodableJsonPayload(out, ctx);
            if (reencodable !== undefined) {
                return serializeProjectedResult({ data: reencodable }, ctx, eligibility, def, readColumns);
            }
            return out;
        }
        // ToolResponse envelope → format-aware MCP content[] + _meta.
        return serializeProjectedResult(out, ctx, eligibility, def, readColumns);
    };
    (0, tool_projection_1.registerProjectedTool)({
        pluginName: 'agent-mcp',
        description: def.description,
        inputSchema,
        capabilities: [def.capability],
        effect: def.effect,
        replaces: def.replaces,
        composition: def.composition,
        profile: def.profile,
        harness: def.harness,
        outputSchema: def.result,
        outputJsonSchema,
        resultEligibility: eligibility,
        agentRoles: def.agentRoles,
        rolesQuota: def.rolesQuota,
        authorize: def.authorize,
        requireRoles: def.requireRoles,
        public: def.public,
        requires: def.requires,
        timeoutSec: def.timeoutSec,
        idleTimeoutSec: def.idleTimeoutSec,
        replayBufferSize: def.replayBufferSize,
        crossWorkspace: def.crossWorkspace,
        modality: def.modality,
        events: def.events,
        state: def.state,
        expose: {
            mcp: { name: def.name },
            http: { path: httpPath, methods: ['POST'] },
            // IPC-eligibility (the typed endpoint_invoke / sys:http allowlist) is
            // opt-in per tool via `expose: { ipc: true }` in defineTool — read off
            // the projected registry by the host's IPC server (Phase E8).
            ...(expose?.ipc ? { ipc: true } : {}),
            // Slash exposure (MCP-prompts slash commands) defaults ON when absent;
            // thread the declared value so `false`/overrides survive projection.
            ...(expose?.slash !== undefined ? { slash: expose.slash } : {}),
        },
        fn: projectedFn,
        guidance: def.guidance,
    });
}
