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
export type FacadeDispatch = (tool: ProjectedTool, toolName: string, args: unknown) => Promise<unknown>;
export interface ToolFacade {
    /** Universal escape hatch — call any ALLOWED tool by its full MCP name (`ns:verb`). */
    call(toolName: string, args?: unknown): Promise<unknown>;
    /** Namespaced access: `tools.<ns>.<camelVerb>(args)`. */
    [ns: string]: any;
}
/**
 * `wake-queue` / `set_status` → `wakeQueue` / `setStatus` (a valid JS identifier).
 * Exported so the COMPILE-TIME signature generator (facade-types.ts, B-CX-API) names verbs
 * identically to this RUNTIME facade — the two must never disagree.
 */
export declare function camelVerb(verb: string): string;
/**
 * Build the `tools` facade the sandbox injects. One callable per ALLOWED tool, both
 * namespaced (`tools.ns.verb`) and flat (`tools.call('ns:verb', …)`). Tools outside `allowed`
 * are absent. Returns an empty-but-callable facade if `tools` is empty.
 */
export declare function buildToolFacade(tools: readonly ProjectedTool[], dispatch: FacadeDispatch, allowed?: ReadonlySet<string>): ToolFacade;
/** Names of the tools exposed by a facade (for parse-checks + prompt catalogs). */
export declare function facadeToolNames(tools: readonly ProjectedTool[], allowed?: ReadonlySet<string>): string[];
/**
 * The role-scoped allowed set BOTH code-mode meta-tools (`code:run`, `code:tools`) build before
 * handing the facade/signatures to a script: the MCP names of every tool whose `agentRoles` admit
 * `role`, minus an `exclude` set (the meta-tools exclude THEMSELVES so a script can't recursively
 * nest code-mode). A tool with no `agentRoles` (or an empty list) is role-open — included for any
 * role. This MIRRORS the dispatcher's role-allowlist gate (`dispatch-stack.ts` / `listMcpProjections`)
 * so the facade a script can reference is exactly the set the dispatcher would let it call — the
 * envelope IS the security boundary, so the two must never disagree.
 *
 * Extracted from the identical loop that lived inline in both `code/run.ts` and `code/tools.ts`
 * (code-execution-tool-orchestration) so the scoping has ONE definition + a hermetic unit test.
 */
export declare function roleScopedToolNames(tools: readonly ProjectedTool[], role: string | null | undefined, exclude?: ReadonlySet<string>): Set<string>;
