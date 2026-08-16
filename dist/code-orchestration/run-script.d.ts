import type { ToolFacade } from './tool-facade';
export interface RunScriptResult {
    ok: boolean;
    /** The script's returned value — the summary that re-enters the model's context. */
    result?: unknown;
    /** Captured console output from the script (bounded by maxLogLines). */
    logs: string[];
    /** Present when ok=false: 'compile_error: …', 'script_timeout …', or the thrown message. */
    error?: string;
}
export interface RunScriptOptions {
    /** Wall-clock budget for the whole script. Default 30s. Sync loops are killed at this bound. */
    timeoutMs?: number;
    /** Cap on captured console lines. Default 200. */
    maxLogLines?: number;
    /**
     * Optional V8 old-generation heap cap (MB) for the worker. When set, a script that allocates
     * past it is killed by the runtime with a heap-OOM error instead of bloating the host. Omit for
     * no explicit cap (the Node default). Very small values (<16) can make the worker fail to boot.
     */
    maxOldGenerationSizeMb?: number;
}
export declare function runOrchestrationScript(script: string, facade: ToolFacade, opts?: RunScriptOptions): Promise<RunScriptResult>;
