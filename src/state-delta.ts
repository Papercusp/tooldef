/**
 * Per-run snapshot DELTA (agent-tool-delta-protocol-2026-06-22, Lane D / P-009).
 *
 * The state channel re-emits a run's WHOLE {@link StateSnapshot} (every openCard +
 * toolState) on each mutation. For a run with many cards where one changes, that
 * re-ships everything. These pure functions let the transport ship only what moved:
 * cards added/updated (keyed by `correlationId`) + removed ids + the new card order
 * + a toolState replacement when it changed. `baseVersion` pins the version the
 * delta applies ON TOP OF — a consumer that isn't at `baseVersion` cannot apply it
 * and must refetch the full snapshot (the `resync` fallback, P-008).
 *
 * Round-trip invariant (the contract the tests pin):
 *   applySnapshotDelta(prev, diffSnapshot(prev, next)) deep-equals next
 * for any prev/next of the SAME run with next.version > prev.version.
 */
import type { OpenCardSnapshot } from './types';
import type { StateSnapshot, VersionedSnapshot } from './state-channel';

export interface SnapshotDelta {
  runId: string;
  /** The version this delta applies on top of (prev.version). */
  baseVersion: number;
  /** The version this delta produces (next.version). */
  version: number;
  /** Cards added or whose content changed since baseVersion (full payloads). */
  upsertedCards: OpenCardSnapshot[];
  /** correlationIds of cards present at baseVersion but gone in this version. */
  removedCardIds: string[];
  /**
   * The full ordered correlationId list of openCards AFTER this delta. Lets the
   * consumer reproduce exact order (incl. a pure reorder) without re-shipping
   * unchanged cards. Length = the new openCards length.
   */
  order: string[];
  /** Present only when toolState changed; carries the replacement value. */
  toolState?: { value: unknown };
}

const keyOf = (c: OpenCardSnapshot): string => c.correlationId;

/** Diff two consecutive per-run snapshots into a minimal delta. */
export function diffSnapshot(prev: VersionedSnapshot, next: VersionedSnapshot): SnapshotDelta {
  const prevById = new Map(prev.snapshot.openCards.map((c) => [keyOf(c), c]));
  const nextById = new Map(next.snapshot.openCards.map((c) => [keyOf(c), c]));

  const upsertedCards: OpenCardSnapshot[] = [];
  for (const [k, card] of nextById) {
    const before = prevById.get(k);
    if (!before || !deepEqual(before, card)) upsertedCards.push(card);
  }
  const removedCardIds: string[] = [];
  for (const k of prevById.keys()) if (!nextById.has(k)) removedCardIds.push(k);

  const delta: SnapshotDelta = {
    runId: next.runId,
    baseVersion: prev.version,
    version: next.version,
    upsertedCards,
    removedCardIds,
    order: next.snapshot.openCards.map(keyOf),
  };
  if (!deepEqual(prev.snapshot.toolState, next.snapshot.toolState)) {
    delta.toolState = { value: next.snapshot.toolState };
  }
  return delta;
}

/**
 * Apply a delta to a base snapshot. Returns the new {@link VersionedSnapshot}, or
 * `null` when it cannot be applied (different run, or `baseVersion` !== base.version
 * — a gap; the caller must refetch the full snapshot). Reconstructs openCards in
 * `delta.order` so reorders are honoured.
 */
export function applySnapshotDelta(base: VersionedSnapshot, delta: SnapshotDelta): VersionedSnapshot | null {
  if (delta.runId !== base.runId || delta.baseVersion !== base.version) return null;
  const byId = new Map(base.snapshot.openCards.map((c) => [keyOf(c), c]));
  for (const id of delta.removedCardIds) byId.delete(id);
  for (const card of delta.upsertedCards) byId.set(keyOf(card), card);

  const openCards: OpenCardSnapshot[] = [];
  for (const id of delta.order) {
    const card = byId.get(id);
    if (card) openCards.push(card); // defensively skip an id with no payload
  }
  const snapshot: StateSnapshot = {
    openCards,
    toolState: delta.toolState ? delta.toolState.value : base.snapshot.toolState,
  };
  return { ...base, version: delta.version, snapshot };
}

/** Structural deep-equality via stable (sorted-key) stringify — order-insensitive. */
function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
