/**
 * Host-specialized seams — types the framework references but does not own.
 *
 * In Papercusp these were concrete unions (`AgentRole`), capability strings,
 * and a subprocess executor. In the generic framework they are open seams:
 * a role is any string, a capability is any string, and `spawn` is an
 * optional host-supplied subprocess runner. Phase 2 (plan P-010) promotes
 * `AgentRole`/`Capability` to a proper generic parameter / host registry;
 * for now they are widened to `string`, which every concrete union the host
 * passes is assignable to.
 */

/** An agent/caller role. Host-defined; the framework only compares strings. */
export type AgentRole = string;

/** A declarative permission string, e.g. `"tasks:read"`. Host-defined. */
export type Capability = string;

/** Options for a host-supplied subprocess spawn. */
export interface PluginSpawnOptions {
  /** Working directory. */
  cwd?: string;
  /** Additional env vars merged on top of the host process env. */
  env?: Record<string, string>;
  /** Stdin payload to write before closing stdin. */
  stdin?: string | Uint8Array;
  /** Hard timeout in ms; the host SIGKILLs on expiry. */
  timeoutMs?: number;
  /** Max captured stdout/stderr size in bytes. */
  maxBufferBytes?: number;
}

/** Result of a host-supplied subprocess spawn. */
export interface PluginSpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True if the process was killed by the host (timeout, abort). */
  killed: boolean;
}

/**
 * A host-supplied subprocess executor handed to tool handlers as `ctx.spawn`.
 * Optional — tools that don't shell out never receive it.
 */
export type PluginSpawn = (
  bin: string,
  args: readonly string[],
  opts?: PluginSpawnOptions,
) => Promise<PluginSpawnResult>;
