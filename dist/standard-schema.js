"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.standardValidate = standardValidate;
exports.validateSync = validateSync;
exports.formatIssues = formatIssues;
/**
 * Validate `input` against a Standard Schema, awaiting async validators (Zod's
 * is synchronous; Valibot/ArkType may be async). Use from an async context.
 */
async function standardValidate(schema, input) {
    const result = await schema['~standard'].validate(input);
    // SuccessResult has `issues?: undefined`; FailureResult has a non-empty
    // `issues`. Truthy-check (not `'issues' in r`) is the correct narrowing.
    if (result.issues)
        return { ok: false, issues: result.issues };
    return { ok: true, value: result.value };
}
/**
 * Synchronous validation for call paths that cannot await (e.g. the
 * fire-and-forget `ctx.publishState`). Zod validates synchronously; if a host
 * plugs in an async validator on such a path, this throws loudly rather than
 * silently dropping validation.
 */
function validateSync(schema, input) {
    const result = schema['~standard'].validate(input);
    if (result instanceof Promise) {
        throw new Error('Standard Schema validate() returned a Promise on a synchronous path. ' +
            'Async validators are not supported here (e.g. ctx.publishState); use a synchronous validator like Zod.');
    }
    if (result.issues)
        return { ok: false, issues: result.issues };
    return { ok: true, value: result.value };
}
/** Render issues into a single `path: message; …` string (Zod-error-like). */
function formatIssues(issues) {
    return issues
        .map((i) => {
        const path = (i.path ?? [])
            .map((seg) => (typeof seg === 'object' && seg !== null ? String(seg.key) : String(seg)))
            .join('.');
        return path ? `${path}: ${i.message}` : i.message;
    })
        .join('; ');
}
