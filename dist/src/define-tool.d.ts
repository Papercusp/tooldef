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
import { type ZodTypeAny } from 'zod';
import { type StandardSchemaV1 } from './standard-schema';
import { type ProjectedToolCorrectiveCall } from './tool-projection';
import { type InvalidInputCorrection } from './dispatch-projected';
import type { RoleToolDefinition, RoleToolDefinitionInput, RouteDefinition, ToolDefinition, ToolDefinitionInput } from './types';
export type { RouteDefinition } from './types';
/**
 * P-019 (fleet-leadership-continuity-and-actuation-2026-08-01) — an
 * explicitly-`undefined` value means NOT PROVIDED, at every depth.
 *
 * `{ harness: undefined }` is idiomatic JS for "I have no value for this" — it is
 * what every spread of an optional (`{ ...(x ? { k: x } : {}) }` written the short
 * way as `{ k: x }`), every destructured passthrough, and every `obj[k] = maybe`
 * produces. But the key IS present in `Object.keys()`, so the EI-10883 closed-shape
 * gate rejects it as an unrecognized key — a hard `invalid_args` failure for a call
 * that supplied nothing at all. JSON has no `undefined`, so this is unreachable over
 * the MCP wire and hits ONLY in-process callers: `code:run` scripts (whose whole
 * point is writing ordinary JS against the catalog) and `tools:invoke`. Under
 * `code:run` it is worse than a wasted round-trip: a read's arg typo aborts the
 * WHOLE script, so already-ordered writes never execute (P-020).
 *
 * The strip is DEEP because the strictness it compensates for is deep:
 * `deepStrictifyInPlace` closes every nested object in the tree, so a top-level-only
 * strip would leave the nested case — `work_items:checkpoint { items: [{ id,
 * checkpoint, harness: undefined }] }`, exactly the row shape agents build in a loop
 * — still failing, for the same reason, one level down. That asymmetry is the bug
 * EI-18723223344390510 already had to fix once for strictness itself; fixing only
 * the level that happened to bite is what leaves it live.
 *
 * Runs FIRST, innermost of the pre-validation shim chain, so every downstream shim
 * sees a clean object: `applyHarnessArgAlias` keys off `'harness' in rec`, which
 * would otherwise rename `{ harness: undefined }` to `{ harness_slug: undefined }`
 * and fail validation just the same, one key over.
 *
 * Deliberately narrow so it can only ever REMOVE a no-op key:
 *  • object KEYS only — an `undefined` ARRAY ELEMENT is a positional value, and
 *    dropping it would silently reindex the array (a different, worse bug);
 *  • plain objects only (`Object.prototype`/null-prototype) — never a Date, Map,
 *    Buffer, or class instance, whose internals are not ours to rebuild;
 *  • returns the input BY REFERENCE when there is nothing to strip, so the common
 *    case allocates nothing and callers keep identity;
 *  • never mutates the caller's object — a rebuilt copy is returned instead, since
 *    the same args object may be retained/reused by the caller.
 */
export declare function stripUndefinedArgKeys(input: unknown): unknown;
/**
 * EI-18729688357283797 — `harness` -> `harness_slug` arg alias, applied BEFORE validation.
 *
 * The catalog's dominant harness-scoping spelling is `harness` (work_items:*, docs:*,
 * plans:*, features:*, issues:*, harness:*, coord:orient, …) and the su persona
 * explicitly teaches it as THE way to scope a per-call ("name the harness on the
 * call: harness: '<slug>'"). A minority of tools (the search:* family — search:fulltext,
 * search:semantic) instead declare `harness_slug`. Because arg validation is STRICT
 * (EI-10883), the taught reflex produces a guaranteed-failing call against those
 * tools — a wasted round-trip every time, never a silent partial. Worse, the shared
 * did-you-mean hint (COMMON_ARG_ALIASES) can suggest the WRONG fix when the tool
 * separately declares an unrelated `scope` arg that happens to share a semantic-alias
 * slot with `harness` (search:fulltext's `scope` is the search-source list, not a
 * harness — confirmed live: the hint says "Did you mean `scope` for `harness`?", which
 * is actively misleading there).
 *
 * Rather than merely teach a better error, ACCEPT the call: when the tool's declared
 * shape has `harness_slug` but not `harness`, and the caller supplied `harness` without
 * `harness_slug`, transparently rename the key before validation. A caller who
 * (unusually) supplied BOTH keeps their explicit `harness_slug` untouched — this never
 * overrides an explicit value, and it is a no-op for every tool that already declares
 * `harness` itself (the common case).
 */
