"use strict";
/**
 * Pluggable JSON-Schema generation (plan P-021 / D-002).
 *
 * Standard Schema (the validator interface the core is moving to in P-020) has
 * **no** JSON-Schema export — so turning a tool's `args`/`events`/`state` schema
 * into the JSON Schema that `tools/list` + OpenAPI need is a *separate*,
 * swappable concern. The engine routes every schema→JSON-Schema conversion
 * through the adapter registered here instead of calling a validator library
 * directly.
 *
 * The default is the Zod adapter (Zod 4's built-in `z.toJSONSchema`), so the
 * Papercusp host — and every existing tool — keeps working with zero changes.
 * A host using Valibot / ArkType / etc. registers its own adapter at startup
 * via `setJsonSchemaAdapter`, before its tools self-register (the schema is
 * converted eagerly at `defineTool` time, same load-order contract as the
 * capability-tier resolver — see capability-tiers.ts).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.zodJsonSchemaAdapter = void 0;
exports.setJsonSchemaAdapter = setJsonSchemaAdapter;
exports.toJsonSchema = toJsonSchema;
const zod_1 = require("zod");
/**
 * Default adapter — Zod 4's built-in `toJSONSchema`. Shipped as the default so
 * the conversion is zero-config for Zod consumers; swappable via
 * `setJsonSchemaAdapter`.
 */
const zodJsonSchemaAdapter = (schema) => zod_1.z.toJSONSchema(schema);
exports.zodJsonSchemaAdapter = zodJsonSchemaAdapter;
let adapter = exports.zodJsonSchemaAdapter;
/** Register the host's schema→JSON-Schema adapter. Call once at startup. */
function setJsonSchemaAdapter(fn) {
    adapter = fn;
}
/** Convert a schema to JSON Schema via the active adapter. */
function toJsonSchema(schema) {
    return adapter(schema);
}
