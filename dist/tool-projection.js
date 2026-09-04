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
import { pinModuleState } from '@papercusp/module-singleton';
import { toJsonSchema } from './schema-adapter';
/**
 * Runtime list of reserved event names. The compile-time `UserEvents<T>`
 * guard rejects them in TS, but the projection registry also checks at
 * register time so plugins (which can bypass the TS layer via JSON
 * manifests) get a loud failure. Phase 4 T2.3.
 */
export const RESERVED_EVENT_NAMES = [
    // Truly framework-only events. Tools MUST NOT redeclare them.
    'done', // dispatcher emits at successful completion with ToolResult.content
    'heartbeat', // transport pings to keep idle connections alive
    'result', // MCP-shaped result envelope on the wire
    'chunk', // framework-emitted binary-stream chunks for tools with largeOutput:true
    'card', // framework-emitted card payloads (ctx.askUser flow — bespoke-card-improvements H1).
    // Cards ride the STATE channel, not the event channel; reserving the name here
    // prevents a plugin from declaring events:{card} and intercepting other tools'
    // askUser flow on the wire.
    // NOTE: 'error' and 'progress' are NOT reserved.
    // 'progress' is documented as user-emittable via ctx.progress(pct, msg) sugar,
    // which itself routes through ctx.emit('progress', ...). Tools declare a
    // schema for it so the wire kind is inferred (dev:ipc_echo does this).
    // 'error' is dispatcher auto-emit on uncaught handler throws AND tools
    // actively emit it mid-stream for non-fatal errors (architect:chat,
    // brainstorm:chat and historical streaming tools declare it).
    // Reserving either would break production tools at register time.
];
/**
 * Inspect a Zod schema and decide whether the wire payload for events
 * of that shape should be raw text (`'string'`) or JSON-encoded (`'json'`).
 *
 * Cheap one-time call per declared event at register time; result is
 * cached on the tool entry so emit-time has no schema-introspection cost.
 */
export function classifyEventWire(schema) {
    // Binary check: detect `z.instanceof(Uint8Array)` by probing the
    // schema with a real Uint8Array. Different Zod versions represent instanceof
    // differently (_def.type: 'custom' in v4, ZodEffects in v3), so we probe
    // structurally instead of relying on _def inspection. The probe is cheap
    // (one parse) and runs once per declared event at register time.
    try {
        const probe = schema.safeParse(new Uint8Array(0));
        const rejectsObject = !schema.safeParse({}).success;
        if (probe.success && rejectsObject)
            return 'binary';
    }
    catch {
        /* fall through to JSON */
    }
    try {
        // Pluggable schema→JSON-Schema (P-021); same path as inputSchema serialization.
        const json = toJsonSchema(schema);
        return json.type === 'string' ? 'string' : 'json';
    }
    catch {
        // Schema rejected json conversion; default to JSON on the wire so
        // the dispatcher never produces an under-defined string fallback.
        return 'json';
    }
}
export function isPapercuspBinaryEnvelope(v) {
    return (typeof v === 'object' &&
        v !== null &&
        v.$papercuspBinary === true &&
        typeof v.data === 'string');
}
export function emitToSseSink(sink, tool, name, data) {
    const kind = tool.eventWireKinds?.[name];
    if (kind === 'string') {
        sink.eventRaw(name, typeof data === 'string' ? data : String(data));
    }
    else if (kind === 'binary' && data instanceof Uint8Array) {
        // Emit the same self-describing envelope as the MCP transport
        // (notifications/papercusp/event params.data). Consumers see a
        // uniform shape regardless of wire; HTTP consumer detects via
        // isPapercuspBinaryEnvelope. Slightly more bytes than raw base64
        // (~35-byte envelope tax) but consumers don't need out-of-band
        // schema info to know it's binary.
        const envelope = {
            $papercuspBinary: true,
            encoding: 'base64',
            data: Buffer.from(data).toString('base64'),
        };
        sink.event(name, envelope);
    }
    else {
        sink.event(name, data);
    }
}
const __PAPERCUSP_PROJECTED_TOOL_REGISTRY = '__papercuspProjectedToolRegistry';
const REGISTRY_STORE = pinModuleState(__PAPERCUSP_PROJECTED_TOOL_REGISTRY, () => ({
    REGISTRY: new Map(),
    BY_MCP_NAME: new Map(),
    BY_HTTP_PATH: new Map(),
    SHAPERS: new Map(),
    CONTRACT_EPOCH: 0,
}));
const REGISTRY = REGISTRY_STORE.REGISTRY;
const BY_MCP_NAME = REGISTRY_STORE.BY_MCP_NAME;
const BY_HTTP_PATH = REGISTRY_STORE.BY_HTTP_PATH;
// A store pinned before this field existed has no SHAPERS map (an older module
// record can win the pin race above and seed the slot without it). Backfill
// rather than letting `.set` throw on undefined — an absent map must degrade to
// "nothing recorded", never to a crash at import time.
const SHAPERS = (REGISTRY_STORE.SHAPERS ??= new Map());
function invalidateProjectedToolContract() {
    REGISTRY_STORE.CONTRACT_EPOCH = (REGISTRY_STORE.CONTRACT_EPOCH ?? 0) + 1;
    REGISTRY_STORE.CONTRACT_REVISION_CACHE = undefined;
}
/**
 * Record a tool's declared payload shapers. Called by `defineTool`; the shapers
 * are otherwise unreachable from the catalog (see `RegistryStore.SHAPERS`).
 */