export declare function applyHarnessArgAlias(argsJsonSchema: Record<string, unknown>, input: unknown): unknown;
/**
 * EI-11621 — unwrap a client `__unparsedToolInput` envelope BEFORE validation.
 *
 * Some MCP clients (Claude Code) that cannot parse the model-emitted tool
 * arguments into structured JSON send `{ __unparsedToolInput: "<raw string>" }`
 * as the tool's arguments instead of the intended object — the raw string is the
 * JSON the model actually tried to emit. This hits tools with anyOf/nullable or
 * nested-object schemas (work_items:complete, session:request-compaction, …) the
 * hardest. Left as-is, the EI-10883 closed-shape gate rejects the reserved key
 * with a confusing "unrecognized key __unparsedToolInput", making those tools
 * unusable from that client without the code_run workaround (the reported bug).
 *
 * This transparently recovers the intended args: when the input object carries
 * `__unparsedToolInput`, JSON-parse its string value (or use it directly when the
 * client already handed us an object) and merge it UNDER any sibling keys the
 * client did parse (real sibling keys win — they are the caller's explicit
 * intent). A non-object / non-JSON payload is dropped so the real validation error
 * is about the actual args, not the framework envelope key. Never throws.
 */
export declare function unwrapUnparsedToolInput(input: unknown): unknown;
/**
 * The unified endpoint primitive (Phase E6, endpoint-unification-2026-05-21).
 *
 * `defineTool` accepts THREE shapes, discriminated structurally:
 *   - **route-shaped** (`{ method, path, auth, handler }`) → returns a
 *     `RouteDefinition`. A plain Hono route; NOT in the agent catalog.
 *     The host mounts it via `registerRoute`. Authors call `defineTool`
 *     directly for routes (the former `defineRoute` alias is removed).
 *   - **role-gated tool** (`{ requirePrincipal: false, … }`) → a
 *     `RoleToolDefinition`, projected to MCP + the HTTP catch-all.
 *   - **principal-gated tool** (the default) → a `ToolDefinition`.
 *
 * One primitive, three projections — the route/tool duplication the
 * endpoint-unification plan set out to remove.
 */
export declare function defineTool<TArgs extends StandardSchemaV1>(input: RoleToolDefinitionInput<TArgs>): RoleToolDefinition<TArgs>;
export declare function defineTool<TArgs extends StandardSchemaV1>(input: ToolDefinitionInput<TArgs>): ToolDefinition<TArgs>;
export declare function defineTool<TInputSchema extends ZodTypeAny | undefined = undefined>(input: RouteDefinition<TInputSchema>): RouteDefinition<TInputSchema>;
/**
 * Infer a tool's read/write effect (code-execution-tool-orchestration B-CX-PRE) from its
 * capability when not set explicitly: write-ish suffixes (`:write`/`:admin`/`:delete`/
 * `:manage`/`:execute`) ⇒ 'write'; everything else ⇒ 'read'. An explicit `effect` always
 * wins. Consumed by the code-execution sandbox's dry-run/confirm gate (read-only ⇒ no gate).
 */
export declare const WRITE_CAPABILITY_SUFFIXES: readonly [':write', ':admin', ':delete', ':manage', ':execute'];
/**
 * Known-mutating capabilities whose names don't end in a write-suffix — the
 * `capability:*` host-capability family (bash/fs-write/edit/write/git/computer/net/terminal) plus
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
export declare const WRITE_CAPABILITIES: Set<string>;
/**
 * THE effect oracle. Exported (not merely used here) because it is the only
 * authoritative answer to "does this capability mutate?" in the tree, and callers
 * outside `defineTool` need it: a static scanner that cannot execute `defineTool`
 * — e.g. `scripts/check-no-bespoke-state-read.mjs`, whose whole bug class was
 * inferring effect from a tool's NAME while this function sat one lib away
 * (WI-6464: `processes:control` read as a state READ, so `processes:freeze` and
 * `processes:limit` were reported as undeclared state reads for hours).
 *
 * Anything re-deriving effect from naming is a second, drifting answer to a
 * question this owns. Consult it instead.
 */
