import type { ProjectedTool } from '../tool-projection';
/** Lazily load the TS compiler (kept out of the eager client bundle). Await once before checkScript(). Idempotent. */
export declare function ensureParseCheckReady(): Promise<void>;
export interface ParseCheckResult {
    ok: boolean;
    /** Tool references found in the script that are NOT in the allowed facade. */
    unknownRefs: string[];
    /** All tool references the static scan resolved (for logging/telemetry). */
    refs: string[];
}
export declare function checkScript(script: string, tools: readonly ProjectedTool[], allowed?: ReadonlySet<string>): ParseCheckResult;
