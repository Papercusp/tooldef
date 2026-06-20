import { describe, it, expect } from 'vitest';
import { checkScript } from './parse-check';

const mkTool = (name: string) => ({ expose: { mcp: { name } } }) as never;
const tools = [mkTool('work_items:list'), mkTool('work_items:get'), mkTool('coord:wake-queue'), mkTool('plans:set-status')];

describe('checkScript (B-CX-1A parse-check)', () => {
  it('passes a script that only references allowed tools', () => {
    const r = checkScript(
      `const o = await tools.work_items.list({});
       for (const w of o.items) await tools.work_items.get({ id: w.id });
       await tools.coord.wakeQueue();`,
      tools,
    );
    expect(r.ok).toBe(true);
    expect(r.unknownRefs).toEqual([]);
    expect(r.refs).toContain('work_items.list');
    expect(r.refs).toContain('coord.wakeQueue');
  });

  it('flags a reference to a tool not in the facade', () => {
    const r = checkScript(`await tools.system.admin({ drop: true });`, tools);
    expect(r.ok).toBe(false);
    expect(r.unknownRefs).toContain('system.admin');
  });

  it('validates the tools.call() escape hatch against full names', () => {
    const ok = checkScript(`await tools.call('plans:set-status', { id: 'P-1' });`, tools);
    expect(ok.ok).toBe(true);
    const bad = checkScript(`await tools.call('secrets:read', {});`, tools);
    expect(bad.ok).toBe(false);
    expect(bad.unknownRefs).toContain('secrets:read');
  });

  it('respects the allowed-set narrowing', () => {
    const r = checkScript(`await tools.plans.setStatus({});`, tools, new Set(['work_items:list']));
    expect(r.ok).toBe(false);
    expect(r.unknownRefs).toContain('plans.setStatus');
  });
});