export function recordToolShapers(name, shape, returns) {
    if (!shape)
        return;
    SHAPERS.set(name, { shape, returns });
}
/** Every tool that declared payload shapers, with its `guidance.returns` prose. */
export function listDeclaredToolShapers() {
    return [...SHAPERS.entries()].map(([name, v]) => ({ name, ...v }));
}
/** Stable unique key for a tool entry. */
function entryKey(tool) {
    // Prefer mcp.name; fall back to http.path; last resort plugin/<idx>.
    if (tool.expose.mcp?.name)
        return `mcp:${tool.expose.mcp.name}`;
    if (tool.expose.http?.path)
        return `http:${tool.expose.http.path}`;
    return `${tool.pluginName}:?`;
}
export class ToolRegistrationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ToolRegistrationError';
    }
}
/**
 * Structural fingerprint of a projected tool — stable across a re-import of
 * the SAME source (HMR / double-import re-eval produces a fresh object that
 * is structurally identical), but distinct for two genuinely different
 * tools. Used to tell a benign re-registration from a silent name-collision
 * between different tools.
 *
 * Why this exists (EI-14): the same-name guards below only fired when the
 * `pluginName` differed. Every built-in `defineTool` tool registers under
 * one synthetic plugin (`agent-mcp`), so two STRUCTURALLY-DIFFERENT built-ins
 * that shared an MCP name slipped past the cross-plugin check and the later
 * import silently replaced the earlier one (`BY_MCP_NAME.set`) with no error.
 * That dropped a real tool on the floor with zero signal: it's how
 * coordination-ops' bare `coord:ask` shadowed coordination-conversations'
 * knowledge-first `coord:ask` in prod while every role prompt still described
 * the knowledge-first one. Comparing this signature lets a same-namespace
 * duplicate-name bug fail loud instead of silently dropping a tool.
 */
function projectedToolSignature(tool) {
    return JSON.stringify({
        description: tool.description ?? '',
        capabilities: [...(tool.capabilities ?? [])].sort(),
        inputSchema: tool.inputSchema ?? null,
        discoveryInputSchema: tool.discoveryInputSchema ?? null,
    });
}
/**
 * Fail loud when `prior` and `tool` claim the same name/path within ONE
 * plugin namespace but are structurally different tools (EI-14). A
 * structurally-identical re-registration (HMR / double-import) is the
 * benign case and returns silently so the caller replaces as before.
 */
function assertNotShadowingCollision(kind, key, prior, tool) {
    if (prior === tool)
        return;
    if (projectedToolSignature(prior) === projectedToolSignature(tool))
        return;
    throw new ToolRegistrationError(`${kind} "${key}" registered twice within plugin "${tool.pluginName}" by two DIFFERENT tools — ` +
        `the second silently shadows the first (last import wins), so a real tool would vanish with no error. ` +
        `Rename one: two distinct tools cannot share a name. ` +
        `prior description: ${JSON.stringify((prior.description ?? '').slice(0, 100))}; ` +
        `new description: ${JSON.stringify((tool.description ?? '').slice(0, 100))}.`);
}
/**
 * Register a projected tool. Validates the manifest:
 *   - At least one of `expose.http` / `expose.mcp` must be set.
 *   - `expose.mcp.name` must use dotted naming and be unique across the
 *     registry.
 *   - `expose.http.path` must be unique across the registry.
 */
