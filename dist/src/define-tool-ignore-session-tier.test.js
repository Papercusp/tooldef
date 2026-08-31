/**
 * WI-37843: `ignoreSessionPayloadTier` — a tool declaring that routine
 * per-session tier shaping does not apply to it.
 *
 * WHY THIS FILE EXISTS AT THE DISPATCH LEVEL RATHER THAN THE UNIT LEVEL.
 * `payload-tier.test.ts` already pins `resolvePayloadTier`, and
 * `orient-core-result-door-priority.test.ts` already pins that coord:orient
 * DECLARES the field. Neither proves the thing that actually matters: that
 * dispatch READS the declaration. That precise gap has bitten this codebase
 * before — `skipResultDoor` spent time fully typed and threaded onto
 * ProjectedTool while the one call site ignored it (EI-19389430626961976), and
 * every declaration-level test stayed green throughout. define-tool.ts carries
 * its own warning to the same effect: a handler-level test proves only that the
 * handler READS a ctx field, never that dispatch DELIVERS it.
 *
 * So these drive the REAL path (defineTool → dispatchProjectedTool → wrapper →
 * applyPayloadTier), and cover BOTH wrapper paths — principal-gated (legacy)
 * and role-gated — because the field is threaded at four separate projection
 * sites and a miss at any one of them is invisible from the other.
 *
 * The fixture payload stays comfortably UNDER PAYLOAD_TIER_HARD_CEILING_CHARS
 * on purpose: this file is about step 1 (tier shaping) only. Letting the
 * payload cross the ceiling would let step 2's force-shape mask a step-1
 * regression, and the test would keep passing for the wrong reason.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from './define-tool';
import { dispatchProjectedTool } from './dispatch-projected';
import { _resetProjectionRegistryForTests, lookupByMcpName } from './tool-projection';
const DEPS = {};
const ctx = (over = {}) => ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    emit: vi.fn(),
    workspaceId: 'default',
    runId: 'r',
    transport: 'mcp',
    principal: { slug: 'system:superuser', workspaceId: 'default', capabilities: new Set(['test:read']) },
    tx: {},
    ...over,
});
const ROW_COUNT = 12;
const SHAPED_MARK = 'SHAPED-BY-TIER';
const rows = () => ({
    rows: Array.from({ length: ROW_COUNT }, (_, i) => ({ key: `row-${i}`, detail: 'd'.repeat(40) })),
});
/** The trimmed shaper drops all but two rows and stamps a marker, so "was this
 *  shaped?" is answerable from the emitted bytes in both directions. */
const shape = {
    trimmed: (d) => ({ rows: d.rows.slice(0, 2), tierMark: SHAPED_MARK }),
    standard: (d) => ({ rows: d.rows.slice(0, 6), tierMark: SHAPED_MARK }),
};
/** Results are format-negotiated on the MCP transport (TOON when it shrinks the
 *  shape), so JSON.parse is not a valid reader — count row keys in the bytes. */
const readBack = (res) => {
    const envelope = res;
    const content = (envelope.result ?? res).content;
    const text = content?.map((c) => c.text ?? '').join('\n') ?? '';
    return {
        visibleRows: (text.match(/\brow-\d+/g) ?? []).length,
        shaped: text.includes(SHAPED_MARK),
    };
};
afterEach(() => _resetProjectionRegistryForTests());
for (const wrapper of ['principal-gated (legacy)', 'role-gated']) {
    const define = (name, ignoreSessionPayloadTier) => defineTool({
        name,
        capability: 'test:read',
        description: 'fixture',
        ...(wrapper === 'role-gated' ? { requirePrincipal: false } : {}),
        args: z.object({}),
        shape,
        ...(ignoreSessionPayloadTier ? { ignoreSessionPayloadTier: true } : {}),
        async handler() {
            return { data: rows() };
        },
    });
    const call = async (name, over = {}, args = {}) => readBack(await dispatchProjectedTool(lookupByMcpName(name), name, args, ctx(over), DEPS));
    describe(`ignoreSessionPayloadTier through the ${wrapper} wrapper (WI-37843)`, () => {
        const slug = wrapper === 'role-gated' ? 'role' : 'legacy';
        // The FALSIFIER for every assertion below. Without it, a broken opt-out and
        // a tool that was never shaped in the first place look identical.
        it('WITHOUT the declaration a trimmed session IS shaped (the measured coord:orient defect)', async () => {
            define(`test:ist-${slug}-off`);
            const data = await call(`test:ist-${slug}-off`, { contextTier: 'trimmed' });
            expect(data.shaped).toBe(true);
            expect(data.visibleRows).toBeLessThan(ROW_COUNT);
        });
        it('WITH the declaration the same trimmed session gets the FULL payload', async () => {
            define(`test:ist-${slug}-on`, true);
            const data = await call(`test:ist-${slug}-on`, { contextTier: 'trimmed' });
            expect(data.shaped).toBe(false);
            expect(data.visibleRows).toBe(ROW_COUNT);
        });
        // The narrowness that makes this safe: the caller keeps control. Only the
        // ambient session tier — which the caller never chose — is discarded.
        it('an EXPLICIT per-call payloadTier still shapes, even with the declaration', async () => {
            define(`test:ist-${slug}-explicit`, true);
            const data = await call(`test:ist-${slug}-explicit`, { contextTier: 'trimmed' }, { payloadTier: 'trimmed' });
            expect(data.shaped).toBe(true);
            expect(data.visibleRows).toBeLessThan(ROW_COUNT);
        });
        it('is inert for a session that had no tier anyway — full stays full', async () => {
            define(`test:ist-${slug}-notier`, true);
            const data = await call(`test:ist-${slug}-notier`);
            expect(data.shaped).toBe(false);
            expect(data.visibleRows).toBe(ROW_COUNT);
        });
    });
}
