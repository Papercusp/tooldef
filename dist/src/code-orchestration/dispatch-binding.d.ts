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
 *
 * WI-6458 is the same failure from the other direction: a PROXIED upstream MCP server
 * (gitnexus) ends its text with a chat affordance — `\n\n---\n**Next:** READ gitnexus://…`
 * — after otherwise-valid JSON, so `JSON.parse` throws and the script got the raw string.
 * `parseJsonWithTrailer` recovers the leading value; the trailing prose is DROPPED for the
 * script (it addresses a human/model reading the raw text, and the direct MCP path still
 * returns it verbatim — only the code-mode facade unwraps).
 */
export declare function unwrapToolResult(result: ToolResult | undefined): unknown;
/**
 * Dispatcher error codes decided BEFORE the tool's handler runs — a gate or a schema
 * rejection. When dispatch fails with one of these, the tool's side effects
 * DEFINITIVELY did not happen: nothing was written, so a retry is safe.
 *
 * This distinction is load-bearing (EI-10951). The orchestrator used to count every
 * DISPATCHED write-effect call as "executed", including one the dispatcher rejected on
 * its args — so a script whose last call had a typo'd argument came back with
 * "1 write-effect call(s) already executed before this failure — do NOT blindly re-run
 * … to avoid a double-write." Nothing had executed. The warning sent the agent off to
 * verify a write that never happened, and taught it to distrust a warning that is
 * RIGHT in the case it exists for (a real partial batch). A safety warning that cries
 * wolf on the most common failure (a bad arg) is worse than no warning.
 *
 * Conservative by construction: a code NOT in this set is treated as UNKNOWN (it may
 * have landed), so a genuinely ambiguous failure still gets the loud warning. Only
 * codes that provably precede the handler belong here.
 */
export declare const PRE_EXECUTION_ERROR_CODES: ReadonlySet<string>;
/**
 * A dispatch-level failure, carrying the dispatcher's own error `code` instead of
 * flattening it into a string. `preExecution` answers the only question a caller
 * recovering from a failed batch actually has: did this write land or not?
 *
 * The `message` format is UNCHANGED (`tool <name> failed [<code>]: <msg>`) — scripts in
 * the wild match on it, and this is a strictly additive widening of the thrown value.
 */
export declare class ToolDispatchError extends Error {
    readonly code: string;
    readonly toolName: string;
    /** True ⇒ the dispatcher rejected the call before the handler ran; nothing was written. */
    readonly preExecution: boolean;
    constructor(toolName: string, code: string, message: string);
}
/** True when a thrown value is a dispatch rejection that provably never reached the handler. */
export declare function isPreExecutionFailure(err: unknown): boolean;
export declare function realDispatch(ctx: UnifiedToolContext, deps: DispatchProjectedDeps): FacadeDispatch;
