import { describe, it, expect, beforeAll } from 'vitest';
import { checkScript, ensureParseCheckReady } from './parse-check';

// checkScript is sync but the TS compiler it uses is lazy-loaded (kept out of the
// eager client bundle) — warm it once before the suite.
beforeAll(async () => { await ensureParseCheckReady(); });

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

// ─────────────────────────────────────────────────────────────────────────────
// B-CX-PARSE — AST walk: catch the obfuscated-but-static forms a regex missed.
// ─────────────────────────────────────────────────────────────────────────────
describe('checkScript (B-CX-PARSE — AST: computed / aliased / destructured)', () => {
  it('resolves computed string-literal access and flags a disallowed tool', () => {
    const r = checkScript(`await tools['system']['admin']({ drop: true });`, tools);
    expect(r.ok).toBe(false);
    expect(r.unknownRefs).toContain('system.admin');
  });

  it('passes computed string-literal access to an allowed tool', () => {
    // Note: the computed key is the facade key (camelCased verb), same as dotted access.
    const r = checkScript(`await tools['work_items'].list({});\nawait tools['coord']['wakeQueue']();`, tools);
    expect(r.ok).toBe(true);
    expect(r.refs).toContain('work_items.list');
    expect(r.refs).toContain('coord.wakeQueue');
  });

  it('follows a `const t = tools` alias', () => {
    const r = checkScript(`const t = tools;\nawait t.system.admin({});`, tools);
    expect(r.ok).toBe(false);
    expect(r.unknownRefs).toContain('system.admin');
  });

  it('follows a chained alias (const w = tools.work_items; const f = w.list)', () => {
    const r = checkScript(
      `const w = tools.work_items;\nconst f = w.list;\nawait f({});`,
      tools,
    );
    expect(r.ok).toBe(true);
    expect(r.refs).toContain('work_items.list');
  });

  it('resolves namespace destructuring `const { coord } = tools`', () => {
    const ok = checkScript(`const { coord } = tools;\nawait coord.wakeQueue();`, tools);
    expect(ok.ok).toBe(true);
    expect(ok.refs).toContain('coord.wakeQueue');

    const bad = checkScript(`const { system } = tools;\nawait system.admin({});`, tools);
    expect(bad.ok).toBe(false);
    expect(bad.unknownRefs).toContain('system.admin');
  });

  it('resolves renamed namespace destructuring `const { coord: c } = tools`', () => {
    const r = checkScript(`const { coord: c } = tools;\nawait c.wakeQueue();`, tools);
    expect(r.ok).toBe(true);
    expect(r.refs).toContain('coord.wakeQueue');
  });

  it('resolves verb destructuring off a namespace `const { list } = tools.work_items`', () => {
    const ok = checkScript(`const { list, get } = tools.work_items;\nawait list({});\nawait get({ id: 'x' });`, tools);
    expect(ok.ok).toBe(true);
    expect(ok.refs).toContain('work_items.list');
    expect(ok.refs).toContain('work_items.get');

    const bad = checkScript(`const { admin } = tools.system;\nawait admin({});`, tools);
    expect(bad.ok).toBe(false);
    expect(bad.unknownRefs).toContain('system.admin');
  });

  it('resolves a computed escape hatch `tools["call"](...)`', () => {
    const r = checkScript(`await tools['call']('secrets:read', {});`, tools);
    expect(r.ok).toBe(false);
    expect(r.unknownRefs).toContain('secrets:read');
  });

  it('does NOT misread `tools.call` as a namespace named "call"', () => {
    const r = checkScript(`await tools.call('plans:set-status', {});`, tools);
    expect(r.ok).toBe(true);
    expect(r.refs).toContain('plans:set-status');
    expect(r.refs).not.toContain('call.plans'); // the colon-name, not a member
  });

  it('leaves genuinely dynamic access to the runtime whitelist (does not flag, does not crash)', () => {
    // A fully dynamic key (a variable, not a literal) is unresolvable statically. By design the
    // parse-check does not constant-fold — the runtime facade whitelist is the real boundary, so
    // this is NOT flagged here. Documents the deliberate boundary.
    const dynMember = checkScript(`const k = 'system';\nawait tools[k].admin({});`, tools);
    expect(dynMember.ok).toBe(true);
    expect(dynMember.unknownRefs).toEqual([]);

    const dynCall = checkScript(`const n = 'secrets:read';\nawait tools.call(n);`, tools);
    expect(dynCall.ok).toBe(true);
    expect(dynCall.unknownRefs).toEqual([]);
  });

  it('still flags a disallowed dotted call when mixed with a valid one', () => {
    const r = checkScript(
      `await tools.work_items.list({});\nawait tools.secrets.read({});`,
      tools,
    );
    expect(r.ok).toBe(false);
    expect(r.unknownRefs).toEqual(['secrets.read']);
    expect(r.refs).toContain('work_items.list');
  });

  it('does not throw on a syntactically broken script (degrades gracefully)', () => {
    const r = checkScript(`await tools.work_items.list({ ;;; `, tools);
    // ts.createSourceFile is resilient (error nodes, no throw); the result is still well-formed.
    expect(Array.isArray(r.unknownRefs)).toBe(true);
    expect(Array.isArray(r.refs)).toBe(true);
  });
});
