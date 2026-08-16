/**
 * OpenAPI 3.1 fragment emitter for projected tools.
 *
 * Given a `ProjectedTool`, produces the per-tool slice of an OpenAPI
 * document: one path entry + the components.schemas entries that path
 * references. The assembler (Phase 7 step 2) walks the catalog, calls
 * `toolToOpenApiFragment()` per tool, and merges into a single document.
 *
 * Wire-format decisions follow openapi-design-spike-2026-05-20.md §6:
 *   - Q1 parsed shape: schemas describe `{ event, id?, data }` not raw
 *     SSE grammar.
 *   - Q2 discriminator: `event` field comes from the SSE `event:` line;
 *     schemas include it as a required string-literal property so the
 *     parsed shape carries the discriminator.
 *   - Q3 tool-name path: colons preserved (`/api/operator:scan`).
 *   - Q5 vendor extensions: `x-papercusp-*`.
 *   - Q6 plugin tools: same shape as built-ins.
 *
 * Spec ref: openapi-design-spike-2026-05-20.md.
 */
import type { ProjectedTool } from './tool-projection';
export declare function componentKey(name: string): string;
export interface OpenApiFragment {
    /**
     * Path entry — keyed under `paths['/api/<toolname>']` in the
     * assembled document.
     */
    path: string;
    /**
     * HTTP method this fragment's operation is keyed under in
     * `paths[path]`. Omitted → `'post'` (every projected tool is POST).
     * `defineTool` fragments set it to the route's actual method, and
     * the assembler merges multiple methods onto one path.
     */
    httpMethod?: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options';
    /** Operation object — keyed under `paths[path][httpMethod]`. */
    operation: Record<string, unknown>;
    /**
     * Schema entries — keyed under `components.schemas[<name>]` in the
     * assembled document. Names are `<toolName>.<suffix>` to avoid
     * collisions between tools.
     */
    schemas: Record<string, Record<string, unknown>>;
}
/**
 * Emit the OpenAPI fragment for a single projected tool.
 *
 * Hosts that want a custom path prefix can pass `pathPrefix` (default
 * `/api`); a custom security-scheme name (default `bearerAuth`) maps to
 * the `securitySchemes` entry the assembler will register.
 */
export declare function toolToOpenApiFragment(toolName: string, tool: ProjectedTool, opts?: {
    pathPrefix?: string;
    securitySchemeName?: string;
}): OpenApiFragment;
/**
 * The fixed set of error response components every tool path references.
 * Returned as a single object so the assembler can spread it into
 * `components.responses` once per document instead of N times.
 */
export declare function standardResponseComponents(): Record<string, Record<string, unknown>>;
