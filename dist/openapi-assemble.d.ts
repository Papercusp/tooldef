/**
 * OpenAPI 3.1 document assembler.
 *
 * Walks a list of projected tools, emits a per-tool fragment for each
 * (`openapi-fragments.ts`), and merges them into one valid OpenAPI 3.1
 * document: `info` + `openapi` version + `paths` + `components`
 * (`schemas`, `responses`, `securitySchemes`).
 *
 * Phase 7 step 2 (openapi-design-spike-2026-05-20.md §7).
 *
 * Pure — takes the tool list as an argument rather than reaching for
 * the registry, so it's trivially testable and the caller decides
 * whether to pass the full catalog or a filtered subset.
 */
import type { ProjectedTool } from './tool-projection';
import { type OpenApiFragment } from './openapi-fragments';
export interface OpenApiDocumentOptions {
    /** `info.title`. Default 'Papercusp Tool API'. */
    title?: string;
    /** `info.version`. Default '0.1.0'. */
    version?: string;
    /** `info.description`. Optional. */
    description?: string;
    /** Path prefix passed to each fragment. Default '/api'. */
    pathPrefix?: string;
    /** Security-scheme name. Default 'bearerAuth'. */
    securitySchemeName?: string;
    /** `servers` array. Optional — omitted when absent. */
    servers?: Array<{
        url: string;
        description?: string;
    }>;
    /**
     * Extra pre-built fragments to merge alongside the tool fragments —
     * `defineTool` operations (endpoint route migration R3). Each carries
     * its own `httpMethod`; multiple methods on one path merge. The host
     * (apps/operator) builds these from its route registry and passes them
     * in — keeps this package free of an apps/operator dependency.
     */
    extraFragments?: ReadonlyArray<OpenApiFragment>;
}
/**
 * Resolve the operation name for a projected tool. Prefers the MCP
 * dotted name; falls back to the HTTP path's last segment. Tools with
 * neither are skipped by the caller (registerProjectedTool already
 * rejects them, so this is defense-in-depth).
 */
export declare function toolOperationName(tool: ProjectedTool): string | null;
/**
 * Assemble a full OpenAPI 3.1 document from a list of projected tools.
 *
 * Path collisions (two tools resolving to the same name) throw — the
 * registry already enforces unique MCP names + HTTP paths, so a
 * collision here means a bug upstream, not a recoverable condition.
 */
export declare function assembleOpenApiDocument(tools: readonly ProjectedTool[], opts?: OpenApiDocumentOptions): Record<string, unknown>;
