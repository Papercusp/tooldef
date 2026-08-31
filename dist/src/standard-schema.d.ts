/**
 * Standard Schema adoption (plan P-020 / D-002).
 *
 * The engine validates a tool's `args`/`input`/`state` and card payloads against
 * any [Standard Schema](https://standardschema.dev) validator — Zod 3.24+,
 * Valibot, ArkType, … — not Zod specifically. It reads only the `~standard`
 * property every such validator exposes; it never calls Zod-specific methods
 * like `.safeParse`. The Papercusp host keeps Zod for its ~96 tools (D-002 only
 * generalizes the core, not the consumers), and Zod schemas satisfy
 * `StandardSchemaV1` so they flow through unchanged.
 *
 * JSON-Schema generation is a *separate* pluggable concern (Standard Schema has
 * no JSON-Schema export) — see `schema-adapter.ts` (P-021).
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';
export type { StandardSchemaV1 };
/** A validation outcome the engine branches on. */
export type ValidationResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    issues: ReadonlyArray<StandardSchemaV1.Issue>;
};
/**
 * Validate `input` against a Standard Schema, awaiting async validators (Zod's
 * is synchronous; Valibot/ArkType may be async). Use from an async context.
 *
 * Strict object validators can report an unknown-key issue before running
 * object-level required checks or refinements. Revalidate once after removing
 * only the reported unknown keys, then merge the new issues back into the
 * original result. The original input is never mutated, and the first pass is
 * retained so the caller still learns about the undeclared keys.
 */
export declare function standardValidate<S extends StandardSchemaV1>(schema: S, input: unknown): Promise<ValidationResult<StandardSchemaV1.InferOutput<S>>>;
/**
 * Synchronous validation for call paths that cannot await (e.g. the
 * fire-and-forget `ctx.publishState`). Zod validates synchronously; if a host
 * plugs in an async validator on such a path, this throws loudly rather than
 * silently dropping validation.
 */
export declare function validateSync<S extends StandardSchemaV1>(schema: S, input: unknown): ValidationResult<StandardSchemaV1.InferOutput<S>>;
export declare function issuePath(issue: StandardSchemaV1.Issue): string;
/**
 * True when EVERY issue is a value-level violation on a NAMED field — i.e. the caller
 * knows the tool's shape and simply sent a value one field would not accept (too long,
 * a bad enum value, a malformed string).
 *
 * EI-10943: this is the signal that a full args-schema dump is pure context burn. The
 * dump (P-004) earns its keep for a SHAPE-blind caller — an unrecognized key, an omitted
 * required field — where one failure should teach the whole contract. But a 1,800-char
 * schema appended to "foundDuring: too long — 3 chars over the 120-char limit" teaches
 * nothing the caller did not already know, and it lands in the context of the agent least
 * able to spare it. An unnamed-path issue (a whole-object refinement) is treated as a
 * shape problem, so it keeps the schema.
 */
export declare function issuesAreValueLevel(issues: ReadonlyArray<StandardSchemaV1.Issue>): boolean;
/**
 * Render issues into a single `path: message; …` string (Zod-error-like).
 *
 * A string `too_big` is rendered ACTIONABLY — how far over the cap the value is and the
 * exact target length — so the caller trims deterministically in ONE retry instead of
 * blind-retrying the same value (a telemetry audit traced ~1,000+ tool calls/14d failing
 * purely on over-length args, and Zod's own "Too big: expected string to have <=120
 * characters" never says by how much). Needs the input to measure the actual length;
 * without it the message degrades gracefully to the target-only form.
 */
/**
 * Resolve issues to their LEAF diagnoses, each with its fully-qualified segment path.
 *
 * This is the traversal `formatIssues` renders from, extracted so other consumers can
 * reach the same leaves. The distinction it encodes is easy to get wrong and expensive
 * when you do: an `invalid_union` issue's own `path` stops at the UNION NODE (`body`),
 * while its real diagnosis lives in per-branch sub-issues several levels deeper
 * (`body.2.couldNotDetermine.0.what`). Anyone reading `issue.path` directly therefore
 * sees a shallow path that does not match the deep one the rendered message shows —
 * which reads as a bug in the renderer rather than a missing descent.
 *
 * Kept as ONE traversal deliberately: a second copy would drift from the rendered
 * message, and a path hint that disagrees with the error beside it is worse than none.
 */
export declare function issueLeaves(issues: ReadonlyArray<StandardSchemaV1.Issue>): Array<{
    issue: StandardSchemaV1.Issue;
    segs: PropertyKey[];
}>;
export declare function formatIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>, input?: unknown): string;
