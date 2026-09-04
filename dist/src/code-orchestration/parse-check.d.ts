import type { ProjectedTool } from '../tool-projection';
/** Lazily load the TS compiler (kept out of the eager client bundle). Await once before checkScript(). Idempotent. */
export declare function ensureParseCheckReady(): Promise<void>;
export interface ParseCheckResult {
    ok: boolean;
    /** Tool references found in the script that are NOT in the allowed facade. */
    unknownRefs: string[];
    /** All tool references the static scan resolved (for logging/telemetry). */
    refs: string[];
    /**
     * Statically resolved tool CALLS, including the literal portion of their
     * argument object. This is deliberately inspection-only: dynamic values are
     * omitted and set `dynamicArgs:true`; the runtime whitelist remains the
     * security boundary. Consumers use this to decide whether a saved script is
     * safe to recommend in a different entity context.
     */
    calls: StaticToolCall[];
}
export interface StaticToolCall {
    /** Canonical `ns:verb` when the projected catalog knows it, otherwise the
     * statically resolved facade member (`ns.verb`). */
    tool: string;
    /** Literal/partially-literal argument value, or null when no value resolved. */
    args: unknown | null;
    /** True when any part of the argument expression was dynamic/unresolved. */
    dynamicArgs: boolean;
}
export declare function checkScript(script: string, tools: readonly ProjectedTool[], allowed?: ReadonlySet<string>): ParseCheckResult;
