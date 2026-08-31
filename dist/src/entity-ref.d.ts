/**
 * Entity-reference args — the semantic type the engine was missing
 * (tool-arg-referential-integrity-2026-07-19 P-001 / D-001).
 *
 * THE PROBLEM. A tool arg that NAMES A DURABLE ENTITY (`pot`, `harness`,
 * `plan`, `fleet`, `ownerId`, …) is, structurally, just `z.string()`. Nothing
 * distinguishes "any text" from "must identify a row that exists". So callers —
 * agents especially — invent values, and the write succeeds. In the audit that
 * prompted this file, 55% of one table's rows pointed at entities that had
 * never existed, across 312 arg sites of which at most 12% checked anything.
 *
 * WHY THIS CANNOT LIVE IN THE SCHEMA'S JSON. `tools/list` publishes JSON
 * Schema, which is deliberately I/O-free (cf. Ajv's `addFormat`) — "exists in
 * the database" is not expressible there, by design. Enforcement therefore
 * belongs at DISPATCH, where a host resolver can be consulted. This module
 * supplies the two halves the dispatcher needs:
 *
 *   1. a MARKER on the schema, so a generic walker can find which args are
 *      entity references and of what kind ({@link entityRef} /
 *      {@link collectEntityRefs});
 *   2. a pluggable, BATCHED host resolver per kind ({@link setEntityResolver} /
 *      {@link resolveEntityRefs}) — the engine ships no entity knowledge, the
 *      same load-order contract as the capability-tier resolver.
 *
 * EFFICIENCY. Real entity sets in a host of this shape are small (hundreds of
 * rows), so a host resolver backed by a process-local `Set` with
 * write-invalidation makes validation an O(1) memory lookup with zero per-call
 * queries. The resolver interface is nonetheless BATCHED (it receives every
 * value of a kind at once, DataLoader-style) so a host with a large set can
 * answer with one `= ANY($1)` instead of N round-trips.
 *
 * The brand is compile-time only and intentionally so: `.brand()` gives
 * authoring safety, never enforcement. The runtime guarantee comes from the
 * dispatch step that consumes {@link collectEntityRefs}.
 */
import { z } from 'zod';
/**
 * What an entity-reference arg points at. Open-ended `string` on purpose — the
 * engine owns no entity vocabulary; a host names its own kinds and registers
 * matching resolvers.
 */
export type EntityKind = string;
/** Metadata recorded for a schema produced by {@link entityRef}. */
export interface EntityRefMeta {
    kind: EntityKind;
    /** Human label used in error text ("unknown pot"). Defaults to `kind`. */
    label?: string;
    /** When true, an unresolvable value WARNS instead of rejecting (staged rollout). */
    soft?: boolean;
}
/** Options for {@link entityRef}. */
export interface EntityRefOptions extends Omit<EntityRefMeta, 'kind'> {
    /**
     * The arg description. MUST be passed here rather than chained as
     * `.describe(...)` — see the note on {@link entityRef} about clone-orphaning.
     */
    describe?: string;
    /** Max length, for the same reason `describe` lives here. */
    max?: number;
}
/**
 * Declare an arg as a reference to an entity of `kind`.
 *
 * ```ts
 * args: z.object({
 *   pot: entityRef('pot', { describe: 'the pot to report on', max: 120 }),
 * })
 * ```
 *
 * ⚠ PASS `describe` / `max` AS OPTIONS — DO NOT CHAIN THEM.
 *
 * Zod 4's `.describe()` and `.max()` return a CLONE of the schema, not the same
 * object. The marker lives in a WeakMap keyed on schema identity (so it cannot
 * leak into published JSON Schema), so anything chained AFTER `entityRef()`
 * produces a new object the registry does not know about — and the arg silently
 * becomes an ordinary string that is never checked. This is not hypothetical: a
 * first conversion pass wrote `entityRef('pot').describe(…)` across seven tools
 * and every one of them was inert, caught only because the conformance ratchet
 * reported `converted=0`. Taking these as options means the marker is always
 * applied LAST, so there is nothing to chain and nothing to get wrong.
 *
 * Wrapping is still fine: `.optional()`, `.nullable()`, `.default()` and array
 * wrapping all produce WRAPPERS with an inner type, which
 * {@link collectEntityRefs} unwraps to find the marker.
 */
export declare function entityRef(kind: EntityKind, opts?: EntityRefOptions): z.ZodString;
/** The meta for a schema, or undefined when it is not an entity ref. */
export declare function entityRefMeta(schema: unknown): EntityRefMeta | undefined;
/** One discovered entity-reference arg. */
export interface EntityRefSite {
    /** Dotted path from the args root, e.g. `pot` or `members.0.pot`. */
    path: string;
    meta: EntityRefMeta;
}
/**
 * Walk an args schema and report every entity-reference site, including ones
 * nested in objects and arrays. Structural only — it inspects the SCHEMA, not
 * a value, so a dispatcher can compute this once per tool at registration
 * rather than per call.
 */
export declare function collectEntityRefs(schema: unknown, path?: string, depth?: number): EntityRefSite[];
/**
 * A host's existence check for one kind. Receives EVERY value of that kind in
 * the call at once (DataLoader-style batching) and returns only the ones that
 * do NOT exist, optionally with near-miss suggestions for the error message.
 *
 * Returning an empty `unknown` array means "all present". A resolver that
 * throws is treated as UNAVAILABLE and fails OPEN (see {@link resolveEntityRefs}).
 */
