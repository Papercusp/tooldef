/**
 * Tests for the projected-tool registry.
 * Run with: npx vitest run packages/agent-mcp/src/tool-projection.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  registerProjectedTool,
  lookupByMcpName,
  lookupByHttpPath,
  listAllProjectedTools,
  listMcpProjections,
  classifyEventWire,
  ToolRegistrationError,
  _resetProjectionRegistryForTests,
  type ProjectedTool,
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

  it('exposes name + description + inputSchema only when events is absent', () => {
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
    });
    // capabilities, roles, etc. NOT exposed in listing — agents see only the contract.
    expect((list[0] as Record<string, unknown>).capabilities).toBeUndefined();
    expect((list[0] as Record<string, unknown>).events).toBeUndefined();
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
