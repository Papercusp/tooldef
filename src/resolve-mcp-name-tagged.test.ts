/**
 * P-005 (fuzzy-tool-name-resolution-2026-07-02): resolveMcpNameTagged — the tagged, typo-recovering
 * sibling of `resolveMcpName`. Pins the stage order (exact → canonical → fuzzy), the safety gates
 * (D-006 unique+margin, D-007 write/high-tier never fuzzy, D-009 caller-visible candidates) and —
 * crucially — that plain `resolveMcpName` stays canonical-only so authority-deriving callers
 * (identity grants) never act on a guess.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerProjectedTool,
  resolveMcpName,
  resolveMcpNameTagged,
  _resetProjectionRegistryForTests,
  type ProjectedTool,
} from './tool-projection';

const noop: ProjectedTool['fn'] = async () => ({ content: [{ type: 'text', text: 'ok' }] });

const reg = (name: string, over: Partial<ProjectedTool> = {}): ProjectedTool => {
  const tool: ProjectedTool = {
    pluginName: `p-${name}`,
    description: 'fixture',
    inputSchema: { type: 'object' },
    capabilities: [],
    expose: { mcp: { name } },
    effect: 'read',
    fn: noop,
    ...over,
  };
  registerProjectedTool(tool);
  return tool;
};

afterEach(() => _resetProjectionRegistryForTests());

describe('resolveMcpNameTagged', () => {
  it('exact registered name → via exact', () => {
    const t = reg('curation:state-of-pot');
    const r = resolveMcpNameTagged('curation:state-of-pot');
    expect(r.tool).toBe(t);
    expect(r.via).toBe('exact');
    expect(r.distance).toBe(0);
  });

  it('separator / mcp__ fold → via canonical, not fuzzy', () => {
    reg('curation:state-of-pot');
    for (const form of ['curation_state-of-pot', 'mcp__papercusp-su__curation_state-of-pot']) {
      const r = resolveMcpNameTagged(form);
      expect(r.via).toBe('canonical');
      expect(r.resolvedName).toBe('curation:state-of-pot');
    }
  });

  it('a one-edit typo on a read tool → via fuzzy, tagged with the sent input and distance', () => {
    const t = reg('curation:state-of-pot');
    const r = resolveMcpNameTagged('curationn:state-of-pot');
    expect(r.tool).toBe(t);
    expect(r.via).toBe('fuzzy');
    expect(r.input).toBe('curationn:state-of-pot');
    expect(r.resolvedName).toBe('curation:state-of-pot');
    expect(r.distance).toBe(1);
  });

  it('a MUTATING tool is never fuzzy-resolved by default (D-007) — reported as blocked', () => {
    // Verb long enough that ONE edit stays within the frozen T (0.2) — 'flags:set' vs 'flags:sett'
    // is 1/4 = 0.25 and would be a plain miss, proving nothing about the D-007 gate.
    reg('plans:set-status', { effect: 'write' });
    const r = resolveMcpNameTagged('plans:set-statuss');
    expect(r.tool).toBeUndefined();
    expect(r.blocked).toBe(true);
    expect(r.alternatives).toEqual(['plans:set-status']);
  });

  it('a tierOf==high tool is never fuzzy-resolved even when it is a read (D-007)', () => {
    reg('secrets:peek');
    const r = resolveMcpNameTagged('secrets:peekk', { tierOf: (n) => (n === 'secrets:peek' ? 'high' : 'low') });
    expect(r.tool).toBeUndefined();
    expect(r.blocked).toBe(true);
  });

  it('a canonical fold still resolves a write tool — a formatting difference is not a guess (D-004)', () => {
    const t = reg('flags:set', { effect: 'write' });
    expect(resolveMcpNameTagged('flags_set').tool).toBe(t);
    expect(resolveMcpNameTagged('flags_set').via).toBe('canonical');
  });

  it('two near neighbours → ambiguous, no tool (D-006)', () => {
    reg('plans:list-a');
    reg('plans:list-b');
    const r = resolveMcpNameTagged('plans:list-c');
    expect(r.tool).toBeUndefined();
    expect(r.ambiguous).toBe(true);
    expect([...r.alternatives].sort()).toEqual(['plans:list-a', 'plans:list-b']);
  });

  it('an ambiguous canonical fold never falls through to fuzzy', () => {
    reg('x:a-b');
    reg('x:a_b');
    const r = resolveMcpNameTagged('mcp__srv__x_a_b');
    expect(r.tool).toBeUndefined();
    expect(r.ambiguous).toBe(true);
  });

  it('D-009: a tool the caller cannot see is neither resolved to nor suggested', () => {
    reg('coord:send-hidden', { pluginName: 'hidden' });
    const r = resolveMcpNameTagged('coord:send-hiddn', { visible: (t) => t.pluginName !== 'hidden' });
    expect(r.tool).toBeUndefined();
    expect(r.alternatives).toEqual([]);
    // …and an exact hit on a hidden tool does not leak either.
    expect(resolveMcpNameTagged('coord:send-hidden', { visible: (t) => t.pluginName !== 'hidden' }).tool).toBeUndefined();
  });

  it('nothing close → empty alternatives, no tool', () => {
    reg('curation:state-of-pot');
    const r = resolveMcpNameTagged('zzzz:qqqq');
    expect(r.tool).toBeUndefined();
    expect(r.alternatives).toEqual([]);
  });

  it('resolveMcpName itself stays canonical-only: a typo is still undefined (authority callers)', () => {
    reg('curation:state-of-pot');
    expect(resolveMcpName('curationn:state-of-pot')).toBeUndefined();
    expect(resolveMcpNameTagged('curationn:state-of-pot').via).toBe('fuzzy');
  });
});