export function registerProjectedTool(tool) {
    if (!tool.expose.http && !tool.expose.mcp) {
        throw new ToolRegistrationError(`tool from plugin "${tool.pluginName}" must declare at least one of expose.http / expose.mcp`);
    }
    // Reject reserved event names at register time. The compile-time
    // UserEvents<T> guard catches them in TS for built-ins, but plugins
    // bypass TS via JSON manifests — this is the runtime backstop.
    // Phase 4 T2.3 (built-ins) + T3.2 (plugin manifests).
    const declaredEventNames = [
        ...(tool.events ? Object.keys(tool.events) : []),
        ...(tool.eventsJsonSchema ? Object.keys(tool.eventsJsonSchema) : []),
    ];
    for (const name of declaredEventNames) {
        if (RESERVED_EVENT_NAMES.includes(name)) {
            throw new ToolRegistrationError(`tool "${tool.expose.mcp?.name ?? tool.expose.http?.path}" declared the reserved event name "${name}". ` +
                `Reserved names (auto-emitted by the framework): ${RESERVED_EVENT_NAMES.join(', ')}.` +
                (name === 'chunk' ? ' Declare `largeOutput: true` instead and return outputRef from the handler.' : ''));
        }
    }
    // Reject conflicting declarations — a tool must use ONE of the two
    // event-schema forms, not both.
    if (tool.events && tool.eventsJsonSchema) {
        throw new ToolRegistrationError(`tool "${tool.expose.mcp?.name ?? tool.expose.http?.path}" declared both \`events\` (Zod) AND \`eventsJsonSchema\` (plugin JSON). Use one — built-ins via defineTool use Zod; plugin manifests use JSON-Schema.`);
    }
    // Pre-classify event wire kinds so emit-time is constant-cost.
    // Caller might set eventWireKinds explicitly (some tests do, and
    // the plugin loader does after running validateAndClassifyPluginEvents);
    // only compute when absent.
    if (tool.events && !tool.eventWireKinds) {
        const kinds = {};
        for (const [name, schema] of Object.entries(tool.events)) {
            kinds[name] = classifyEventWire(schema);
        }
        tool.eventWireKinds = kinds;
    }
    if (tool.expose.mcp) {
        const name = tool.expose.mcp.name;
        // Require a namespace separator (dot or colon) to prevent collisions
        // with bare names. Both conventions in use:
        //   - dotted (plugin tools, our preference): 'repomix.pack'
        //   - colon (built-in agent-mcp tools): 'tasks:list', 'audit:list'
        if (!name || (!name.includes('.') && !name.includes(':'))) {
            throw new ToolRegistrationError(`MCP tool name "${name}" must include a namespace separator ("." or ":") — e.g. "${tool.pluginName.replace(/^@.*\//, '')}.verb"`);
        }
        const prior = BY_MCP_NAME.get(name);
        if (prior && prior.pluginName !== tool.pluginName) {
            throw new ToolRegistrationError(`MCP tool name "${name}" claimed by plugins "${prior.pluginName}" and "${tool.pluginName}"`);
        }
        if (prior)
            assertNotShadowingCollision('MCP tool name', name, prior, tool);
        BY_MCP_NAME.set(name, tool);
    }
    if (tool.expose.http) {
        const p = tool.expose.http.path;
        if (!p.startsWith('/')) {
            throw new ToolRegistrationError(`HTTP path "${p}" must start with "/"`);
        }
        const prior = BY_HTTP_PATH.get(p);
        if (prior && prior.pluginName !== tool.pluginName) {
            throw new ToolRegistrationError(`HTTP path "${p}" claimed by plugins "${prior.pluginName}" and "${tool.pluginName}"`);
        }
        if (prior)
            assertNotShadowingCollision('HTTP path', p, prior, tool);
        BY_HTTP_PATH.set(p, tool);
    }
    REGISTRY.set(entryKey(tool), tool);
    invalidateProjectedToolContract();
}
/**
 * Remove all entries for a plugin from the registry. Used by the host's
 * `/api/plugins/host/refresh` flow so re-discovery can re-register without
 * tripping the cross-plugin name-collision guard against its own prior
 * entries.
 */
