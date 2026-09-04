/**
 * raw-text-result-shape.test.ts — EI-20066912585022608.
 *
 * A handler that hand-rolls a human-readable TEXT `ToolResult` is invisible to the
 * JSON path in `unwrapToolResult`, so a `code:run` script receives the raw STRING and
 * every `result.<field>` read on it resolves to `undefined` — silently, and
 * indistinguishably from a legitimately empty value. (`capability:bash` is the
 * reported case: two greps that both matched came back as '' and read as "the
 * codebase does not contain this".) The escape hatch such a handler now uses is
 * `structuredContent`, attached only when `ctx.codeMode` says the consumer is a
 * script rather than a model.
 *
 * These tests drive the REAL defineTool → dispatchProjectedTool path rather than
 * calling `unwrapToolResult` on a hand-built object, because the thing that could
 * break this is a serialization hop in between (the P-002 TOON re-encode, payload
 * tiering, the raw-result passthrough) — none of which a unit test of the unwrapper
 * would exercise. Same harness shape as format-integration.test.ts.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../define-tool';
import { dispatchProjectedTool, type DispatchProjectedDeps } from '../dispatch-projected';
import {
  lookupByMcpName,
  _resetProjectionRegistryForTests,
  type UnifiedToolContext,
} from '../tool-projection';
import { unwrapToolResult } from './dispatch-binding';

const DEPS: DispatchProjectedDeps = {};

const ctx = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'w',
  runId: 'r',
  transport: 'mcp',
  ...over,
});

/** A handler in the shape of capability:bash's foreground branch: a rendered header
 *  line plus output, optionally with the machine-readable twin for code-mode. */
function defineTextTool(name: string, opts: { structured?: boolean }): void {
  defineTool({
    name,
    requirePrincipal: false,
    capability: 'test:read',
    args: z.object({}),
    handler: async (_a, c) => ({
      content: [{ type: 'text' as const, text: 'exit 0 · 0.0s · cwd /tmp\nHELLO' }],
      ...(opts.structured && c.codeMode
        ? { structuredContent: { ok: true, exit_code: 0, output: 'HELLO' } }
        : {}),
    }),
  });
}

async function seenByScript(name: string, over: Partial<UnifiedToolContext> = {}) {
  const tool = lookupByMcpName(name)!;
  const r = await dispatchProjectedTool(tool, name, {}, ctx(over), DEPS);
  if (!r.ok) throw new Error(`dispatch failed: ${r.error?.code}`);
  return unwrapToolResult(r.result);
}

afterEach(() => _resetProjectionRegistryForTests());

describe('a hand-rolled TEXT ToolResult, as a code:run script sees it', () => {
  it('reaches the script as a raw STRING when the handler offers nothing structured', async () => {
    defineTextTool('t:plaintext', { structured: false });
    const seen = await seenByScript('t:plaintext', { codeMode: true });

    // This is the DEFECT, pinned deliberately rather than fixed globally: there is
    // nothing in a rendered text body for the unwrapper to key on, so the generic
    // path cannot do better. The fix has to come from the handler.
    expect(typeof seen).toBe('string');
    // …and this is why it is dangerous — the natural access is undefined, not an error.
    expect((seen as unknown as Record<string, unknown>).output).toBeUndefined();
  });

  it('reaches the script as an OBJECT once the handler attaches structuredContent', async () => {
    defineTextTool('t:structured', { structured: true });
    const seen = (await seenByScript('t:structured', { codeMode: true })) as Record<string, unknown>;

    // The contract capability:bash depends on: structuredContent SURVIVES the real
    // dispatch path (it is not stripped, re-encoded, or tier-shaped away) and
    // unwrapToolResult prefers it over the text body.
    expect(typeof seen).toBe('object');
    expect(seen.output).toBe('HELLO');
    expect(seen.exit_code).toBe(0);
  });

  it('still renders the text body for the model — the structured twin is additive', async () => {
    defineTextTool('t:both', { structured: true });
    const tool = lookupByMcpName('t:both')!;
    const r = await dispatchProjectedTool(tool, 't:both', {}, ctx({ codeMode: true }), DEPS);

    // A direct MCP reader must be unaffected: same rendered header + output as before.
    expect((r.result!.content![0] as { text: string }).text).toContain('exit 0');
    expect((r.result!.content![0] as { text: string }).text).toContain('HELLO');
  });

  it('costs a NON-code-mode caller nothing — no duplicated payload on the wire', async () => {
    defineTextTool('t:gated', { structured: true });
    const tool = lookupByMcpName('t:gated')!;
    const r = await dispatchProjectedTool(tool, 't:gated', {}, ctx(), DEPS);

    // The gate is what makes this affordable on a tool called as often as
    // capability:bash: without codeMode the machine-readable twin is never built,
    // so the direct path carries the output exactly once.
    expect(r.result!.structuredContent).toBeUndefined();
  });

  // EI-22044192752243601: capability:read's raw:true / default line-window modes
  // hit this same defect — and the reported case's precise failure was an EMPTY
  // string body (`cur.content ?? cur.text ?? ''` resolved to `''`), which is
  // indistinguishable from "the field legitimately exists and is empty" once
  // laundered through a falsy-leaning check. Drive an empty body through the
  // REAL dispatch pipeline (not a hand-built object) so a serialization/tiering
  // hop that treats '' as "nothing to carry" would be caught here, not just in
  // the direct-handler unit tests.
  it('survives the real dispatch path with an EMPTY body — not a vanished field', async () => {
    defineTool({
      name: 't:empty-body',
      requirePrincipal: false,
      capability: 'test:read',
      args: z.object({}),
      handler: async (_a, c) => ({
        content: [{ type: 'text' as const, text: '' }],
        ...(c.codeMode ? { structuredContent: { ok: true, file_path: '/tmp/x', body: '' } } : {}),
      }),
    });
    const seen = (await seenByScript('t:empty-body', { codeMode: true })) as Record<string, unknown>;

    expect(typeof seen).toBe('object');
    expect(seen.body).toBe('');
    expect(seen.ok).toBe(true);
    // Field names that would collide with the MCP envelope's own `content`/`text`
    // are exactly what let the original bug's `cur.content ?? cur.text ?? ''`
    // silently resolve — `body` must not be shadowed by either.
    expect(seen.content).toBeUndefined();
    expect(seen.text).toBeUndefined();
  });
});
