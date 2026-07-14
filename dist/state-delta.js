import { computeRowDigest, diffFromDigest, applySemanticDelta, computeViewChecksum } from './delta-protocol';
const keyOf = (c) => c.correlationId;
/**
 * Diff two consecutive per-run snapshots into a delta, or `null` when a delta can't
 * be computed (the card view exceeds the digest cap) — the caller sends a full
 * snapshot in that case.
 */
export function diffSnapshot(prev, next) {
    const digest = computeRowDigest(prev.snapshot.openCards, keyOf);
    if (digest === null)
        return null; // too many cards to digest → caller sends full
    const cards = diffFromDigest(digest, next.snapshot.openCards, keyOf);
    const delta = {
        runId: next.runId,
        baseVersion: prev.version,
        version: next.version,
        cards,
        order: next.snapshot.openCards.map(keyOf),
    };
    if (toolStateChanged(prev.snapshot.toolState, next.snapshot.toolState)) {
        delta.toolState = { value: next.snapshot.toolState };
    }
    return delta;
}
/**
 * Apply a delta to a base snapshot. Returns the new {@link VersionedSnapshot}, or
 * `null` when it cannot be applied (different run, or `baseVersion` !== base.version
 * — a gap; the caller must refetch the full snapshot). Reorders by `delta.order`.
 */
export function applySnapshotDelta(base, delta) {
    if (delta.runId !== base.runId || delta.baseVersion !== base.version)
        return null;
    const merged = applySemanticDelta(base.snapshot.openCards, delta.cards, keyOf);
    const byId = new Map(merged.map((c) => [keyOf(c), c]));
    const openCards = [];
    for (const id of delta.order) {
        const card = byId.get(id);
        if (card)
            openCards.push(card); // defensively skip an id with no payload
    }
    const snapshot = {
        openCards,
        toolState: delta.toolState ? delta.toolState.value : base.snapshot.toolState,
    };
    return { ...base, version: delta.version, snapshot };
}
/** toolState change-detect via the engine's order-insensitive content checksum. */
function toolStateChanged(a, b) {
    return computeViewChecksum([a], () => 't') !== computeViewChecksum([b], () => 't');
}
/**
 * Choose how to emit `next` on a per-run snapshot stream: a `delta` against `prev`
 * for a delta-aware consumer when one can be computed, else the full `snapshot`
 * (the baseline on first emit, a non-delta consumer, an unchanged version, or an
 * undeltable view). Pure — the caller tracks `prev` per run and updates it to
 * `next` after emitting.
 */
export function chooseSnapshotEmission(prev, next, wantsDelta) {
    if (wantsDelta && prev && prev.version !== next.version) {
        const d = diffSnapshot(prev, next);
        if (d)
            return { event: 'delta', data: d };
    }
    return { event: 'snapshot', data: next };
}