export function unregisterProjectedToolsForPlugin(pluginName) {
    let removed = 0;
    for (const [k, t] of Array.from(REGISTRY.entries())) {
        if (t.pluginName === pluginName) {
            // EI-20803112372029993: drop the plugin's declared shapers too, and do it
            // HERE — the entry is gone from REGISTRY by the end of this loop, so a
            // later pass over it would find nothing and silently leak. Tool names are
            // unique across the registry, so deleting by name cannot reach a core tool;
            // leaving them behind would let the contract check report a violation
            // against a tool that is no longer loaded.
            if (t.expose.mcp?.name)
                SHAPERS.delete(t.expose.mcp.name);
            REGISTRY.delete(k);
            removed++;
        }
    }
    for (const [k, t] of Array.from(BY_MCP_NAME.entries())) {
        if (t.pluginName === pluginName)
            BY_MCP_NAME.delete(k);
    }
    for (const [k, t] of Array.from(BY_HTTP_PATH.entries())) {
        if (t.pluginName === pluginName)
            BY_HTTP_PATH.delete(k);
    }
    if (removed > 0)
        invalidateProjectedToolContract();
    return removed;
}
/** Look up by MCP name (e.g. 'repomix.pack') — EXACT match only. */
export function lookupByMcpName(name) {
    return BY_MCP_NAME.get(name);
}
/**
 * Normalize an MCP tool name for TOLERANT resolution: strip a client's
 * `mcp__<server>__` advertisement wrapper, then collapse every separator
 * (`:` `_` `.` `-`) to one. So the canonical registered name
 * (`curation:state-of-pot`), the underscore/group_verb form
 * (`curation_state-of-pot`), and the fully client-mangled form
 * (`mcp__papercusp-su__curation_state-of-pot`) all reduce to ONE key.
 *
 * This is the single source of truth for tool-name normalization — operator-
 * core's unknown-tool suggestion path aliases to it, so a SUGGESTED name and a
 * RESOLVED name can never disagree (the drift that would make "did you mean X?"
 * point at a name that then fails to resolve).
 */
export function normalizeMcpName(name) {
    return name
        .toLowerCase()
        .replace(/^mcp__[^_]+(?:[^_]|_(?!_))*__/, '') // mcp__<server>__<tool> → <tool>
        .replace(/[:_.\-]+/g, ':');
}
/**
 * Resolve an MCP tool name TOLERANTLY (WI-3930). Exact registered name first —
 * the fast, unchanged path that every canonical (colon-form) call takes. Only
 * on an exact miss does it fall back to a NORMALIZED match, which accepts the
 * underscore/group_verb and fully-mangled forms an agent naturally copies from
 * its own advertised tool list (`mcp__papercusp-su__curation_state-of-pot`) or
 * from a hook/error string. The docs tell agents to fall back to
 * `tools:invoke { name }` with the colon-form name; this makes that fallback
 * also accept the other two forms, so a single paste resolves instead of
 * costing a wasted unknown-tool round-trip.
 *
 * The normalized fallback resolves ONLY when it is UNAMBIGUOUS — exactly one
 * registered tool normalizes to the requested key. If two do (a real name
 * collision under separator-folding), it returns undefined so the caller
 * surfaces the honest unknown-tool / disambiguation path rather than silently
 * guessing one. A genuine typo (`curatoin:state-of-pot`) normalizes to a key no
 * tool matches → undefined, exactly as before.
 */
export function resolveMcpName(name) {
    const exact = BY_MCP_NAME.get(name);
    if (exact)
        return exact;
    const norm = normalizeMcpName(name);
    if (!norm)
        return undefined;
    let hit;
    for (const [registered, tool] of BY_MCP_NAME) {
        if (normalizeMcpName(registered) === norm) {
            if (hit && hit !== tool)
                return undefined; // ambiguous → don't guess
            hit = tool;
        }
    }
    return hit;
}
/** Look up by HTTP path (e.g. '/api/plugins/repomix/pack'). */
export function lookupByHttpPath(path) {
    return BY_HTTP_PATH.get(path);
}
/** Snapshot of all registered projected tools. */
export function listAllProjectedTools() {
    return Array.from(REGISTRY.values());
}
/**
 * The absolute file that defined `toolName` (its MCP-exposed name, e.g.
 * `improvements:capture`), or `null` when the tool is unknown, was registered
 * without a readable call stack, or has no defining module at all.
 *
 * Three-valued by omission on purpose: `null` means UNKNOWN, never "this tool
 * has no source". A caller that treats a null as a negative verdict would turn
 * an unreadable stack into a confident claim about the code — the same
 * absence-reads-as-positive failure `candidate-contains.ts` is built to avoid.
 */
