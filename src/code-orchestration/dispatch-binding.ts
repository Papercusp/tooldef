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
import type { UnifiedToolContext, ProjectedTool } from '../tool-projection';
import type { DispatchProjectedDeps } from '../dispatch-types';
import type { ToolResult } from '../wire';
import { dispatchProjectedTool } from '../dispatch-projected';
import type { FacadeDispatch } from './tool-facade';

/**
 * Unwrap a settled `ToolResult` into the plain value the script should receive:
 * `structuredContent` if present, else the JSON-parsed text payload, else the raw text.
 */
export function unwrapToolResult(result: ToolResult | undefined): unknown {
  if (!result) return undefined;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const textItem = result.content?.find(
    (c): c is { text: string } => typeof (c as { text?: unknown }).text === 'string',
  );
  if (!textItem) return result;
  try {
    return JSON.parse(textItem.text);
  } catch {
    return textItem.text;
  }
}

export function realDispatch(ctx: UnifiedToolContext, deps: DispatchProjectedDeps): FacadeDispatch {
  return async (tool: ProjectedTool, toolName: string, args: unknown): Promise<unknown> => {
    const r = await dispatchProjectedTool(tool, toolName, args, ctx, deps);
    if (!r.ok) {
      throw new Error(
        `tool ${toolName} failed [${r.error?.code ?? 'error'}]: ${r.error?.message ?? 'unknown error'}`,
      );
    }
    return unwrapToolResult(r.result);
  };
}
