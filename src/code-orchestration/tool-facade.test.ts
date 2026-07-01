import { describe, it, expect, vi } from 'vitest';
import { buildToolFacade, facadeToolNames, roleScopedToolNames } from './tool-facade';

// Minimal ProjectedTool stand-in — the facade only reads expose.mcp.name.
const mkTool = (name: string) => ({ expose: { mcp: { name } } }) as never;

// Stand-in carrying agentRoles, for the role-scoping helper.
const mkRoleTool = (name: string, agentRoles?: string[]) =>
  ({ expose: { mcp: { name } }, ...(agentRoles ? { agentRoles } : {}) }) as never;

describe('buildToolFacade (B-CX-1A)', () => {
  it('exposes tools.<ns>.<camelVerb>() routed through the injected dispatch', async () => {
    const dispatch = vi.fn(async () => ({ items: [] }));
    const f = buildToolFacade([mkTool('work_items:list'), mkTool('coord:wake-queue')], dispatch);

    await f.workItems.list({ status: 'open' });
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
    expect(typeof f.workItems?.list).toBe('function');
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

describe('roleScopedToolNames (code:run / code:tools facade scoping)', () => {
  const TOOLS = [
    mkRoleTool('plans:list', ['worker', 'operator']),
    mkRoleTool('work_items:get', ['worker', 'operator']),
    mkRoleTool('operator:rate_limit_config', ['operator']), // operator-only
    mkRoleTool('docs:get'), // role-open (no agentRoles)
    mkRoleTool('code:run', ['worker', 'operator']),
    mkRoleTool('code:tools', ['worker', 'operator']),
  ];

  it("includes only tools the role may call, plus role-open tools", () => {
    const allowed = roleScopedToolNames(TOOLS, 'worker');
    expect(allowed.has('plans:list')).toBe(true);
    expect(allowed.has('work_items:get')).toBe(true);
    expect(allowed.has('docs:get')).toBe(true); // role-open: included for any role
    expect(allowed.has('operator:rate_limit_config')).toBe(false); // operator-only: excluded for worker
  });

  it('excludes the code-mode meta-tools so a script cannot recursively nest code-mode', () => {
    // code:run excludes only itself (a script calling code:tools, a read, is harmless);
    // code:tools excludes BOTH so the rendered catalog never surfaces the meta-tools.
    const runScoped = roleScopedToolNames(TOOLS, 'worker', new Set(['code:run']));
    expect(runScoped.has('code:run')).toBe(false);
    expect(runScoped.has('code:tools')).toBe(true);

    const toolsScoped = roleScopedToolNames(TOOLS, 'worker', new Set(['code:run', 'code:tools']));
    expect(toolsScoped.has('code:run')).toBe(false);
    expect(toolsScoped.has('code:tools')).toBe(false);
  });

  it('a role that may call an operator-only tool gets it', () => {
    const allowed = roleScopedToolNames(TOOLS, 'operator', new Set(['code:run']));
    expect(allowed.has('operator:rate_limit_config')).toBe(true);
  });

  it('a null/unknown role still gets role-open tools but no role-gated ones', () => {
    const allowed = roleScopedToolNames(TOOLS, null);
    expect(allowed.has('docs:get')).toBe(true); // role-open
    expect(allowed.has('plans:list')).toBe(false); // role-gated, no role to match
  });
});
