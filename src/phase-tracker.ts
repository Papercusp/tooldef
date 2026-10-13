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
 * UNION of the phase intervals, clipped to the elapsed window: the share of wall time
 * that some named phase covered. A phase still running when the snapshot is taken
 * (a handler that returned on its own deadline while a branch kept working) covered
 * the wall time from its start to the snapshot, so it counts up to that instant;
 * `completedAttributedMs` keeps the completed-only union beside it, and `pending`
 * still names every in-flight phase. Gaps where no phase ran stay unattributed.
 *
 * The dispatcher also records its own pre-handler steps (authority evaluation,
 * capability envelope, ...) as `dispatch:<step>` phases via `addCompleted`, so wall
 * time spent before the handler starts is attributed by name instead of vanishing.
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
  /**
   * Wall time covered by the union of phase intervals, clipped to elapsedMs. A phase
   * still in flight at the snapshot counts from its start up to the snapshot.
   */
  attributedMs: number;
  /** The same union over COMPLETED phases only (in-flight phases excluded). */
  completedAttributedMs: number;
  phases: PhaseInterval[];
  /** Phases still running when the call ended (a timeout or an abandoned branch). */
  pending: Array<{ phase: string; startMs: number; elapsedMs: number }>;
  omittedCompletedCount: number;
}

export interface PhaseTracker {
  track<T>(phase: string, work: () => T | Promise<T>): Promise<T>;
  /**
   * Record a phase that already finished, timed by the caller on this tracker's clock
   * (`startedAt` is an absolute clock reading). Used by the dispatcher, which times its
   * steps itself and records only the ones that took measurable time.
   */
  addCompleted(phase: string, startedAt: number, durationMs: number): void;
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

  const pushCompleted = (phase: string, startedAt: number, durationMs: number): void => {
    completed.push({
      phase,
      startMs: Math.max(0, startedAt - createdAt),
      durationMs: Math.max(0, durationMs),
    });
    if (completed.length > historyCap) {
      completed.shift();
      omittedCompletedCount += 1;
    }
  };

  return {
    async track<T>(phase: string, work: () => T | Promise<T>): Promise<T> {
      const id = ++nextId;
      active.set(id, { phase, startedAt: now() });
      try {
        return await work();
      } finally {
        const started = active.get(id);
        active.delete(id);
        if (started) pushCompleted(phase, started.startedAt, now() - started.startedAt);
      }
    },
    addCompleted(phase: string, startedAt: number, durationMs: number): void {
      pushCompleted(phase, startedAt, durationMs);
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
      const pending = [...active.values()].map(({ phase, startedAt }) => ({
        phase,
        startMs: Math.max(0, startedAt - createdAt),
        elapsedMs: Math.max(0, at - startedAt),
      }));
      const inFlight = pending.map(({ startMs, elapsedMs: ran }) => ({ startMs, durationMs: ran }));
      return {
        schemaVersion: 'handler-phases-v1',
        unit: 'ms',
        timing: 'wall-time-possibly-concurrent',
        elapsedMs,
        attributedMs: unionCoveredMs([...completed, ...inFlight], elapsedMs),
        completedAttributedMs: unionCoveredMs(completed, elapsedMs),
        phases: completed.map((interval) => ({ ...interval })),
        pending,
        omittedCompletedCount,
      };
    },
  };
}

/**
 * Run `work` as the named phase when a tracker is present, or untracked when it is not.
 * Handlers receive `ctx.phases` only through the dispatcher; a direct handler call (a
 * unit test) has none, and the work must still run identically.
 */
export function trackPhase<T>(
  tracker: PhaseTracker | undefined,
  phase: string,
  work: () => T | Promise<T>,
): Promise<T> {
  return tracker ? tracker.track(phase, work) : Promise.resolve().then(work);
}
