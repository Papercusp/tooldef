import type { ProjectedTool } from '../tool-projection';
export interface ParseCheckResult {
    ok: boolean;
    /** Tool references found in the script that are NOT in the allowed facade. */
    unknownRefs: string[];
    /** All tool references the static scan resolved (for logging/telemetry). */
    refs: string[];
}
export declare function checkScript(script: string, tools: readonly ProjectedTool[], allowed?: ReadonlySet<string>): ParseCheckResult;
