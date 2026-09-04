/**
 * Tests for the projected-tool registry.
 * Run with: npx vitest run packages/agent-mcp/src/tool-projection.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  registerProjectedTool,
  unregisterProjectedToolsForPlugin,
  lookupByMcpName,
  resolveMcpName,
  normalizeMcpName,
  lookupByHttpPath,
  listAllProjectedTools,
  listMcpProjections,
  PROJECTED_TOOL_REGISTRY_SOURCE,
  projectedToolRegistryRevision,
  projectedToolAdmitted,
  projectedToolCallContract,
  assertProjectedToolCallContract,
  renderProjectedToolCall,
  projectedToolCorrectiveCalls,
  assertProjectedToolGuidanceConformance,
  ProjectedToolContractError,
  classifyEventWire,
  ToolRegistrationError,
  _resetProjectionRegistryForTests,
  type ProjectedTool,
  type UnifiedToolContext,
} from './tool-projection';

const noop: ProjectedTool['fn'] = async () => ({
  content: [{ type: 'text', text: 'ok' }],
});

const baseTool = (over: Partial<ProjectedTool> = {}): ProjectedTool => ({
  pluginName: 'fixture',
  description: 'test tool',
  inputSchema: { type: 'object' },
  capabilities: [],
  expose: { mcp: { name: 'fix.tool' } },
  fn: noop,
  ...over,
});

afterEach(() => _resetProjectionRegistryForTests());

describe('empty agent role allowlists', () => {
  it('treats an empty allowlist as deny-all in listings and contract availability', () => {
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 'owner:ui-only' } },
      agentRoles: [],
    }));
    expect(listMcpProjections('operator').map((tool) => tool.name)).not.toContain('owner:ui-only');
    expect(projectedToolAdmitted('owner:ui-only', { role: 'operator' })).toBe(false);
    expect(() => projectedToolCallContract('owner:ui-only', { role: 'operator' }))
      .toThrow(/role operator is not admitted/);
  });
});

describe('UnifiedToolContext principal provenance', () => {
  it('accepts the canonical metadata carried by transport adapters', () => {
    const principal: NonNullable<UnifiedToolContext['principal']> = {
      kind: 'harness',
      slug: 'system:worker',
      workspaceId: 'ws',
      authMethod: 'spawn-url',
      trust: 'trusted',
      capabilities: new Set(),
    };
    expect(principal).toMatchObject({
      kind: 'harness',
      authMethod: 'spawn-url',
      trust: 'trusted',
    });
  });
});

describe('normalizeMcpName (WI-3930)', () => {
  it('collapses the colon, underscore, and fully-mangled forms to ONE key', () => {
    const canonical = normalizeMcpName('curation:state-of-pot');
    expect(normalizeMcpName('curation_state-of-pot')).toBe(canonical);
    expect(normalizeMcpName('mcp__papercusp-su__curation_state-of-pot')).toBe(canonical);
    expect(normalizeMcpName('CURATION:STATE-OF-POT')).toBe(canonical); // case-insensitive
  });

  it('strips only the mcp__<server>__ wrapper, not a real leading segment', () => {
    expect(normalizeMcpName('mcp__papercusp-su__rubrics_list')).toBe('rubrics:list');
    expect(normalizeMcpName('rubrics:list')).toBe('rubrics:list');
  });

  it('leaves a distinct name distinct (no false collision)', () => {
    expect(normalizeMcpName('rubrics:list')).not.toBe(normalizeMcpName('rubrics:get'));
  });
});

describe('resolveMcpName (WI-3930 — tolerant tool-name resolution)', () => {
  // The registered name is canonical colon form; agents commonly paste the
  // underscore/group_verb or fully client-mangled form they see advertised.
  const register = () =>
    registerProjectedTool(baseTool({ expose: { mcp: { name: 'curation:state-of-pot' } } }));

  it('resolves the exact canonical (colon) name — the unchanged fast path', () => {
    register();
    expect(resolveMcpName('curation:state-of-pot')).toBeDefined();
  });

  it('resolves the underscore / group_verb form', () => {
    register();
    expect(resolveMcpName('curation_state-of-pot')).toBeDefined();
  });

  it('resolves the fully client-mangled mcp__server__ form', () => {
    register();
    expect(resolveMcpName('mcp__papercusp-su__curation_state-of-pot')).toBeDefined();
  });

  it('returns undefined for a genuine typo (no fabricated match)', () => {
    register();
    expect(resolveMcpName('curatoin:state-of-pot')).toBeUndefined();
    expect(resolveMcpName('curation:completely-different')).toBeUndefined();
  });

  it('refuses to guess when the normalized form is AMBIGUOUS (two tools collide)', () => {
    // Two DISTINCT registered names that fold to the same normalized key.
    registerProjectedTool(baseTool({ pluginName: 'p1', expose: { mcp: { name: 'x:a-b' } } }));
    registerProjectedTool(baseTool({ pluginName: 'p2', expose: { mcp: { name: 'x:a_b' } } }));
    // Exact still works for each…
    expect(resolveMcpName('x:a-b')).toBeDefined();
    expect(resolveMcpName('x:a_b')).toBeDefined();
    // …but a form that isn't either exact name and folds to both → no guess.
    expect(resolveMcpName('mcp__srv__x_a_b')).toBeUndefined();
  });
});

describe('registerProjectedTool', () => {
  it('registers a tool with both http + mcp exposure', () => {
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 'fix.both' }, http: { path: '/api/plugins/fix/both' } },
    }));
    expect(lookupByMcpName('fix.both')).toBeDefined();
    expect(lookupByHttpPath('/api/plugins/fix/both')).toBeDefined();
  });

  it('registers an mcp-only tool', () => {
    registerProjectedTool(baseTool({ expose: { mcp: { name: 'fix.only_mcp' } } }));
    expect(lookupByMcpName('fix.only_mcp')).toBeDefined();
    expect(lookupByHttpPath('/api/plugins/fix/only_mcp')).toBeUndefined();
  });

  it('registers an http-only tool (invisible to agents)', () => {
    registerProjectedTool(baseTool({ expose: { http: { path: '/api/plugins/fix/admin' } } }));
    expect(lookupByMcpName('fix.admin')).toBeUndefined();
    expect(lookupByHttpPath('/api/plugins/fix/admin')).toBeDefined();
  });

  it('rejects a tool with no exposure', () => {
    expect(() => registerProjectedTool(baseTool({ expose: {} }))).toThrow(ToolRegistrationError);
  });

  it('rejects framework-only event names at register time (Phase 4 T2.3)', async () => {
    // RESERVED_EVENT_NAMES is the runtime backstop for plugins that
    // bypass the TS-level UserEvents<T> guard via JSON manifests.
    // Only the FRAMEWORK-AUTO-EMITTED names are reserved:
    //   - done: dispatcher emits at successful completion
    //   - heartbeat: transport ping
    //   - result: MCP-shaped envelope
    //   - chunk: framework-emitted for largeOutput tools
    // `progress` and `error` are intentionally NOT reserved — tools
    // declare schemas for them (e.g. dev:ipc_echo declares progress).
    const { z } = await import('zod');
    for (const reserved of ['done', 'heartbeat', 'result', 'chunk']) {
      _resetProjectionRegistryForTests();
      const events = { [reserved]: z.object({}) };
      expect(() => registerProjectedTool(baseTool({
        expose: { mcp: { name: `fix.reserved-${reserved}` } },
        events: events as never,
      }))).toThrow(/reserved event name/);
    }
  });

  it('accepts non-reserved event names (progress + error are user-emittable)', async () => {
    // Locks in the D2 / D3 carve-outs: tools can declare progress
    // (alias of ctx.progress sugar) and error (D3 dual-mode) without
    // tripping the reserved-name check.
    const { z } = await import('zod');
    for (const name of ['progress', 'error', 'delta', 'tool_call']) {
      _resetProjectionRegistryForTests();
      const events = { [name]: z.object({}) };
      expect(() => registerProjectedTool(baseTool({
        expose: { mcp: { name: `fix.allowed-${name}` } },
        events: events as never,
      }))).not.toThrow();
    }
  });

  it('chunk-reservation error message points at largeOutput', async () => {
    const { z } = await import('zod');
    expect(() => registerProjectedTool(baseTool({
      expose: { mcp: { name: 'fix.chunk-reserved' } },
      events: { chunk: z.object({ ref: z.string() }) } as never,
    }))).toThrow(/largeOutput/);
  });

  it('rejects a name without a namespace separator', () => {
    expect(() => registerProjectedTool(baseTool({ expose: { mcp: { name: 'noprefix' } } }))).toThrow(/namespace separator/);
  });

  it('accepts colon-separated names (legacy built-in convention)', () => {
    registerProjectedTool(baseTool({ expose: { mcp: { name: 'tasks:list' } } }));
    expect(lookupByMcpName('tasks:list')).toBeDefined();
  });

  it('rejects a non-absolute HTTP path', () => {
    expect(() => registerProjectedTool(baseTool({ expose: { http: { path: 'no/leading/slash' } } }))).toThrow(/must start with/);
  });

  it('rejects duplicate MCP names across plugins', () => {
    registerProjectedTool(baseTool({ pluginName: 'a', expose: { mcp: { name: 'dup.tool' } } }));
    expect(() => registerProjectedTool(baseTool({ pluginName: 'b', expose: { mcp: { name: 'dup.tool' } } }))).toThrow(/claimed by plugins "a" and "b"/);
  });

  it('rejects duplicate HTTP paths across plugins', () => {
    registerProjectedTool(baseTool({
      pluginName: 'a',
      expose: { mcp: { name: 'a.x' }, http: { path: '/api/dup' } },
    }));
    expect(() => registerProjectedTool(baseTool({
      pluginName: 'b',
      expose: { mcp: { name: 'b.x' }, http: { path: '/api/dup' } },
    }))).toThrow(/HTTP path "\/api\/dup" claimed by plugins "a" and "b"/);
  });

  // EI-14: two STRUCTURALLY-DIFFERENT tools sharing an MCP name WITHIN one
  // plugin namespace (every built-in shares pluginName 'agent-mcp') used to
  // slip past the cross-plugin guard — the later import silently replaced the
  // earlier tool with no signal. This is how the bare `coord:ask` shadowed the
  // knowledge-first `coord:ask` in prod. It must now fail loud.
  it('rejects same-name different-tool collisions within one plugin (EI-14)', () => {
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 'coord:ask' } },
      description: 'Knowledge-first: search existing knowledge, then open a question.',
    }));
    expect(() => registerProjectedTool(baseTool({
      expose: { mcp: { name: 'coord:ask' } },
      description: 'Ask the human owner directly and wait a bounded time.',
    }))).toThrow(/silently shadows the first/);
  });

  it('allows a structurally-identical re-registration (HMR / double-import)', () => {
    const def = (): ProjectedTool => baseTool({
      expose: { mcp: { name: 'fix.reimport' } },
      description: 'same tool, re-evaluated',
      inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
    });
    registerProjectedTool(def());
    // A fresh-but-identical object (what a module re-eval produces) replaces silently.
    expect(() => registerProjectedTool(def())).not.toThrow();
    expect(lookupByMcpName('fix.reimport')).toBeDefined();
  });

  it('rejects same-path different-tool collisions within one plugin (EI-14)', () => {
    registerProjectedTool(baseTool({
      expose: { http: { path: '/api/agent-tools/coord/ask' } },
      description: 'knowledge-first',
    }));
    expect(() => registerProjectedTool(baseTool({
      expose: { http: { path: '/api/agent-tools/coord/ask' } },
      description: 'ask-owner',
    }))).toThrow(/silently shadows the first/);
  });
});

describe('listAllProjectedTools', () => {
  it('returns all registered tools regardless of exposure shape', () => {
    registerProjectedTool(baseTool({ expose: { mcp: { name: 'a.one' } } }));
    registerProjectedTool(baseTool({ expose: { http: { path: '/api/b' } } }));
    registerProjectedTool(baseTool({ expose: { mcp: { name: 'c.three' }, http: { path: '/api/c' } } }));
    expect(listAllProjectedTools()).toHaveLength(3);
  });
});

describe('listMcpProjections', () => {
  it('returns only tools with expose.mcp', () => {
    registerProjectedTool(baseTool({ expose: { mcp: { name: 'mcp.one' } } }));
    registerProjectedTool(baseTool({ expose: { http: { path: '/api/http-only' } } }));
    expect(listMcpProjections().map((t) => t.name)).toEqual(['mcp.one']);
  });

  it('filters by role allowlist when provided', () => {
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 'a.worker' } }, agentRoles: ['worker'],
    }));
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 'b.architect' } }, agentRoles: ['architect'],
    }));
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 'c.any' } }, // no roles -> visible to everyone
    }));
    const workerView = listMcpProjections('worker').map((t) => t.name).sort();
    expect(workerView).toEqual(['a.worker', 'c.any']);
  });

  it('exposes the executable contract plus shared registry provenance when events is absent', () => {
    registerProjectedTool(baseTool({
      description: 'desc x',
      inputSchema: { type: 'object', properties: { foo: { type: 'string' } } },
      capabilities: ['secrets:read:X'],
      expose: { mcp: { name: 'x.tool' } },
    }));
    const list = listMcpProjections();
    expect(list[0]).toEqual({
      name: 'x.tool',
      description: 'desc x',
      inputSchema: { type: 'object', properties: { foo: { type: 'string' } } },
      _meta: {
        'papercusp/toolRegistryRevision': projectedToolRegistryRevision(),
        'papercusp/toolRegistrySource': 'projected-tool-registry',
      },
    });
    // capabilities, roles, etc. NOT exposed in listing — agents see only the contract.
    expect((list[0] as unknown as Record<string, unknown>).capabilities).toBeUndefined();
    expect((list[0] as unknown as Record<string, unknown>).events).toBeUndefined();
  });

  it('uses one order-independent revision and changes with every agent-facing contract surface', () => {
    const a = baseTool({
      expose: { mcp: { name: 'rev:a' } },
      inputSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      outputJsonSchema: { type: 'object', properties: { result: { type: 'string' } } },
      guidance: { when: 'Use rev:a for text.', returns: '{ result }' },
    });
    const b = baseTool({ expose: { mcp: { name: 'rev:b' } } });
    expect(projectedToolRegistryRevision([a, b])).toBe(projectedToolRegistryRevision([b, a]));
    for (const changed of [
      { ...a, description: 'changed description' },
      { ...a, inputSchema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] } },
      { ...a, outputJsonSchema: { type: 'object', properties: { result: { type: 'number' } } } },
      { ...a, guidance: { ...a.guidance, when: 'Use rev:a for voice.' } },
      { ...a, guidance: { ...a.guidance, returns: '{ stale_result }' } },
      { ...a, guidance: { ...a.guidance, seeAlso: ['rev:b'] } },
    ]) {
      expect(projectedToolRegistryRevision([a, b])).not.toBe(projectedToolRegistryRevision([changed, b]));
    }
  });

  it('surfaces events schemas as JSON-Schema when the tool declares them', () => {
    registerProjectedTool(baseTool({
      description: 'streamy tool',
      expose: { mcp: { name: 's.tool' } },
      events: {
        delta: z.object({ text: z.string() }),
        cost: z.object({ usd: z.number() }),
      },
    }));
    const list = listMcpProjections();
    expect(list[0]?.events).toBeDefined();
    expect(Object.keys(list[0]!.events!).sort()).toEqual(['cost', 'delta']);
    // JSON-Schema shape — each event has type:object + properties.
    expect(list[0]!.events!.delta).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
    });
    expect(list[0]!.events!.cost).toMatchObject({
      type: 'object',
      properties: { usd: { type: 'number' } },
    });
    // $schema is stripped — clients don't need the metadata.
    expect((list[0]!.events!.delta as Record<string, unknown>).$schema).toBeUndefined();
  });

  it('serializes z.instanceof(Uint8Array) without throwing (binary placeholder)', () => {
    // Regression: z.toJSONSchema throws "Custom types cannot be represented
    // in JSON Schema" on z.instanceof(Uint8Array). Before the catch+fallback
    // landed, listMcpProjections() would 500 the entire tools/list response
    // when any tool declared a binary event — and dev:ipc_echo does by
    // default. Now we emit a placeholder so clients still get the listing.
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 's.bin' } },
      events: {
        delta: z.object({ text: z.string() }),
        bin: z.instanceof(Uint8Array),
      },
    }));
    const list = listMcpProjections();
    expect(list[0]?.events?.bin).toMatchObject({
      type: 'string',
      contentEncoding: 'base64',
    });
    // Non-binary events serialize normally alongside.
    expect(list[0]?.events?.delta).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
    });
  });

  it('falls back to placeholder for any unrepresentable event schema', () => {
    // Defensive: a custom Zod check that toJSONSchema rejects must not
    // 500 tools/list — the tool stays usable; only its typed JSON-Schema
    // view is degraded.
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 's.custom' } },
      events: {
        weird: z.custom<unknown>(() => true),
      },
    }));
    const list = listMcpProjections();
    expect(list[0]?.events?.weird).toBeDefined();
    // Either binary (if classified as such by the heuristic) or the
    // generic "not representable" placeholder. Both are acceptable;
    // what matters is no throw.
    expect(typeof list[0]?.events?.weird).toBe('object');
  });

  it('omits events field when declared schema is empty', () => {
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 's.empty' } },
      events: {}, // declared but empty
    }));
    const list = listMcpProjections();
    expect(list[0]?.events).toBeUndefined();
  });

  it('round-trips .describe() through to events JSON-Schema (content-type hint)', () => {
    // Tools can annotate an event payload's content-type (or any other
    // hint) via z.string().describe('...') / z.object({...}).describe('...').
    // Surfaced in tools/list as the JSON-Schema `description` field —
    // clients pick parsers / renderers off it.
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 's.described' } },
      events: {
        diff_patch: z.string().describe('application/xml'),
        log_line:   z.string().describe('text/plain'),
        pct_update: z.object({ pct: z.number() }).describe('Progress payload'),
      },
    }));
    const list = listMcpProjections();
    expect(list[0]?.events?.diff_patch).toMatchObject({
      type: 'string',
      description: 'application/xml',
    });
    expect(list[0]?.events?.log_line).toMatchObject({
      type: 'string',
      description: 'text/plain',
    });
    expect(list[0]?.events?.pct_update).toMatchObject({
      type: 'object',
      description: 'Progress payload',
    });
  });

  // P-010 / P-011 / P-012 — profile gate
  describe('profile gating', () => {
    it('P-010: power profile hides engineer-tagged tools', () => {
      registerProjectedTool(baseTool({ expose: { mcp: { name: 'group.a' } }, profile: 'engineer' }));
      registerProjectedTool(baseTool({ expose: { mcp: { name: 'group.b' } } }));
      registerProjectedTool(baseTool({ expose: { mcp: { name: 'group.c' } }, profile: 'all' }));
      const names = listMcpProjections(undefined, 'power').map((t) => t.name);
      expect(names).not.toContain('group.a');
      expect(names).toContain('group.b');
      expect(names).toContain('group.c');
    });

    it('P-011: SU caller with ?profile=power sees same filtered list', () => {
      registerProjectedTool(baseTool({ expose: { mcp: { name: 'su.eng' } }, profile: 'engineer' }));
      registerProjectedTool(baseTool({ expose: { mcp: { name: 'su.all' } } }));
      const names = listMcpProjections(undefined, 'power').map((t) => t.name);
      expect(names).not.toContain('su.eng');
      expect(names).toContain('su.all');
    });

    it('P-012: engineer profile sees all tools (no regression)', () => {
      registerProjectedTool(baseTool({ expose: { mcp: { name: 'eng.a' } }, profile: 'engineer' }));
      registerProjectedTool(baseTool({ expose: { mcp: { name: 'eng.b' } } }));
      const names = listMcpProjections(undefined, 'engineer').map((t) => t.name);
      expect(names).toContain('eng.a');
      expect(names).toContain('eng.b');
    });

  });
});

describe('registry-derived executable tool contracts (P-002)', () => {
  it('returns the accepted call schema, registered result schema, aliases, and registry provenance', () => {
    const inputSchema = {
      type: 'object',
      properties: { current_plan_slug: { type: 'string' } },
      required: ['current_plan_slug'],
      additionalProperties: false,
    };
    const outputJsonSchema = {
      type: 'object',
      properties: { accepted: { type: 'boolean' } },
      required: ['accepted'],
    };
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 'coord:declare-intent' } },
      description: 'Declare a coordination intent.',
      inputSchema,
      outputJsonSchema,
      guidance: {
        returns: '{ stale_authored_shape }',
        argRedirects: { planSlug: 'current_plan_slug' },
      },
    }));

    expect(projectedToolCallContract('coord:declare-intent')).toEqual({
      source: PROJECTED_TOOL_REGISTRY_SOURCE,
      revision: projectedToolRegistryRevision(),
      name: 'coord:declare-intent',
      description: 'Declare a coordination intent.',
      inputSchema,
      returns: { source: 'registered-output-schema', outputJsonSchema },
      aliases: {
        planSlug: { target: 'current_plan_slug', provenance: 'authored-tool-guidance' },
      },
    });
  });

  it('uses authored return guidance only when no registered output schema exists', () => {
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 'legacy:result' } },
      guidance: { returns: '  { legacy, rows:[...] }  ' },
    }));
    registerProjectedTool(baseTool({ expose: { mcp: { name: 'runtime:untyped' } } }));

    expect(projectedToolCallContract('legacy:result').returns).toEqual({
      source: 'authored-tool-guidance',
      description: '{ legacy, rows:[...] }',
    });
    expect(projectedToolCallContract('runtime:untyped').returns).toEqual({ source: 'undeclared' });
  });

  it('invalidates the cached registry revision after register and unregister mutations', () => {
    registerProjectedTool(baseTool({ expose: { mcp: { name: 'revision:first' } } }));
    const before = projectedToolRegistryRevision();
    expect(projectedToolRegistryRevision()).toBe(before);

    registerProjectedTool(baseTool({
      pluginName: 'temporary-contract',
      expose: { mcp: { name: 'revision:second' } },
    }));
    const afterRegister = projectedToolRegistryRevision();
    expect(afterRegister).not.toBe(before);

    expect(unregisterProjectedToolsForPlugin('temporary-contract')).toBe(1);
    expect(projectedToolRegistryRevision()).toBe(before);
  });

  it('renders only calls that satisfy required, enum, and undeclared-key constraints', () => {
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 'work_items:complete' } },
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          state: { type: 'string', enum: ['done', 'resolved'] },
        },
        required: ['id', 'state'],
        additionalProperties: false,
      },
    }));

    expect(renderProjectedToolCall('work_items:complete', { id: 'WI-1', state: 'done' }))
      .toBe('work_items:complete {"id":"WI-1","state":"done"}');
    expect(() => assertProjectedToolCallContract('work_items:complete', { state: 'done' }))
      .toThrow(/\$\.id: required/);
    expect(() => assertProjectedToolCallContract('work_items:complete', { id: 'WI-1', state: 'closed' }))
      .toThrow(/not one of done\|resolved/);
    expect(() => assertProjectedToolCallContract('work_items:complete', {
      id: 'WI-1', state: 'done', completion: 'extra',
    })).toThrow(/\$\.completion: undeclared key/);
  });

  it('fails closed when the tool is absent or excluded by role, profile, or modality', () => {
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 'fleet:restricted' } },
      agentRoles: ['worker'],
      profile: 'engineer',
      modality: ['text'],
    }));

    expect(projectedToolCallContract('fleet:restricted', {
      role: 'worker', profile: 'engineer', modality: 'text',
    }).name).toBe('fleet:restricted');
    expect(() => projectedToolCallContract('fleet:restricted', { role: 'architect' }))
      .toThrow(/role architect is not admitted/);
    expect(() => projectedToolCallContract('fleet:restricted', { profile: 'power' }))
      .toThrow(/power profile is not admitted/);
    expect(() => projectedToolCallContract('fleet:restricted', { modality: 'voice' }))
      .toThrow(/modality voice is not admitted/);
    expect(() => projectedToolCallContract('fleet:missing'))
      .toThrow(ProjectedToolContractError);
  });

  it('validates structured corrective calls against target schema and client admission', () => {
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 'work_items:tag' } },
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          topic: { type: 'string' },
          mode: { type: 'string', enum: ['add', 'remove'] },
        },
        required: ['id', 'topic', 'mode'],
        additionalProperties: false,
      },
      agentRoles: ['worker'],
      profile: 'engineer',
      modality: ['text'],
    }));
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 'work_items:update' } },
      agentRoles: ['worker'],
      profile: 'engineer',
      modality: ['text'],
      guidance: {
        argRedirects: {
          tags: {
            tool: 'work_items:tag',
            args: { id: '<work-item-id>', topic: '<topic>', mode: 'add' },
            note: 'the canonical tag writer',
          },
        },
      },
    }));

    expect(projectedToolCorrectiveCalls('work_items:update', {
      role: 'worker', profile: 'engineer', modality: 'text',
    })).toEqual([expect.objectContaining({
      rejectedArg: 'tags',
      tool: 'work_items:tag',
      args: { id: '<work-item-id>', topic: '<topic>', mode: 'add' },
      note: 'the canonical tag writer',
      source: PROJECTED_TOOL_REGISTRY_SOURCE,
      registryRevision: projectedToolRegistryRevision(),
      rendered: 'work_items:tag {"id":"<work-item-id>","topic":"<topic>","mode":"add"}',
    })]);
    expect(() => projectedToolCorrectiveCalls('work_items:update', { role: 'architect' }))
      .toThrow(/role architect is not admitted/);
    expect(() => projectedToolCorrectiveCalls('work_items:update', { role: 'worker', modality: 'voice' }))
      .toThrow(/modality voice is not admitted/);
  });

  it('fails structured corrective-call conformance on missing tools, required keys, enums, and undeclared keys', () => {
    const targetSchema = {
      type: 'object',
      properties: { id: { type: 'string' }, mode: { type: 'string', enum: ['add'] } },
      required: ['id', 'mode'],
      additionalProperties: false,
    };
    registerProjectedTool(baseTool({ expose: { mcp: { name: 'target:write' } }, inputSchema: targetSchema }));
    const source = (name: string, tool: string, args: Record<string, unknown>) => registerProjectedTool(baseTool({
      expose: { mcp: { name } },
      guidance: { argRedirects: { stale: { tool, args } } },
    }));

    source('source:missing', 'target:missing', { id: 'x', mode: 'add' });
    source('source:required', 'target:write', { mode: 'add' });
    source('source:enum', 'target:write', { id: 'x', mode: 'remove' });
    source('source:extra', 'target:write', { id: 'x', mode: 'add', stale: true });

    expect(() => projectedToolCorrectiveCalls('source:missing')).toThrow(/tool contract unavailable/);
    expect(() => projectedToolCorrectiveCalls('source:required')).toThrow(/\.id: required/);
    expect(() => projectedToolCorrectiveCalls('source:enum')).toThrow(/not one of add/);
    expect(() => projectedToolCorrectiveCalls('source:extra')).toThrow(/\.stale: undeclared key/);
  });

  // EI-22188204415833751: an all-profile tool may legitimately redirect into a narrower one
  // (coord:presence -> fleet:assignments). Resolving that target under a profile the TARGET does
  // not admit used to throw, and _guidance-adapter.ts turns any conformance throw into `return []`
  // — so one cross-profile redirect deleted ALL ~835 tool-guidance pages and red-pinned the gate.
  it('withholds a cross-profile redirect from contexts that cannot call the target, without weakening the schema rail', () => {
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 'narrow:target' } },
      profile: 'engineer',
      inputSchema: {
        type: 'object',
        properties: { fleet: { type: 'string' } },
        additionalProperties: false,
      },
    }));
    // no `profile` => untagged => admitted under every profile, like coord:presence
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 'broad:source' } },
      guidance: { argRedirects: { fleet: { tool: 'narrow:target', args: { fleet: '<fleet-slug>' } } } },
    }));

    // POSITIVE CONTROL: a profile that admits the target is still offered the remedy, so a
    // passing 'power' case below cannot be explained by the redirect having been dropped for all.
    expect(projectedToolCorrectiveCalls('broad:source', { profile: 'engineer' }))
      .toEqual([expect.objectContaining({ rejectedArg: 'fleet', tool: 'narrow:target' })]);

    // THE FIX: withheld, not fatal. Pre-fix both of these threw 'power profile is not admitted'.
    expect(() => projectedToolCorrectiveCalls('broad:source', { profile: 'power' })).not.toThrow();
    expect(projectedToolCorrectiveCalls('broad:source', { profile: 'power' })).toEqual([]);

    // The whole-registry rail — the thing that actually red-pinned the gate — stays green.
    expect(() => assertProjectedToolGuidanceConformance()).not.toThrow();

    // NOT-WEAKENED CONTROL: a malformed remedy on an ADMITTED target must still be fatal.
    // This is the class that caught the dev:restart enum placeholder (WI-2142574); if skipping
    // availability ever silenced it, this assertion fails.
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 'broad:malformed' } },
      guidance: { argRedirects: { fleet: { tool: 'narrow:target', args: { nope: true } } } },
    }));
    expect(() => projectedToolCorrectiveCalls('broad:malformed', { profile: 'engineer' }))
      .toThrow(/undeclared key/);
  });
});

describe('emitToSseSink', () => {
  // Lightweight recording sink matching the MinimalEventSink contract.
  function recSink() {
    const events: Array<{ kind: 'event' | 'raw'; name: string; data: unknown }> = [];
    return {
      events,
      sink: {
        event(name: string, value: unknown): void { events.push({ kind: 'event', name, data: value }); },
        eventRaw(name: string, value: string): void { events.push({ kind: 'raw', name, data: value }); },
      },
    };
  }

  it('z.string() events go through eventRaw with the raw text', async () => {
    const { emitToSseSink } = await import('./tool-projection');
    const { sink, events } = recSink();
    emitToSseSink(sink, { eventWireKinds: { delta: 'string' } } as never, 'delta', 'hello world');
    expect(events).toEqual([{ kind: 'raw', name: 'delta', data: 'hello world' }]);
  });

  it('object events go through event with the object passed through', async () => {
    const { emitToSseSink } = await import('./tool-projection');
    const { sink, events } = recSink();
    emitToSseSink(sink, { eventWireKinds: { cost: 'json' } } as never, 'cost', { usd: 0.5 });
    expect(events).toEqual([{ kind: 'event', name: 'cost', data: { usd: 0.5 } }]);
  });

  it('binary events emit the self-describing envelope (cross-transport unification)', async () => {
    const { emitToSseSink } = await import('./tool-projection');
    const { sink, events } = recSink();
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    emitToSseSink(sink, { eventWireKinds: { chunk: 'binary' } } as never, 'chunk', bytes);
    // PR F (item 14): same envelope shape as MCP transport's
    // notifications/papercusp/event params.data so consumers across
    // HTTP / MCP / IPC can normalize without out-of-band schema info.
    expect(events).toEqual([{
      kind: 'event',
      name: 'chunk',
      data: {
        $papercuspBinary: true,
        encoding: 'base64',
        data: '3q2+7w==',
      },
    }]);
  });

  it('isPapercuspBinaryEnvelope detects the envelope shape', async () => {
    const { isPapercuspBinaryEnvelope } = await import('./tool-projection');
    expect(isPapercuspBinaryEnvelope({
      $papercuspBinary: true,
      encoding: 'base64',
      data: '3q2+7w==',
    })).toBe(true);
    expect(isPapercuspBinaryEnvelope({ data: '3q2+7w==' })).toBe(false);
    expect(isPapercuspBinaryEnvelope({ $papercuspBinary: false })).toBe(false);
    expect(isPapercuspBinaryEnvelope(null)).toBe(false);
    expect(isPapercuspBinaryEnvelope('string')).toBe(false);
    expect(isPapercuspBinaryEnvelope({
      $papercuspBinary: true,
      encoding: 'base64',
      data: 123, // not a string
    })).toBe(false);
  });

  it('binary kind without Uint8Array data falls back to JSON (defensive)', async () => {
    const { emitToSseSink } = await import('./tool-projection');
    const { sink, events } = recSink();
    // Handler emits a {} instead of Uint8Array; we don't pretend it's binary.
    emitToSseSink(sink, { eventWireKinds: { chunk: 'binary' } } as never, 'chunk', { wrong: 'shape' });
    expect(events).toEqual([{ kind: 'event', name: 'chunk', data: { wrong: 'shape' } }]);
  });

  it('non-string data with string kind is String()-coerced (not JSON-stringified)', async () => {
    const { emitToSseSink } = await import('./tool-projection');
    const { sink, events } = recSink();
    emitToSseSink(sink, { eventWireKinds: { tag: 'string' } } as never, 'tag', 42);
    expect(events).toEqual([{ kind: 'raw', name: 'tag', data: '42' }]);
  });

  it('tool without eventWireKinds falls through to JSON (back-compat)', async () => {
    const { emitToSseSink } = await import('./tool-projection');
    const { sink, events } = recSink();
    emitToSseSink(sink, {} as never, 'delta', { text: 'hi' });
    expect(events).toEqual([{ kind: 'event', name: 'delta', data: { text: 'hi' } }]);
  });
});

describe('classifyEventWire', () => {
  it('returns "string" for z.string()', () => {
    expect(classifyEventWire(z.string())).toBe('string');
  });

  it('returns "string" for z.string() with describe()', () => {
    expect(classifyEventWire(z.string().describe('text/plain'))).toBe('string');
  });

  it('returns "json" for z.object({...})', () => {
    expect(classifyEventWire(z.object({ usd: z.number() }))).toBe('json');
  });

  it('returns "json" for z.number()', () => {
    expect(classifyEventWire(z.number())).toBe('json');
  });

  it('returns "binary" for z.instanceof(Uint8Array)', () => {
    expect(classifyEventWire(z.instanceof(Uint8Array))).toBe('binary');
  });

  it('binary classification survives a registerProjectedTool round-trip', () => {
    registerProjectedTool({
      pluginName: 'fixture',
      description: 'binary tool',
      inputSchema: { type: 'object' },
      capabilities: [],
      expose: { mcp: { name: 'bin.tool' } },
      events: {
        bin: z.instanceof(Uint8Array),
        meta:  z.object({ size: z.number() }),
      },
      fn: noop,
    });
    const t = lookupByMcpName('bin.tool')!;
    expect(t.eventWireKinds?.bin).toBe('binary');
    expect(t.eventWireKinds?.meta).toBe('json');
  });
});