export function projectedToolSourceFile(toolName) {
    // Tolerant on purpose: a caller reporting a tool failure copies whatever
    // spelling it saw — the canonical colon form from the docs, the underscore
    // form, or its client's fully-mangled `mcp__<server>__<verb>` id. resolveMcpName
    // accepts all three and returns undefined rather than guessing when a
    // normalized name is ambiguous.
    return resolveMcpName(toolName)?.sourceFile ?? null;
}
/**
 * Stable content revision for the executable MCP contract.
 *
 * The registry is the authority for names, accepted argument shapes, and
 * client/role visibility. Every agent-facing projection carries this same
 * revision so callers can detect guidance produced from a different contract.
 * Registration order is deliberately excluded; executable content is not.
 */
export const PROJECTED_TOOL_REGISTRY_SOURCE = 'projected-tool-registry';
export function projectedToolRegistryRevision(tools) {
    if (!tools) {
        const epoch = REGISTRY_STORE.CONTRACT_EPOCH ?? 0;
        const cached = REGISTRY_STORE.CONTRACT_REVISION_CACHE;
        if (cached?.epoch === epoch)
            return cached.revision;
        const revision = projectedToolRegistryRevision(listAllProjectedTools());
        REGISTRY_STORE.CONTRACT_REVISION_CACHE = { epoch, revision };
        return revision;
    }
    const canonical = (value) => {
        if (value === null || typeof value !== 'object')
            return JSON.stringify(value) ?? 'null';
        if (Array.isArray(value))
            return `[${value.map(canonical).join(',')}]`;
        const row = value;
        return `{${Object.keys(row)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
            .join(',')}}`;
    };
    const contracts = tools
        .flatMap((tool) => {
        const name = tool.expose.mcp?.name;
        if (!name)
            return [];
        return [{
                name,
                description: tool.description,
                inputSchema: tool.discoveryInputSchema ?? tool.inputSchema,
                outputJsonSchema: tool.outputJsonSchema ?? null,
                agentRoles: [...(tool.agentRoles ?? [])].sort(),
                profile: tool.profile ?? 'all',
                modality: [...(tool.modality ?? ['text', 'voice'])].sort(),
                guidance: {
                    when: tool.guidance?.when ?? null,
                    notWhen: tool.guidance?.notWhen ?? null,
                    chaining: tool.guidance?.chaining ?? null,
                    returns: tool.guidance?.returns ?? null,
                    argRedirects: tool.guidance?.argRedirects ?? {},
                    byRole: tool.guidance?.byRole ?? {},
                    // Function-form result links are runtime-only truth and cannot be
                    // serialized into a stable catalog revision. Static links can and
                    // should invalidate every cached guidance projection when changed.
                    seeAlso: typeof tool.guidance?.seeAlso === 'function'
                        ? 'runtime-resolved'
                        : tool.guidance?.seeAlso ?? null,
                },
            }];
    })
        .sort((a, b) => a.name.localeCompare(b.name));
    // Deterministic drift watermark, not a security primitive. FNV-1a avoids
    // making this generic registry module Node-crypto-specific.
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(canonical(contracts))) {
        hash ^= BigInt(byte);
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return `projected-tool-registry-v1:${hash.toString(16).padStart(16, '0')}`;
}
export class ProjectedToolContractError extends Error {
    name = 'ProjectedToolContractError';
}
function availabilityProblem(tool, context) {
    if (context.role && tool.agentRoles && !tool.agentRoles.includes(context.role)) {
        return `role ${context.role} is not admitted`;
    }
    if (context.profile === 'power' && tool.profile === 'engineer')
        return 'power profile is not admitted';
    if (context.modality && !(tool.modality ?? ['text', 'voice']).includes(context.modality)) {
        return `modality ${context.modality} is not admitted`;
    }
    return null;
}
/**
 * Is this tool REGISTERED and admitted under `context` — asked WITHOUT throwing.
 *
 * The distinction this exists to draw: a redirect pointing at a tool that does not
 * exist is a registry defect and must fail render/CI loudly, but a tool that merely
 * is not admitted to the CURRENT role/profile/modality is an ordinary scoping fact.
 * A renderer that walks a role-independent tool list needs to tell those apart, and
 * `projectedToolCallContract` deliberately cannot — it throws for both.
 *
 * Returns false for an absent tool too, so a caller that wants the loud failure keeps
 * using the throwing form; this is only for "should I render this extra?" decisions.
 */
