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

/** Render issues into a single `path: message; …` string (Zod-error-like). */
export function formatIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>): string {
  return issues
    .map((i) => {
      const path = (i.path ?? [])
        .map((seg) => (typeof seg === 'object' && seg !== null ? String((seg as { key: PropertyKey }).key) : String(seg)))
        .join('.');
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join('; ');
}