export declare function inferCapabilityEffect(capability: string, explicit?: 'read' | 'write'): 'read' | 'write';
export declare function flattenForOpenAi(schema: Record<string, unknown>): Record<string, unknown>;
export declare function strictArgs<T>(schema: T): T;
/**
 * Return the closest declared field for an unknown arg, when confidence is high.
 *
 * `opts` is optional so every name-only caller (and the exported-direct test surface)
 * keeps its current behaviour; pass `value`/`props` to enable the value-admissibility
 * filter documented on `candidateRefutesValue`.
 */
export declare function suggestArgName(unknown: string, accepted: readonly string[], opts?: {
    value?: unknown;
    props?: Record<string, unknown>;
}): string | null;
/**
 * Map each key declared on a NESTED object schema to its dotted path
 * (`observation.refs`), one level deep.
 *
 * WHY (WI-38059): `unknownArgHint` built its candidate list from TOP-LEVEL
 * properties only, so a key that genuinely exists — just one level down —
 * had nothing to match against and produced NO suggestion. The rejection
 * then read as "this tool has no `refs` concept" when the truth was "`refs`
 * lives inside `observation`". The caller's natural inference from that is
 * to DROP the arg, silently losing whatever it carried (attribution, in the
 * observed case), rather than to relocate it. That is strictly worse than a
 * round-trip: it fails quietly.
 *
 * One level only, and first-declaration-wins on a collision: this exists to
 * name an obvious relocation, not to search a schema tree. A deeper or
 * ambiguous match is left to the full schema hint that follows it.
 */
export declare function nestedArgPaths(props: Record<string, unknown> | undefined): Map<string, string>;
export declare function invalidInputCorrections(issues: ReadonlyArray<{
    message?: string;
    keys?: readonly string[];
}> | undefined, rawSchema: unknown, argRedirects?: Record<string, string | ProjectedToolCorrectiveCall>, 
/** The caller's raw args, so a near-name guess can be checked against the value it
 *  would relocate (EI-21390759884688723). Optional: absent, behaviour is name-only. */
input?: unknown): InvalidInputCorrection[];
export declare function unknownArgHint(issues: ReadonlyArray<{
    message?: string;
    keys?: readonly string[];
}> | undefined, rawSchema: unknown, argRedirects?: Record<string, string | ProjectedToolCorrectiveCall>, 
/** See `invalidInputCorrections` — enables the value-admissibility filter. */
input?: unknown): string;
/**
 * Convert a tool's `args` to JSON Schema — failing LOUD and, crucially, NAMED.
 *
 * A tool's args schema is its CALLABLE CONTRACT, so unlike an unrepresentable *event*
 * schema (which degrades to a placeholder, keeping the tool usable) there is nothing to
 * degrade to: an args schema that cannot be advertised is a fatal authoring error.
 *
 * But it must fail with the TOOL'S NAME. This conversion runs at REGISTRATION — i.e.
 * during module import — and the same unguarded conversion runs again in the MCP
 * tools/list handlers. So one bad schema does not break one tool: it throws mid-import
 * and takes down the WHOLE catalog, surfacing as a bare, anonymous adapter error with no
 * tool, no file, nothing to grep (observed: `Transforms cannot be represented in JSON
 * Schema`, which reads like an unrelated infra/zod break and was mis-triaged as one).
 *
 * The overwhelmingly common cause is a TRAILING `.transform()` in the args schema, whose
 * output type JSON Schema cannot express. Refinements (`.refine` / `.superRefine`) and
 * `preprocess` are all representable and fine.
 */
export declare function toArgsJsonSchema(toolName: string, args: StandardSchemaV1): Record<string, unknown>;