export function projectedToolAdmitted(name, context = {}) {
    const tool = lookupByMcpName(name);
    if (!tool?.expose.mcp)
        return false;
    return availabilityProblem(tool, context) === null;
}
/** Resolve one exact, currently callable registry contract or fail render/CI loudly. */
export function projectedToolCallContract(name, context = {}) {
    const tool = lookupByMcpName(name);
    if (!tool?.expose.mcp)
        throw new ProjectedToolContractError(`tool contract unavailable: ${name}`);
    const unavailable = availabilityProblem(tool, context);
    if (unavailable)
        throw new ProjectedToolContractError(`tool contract unavailable: ${name} (${unavailable})`);
    return {
        source: PROJECTED_TOOL_REGISTRY_SOURCE,
        revision: projectedToolRegistryRevision(),
        name,
        description: tool.description,
        inputSchema: tool.discoveryInputSchema ?? tool.inputSchema,
        returns: tool.outputJsonSchema
            ? { source: 'registered-output-schema', outputJsonSchema: tool.outputJsonSchema }
            : tool.guidance?.returns?.trim()
                ? { source: 'authored-tool-guidance', description: tool.guidance.returns.trim() }
                : { source: 'undeclared' },
        aliases: Object.fromEntries(Object.entries(tool.guidance?.argRedirects ?? {})
            .filter((entry) => typeof entry[1] === 'string')
            .map(([key, target]) => [
            key,
            { target, provenance: 'authored-tool-guidance' },
        ])),
    };
}
function contractProblems(schema, value, path = '$') {
    const alternatives = Array.isArray(schema.anyOf)
        ? schema.anyOf
        : Array.isArray(schema.oneOf)
            ? schema.oneOf
            : null;
    if (alternatives) {
        const attempts = alternatives
            .filter((branch) => !!branch && typeof branch === 'object' && !Array.isArray(branch))
            .map((branch) => contractProblems(branch, value, path));
        if (attempts.some((problems) => problems.length === 0))
            return [];
        return attempts.sort((a, b) => a.length - b.length)[0] ?? [`${path}: no declared schema branch matched`];
    }
    if (Array.isArray(schema.allOf)) {
        return schema.allOf.flatMap((branch) => branch && typeof branch === 'object' && !Array.isArray(branch)
            ? contractProblems(branch, value, path)
            : []);
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
        return [`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.map(String).join('|')}`];
    }
    if ('const' in schema && !Object.is(schema.const, value))
        return [`${path}: expected ${JSON.stringify(schema.const)}`];
    if (schema.type === 'object' || schema.properties) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return [`${path}: expected object`];
        const row = value;
        const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
            ? schema.properties
            : {};
        const problems = [];
        for (const key of Array.isArray(schema.required) ? schema.required : []) {
            if (typeof key === 'string' && !(key in row))
                problems.push(`${path}.${key}: required`);
        }
        if (schema.additionalProperties === false) {
            for (const key of Object.keys(row))
                if (!(key in properties))
                    problems.push(`${path}.${key}: undeclared key`);
        }
        for (const [key, child] of Object.entries(properties)) {
            if (!(key in row) || !child || typeof child !== 'object' || Array.isArray(child))
                continue;
            problems.push(...contractProblems(child, row[key], `${path}.${key}`));
        }
        return problems;
    }
    if (schema.type === 'array') {
        if (!Array.isArray(value))
            return [`${path}: expected array`];
        const item = schema.items;
        return item && typeof item === 'object' && !Array.isArray(item)
            ? value.flatMap((entry, index) => contractProblems(item, entry, `${path}[${index}]`))
            : [];
    }
    if (schema.type === 'string' && typeof value !== 'string')
        return [`${path}: expected string`];
    if ((schema.type === 'number' || schema.type === 'integer') && typeof value !== 'number')
        return [`${path}: expected ${schema.type}`];
    if (schema.type === 'boolean' && typeof value !== 'boolean')
        return [`${path}: expected boolean`];
    if (schema.type === 'null' && value !== null)
        return [`${path}: expected null`];
    return [];
}
/** Validate a prompt/example call against the same accepted schema used for discovery. */
export function assertProjectedToolCallContract(name, args, context = {}) {
    const contract = projectedToolCallContract(name, context);
    const problems = contractProblems(contract.inputSchema, args);
    if (problems.length > 0)
        throw new ProjectedToolContractError(`invalid generated call for ${name}: ${problems.join('; ')}`);
    return contract;
}
/** Render an exact example only after registry/schema/admission conformance succeeds. */
export function renderProjectedToolCall(name, args, context = {}) {
    assertProjectedToolCallContract(name, args, context);
    return `${name} ${JSON.stringify(args)}`;
}
/** Validate and render every structured rejected-arg remedy on one source tool. */
export function projectedToolCorrectiveCalls(name, context = {}) {
    projectedToolCallContract(name, context);
    const tool = lookupByMcpName(name);
    return Object.entries(tool.guidance?.argRedirects ?? {}).flatMap(([rejectedArg, redirect]) => {
        if (typeof redirect === 'string')
            return [];
        // A remedy this context cannot CALL is not offered to it (EI-22188204415833751). An
        // all-profile tool may legitimately redirect into a narrower one — coord:presence's
        // `fleet` -> fleet:assignments (profile:'engineer') — which is correct guidance for the
        // profiles that DO admit the target. Resolving it under a profile the TARGET rejects must
        // therefore NARROW this list, not fail the rail: _guidance-adapter.ts converts any throw
        // from here into `return []`, so one such redirect deletes the ENTIRE ~835-page guidance
        // corpus rather than omitting one entry, which red-pinned the fleet green-checkpoint gate.
        //
        // ONLY availability is skipped, and only when the target genuinely resolves. An unknown
        // target tool, a missing required key, a bad enum, or an undeclared key still throws — that
        // is the rail that caught the dev:restart enum placeholder (WI-2142574), and the tests at
        // 'fails structured corrective-call conformance on missing tools, required keys, enums, and
        // undeclared keys' hold it in place.
        const redirectTarget = lookupByMcpName(redirect.tool);
        if (redirectTarget?.expose.mcp && availabilityProblem(redirectTarget, context))
            return [];
        const rendered = renderProjectedToolCall(redirect.tool, redirect.args, context);
        return [{
                rejectedArg,
                tool: redirect.tool,
                args: redirect.args,
                ...(redirect.note ? { note: redirect.note } : {}),
                source: PROJECTED_TOOL_REGISTRY_SOURCE,
                registryRevision: projectedToolRegistryRevision(),
                rendered,
            }];
    });
}
/**
 * CI/render rail for executable guidance. Every remedy OFFERED to a context must
 * satisfy the target's current required/enum/closed-object schema.
 *
 * Note the scope of "offered": a redirect whose TARGET is not admitted in a context is
 * withheld from that context rather than failing the rail (see projectedToolCorrectiveCalls),
 * so an all-profile tool may redirect into a narrower one without deleting the corpus. The
 * schema half is unconditional — an offered remedy that cannot validate is still fatal.
 */
