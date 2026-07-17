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
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ReadonlyArray<StandardSchemaV1.Issue> };

/**
 * Validate `input` against a Standard Schema, awaiting async validators (Zod's
 * is synchronous; Valibot/ArkType may be async). Use from an async context.
 */
export async function standardValidate<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
): Promise<ValidationResult<StandardSchemaV1.InferOutput<S>>> {
  const result = await schema['~standard'].validate(input);
  // SuccessResult has `issues?: undefined`; FailureResult has a non-empty
  // `issues`. Truthy-check (not `'issues' in r`) is the correct narrowing.
  if (result.issues) return { ok: false, issues: result.issues };
  return { ok: true, value: result.value };
}

/**
 * Synchronous validation for call paths that cannot await (e.g. the
 * fire-and-forget `ctx.publishState`). Zod validates synchronously; if a host
 * plugs in an async validator on such a path, this throws loudly rather than
 * silently dropping validation.
 */
export function validateSync<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
): ValidationResult<StandardSchemaV1.InferOutput<S>> {
  const result = schema['~standard'].validate(input);
  if (result instanceof Promise) {
    throw new Error(
      'Standard Schema validate() returned a Promise on a synchronous path. ' +
        'Async validators are not supported here (e.g. ctx.publishState); use a synchronous validator like Zod.',
    );
  }
  if (result.issues) return { ok: false, issues: result.issues };
  return { ok: true, value: result.value };
}

/**
 * A validation issue's ZOD-flavoured extras. StandardSchemaV1.Issue only promises
 * `{ message, path? }`, but a Zod issue carries `code`/`origin`/`maximum` at runtime
 * and that is what every validator in this repo actually produces. Read them
 * defensively (all optional): a host plugging in a non-Zod validator simply loses the
 * enrichment and falls back to the plain `path: message` rendering.
 */
interface IssueExtras {
  code?: string;
  origin?: string;
  maximum?: number;
  minimum?: number;
}

/**
 * Value-level issue codes: the caller used a KEY THAT EXISTS and supplied a value the
 * field would not take. Contrast with a shape problem (an unrecognized key, a missing
 * required field, a wrong type) where the caller demonstrably does not know the schema.
 * The distinction drives `issuesAreValueLevel` below — see its doc.
 */
const VALUE_LEVEL_CODES = new Set(['too_big', 'too_small', 'invalid_format', 'invalid_value', 'not_multiple_of']);

export function issuePath(issue: StandardSchemaV1.Issue): string {
  return (issue.path ?? [])
    .map((seg) => (typeof seg === 'object' && seg !== null ? String((seg as { key: PropertyKey }).key) : String(seg)))
    .join('.');
}

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
export function issuesAreValueLevel(issues: ReadonlyArray<StandardSchemaV1.Issue>): boolean {
  if (issues.length === 0) return false;
  return issues.every((issue) => {
    const code = (issue as IssueExtras).code;
    return !!code && VALUE_LEVEL_CODES.has(code) && issuePath(issue).length > 0;
  });
}

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
export function formatIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>, input?: unknown): string {
  return issues
    .map((i) => {
      const path = issuePath(i);
      const extras = i as IssueExtras;
      if (extras.code === 'too_big' && extras.origin === 'string' && typeof extras.maximum === 'number') {
        const max = extras.maximum;
        const actual = input !== undefined ? valueAtIssuePath(input, i) : undefined;
        const actualLen = typeof actual === 'string' ? actual.length : null;
        const over = actualLen !== null ? actualLen - max : null;
        const detail =
          over !== null && over > 0
            ? `too long — ${actualLen} chars, ${over} over the ${max}-char limit; trim to ${max}.`
            : `too long — over the ${max}-char limit; trim to ${max}.`;
        return path ? `${path}: ${detail}` : detail;
      }
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join('; ');
}

/** Walk `input` to the value an issue points at (undefined if the path does not resolve). */
function valueAtIssuePath(input: unknown, issue: StandardSchemaV1.Issue): unknown {
  let cur: unknown = input;
  for (const seg of issue.path ?? []) {
    const key = typeof seg === 'object' && seg !== null ? (seg as { key: PropertyKey }).key : (seg as PropertyKey);
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}
