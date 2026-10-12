/**
 * Per-call handler phase timing.
 *
 * A tool handler wraps each named stage of its work in `tracker.track(name, fn)`.
 * The dispatcher creates one tracker per call, exposes it as `ctx.phases`, and
 * persists the completed intervals into the invocation's telemetry metadata as
 * `handlerPhases` on EVERY call. Before this, phase timing existed only inside
 * coord:orient and was emitted only on its deadline fallback, so a slow call that
 * finished in time left no record of where its time went.
 *
 * Phases may run concurrently (a handler that fans out with Promise.all), so the
 * sum of phase durations can exceed the wall time. `attributedMs` is therefore the
 * UNION of the completed intervals, clipped to the elapsed window: the share of
 * wall time that some named phase covered.
 */

/** One completed phase, as exposed by `snapshot()` (shape kept stable for callers). */
export interface PhaseDuration {
  phase: string;
  durationMs: number;
}

/** One completed phase with its start offset from tracker creation. */
export interface PhaseInterval extends PhaseDuration {
  startMs: number;
}

export interface PhaseSnapshot {
  /** Latest-started phase that is still pending; this is a timing clue, not causal proof. */
  activePhase: string | null;
  activePhases: string[];
  activePhaseElapsedMs: number | null;
  completedDurationsMs: PhaseDuration[];
  omittedCompletedCount: number;
  activePhaseSelection: 'latest-started-pending';
}

/** The persisted record. Absent from the metadata when a call recorded no phase. */
export interface HandlerPhasesMetadata {
  schemaVersion: 'handler-phases-v1';
  unit: 'ms';
  timing: 'wall-time-possibly-concurrent';
  /** Wall time from tracker creation to the snapshot. */
  elapsedMs: number;
  /** Wall time covered by the union of completed phase intervals, clipped to elapsedMs. */
  attributedMs: number;
  phases: PhaseInterval[];
  /** Phases still running when the call ended (a timeout or an abandoned branch). */
  pending: Array<{ phase: string; startMs: number; elapsedMs: number }>;
  omittedCompletedCount: number;
}

export interface PhaseTracker {
  track<T>(phase: string, work: () => T | Promise<T>): Promise<T>;
  snapshot(): PhaseSnapshot;
  /** Completed intervals with start offsets, oldest first. */
  intervals(): PhaseInterval[];
  /** The persisted record, or null when nothing was tracked. */
  toMetadata(): HandlerPhasesMetadata | null;
}

export interface PhaseTrackerOptions {
  /** Completed phases kept before the oldest are dropped (and counted). Default 64. */
  historyCap?: number;
  /** Clock in ms. Defaults to Date.now so fake timers drive it in tests. */
  now?: () => number;
}

/** Length of the union of [start, end] intervals clipped to [0, limit]. */
export function unionCoveredMs(intervals: ReadonlyArray<{ startMs: number; durationMs: number }>, limit: number): number {
  const spans = intervals
    .map(({ startMs, durationMs }) => [Math.max(0, startMs), Math.min(limit, startMs + durationMs)] as const)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let cursor = -Infinity;
  for (const [start, end] of spans) {
    if (end <= cursor) continue;
    covered += end - Math.max(start, cursor);
    cursor = end;
  }
  return covered;
}

export function createPhaseTracker(options: PhaseTrackerOptions = {}): PhaseTracker {
  const historyCap = options.historyCap ?? 64;
  const now = options.now ?? Date.now;
  const createdAt = now();
  let nextId = 0;
  let omittedCompletedCount = 0;
  const active = new Map<number, { phase: string; startedAt: number }>();
  const completed: PhaseInterval[] = [];

  return {
    async track<T>(phase: string, work: () => T | Promise<T>): Promise<T> {
      const id = ++nextId;
      active.set(id, { phase, startedAt: now() });
      try {
        return await work();
      } finally {
        const started = active.get(id);
        active.delete(id);
        if (started) {
          completed.push({
            phase,
            startMs: Math.max(0, started.startedAt - createdAt),
            durationMs: Math.max(0, now() - started.startedAt),
          });
          if (completed.length > historyCap) {
            completed.shift();
            omittedCompletedCount += 1;
          }
        }
      }
    },
    snapshot(): PhaseSnapshot {
      const pending = [...active.values()];
      const current = pending[pending.length - 1];
      return {
        activePhase: current?.phase ?? null,
        activePhases: pending.slice(-historyCap).map(({ phase }) => phase),
        activePhaseElapsedMs: current ? Math.max(0, now() - current.startedAt) : null,
        completedDurationsMs: completed.map(({ phase, durationMs }) => ({ phase, durationMs })),
        omittedCompletedCount,
        activePhaseSelection: 'latest-started-pending',
      };
    },
    intervals(): PhaseInterval[] {
      return completed.map((interval) => ({ ...interval }));
    },
    toMetadata(): HandlerPhasesMetadata | null {
      if (completed.length === 0 && active.size === 0 && omittedCompletedCount === 0) return null;
      const at = now();
      const elapsedMs = Math.max(0, at - createdAt);
      return {
        schemaVersion: 'handler-phases-v1',
        unit: 'ms',
        timing: 'wall-time-possibly-concurrent',
        elapsedMs,
        attributedMs: unionCoveredMs(completed, elapsedMs),
        phases: completed.map((interval) => ({ ...interval })),
        pending: [...active.values()].map(({ phase, startedAt }) => ({
          phase,
          startMs: Math.max(0, startedAt - createdAt),
          elapsedMs: Math.max(0, at - startedAt),
        })),
        omittedCompletedCount,
      };
    },
  };
}