export function assertProjectedToolGuidanceConformance() {
    let toolsChecked = 0;
    let correctiveCallsChecked = 0;
    for (const tool of listAllProjectedTools()) {
        const name = tool.expose.mcp?.name;
        if (!name)
            continue;
        const hasStructured = Object.values(tool.guidance?.argRedirects ?? {}).some((redirect) => typeof redirect === 'object' && redirect !== null);
        if (!hasStructured)
            continue;
        toolsChecked += 1;
        const roles = tool.agentRoles?.length ? [...tool.agentRoles] : [undefined];
        const profiles = tool.profile === 'engineer'
            ? ['engineer']
            : ['engineer', 'power'];
        const modalities = [...(tool.modality ?? ['text', 'voice'])];
        for (const role of roles) {
            for (const profile of profiles) {
                for (const modality of modalities) {
                    correctiveCallsChecked += projectedToolCorrectiveCalls(name, { role, profile, modality }).length;
                }
            }
        }
    }
    return {
        source: PROJECTED_TOOL_REGISTRY_SOURCE,
        registryRevision: projectedToolRegistryRevision(),
        toolsChecked,
        correctiveCallsChecked,
    };
}
/**
 * True if a tool declares ANY auth gate — a capability, an agent-role allowlist, an RBAC
 * role requirement, or an `authorize` hook. The single predicate behind both the
 * default-deny dispatch gate and `listUngatedProjectedTools` (RFC tooldef-auth Phase 3),
 * so the enforcement and the migration aid can't drift.
 */
export function toolDeclaresGate(tool) {
    return (tool.capabilities.length > 0 ||
        (tool.agentRoles?.length ?? 0) > 0 ||
        (tool.requireRoles?.length ?? 0) > 0 ||
        !!tool.authorize);
}
/**
 * Tools that would be denied once `deps.defaultDeny` is flipped on: they declare no gate
 * and are not marked `public`. The migration aid for RFC tooldef-auth Phase 3 (§8 D1) —
 * run it (with the full tool registry loaded) BEFORE enabling default-deny, triage each
 * (declare a gate or mark `public`), then flip. Empty result = safe to flip.
 */
export function listUngatedProjectedTools() {
    return Array.from(REGISTRY.values()).filter((t) => !t.public && !toolDeclaresGate(t));
}
/**
 * Memoise the JSON-Schema serialization per ProjectedTool reference.
 * Same `events` object identity means same serialized output, so the
 * weak-keyed cache avoids re-running `z.toJSONSchema` on every
 * `tools/list` call.
 */
