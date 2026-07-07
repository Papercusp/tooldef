"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.negotiateRowsDelta = negotiateRowsDelta;
/**
 * rows-delta — server-side delta negotiation for a BARE ROW ARRAY (a sync RESOURCE),
 * the resolver/SSE-path sibling of define-tool's `negotiateToolDelta`. Where the tool
 * path negotiates over a ToolResponse, a sync resolver (e.g. `plans.attention`) returns
 * a plain rows array; this composes the SAME delta primitives (computeRowDigest +
 * computeViewChecksum + diffFromDigest + the cursor codec) to turn "client cursor + the
 * freshly-resolved rows" into a `full` or `delta` response.
 *
 * agent-tool-delta-client-rollout-2026-06-23 P-006 (the 327GB sync win): the UI re-fetches
 * the full ~633KB plans.attention view on every plans-table invalidation. With a delta-aware
 * client (useSyncResource sending its cursor) only the changed rows travel. Correctness is the
 * SAME structural guarantee as the tool path: the response carries the full-view `checksum`, the
 * client verifies its merge against it and refetches a full on any mismatch — never a wrong view.
 */
const delta_protocol_1 = require("./delta-protocol");
/**
 * Negotiate a `full` vs `delta` response for a resolved rows array. Pure: same inputs →
 * same output. A cold call (no cursor), a cursor for a different schema, or a cursor with
 * no row digest all degrade to `full` (+ a fresh cursor). A cursor whose checksum already
 * matches the current view yields an empty `delta` (nothing changed). Otherwise it diffs the
 * current rows against the cursor's base digest.
 */
function negotiateRowsDelta(input) {
    const { cursor, rows, itemKey, itemKeyField, schemaVersion } = input;
    const checksum = (0, delta_protocol_1.computeViewChecksum)(rows, itemKey);
    const digest = (0, delta_protocol_1.computeRowDigest)(rows, itemKey);
    const freshCursor = (0, delta_protocol_1.encodeDeltaCursor)({
        v: 1,
        fp: '',
        rev: checksum,
        ...(schemaVersion ? { sv: schemaVersion } : {}),
        ...(digest ? { dg: digest } : {}),
    });
    const full = () => ({ mode: 'full', rows, checksum, cursor: freshCursor, itemKeyField });
    if (!cursor)
        return full();
    const decoded = (0, delta_protocol_1.decodeDeltaCursor)(cursor);
    // Malformed, a schema bump, or a cursor without a row digest → can't diff → full.
    if (!decoded || (decoded.sv ?? '') !== (schemaVersion ?? '') || !decoded.dg)
        return full();
    // Unchanged view → an empty delta (the client keeps its base; the whole point).
    if (decoded.rev === checksum) {
        return { mode: 'delta', changes: [], checksum, cursor: freshCursor, itemKeyField };
    }
    const changes = (0, delta_protocol_1.diffFromDigest)(decoded.dg, rows, itemKey);
    return { mode: 'delta', changes, checksum, cursor: freshCursor, itemKeyField };
}
