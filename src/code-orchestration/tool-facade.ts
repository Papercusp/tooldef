/**
 * code-execution-tool-orchestration B-CX-1A — the tool FACADE.
 *
 * The code-execution sandbox injects a `tools` object whose every member is one of the
 * agent's ALLOWED tools, callable as a normal async function:
 *
 *     const open = await tools.work_items.list({ status: 'open' });
 *     await tools.coord.wakeQueue();                 // hyphenated verbs → camelCase
 *     await tools.call('plans:set-status', { ... }); // universal escape hatch by full name
 *
 * Each call is routed through an INJECTED `dispatch` fn. In production that fn is bound to the
 * caller's `UnifiedToolContext` + `DispatchProjectedDeps` (see `realDispatch` in
 * `dispatch-binding.ts`) so every call goes through the SAME gating / capability-envelope /
 * audit pipeline as an MCP `tools/call` — code-mode is just a new caller of the dispatcher, not
 * a parallel tool system. Injection keeps this builder pure + unit-testable with a mock.
 *
 * SAFETY MODEL: the facade only contains tools in `allowed` (the agent's capability envelope),
 * so model-written code physically cannot reference a tool it isn't permitted to call. That
 * whitelist — NOT vm isolation — is the security boundary (the field consensus; see the plan
 * §8). The dry-run/confirm gate on `effect: 'write'` tools (B-CX-PRE marker, B-CX-2A gate) is
 * the second layer.
 */
import type { ProjectedTool } from '../tool-projection';

/**
 * Per-call dispatch the facade invokes. Injected so the facade is decoupled from ctx/deps
 * construction — production binds it to the real dispatcher; tests pass a mock.
 */
export type FacadeDispatch = (
  tool: ProjectedTool,
  toolName: string,
  args: unknown,
) => Promise<unknown>;

export interface ToolFacade {
  /** Universal escape hatch — call any ALLOWED tool by its full MCP name (`ns:verb`). */
  call(toolName: string, args?: unknown): Promise<unknown>;
  /** Namespaced access: `tools.<ns>.<camelVerb>(args)`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [ns: string]: any;
}

/** `wake-queue` / `set_status` → `wakeQueue` / `setStatus` (a valid JS identifier). */
function camelVerb(verb: string): string {
  return verb.replace(/[-_]+([a-z0-9])/gi, (_m, c: string) => c.toUpperCase());
}

/**
 * Build the `tools` facade the sandbox injects. One callable per ALLOWED tool, both
 * namespaced (`tools.ns.verb`) and flat (`tools.call('ns:verb', …)`). Tools outside `allowed`
 * are absent. Returns an empty-but-callable facade if `tools` is empty.
 */
export function buildToolFacade(
  tools: readonly ProjectedTool[],
  dispatch: FacadeDispatch,
  allowed?: ReadonlySet<string>,
): ToolFacade {
  const byName = new Map<string, ProjectedTool>();
  const facade: ToolFacade = {
    async call(toolName: string, args?: unknown): Promise<unknown> {
      const tool = byName.get(toolName);
      if (!tool) {
        throw new Error(`code-orchestration: tool not available in this sandbox: ${toolName}`);
      }
      return dispatch(tool, toolName, args ?? {});
    },
  };

  for (const tool of tools) {
    const name = tool.expose?.mcp?.name;
    if (!name) continue;
    const ci = name.indexOf(':');
    if (ci <= 0) continue; // skip names without a `ns:verb` shape
    if (allowed && !allowed.has(name)) continue;

    byName.set(name, tool);
    const ns = name.slice(0, ci);
    const verb = camelVerb(name.slice(ci + 1));
    if (ns === 'call') continue; // never shadow the escape hatch
    const bucket = (facade[ns] ??= {} as Record<string, unknown>);
    bucket[verb] = (args?: unknown): Promise<unknown> => dispatch(tool, name, args ?? {});
  }

  return facade;
}

/** Names of the tools exposed by a facade (for parse-checks + prompt catalogs). */
export function facadeToolNames(
  tools: readonly ProjectedTool[],
  allowed?: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const tool of tools) {
    const name = tool.expose?.mcp?.name;
    if (!name || name.indexOf(':') <= 0) continue;
    if (allowed && !allowed.has(name)) continue;
    out.push(name);
  }
  return out.sort();
}