const EVENTS_JSON_CACHE = new WeakMap();
function serializeEventsSchema(events) {
    const cached = EVENTS_JSON_CACHE.get(events);
    if (cached)
        return cached;
    const out = {};
    for (const [name, schema] of Object.entries(events)) {
        const kind = classifyEventWire(schema);
        if (kind === 'binary') {
            // z.toJSONSchema throws on z.instanceof(Uint8Array) ("Custom types
            // cannot be represented in JSON Schema"). Surface binary events
            // explicitly so MCP clients can decode the EVENT_BIN wire frame.
            out[name] = {
                type: 'string',
                contentEncoding: 'base64',
                description: 'Binary payload — base64 over JSON transports; raw bytes over IPC EVENT_BIN.',
            };
            continue;
        }
        try {
            // Pluggable schema→JSON-Schema (P-021); default adapter is Zod 4's
            // toJSONSchema (zod-to-json-schema@3 returned empty schemas on zod 4).
            const json = toJsonSchema(schema);
            // Drop $schema — MCP clients don't need it and it's noise in tools/list.
            delete json.$schema;
            out[name] = json;
        }
        catch {
            // Any other unrepresentable schema (custom check, lazy refs to
            // self, etc.) → emit a permissive placeholder so tools/list never
            // 500s. The tool still works; clients just lose the typed view.
            out[name] = { description: 'Schema not representable in JSON Schema.' };
        }
    }
    EVENTS_JSON_CACHE.set(events, out);
    return out;
}
export function listMcpProjections(role, profile) {
    const out = [];
    const registryRevision = projectedToolRegistryRevision();
    for (const tool of REGISTRY.values()) {
        if (!tool.expose.mcp)
            continue;
        if (role && tool.agentRoles && !tool.agentRoles.includes(role))
            continue;
        // Profile gate: tools tagged `profile: 'engineer'` are hidden from
        // power-profile callers. Untagged tools (undefined / 'all') are visible
        // to everyone — backward-compatible for tools not yet tagged.
        // eslint-disable-next-line no-console
        if (profile === 'power' && tool.profile === 'engineer')
            continue;
        const listing = {
            name: tool.expose.mcp.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            _meta: {
                'papercusp/toolRegistryRevision': registryRevision,
                'papercusp/toolRegistrySource': PROJECTED_TOOL_REGISTRY_SOURCE,
            },
        };
        // Advertise the output schema + negotiable formats when the tool declared
        // an output schema (P-010). Tools without one still get the runtime
        // auto-encoder; they just don't advertise a capability set.
        //
        // MCP `outputSchema` describes `structuredContent`, which the spec requires
        // to be a JSON OBJECT — so a strict client (the MCP SDK) rejects a tools/list
        // whose outputSchema is array/scalar-rooted. Our list tools return bare
        // arrays, so we only emit the spec-standard `outputSchema` for object-rooted
        // shapes; the array/list case advertises capability via the `resultFormats`
        // extension below (which the SDK tolerates as an unknown field).
        if (tool.outputJsonSchema && tool.outputJsonSchema.type === 'object') {
            listing.outputSchema = tool.outputJsonSchema;
        }
        if (tool.resultEligibility) {
            const formats = [...tool.resultEligibility.capabilities];
            listing.resultFormats = formats;
            // Mirror onto `_meta` — the spec passthrough slot — so it survives the
            // strict MCP SDK tools/list validation that strips unknown top-level fields.
            listing._meta = { ...(listing._meta ?? {}), 'papercusp/resultFormats': formats };
        }
        if (tool.events && Object.keys(tool.events).length > 0) {
            listing.events = serializeEventsSchema(tool.events);
        }
        else if (tool.eventsJsonSchema && Object.keys(tool.eventsJsonSchema).length > 0) {
            // Plugin tools (T3.2): the JSON-Schema is the source of truth;
            // no conversion needed.
            listing.events = tool.eventsJsonSchema;
        }
        if (tool.modality && tool.modality.length > 0) {
            listing.modality = tool.modality;
        }
        out.push(listing);
    }
    return out;
}
/** Test-only — flushes the registry between tests. */
export function _resetProjectionRegistryForTests() {
    REGISTRY.clear();
    BY_MCP_NAME.clear();
    BY_HTTP_PATH.clear();
    invalidateProjectedToolContract();
    SHAPERS.clear();
}
