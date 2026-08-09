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
import { InvalidInputError } from './dispatch-projected';
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
  try {
    await dispatchProjectedTool(
      lookupByMcpName(toolName)!,
      toolName,
      { known: 'x', totallyUnknownArg: 'y' },
      ctx(),
      DEPS,
    );
    throw new Error('expected the call to reject');
  } catch (err) {
    if (err instanceof InvalidInputError) return err.message;
    throw err;
  }
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

    const result = await dispatchProjectedTool(
      lookupByMcpName('test:vintage-hint-clean-call')!,
      'test:vintage-hint-clean-call',
      { known: 'x' },
      ctx(),
      DEPS,
    );
    expect((result as { content: { text: string }[] }).content[0]!.text).toBe('{"known":"x"}');
  });
});
