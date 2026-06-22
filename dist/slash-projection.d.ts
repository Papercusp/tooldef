/**
 * Slash exposure — project MCP-exposed tools onto the MCP **prompts**
 * primitive so agent clients (Claude Code, …) surface every tool the
 * session can call as a slash command.
 *
 * Plan: slash-exposure-tool-catalog-2026-06-12.
 *
 * This is a catalog projection, NOT a dispatch transport (plan D-001): a
 * rendered slash prompt instructs the agent to invoke the tool over the
 * session's existing MCP connection, so role gating, quota, audit, and
 * result formatting are inherited from the normal tools/call path. The
 * host transport (operator-core `_mcp-handler.ts`) decides WHICH tools are
 * visible per session (same role/profile walk as tools/list — parity by
 * construction); this module owns the per-tool projection mechanics:
 * naming, prompt-argument derivation, and the instruction render.
 *
 * Dynamic prompts live under the reserved `tool:` name namespace (plan
 * D-006); `prompt-registry.ts` rejects static prompts claiming it.
 */
import type { ProjectedTool, ToolExposureSlash } from './tool-projection';
import type { PromptArgumentSchema, PromptResult } from './types';
/** Reserved name prefix for dynamic tool prompts (plan D-006). */
export declare const SLASH_PROMPT_PREFIX = "tool:";
/** A prompts/list entry for one slash-exposed tool. */
export interface SlashPromptListing {
    name: string;
    description: string;
    arguments?: PromptArgumentSchema[];
}
/**
 * Normalize a tool's slash exposure. Returns the override object (possibly
 * empty) when the tool projects onto the slash surface, or null when it is
 * excluded — `expose.slash: false`, or no MCP exposure at all (an HTTP-only
 * tool has no agent-callable name for the rendered instruction to target).
 * Absent/`true` ⇒ ON with defaults (owner-ratified default-on, plan D-003).
 */
export declare function resolveSlashExposure(tool: ProjectedTool): ToolExposureSlash | null;
/** The dynamic prompt name for a tool: `tool:<override ?? mcp name>`. */
export declare function slashPromptNameFor(tool: ProjectedTool): string | null;
/** True when a prompt name addresses the dynamic tool-prompt namespace. */
export declare function isSlashPromptName(name: string): boolean;
/** Strip the `tool:` prefix back to the (overridden or MCP) tool name. */
export declare function slashPromptToolName(promptName: string): string;
/**
 * Derive MCP prompt arguments from a tool's input JSON Schema: every
 * top-level scalar (string/number/integer/boolean/enum) property, optionally
 * restricted to `restrict`. Non-scalar fields are deliberately omitted —
 * the rendered instruction has the agent elicit them (plan D-004).
 *
 * All arguments are advertised `required: false` ON THE WIRE, with
 * required-ness annotated in the description instead: a client that
 * enforces required prompt args client-side would otherwise block bare
 * `/command` invocation, which is exactly the elicitation flow we want to
 * keep available (implementation note on plan D-004).
 */
export declare function deriveSlashPromptArguments(inputSchema: Record<string, unknown>, restrict?: readonly string[]): PromptArgumentSchema[];
/**
 * Build the prompts/list entry for one slash-exposed tool, or null when the
 * tool is excluded. `advertisedInputSchema` lets the host pass the schema
 * the agent actually sees on tools/list (e.g. the positional-`row` swap for
 * registry write tools) so prompt args match what is callable; defaults to
 * the registered schema.
 */
export declare function slashPromptListingFor(tool: ProjectedTool, advertisedInputSchema?: Record<string, unknown>): SlashPromptListing | null;
/**
 * Render the instruction message for a slash-invoked tool (plan D-004 +
 * D-007). Pure — no I/O, no ctx; the host wraps it in prompts/get.
 *
 * The message directs the agent to: coerce the string-typed slash args per
 * the schema, elicit any missing REQUIRED fields from the user before
 * invoking, confirm first for high-tier (and apparently-destructive)
 * invocations, then call the tool over this MCP session and summarize.
 */
export declare function renderSlashPrompt(tool: ProjectedTool, args: Record<string, string>, advertisedInputSchema?: Record<string, unknown>, opts?: {
    /**
     * Replace the supplied-arguments block verbatim — used by FILE emitters
     * whose client substitutes its own placeholder at invocation time (the
     * Codex `$ARGUMENTS` path, plan P-009). When set, `args` is ignored.
     */
    suppliedArgsText?: string;
}): PromptResult;
