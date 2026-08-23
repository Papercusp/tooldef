import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { defineTool } from './define-tool';
import { listAllProjectedTools, _resetProjectionRegistryForTests } from './tool-projection';

/**
 * code-execution-tool-orchestration B-CX-PRE: every tool def carries a read/write
 * `effect`, inferred from its capability (a write-suffix OR the known-mutator set),
 * overridable per tool, and threaded onto the projected tool so the code-execution
 * sandbox can decide whether a call needs a dry-run/confirm gate.
 */
afterEach(() => _resetProjectionRegistryForTests());

const base = {
  args: z.object({}),
  requirePrincipal: false as const,
  agentRoles: ['operator'],
  handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
};

const projected = (mcpName: string) =>
  listAllProjectedTools().find((p) => p.expose.mcp?.name === mcpName);

describe('defineTool effect inference (B-CX-PRE)', () => {
  it("infers 'write' from a :write capability + threads it to the projected tool", () => {
    const def = defineTool({ name: 'test:eff_w', capability: 'work_items:write', ...base });
    expect(def.effect).toBe('write');
    expect(projected('test:eff_w')?.effect).toBe('write');
  });

  it("infers 'read' from a :read capability", () => {
    const def = defineTool({ name: 'test:eff_r', capability: 'work_items:read', ...base });
    expect(def.effect).toBe('read');
    expect(projected('test:eff_r')?.effect).toBe('read');
  });

  it('honors an explicit effect override (a read-capability tool that mutates)', () => {
    const def = defineTool({ name: 'test:eff_override', capability: 'work_items:read', effect: 'write', ...base });
    expect(def.effect).toBe('write');
    expect(projected('test:eff_override')?.effect).toBe('write');
  });

  it('threads an argument-sensitive effect classifier to the definition and projection', () => {
    const def = defineTool({
      ...base,
      name: 'test:eff_dynamic',
      capability: 'operator:write',
      args: z.object({ op: z.enum(['status', 'trigger']) }),
      effectForCall: (args) => (args.op === 'status' ? 'read' : 'write'),
    });
    expect(def.effect).toBe('write');
    expect(def.effectForCall?.({ op: 'status' })).toBe('read');
    expect(def.effectForCall?.({ op: 'trigger' })).toBe('write');

    const projectedTool = projected('test:eff_dynamic');
    expect(projectedTool?.effect).toBe('write');
    expect(projectedTool?.effectForCall?.({ op: 'status' })).toBe('read');
    expect(projectedTool?.effectForCall?.({ op: 'trigger' })).toBe('write');
  });

  it("treats known host-capability mutators (capability:bash) as 'write'", () => {
    const def = defineTool({ name: 'test:eff_bash', capability: 'capability:bash', ...base });
    expect(def.effect).toBe('write');
  });

  it("infers 'write' from an :admin capability", () => {
    const def = defineTool({ name: 'test:eff_admin', capability: 'system:admin', ...base });
    expect(def.effect).toBe('write');
  });

  // B-CX-EFFECT: dedicated mutator capabilities whose names DON'T end in a write-suffix —
  // each added to the central WRITE_CAPABILITIES set (none shares its exact capability
  // string with a reader). Guards the set so a refactor can't silently drop one and
  // re-mis-infer these as 'read' (the dry-run gate would then EXECUTE them on a preview).
  it.each([
    'turn:interrupt',
    'ui:dispatch',
    'tui:dispatch',
    'operator:converse',
    'activity:report',
    'capability:net',
  ])("treats dedicated mutator capability '%s' as 'write'", (capability) => {
    const def = defineTool({ name: `test:eff_${capability.replace(/:/g, '_')}`, capability, ...base });
    expect(def.effect).toBe('write');
  });
});

describe('defineTool schema projections', () => {
  it('keeps union requirements for discovery without weakening the MCP/OpenAI schema', () => {
    const name = 'test:schema_projection_union';
    const args = z.union([
      z.object({ path: z.string().min(1), sha: z.string().optional() }),
      z.object({ path: z.string().optional(), sha: z.string().min(4) }),
    ]);

    defineTool({
      name,
      capability: 'test:read',
      requirePrincipal: false,
      args,
      handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    });

    const projected = listAllProjectedTools().find((tool) => tool.expose.mcp?.name === name);
    expect(projected).toBeDefined();
    expect(projected?.inputSchema).toMatchObject({ type: 'object' });
    expect(projected?.inputSchema.oneOf).toBeUndefined();
    expect(projected?.inputSchema.anyOf).toBeUndefined();
    expect(projected?.inputSchema.required).toBeUndefined();

    expect(projected?.discoveryInputSchema?.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ required: expect.arrayContaining(['path']) }),
        expect.objectContaining({ required: expect.arrayContaining(['sha']) }),
      ]),
    );
  });
});

describe('defineTool composition / replaces (tool-call-batching-wrappers P-010)', () => {
  it("derives composition 'composite' from `replaces` + threads replaces to the projected tool", () => {
    const def = defineTool({
      name: 'test:comp_c',
      capability: 'coord:read',
      replaces: ['fleet:assignments', 'work_items:list', 'coord:inbox'],
      ...base,
    });
    expect(def.composition).toBe('composite');
    expect(def.replaces).toEqual(['fleet:assignments', 'work_items:list', 'coord:inbox']);
    const p = projected('test:comp_c');
    expect(p?.composition).toBe('composite');
    expect(p?.replaces).toEqual(['fleet:assignments', 'work_items:list', 'coord:inbox']);
  });

  it("defaults composition to 'primitive' when `replaces` is omitted", () => {
    const def = defineTool({ name: 'test:comp_p', capability: 'coord:read', ...base });
    expect(def.composition).toBe('primitive');
    expect(def.replaces).toBeUndefined();
    expect(projected('test:comp_p')?.composition).toBe('primitive');
  });
});
