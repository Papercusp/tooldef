/**
 * EI-19953470656367880 — an `Unrecognized key` invalid_args rejection is the exact
 * shape a caller sees when it (or the UI sending on its behalf) is NEWER than the
 * long-lived process it's talking to (chiefly a Tauri desktop's own spawned
 * operator, which has no file-watch and serves whatever code it booted with). This
 * pins the fix at the framework level, through the REAL dispatch path
 * (defineTool → dispatchProjectedTool), not just the pure formatter in
 * server-vintage.test.ts — see the define-tool-legacy-ctx.test.ts precedent for why
 * that distinction matters here (a unit test on the formatter alone would not have
 * caught it not being WIRED into unknownArgHint's call site).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from './define-tool';
import { dispatchProjectedTool, type DispatchProjectedDeps } from './dispatch-projected';
import { _resetProjectionRegistryForTests, lookupByMcpName, type UnifiedToolContext } from './tool-projection';
import { resetServerVintageResolver, setServerVintageResolver } from './server-vintage';

const DEPS: DispatchProjectedDeps = {};

const ctx = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: () => {},
  signal: new AbortController().signal,
  progress: () => {},
  emit: () => {},
  workspaceId: 'default',
  runId: 'r',
  transport: 'mcp',
  principal: { slug: 'system:superuser', workspaceId: 'default', capabilities: new Set(['test:read']) },
  tx: {},
  ...over,
});

async function callWithUnknownKey(toolName: string): Promise<string> {
  // dispatchProjectedTool does NOT throw on a validation failure — dispatch-stack's
  // invoke step catches the handler-thrown InvalidInputError internally and returns
  // a discriminated { ok: false, error } result (dispatch-stack.ts ~L677-679).
  const outcome = await dispatchProjectedTool(
    lookupByMcpName(toolName)!,
    toolName,
    { known: 'x', totallyUnknownArg: 'y' },
    ctx(),
    DEPS,
  );
  if (outcome.ok) throw new Error('expected the call to fail with invalid_input');
  expect(outcome.error?.code).toBe('invalid_input');
  return outcome.error?.message ?? '';
}

afterEach(() => {
  _resetProjectionRegistryForTests();
  resetServerVintageResolver();
});

describe('unknownArgHint + server-vintage wiring', () => {
  it('an unrecognized-key rejection carries NO vintage hint when no resolver is registered', async () => {
    defineTool({
      name: 'test:vintage-hint-none',
      capability: 'test:read',
      description: 'fixture',
      args: z.object({ known: z.string() }),
      async handler() {
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });

    const message = await callWithUnknownKey('test:vintage-hint-none');
    expect(message).toContain('Unrecognized key');
    expect(message.toLowerCase()).not.toContain('restart');
  });

  it('an unrecognized-key rejection appends the build id + age + restart hint when a resolver IS registered', async () => {
    setServerVintageResolver(() => ({ buildId: '7af3a88344', bootedAgoMs: 4.6 * 60 * 60_000 }));
    defineTool({
      name: 'test:vintage-hint-present',
      capability: 'test:read',
      description: 'fixture',
      args: z.object({ known: z.string() }),
      async handler() {
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });

    const message = await callWithUnknownKey('test:vintage-hint-present');
    expect(message).toContain('Unrecognized key');
    expect(message).toContain('7af3a88344');
    expect(message).toContain('4.6h');
    expect(message.toLowerCase()).toContain('restart');
  });

  it('a call that validates cleanly is completely unaffected by a registered resolver', async () => {
    setServerVintageResolver(() => ({ buildId: 'deadbeef', bootedAgoMs: 1_000 }));
    defineTool({
      name: 'test:vintage-hint-clean-call',
      capability: 'test:read',
      description: 'fixture',
      args: z.object({ known: z.string() }),
      async handler(args) {
        return { content: [{ type: 'text', text: JSON.stringify(args) }] };
      },
    });

    const outcome = await dispatchProjectedTool(
      lookupByMcpName('test:vintage-hint-clean-call')!,
      'test:vintage-hint-clean-call',
      { known: 'x' },
      ctx(),
      DEPS,
    );
    expect(outcome.ok).toBe(true);
    expect((outcome.result as { content: { text: string }[] }).content[0]!.text).toBe('{"known":"x"}');
  });

  it('a top-level object type error renders that field shape instead of the oversized full schema', async () => {
    defineTool({
      name: 'test:top-level-object-schema-hint',
      capability: 'test:read',
      description: 'fixture',
      args: z.object({
        why: z.object({
          goalRef: z.string().min(1),
          note: z.string().min(1).optional(),
        }),
        unrelated: z.string().optional().describe('A deliberately verbose sibling field description.'),
      }),
      async handler() {
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });

    const outcome = await dispatchProjectedTool(
      lookupByMcpName('test:top-level-object-schema-hint')!,
      'test:top-level-object-schema-hint',
      { why: 'invalid scalar' },
      ctx(),
      DEPS,
    );
    if (outcome.ok) throw new Error('expected the call to fail with invalid_input');
    const message = outcome.error?.message ?? '';
    expect(outcome.error?.code).toBe('invalid_input');
    expect(message).toContain('why: Invalid input: expected object');
    expect(message).toContain('why` accepts');
    expect(message).toContain('goalRef');
    expect(message).not.toContain('full args schema:');
  });
});
