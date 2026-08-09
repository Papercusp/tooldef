/**
 * server-vintage — a host-registered "how stale is this process" resolver.
 *
 * EI-19953470656367880: a long-lived server process (a Tauri desktop's own spawned
 * operator, chief among them — it has no file-watch and runs whatever code it booted
 * with, indefinitely) rejects a newly-added tool arg with a bare `Unrecognized key`
 * error. Nothing in that error says WHY: the caller (often a hot-reloaded UI sending
 * an arg the process's own code predates) has no way to distinguish "I made a typo"
 * from "the server I'm talking to is hours old and has never seen this arg exist."
 * Both look identical from the wire.
 *
 * The library owns the SEAM (where to hang the extra line, and how to fail safe);
 * the HOST owns the POLICY (what its own build id + boot time actually are) — the
 * same "declare the port here, wire the impl host-side" split as `result-annotator.ts`
 * / `setSemanticDeltaEnabledResolver`. This file stays host-agnostic on purpose: a
 * generic `libs/generic/*` package must not know what "PAPERCUSP_BUILD_SHA" is.
 *
 * Default is unregistered (no resolver ⇒ the unknown-arg hint is unchanged), so every
 * existing consumer/test is behavior-neutral until a host opts in.
 */

/** What the host process considers its own "vintage" — opaque build id + how long
 *  it has been running. Both best-effort; a host that cannot determine one leaves it
 *  `null` rather than guessing. */
export interface ServerVintage {
  /** Short git sha / build id the running process was started from, or null if unknown. */
  readonly buildId: string | null;
  /** Milliseconds since the process started serving. */
  readonly bootedAgoMs: number;
}

let resolver: (() => ServerVintage | null) | null = null;

/** Register the host's server-vintage resolver (last registration wins). Must be
 *  cheap + synchronous — it runs on the invalid-args failure path, which is already
 *  an error case; a host that needs I/O caches it out-of-band and the resolver only
 *  reads the cache (the same contract `getBuildInfo()` already keeps in Papercusp). */
export function setServerVintageResolver(fn: (() => ServerVintage | null) | null): void {
  resolver = fn;
}

/** Clear the registered resolver — test seam + host teardown. */
export function resetServerVintageResolver(): void {
  resolver = null;
}

/** Read the current server vintage, or null when no host resolver is registered, the
 *  host has none to report, or the resolver throws (NEVER lets a broken resolver fail
 *  the underlying tool-arg validation it is only trying to annotate). */
export function readServerVintage(): ServerVintage | null {
  if (!resolver) return null;
  try {
    return resolver();
  } catch {
    return null;
  }
}

/** Render `ms` as a short human duration ("52min", "4.6h", "3d") — coarse on purpose;
 *  this exists to answer "is this process old enough to be stale", not to be a clock. */
export function formatVintageAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time';
  const min = ms / 60_000;
  if (min < 1) return '<1min';
  if (min < 60) return `${Math.round(min)}min`;
  const hr = min / 60;
  if (hr < 24) return `${hr.toFixed(1)}h`;
  return `${(hr / 24).toFixed(1)}d`;
}

/**
 * The extra sentence appended to an `Unrecognized key` invalid_args error, when a
 * host resolver is registered. Empty string when there is nothing to add (no
 * resolver, or the resolver returned null) — callers concatenate unconditionally.
 */
export function serverVintageHint(): string {
  const vintage = readServerVintage();
  if (!vintage) return '';
  const build = vintage.buildId ?? 'an unknown build';
  const age = formatVintageAge(vintage.bootedAgoMs);
  return (
    ` This server is running build ${build}, started ${age} ago. If this argument was added` +
    ' after that build, the running process has never seen it — restart the app/process to pick up the new code.'
  );
}
