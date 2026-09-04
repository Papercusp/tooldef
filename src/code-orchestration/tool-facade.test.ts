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

  it('also accepts the raw snake_case spelling of ns + verb (the canonical MCP name)', async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const f = buildToolFacade([mkTool('work_items:checkpoint'), mkTool('coord:wake-queue')], dispatch);

    // snake namespace + snake verb — the same string as the MCP name, dotted.
    await f.work_items.checkpoint({ id: 'EI-1' });
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), 'work_items:checkpoint', { id: 'EI-1' });

    // camel spelling still works and routes identically (same fn, same bucket).
    await f.workItems.checkpoint({ id: 'EI-2' });
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), 'work_items:checkpoint', { id: 'EI-2' });
    expect(f.work_items.checkpoint).toBe(f.workItems.checkpoint);

    // hyphenated verb reachable under its raw underscore spelling too.
    await f.coord.wake_queue();
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), 'coord:wake-queue', {});
  });

  it('snake aliases respect the allowed-set whitelist (no bypass)', () => {
    const f = buildToolFacade(
      [mkTool('work_items:list'), mkTool('system:admin')],
      vi.fn(),
      new Set(['work_items:list']),
    );
    // omitted tool has neither spelling
    expect(f.system).toBeUndefined();
    // single-word namespace needs no alias key beyond itself
    expect(typeof f.workItems.list).toBe('function');
    expect(typeof f.work_items.list).toBe('function');
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

/**
 * EI-18683272396981279 — plugin-namespaced (dot-form) tools were absent from the facade.
 *
 * A plugin tool projects its MCP name with a DOT, not a colon (`gitnexus.query`,
 * `firecrawl.scrape` — see `registerPluginTools` in `@papercusp/plugin-loader`, which mounts
 * every plugin tool as `<shortPluginName>.<tool.name>` by default). The facade's colon-only
 * shape check (`name.indexOf(':') <= 0`) silently skipped every such tool — even one already
 * present in the agent's `allowed` envelope — so a batched `code:run` script could not reach
 * gitnexus at all, with no error naming why.
 */
describe('buildToolFacade: plugin-namespaced (dot-form) tool names (EI-18683272396981279)', () => {
  it('exposes a dot-form plugin tool as tools.<ns>.<verb>()', async () => {
    const dispatch = vi.fn(async () => ({ hits: [] }));
    const f = buildToolFacade([mkTool('gitnexus.query')], dispatch);
    await f.gitnexus.query({ pattern: 'foo' });
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), 'gitnexus.query', { pattern: 'foo' });
  });

  it('exposes the call() escape hatch for a dot-form name too', async () => {
    const dispatch = vi.fn(async () => 'ok');
    const f = buildToolFacade([mkTool('gitnexus.query')], dispatch);
    expect(await f.call('gitnexus.query', { pattern: 'bar' })).toBe('ok');
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), 'gitnexus.query', { pattern: 'bar' });
  });

  it('a hyphenated plugin namespace camelCases the same as a colon-form one', async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const f = buildToolFacade([mkTool('fetch-plus.scrape')], dispatch);
    await f.fetchPlus.scrape({ url: 'https://x' });
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), 'fetch-plus.scrape', { url: 'https://x' });
    // raw snake spelling also resolves (same ergonomics as colon-form namespaces)
    await f.fetch_plus.scrape({ url: 'https://y' });
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), 'fetch-plus.scrape', { url: 'https://y' });
  });

  it('respects the allowed-set whitelist for dot-form names (no bypass)', () => {
    const f = buildToolFacade(
      [mkTool('gitnexus.query'), mkTool('firecrawl.scrape')],
      vi.fn(),
      new Set(['gitnexus.query']),
    );
    expect(typeof f.gitnexus.query).toBe('function');
    expect(f.firecrawl).toBeUndefined();
  });

  it('facadeToolNames includes dot-form plugin tool names alongside colon-form ones', () => {
    const tools = [mkTool('plans:list'), mkTool('gitnexus.query'), mkTool('malformed-no-separator')];
    expect(facadeToolNames(tools)).toEqual(['gitnexus.query', 'plans:list']);
  });

  it('a colon-form name is never mis-split on an incidental dot (colon wins)', async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    // Namespace containing a dot would be unusual for a colon-form tool, but the
    // separator choice must stay deterministic: colon wins whenever present.
    const f = buildToolFacade([mkTool('a.b:verb')], dispatch);
    await f.call('a.b:verb', {});
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), 'a.b:verb', {});
    // and the ns bucket is keyed off the colon split, not the dot
    expect(typeof f['a.b']?.verb).toBe('function');
  });
});

describe('roleScopedToolNames (code:run / code:tools facade scoping)', () => {
  const TOOLS = [
    mkRoleTool('plans:list', ['worker', 'operator']),
    mkRoleTool('work_items:get', ['worker', 'operator']),
    mkRoleTool('operator:rate_limit_config', ['operator']), // operator-only
    mkRoleTool('docs:get'), // role-open (no agentRoles)
    mkRoleTool('owner:ui-only', []), // explicit deny-all
    mkRoleTool('code:run', ['worker', 'operator']),
    mkRoleTool('code:tools', ['worker', 'operator']),
  ];

  it("includes only tools the role may call, plus role-open tools", () => {
    const allowed = roleScopedToolNames(TOOLS, 'worker');
    expect(allowed.has('plans:list')).toBe(true);
    expect(allowed.has('work_items:get')).toBe(true);
    expect(allowed.has('docs:get')).toBe(true); // role-open: included for any role
    expect(allowed.has('owner:ui-only')).toBe(false); // empty allowlist: denied for every role
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
    expect(allowed.has('owner:ui-only')).toBe(false); // explicit deny-all
    expect(allowed.has('plans:list')).toBe(false); // role-gated, no role to match
  });
});
