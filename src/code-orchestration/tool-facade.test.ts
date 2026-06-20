import { describe, it, expect, vi } from 'vitest';
import { buildToolFacade, facadeToolNames } from './tool-facade';

// Minimal ProjectedTool stand-in — the facade only reads expose.mcp.name.
const mkTool = (name: string) => ({ expose: { mcp: { name } } }) as never;

describe('buildToolFacade (B-CX-1A)', () => {
  it('exposes tools.<ns>.<camelVerb>() routed through the injected dispatch', async () => {
    const dispatch = vi.fn(async () => ({ items: [] }));
    const f = buildToolFacade([mkTool('work_items:list'), mkTool('coord:wake-queue')], dispatch);

    await f.work_items.list({ status: 'open' });
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), 'work_items:list', { status: 'open' });

    await f.coord.wakeQueue(); // hyphenated verb → camelCase, empty args defaults to {}
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), 'coord:wake-queue', {});
  });

  it('exposes the call() escape hatch keyed by full MCP name', async () => {
    const dispatch = vi.fn(async () => 'ok');
    const f = buildToolFacade([mkTool('plans:set-status')], dispatch);
    expect(await f.call('plans:set-status', { id: 'P-1' })).toBe('ok');
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), 'plans:set-status', { id: 'P-1' });
  });

  it('omits tools outside the allowed set (capability-envelope whitelist is the boundary)', () => {
    const f = buildToolFacade(
      [mkTool('work_items:list'), mkTool('system:admin')],
      vi.fn(),
      new Set(['work_items:list']),
    );
    expect(typeof f.work_items?.list).toBe('function');
    expect(f.system).toBeUndefined();
  });

  it('call() throws for a tool not in the sandbox', async () => {
    const f = buildToolFacade([mkTool('work_items:list')], vi.fn(), new Set(['work_items:list']));
    await expect(f.call('system:admin', {})).rejects.toThrow(/not available/);
  });

  it('facadeToolNames lists the allowed, well-formed tool names sorted', () => {
    const tools = [mkTool('plans:list'), mkTool('work_items:list'), mkTool('malformed-no-colon')];
    expect(facadeToolNames(tools)).toEqual(['plans:list', 'work_items:list']);
    expect(facadeToolNames(tools, new Set(['plans:list']))).toEqual(['plans:list']);
  });
});