export type EntityResolver = (values: readonly string[]) => Promise<{
    unknown: readonly string[];
    /** Near matches for an unknown value, best first — powers "did you mean". */
    suggestions?: Readonly<Record<string, readonly string[]>>;
    /** The full valid set, when small enough to name in an error. */
    allowed?: readonly string[];
}>;
/**
 * Register the host's existence check for one kind. Call during startup,
 * before dispatch runs. Last writer wins; a kind with no resolver is SKIPPED
 * (unvalidated) rather than rejected — so adopting `entityRef` on an arg is
 * safe before its resolver exists.
 */
export declare function setEntityResolver(kind: EntityKind, resolver: EntityResolver): void;
/** Drop a resolver (tests, teardown). */
export declare function clearEntityResolvers(): void;
/** Whether a kind currently has a resolver — the "will this actually be checked" probe. */
export declare function hasEntityResolver(kind: EntityKind): boolean;
/** One rejected value, ready to render into an error message. */
export interface EntityRefViolation {
    path: string;
    kind: EntityKind;
    label: string;
    value: string;
    suggestions: readonly string[];
    allowed?: readonly string[];
    soft: boolean;
}
/**
 * Check a call's args against the registered resolvers and report violations.
 *
 * FAILS OPEN, deliberately. A kind with no resolver, or a resolver that throws,
 * yields NO violations: referential validation is a correctness improvement, and
 * an outage in the lookup path must not take down every tool that names an
 * entity. Hard failure modes belong in the DB's foreign keys, which are the
 * backstop this layer sits in front of (D-001).
 */
export declare function resolveEntityRefs(sites: readonly EntityRefSite[], args: unknown): Promise<EntityRefViolation[]>;
/**
 * A kind's PUBLISHABLE vocabulary — the set worth advertising in `tools/list`
 * so a model cannot EMIT an invalid value, rather than being corrected after
 * the fact by {@link resolveEntityRefs}.
 *
 * Returning `null` means "not publishable right now" (unknown, unavailable, or
 * the host would rather not say) and is treated exactly like an absent
 * registration: no enum, no error.
 */
export type EntityEnumerator = () => Promise<readonly string[] | null>;
export interface EntityEnumOptions {
    /**
     * Publish the enum only when the set is at most this large. Above it, the
     * overlay emits NOTHING and the arg stays a plain string.
     *
     * ⚠ THIS CAP IS A TOKEN BUDGET, NOT A STYLE PREFERENCE. `tools/list` bytes
     * are PROMPT-PREFIX bytes: an enum is re-serialized into every session's
     * catalog, once per arg site, in every tool that names the kind. Measured on
     * this host (2026-07-19): pots=142, harness slugs=428, fleets=161 — a single
     * one of those inlined across its arg sites costs more prompt weight than the
     * whole tool catalog's descriptions. The dispatch-time check with
     * nearest-match suggestions is the enforcement path for a set that big; the
     * enum is a bonus for genuinely small, mostly-static vocabularies.
     */
    maxValues?: number;
    /**
     * Regex source for values that are VALID BUT UNENUMERABLE — an open
     * vocabulary with a closed core. Emitted as `anyOf: [{enum}, {pattern}]` so
     * the model gets the concrete list without the schema rejecting the tail.
     *
     * The motivating case: agent roles are a fixed built-in list PLUS
     * plugin-contributed `<plugin>:<role>` ids that no startup-time enumeration
     * can see. A bare `enum` there would advertise a closed set that is a lie,
     * and a strict client would reject a legitimate plugin role.
     */
    openPattern?: string;
}
/** Default cap — see the token-budget note on {@link EntityEnumOptions.maxValues}. */
export declare const DEFAULT_MAX_ENUM_VALUES = 60;
/**
 * How long one successfully-loaded enum fragment is reused by tools/list.
 *
 * The host calls {@link applyEntityRefEnums} once PER TOOL while building a
 * catalog. Without a cache, 29 entity-ref sites in Papercusp's current catalog
 * each reload their kind independently; a reconnect herd multiplies those DB
 * reads across every request worker. Keep the window aligned with the host's
 * dispatch-time entity cache: short enough that a newly-created entity appears
 * quickly, long enough to collapse one catalog build and a reconnect burst.
 */
export declare const ENTITY_ENUM_CACHE_TTL_MS = 30000;
/**
 * Register the publishable vocabulary for a kind. Independent of
 * {@link setEntityResolver} on purpose: a kind can be ENFORCED without being
 * publishable (too large — the common case here) and, in principle,
 * publishable without being enforced.
 */
export declare function setEntityEnum(kind: EntityKind, load: EntityEnumerator, opts?: EntityEnumOptions): void;
/** Drop registered enums (tests, teardown). */
export declare function clearEntityEnums(): void;
/**
 * Overlay published vocabularies onto a tool's already-converted JSON Schema.
 *
 * MUTATES AND RETURNS `jsonSchema` — it is called on the freshly-built schema
 * inside a `tools/list` handler, which owns that object.
 *
 * Deliberately a SEPARATE step from `toArgsJsonSchema` rather than something
 * `entityRef` bakes into the schema: the marker is a WeakMap entry precisely so
 * that declaring an arg as an entity ref cannot silently change the published
 * wire contract. Publishing is an explicit, host-controlled, capped act.
 */
export declare function applyEntityRefEnums(argsSchema: unknown, jsonSchema: Record<string, unknown>): Promise<Record<string, unknown>>;
/**
 * A stable fingerprint of everything currently publishable. A host polls this
 * and fires `notifications/tools/list_changed` when it moves, so a live client
 * re-fetches a catalog whose enums actually changed — and, just as importantly,
 * does NOT re-fetch (busting its prompt cache) when they did not.
 */
export declare function entityEnumRevision(): Promise<string>;
/**
 * Render violations as one corrective message — the `--model` UX generalized:
 * name what was wrong, the nearest match, and the allowed set when it is small
 * enough to be useful rather than noise.
 */
export declare function formatEntityRefViolations(violations: readonly EntityRefViolation[]): string;
