/**
 * Tests for the slash projection (slash-exposure-tool-catalog-2026-06-12):
 * exposure resolution + default-ON, naming, prompt-argument derivation from
 * input JSON Schema, the instruction render, and the reserved `tool:` prompt
 * namespace guard.
 * Run with: npx vitest run libs/generic/tooldef/src/slash-projection.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  SLASH_PROMPT_PREFIX,
  deriveSlashPromptArguments,
  isSlashPromptName,
  renderSlashPrompt,
  resolveSlashExposure,
  slashPromptListingFor,
  slashPromptNameFor,
  slashPromptToolName,
} from './slash-projection';
import { registerPrompt, _resetPromptCatalogForTests } from './prompt-registry';
import { setCapabilityTierResolver, defaultTierResolver } from './capability-tiers';
import type { ProjectedTool } from './tool-projection';
import type { ToolResult } from './wire';

afterEach(() => {
  _resetPromptCatalogForTests();
  setCapabilityTierResolver(defaultTierResolver);
});

const fn = async (): Promise<ToolResult> => ({ content: [] });

function tool(overrides: Partial<ProjectedTool> = {}): ProjectedTool {
  return {
    pluginName: 'agent-mcp',
    description: 'List the plans.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Plan slug.' },
        limit: { type: 'integer' },
        verbose: { type: 'boolean' },
        status: { enum: ['draft', 'active'] },
        filters: { type: 'object' },
        ids: { type: 'array' },
      },
      required: ['slug'],
    },
    capabilities: ['plans:read' as never],
    expose: { mcp: { name: 'plans:list' }, http: { path: '/api/agent-tools/plans/list' } },
    fn,
    ...overrides,
  };
}

describe('resolveSlashExposure (default ON, D-003)', () => {
  it('is ON when expose.slash is absent', () => {
    expect(resolveSlashExposure(tool())).toEqual({});
  });

  it('is ON with empty overrides when expose.slash is true', () => {
    expect(resolveSlashExposure(tool({ expose: { mcp: { name: 'a:b' }, slash: true } }))).toEqual({});
  });

  it('is OFF when expose.slash is false', () => {
    expect(resolveSlashExposure(tool({ expose: { mcp: { name: 'a:b' }, slash: false } }))).toBeNull();
  });

  it('is OFF for HTTP-only tools (no MCP name to instruct the agent to call)', () => {
    expect(resolveSlashExposure(tool({ expose: { http: { path: '/api/x' } } }))).toBeNull();
  });

  it('returns the override object when given one', () => {
    const slash = { name: 'plans', description: 'd', args: ['slug'] as const };
    expect(resolveSlashExposure(tool({ expose: { mcp: { name: 'a:b' }, slash } }))).toBe(slash);
  });
});

describe('naming', () => {
  it('prefixes the MCP name with tool:', () => {
    expect(slashPromptNameFor(tool())).toBe('tool:plans:list');
  });

  it('honors the slash name override', () => {
    expect(
      slashPromptNameFor(tool({ expose: { mcp: { name: 'plans:list' }, slash: { name: 'plans' } } })),
    ).toBe('tool:plans');
  });

  it('round-trips through isSlashPromptName/slashPromptToolName', () => {
    expect(isSlashPromptName('tool:plans:list')).toBe(true);
    expect(isSlashPromptName('agent:role')).toBe(false);
    expect(slashPromptToolName('tool:plans:list')).toBe('plans:list');
  });
});

describe('deriveSlashPromptArguments (D-004)', () => {
  it('surfaces top-level scalars + enums, skips objects/arrays', () => {
    const args = deriveSlashPromptArguments(tool().inputSchema);
    expect(args.map((a) => a.name).sort()).toEqual(['limit', 'slug', 'status', 'verbose']);
  });

  it('advertises required:false on the wire and annotates required-ness in the description', () => {
    const args = deriveSlashPromptArguments(tool().inputSchema);
    const slug = args.find((a) => a.name === 'slug')!;
    expect(slug.required).toBe(false);
    expect(slug.description).toMatch(/required — the agent will ask if omitted/);
    expect(slug.description).toMatch(/Plan slug\./);
  });

  it('lists enum members in the description', () => {
    const args = deriveSlashPromptArguments(tool().inputSchema);
    const status = args.find((a) => a.name === 'status')!;
    expect(status.description).toMatch(/One of: draft, active\./);
  });

  it('honors the restrict list', () => {
    const args = deriveSlashPromptArguments(tool().inputSchema, ['slug']);
    expect(args.map((a) => a.name)).toEqual(['slug']);
  });

  it('handles nullable scalar type arrays', () => {
    const args = deriveSlashPromptArguments({
      type: 'object',
      properties: { note: { type: ['string', 'null'] } },
    });
    expect(args.map((a) => a.name)).toEqual(['note']);
  });

  it('returns [] for a schema without properties', () => {
    expect(deriveSlashPromptArguments({ type: 'object' })).toEqual([]);
  });
});

describe('slashPromptListingFor', () => {
  it('builds a listing with name, description (guidance.when preferred), and args', () => {
    const listing = slashPromptListingFor(
      tool({ guidance: { when: 'When the user asks about plans.' } }),
    )!;
    expect(listing.name).toBe('tool:plans:list');
    expect(listing.description).toBe('When the user asks about plans.');
    expect(listing.arguments!.length).toBe(4);
  });

  it('falls back to the tool description without guidance', () => {
    expect(slashPromptListingFor(tool())!.description).toBe('List the plans.');
  });

  it('uses the advertised schema override when given', () => {
    const listing = slashPromptListingFor(tool(), {
      type: 'object',
      properties: { row: { type: 'string' } },
      required: ['row'],
    })!;
    expect(listing.arguments!.map((a) => a.name)).toEqual(['row']);
  });

  it('returns null for an excluded tool', () => {
    expect(slashPromptListingFor(tool({ expose: { mcp: { name: 'a:b' }, slash: false } }))).toBeNull();
  });
});

describe('renderSlashPrompt', () => {
  it('embeds the tool name, schema, supplied args, and the elicitation directive', () => {
    const result = renderSlashPrompt(tool(), { slug: 'my-plan' });
    const text = result.messages[0]!.content.text;
    expect(result.messages[0]!.role).toBe('user');
    expect(text).toContain('`plans:list`');
    expect(text).toContain('"Plan slug."');
    expect(text).toContain('- slug: my-plan');
    expect(text).toMatch(/REQUIRED input field is still missing.*ask the user/);
    expect(text).toMatch(/summarize the result/);
  });

  it('renders "(none)" when no args were supplied', () => {
    const text = renderSlashPrompt(tool(), {}).messages[0]!.content.text;
    expect(text).toContain('(none)');
  });

  it('adds the hard confirm directive for high-tier capabilities (D-007)', () => {
    setCapabilityTierResolver((cap) => (cap === 'danger:write' ? 'high' : 'low'));
    const text = renderSlashPrompt(
      tool({ capabilities: ['danger:write' as never] }),
      {},
    ).messages[0]!.content.text;
    expect(text).toMatch(/HIGH-tier/);
    expect(text).toMatch(/explicit confirmation/);
  });

  it('keeps the soft destructive-confirm line for low-tier tools', () => {
    const text = renderSlashPrompt(tool(), {}).messages[0]!.content.text;
    expect(text).not.toMatch(/HIGH-tier/);
    expect(text).toMatch(/destructive or irreversible/);
  });

  it('includes guidance when/notWhen lines when present', () => {
    const text = renderSlashPrompt(
      tool({ guidance: { when: 'For plan lookups.', notWhen: 'Not for features.' } }),
      {},
    ).messages[0]!.content.text;
    expect(text).toContain('When to use: For plan lookups.');
    expect(text).toContain('Not for: Not for features.');
  });
});

describe('reserved tool: prompt namespace (D-006)', () => {
  it('registerPrompt rejects a static prompt under tool:*', () => {
    expect(() =>
      registerPrompt({
        name: `${SLASH_PROMPT_PREFIX}sneaky`,
        description: 'nope',
        tier: 'low',
        render: async () => ({ messages: [] }),
      }),
    ).toThrow(/reserved "tool:" namespace/);
  });

  it('still accepts ordinary prompt names', () => {
    expect(() =>
      registerPrompt({
        name: 'agent:role',
        description: 'ok',
        tier: 'low',
        render: async () => ({ messages: [] }),
      }),
    ).not.toThrow();
  });
});
