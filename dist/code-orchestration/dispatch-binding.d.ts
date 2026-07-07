/**
 * code-execution-tool-orchestration B-CX-1A — the DISPATCH BINDING.
 *
 * Binds the facade's injected `FacadeDispatch` to a real `UnifiedToolContext` + `DispatchProjectedDeps`,
 * so every tool call the model's script makes routes through the SAME dispatcher pipeline
 * (role/capability/envelope gates, quota, authorize, telemetry, audit) as an MCP `tools/call` —
 * code-mode is just another caller of the dispatcher, not a parallel tool path.
 *
 * On success it UNWRAPS the MCP `ToolResult` into the plain data the script should see (so model
 * code gets `result.items`, not `result.content[0].text`). On a dispatch failure it throws, so
 * the script's own try/catch — or the executor's error capture — surfaces it.
 */
import type { UnifiedToolContext } from '../tool-projection';
import type { DispatchProjectedDeps } from '../dispatch-types';
import type { ToolResult } from '../wire';
import type { FacadeDispatch } from './tool-facade';
/**
 * Unwrap a settled `ToolResult` into the plain value the script should receive:
 * `structuredContent` if present, else the decoded text payload, else the raw text.
 *
 * EI-7689: a compact (non-JSON) tool response self-identifies with a leading `format:
 * <fmt>\n` marker (TOON/CSV/TSV/MD — serialize-result.ts) — none of those are valid JSON,
 * so a plain `JSON.parse` always THROWS on them and this used to silently fall back to
 * handing the script the raw marker+encoded STRING as its `result`. Any in-script
 * truthiness/property check on that string (`if (result.ok)`) then silently lies: a
 * non-empty string is always truthy no matter what's encoded inside it, so a genuine
 * server-side failure can read as success. Reproduced live 2026-07-05 (su-15a64): a
 * `plans:new` call failed server-side (`similar_exists`) but returned a truthy TOON
 * string, and the script's `result.ok` check passed, reporting a phantom plan creation.
 * Parse the marker first and DECODE with the matching format (the lossless inverse of
 * the encoder that produced it) so the script always sees the real structured value.
 */
export declare function unwrapToolResult(result: ToolResult | undefined): unknown;
export declare function realDispatch(ctx: UnifiedToolContext, deps: DispatchProjectedDeps): FacadeDispatch;
