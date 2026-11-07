import { describe, it, expect, beforeAll } from 'vitest';
import { checkScript, collectStaticPropertyStringComparisons, ensureParseCheckReady } from './parse-check';

// checkScript is sync but the TS compiler it uses is lazy-loaded (kept out of the
// eager client bundle) — warm it once before the suite.
beforeAll(async () => { await ensureParseCheckReady(); });

describe('static property string comparisons', () => {
  it('captures entity filter literals from the AST while ignoring comments and type guards', () => {
    const comparisons = collectStaticPropertyStringComparisons(`
      // report.planSlug === 'comment-only-plan'
      const report = await tools.plans.conformance({ op: 'report', harness: 'papercusp' });
      return report.plans
        ?.filter((plan) => plan.planSlug === 'fixed-plan')
        ?.filter((plan) => 'excluded-plan' !== plan['plan_slug'])
        ?.filter((plan) => typeof plan.planSlug === 'string');
    `);
    expect(comparisons).toEqual([
      { property: 'planSlug', value: 'fixed-plan' },
      { property: 'plan_slug', value: 'excluded-plan' },
    ]);
  });
});

const mkTool = (name: string) => ({ expose: { mcp: { name } } }) as never;
const tools = [mkTool('work_items:list'), mkTool('work_items:get'), mkTool('coord:wake-queue'), mkTool('plans:set-status')];

describe('checkScript (B-CX-1A parse-check)', () => {
  it('passes a script that only references allowed tools', () => {
    const r = checkScript(
      `const o = await tools.workItems.list({});
       for (const w of o.items) await tools.workItems.get({ id: w.id });
       await tools.coord.wakeQueue();`,
      tools,
    );
    expect(r.ok).toBe(true);
    expect(r.unknownRefs).toEqual([]);
    expect(r.refs).toContain('workItems.list');
    expect(r.refs).toContain('coord.wakeQueue');
  });

  it('accepts the raw snake_case spelling of ns/verb (matches the canonical MCP name)', () => {
    const r = checkScript(
      `await tools.work_items.get({ id: 'EI-1' });
       await tools.coord.wake_queue();
       await tools.workItems.list({});`, // camel still fine, mixed in
      tools,
    );
    expect(r.ok).toBe(true);
    expect(r.unknownRefs).toEqual([]);
    expect(r.refs).toContain('work_items.get'); // raw form recorded for telemetry
  });

  it('still flags a snake_case ref to a tool genuinely absent from the facade', () => {
    const r = checkScript(`await tools.secret_store.read({});`, tools);
    expect(r.ok).toBe(false);
    expect(r.unknownRefs).toContain('secret_store.read');
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
    const r = checkScript(`await tools['workItems'].list({});\nawait tools['coord']['wakeQueue']();`, tools);
    expect(r.ok).toBe(true);
    expect(r.refs).toContain('workItems.list');
    expect(r.refs).toContain('coord.wakeQueue');
  });

  it('follows a `const t = tools` alias', () => {
    const r = checkScript(`const t = tools;\nawait t.system.admin({});`, tools);
    expect(r.ok).toBe(false);
    expect(r.unknownRefs).toContain('system.admin');
  });

  it('follows a chained alias (const w = tools.workItems; const f = w.list)', () => {
    const r = checkScript(
      `const w = tools.workItems;\nconst f = w.list;\nawait f({});`,
      tools,
    );
    expect(r.ok).toBe(true);
    expect(r.refs).toContain('workItems.list');
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

  it('resolves verb destructuring off a namespace `const { list } = tools.workItems`', () => {
    const ok = checkScript(`const { list, get } = tools.workItems;\nawait list({});\nawait get({ id: 'x' });`, tools);
    expect(ok.ok).toBe(true);
    expect(ok.refs).toContain('workItems.list');
    expect(ok.refs).toContain('workItems.get');

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

  it('projects literal call arguments while marking dynamic leaves incomplete', () => {
    const r = checkScript(
      `const runtime = 'WI-runtime';
       await tools.workItems.get({ id: 'WI-1', harness: 'papercusp', runtime });
       await tools.call('plans:set-status', { slug: 'release-plan', item: 'P-008', status: 'wip' });`,
      tools,
    );

    expect(r.calls).toMatchObject([
      {
        tool: 'work_items:get',
        args: { id: 'WI-1', harness: 'papercusp' },
        dynamicArgs: true,
      },
      {
        tool: 'plans:set-status',
        args: { slug: 'release-plan', item: 'P-008', status: 'wip' },
        dynamicArgs: false,
      },
    ]);
  });

  it('binds a directly awaited tool result and records its statically-read path and locations', () => {
    const r = checkScript(
      'const trace = await tools.workItems.get({ id: "WI-1" });\nreturn trace.item.state;',
      tools,
    );

    expect(r.calls).toMatchObject([
      {
        tool: 'work_items:get',
        position: { line: 1, column: 21 },
        resultBindings: ['trace'],
        resultReads: [{ path: ['item', 'state'], position: { line: 2, column: 8 } }],
      },
    ]);
  });

  it('recognizes an optional result path after a throwing disjunction guard', () => {
    const guarded = checkScript(
      `const page = await tools.capability.read({ file_path: '/tmp/page', byte_offset: 0, byte_limit: 10 });
       if (!page.ok || page.encoding !== 'base64' || !page.data) throw new Error('invalid byte page');
       return page.data;`,
      [mkTool('capability:read')],
    );
    const guardedRead = guarded.calls[0]?.resultReads?.find(
      (read) => read.path[0] === 'data' && read.position.line === 3,
    );

    expect(guardedRead).toMatchObject({
      path: ['data'],
      safeOptionalPaths: [['data']],
    });

    const unguarded = checkScript(
      `const page = await tools.capability.read({ file_path: '/tmp/page', byte_offset: 0, byte_limit: 10 });
       return page.data;`,
      [mkTool('capability:read')],
    );
    expect(unguarded.calls[0]?.resultReads?.[0]?.safeOptionalPaths).toBeUndefined();
  });

  it('binds Promise.all array results to their destructured identifiers', () => {
    const r = checkScript(
      `const [work, status] = await Promise.all([
        tools.workItems.get({ id: 'WI-1' }),
        tools.plans.setStatus({ slug: 'p', item: 'P-1', status: 'wip' }),
      ]);
      return status.status;`,
      tools,
    );

    expect(r.calls).toMatchObject([
      { tool: 'work_items:get', resultBindings: ['work'] },
      { tool: 'plans:set-status', resultBindings: ['status'], resultReads: [{ path: ['status'] }] },
    ]);
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
      `await tools.workItems.list({});\nawait tools.secrets.read({});`,
      tools,
    );
    expect(r.ok).toBe(false);
    expect(r.unknownRefs).toEqual(['secrets.read']);
    expect(r.refs).toContain('workItems.list');
  });

  it('does not throw on a syntactically broken script (degrades gracefully)', () => {
    const r = checkScript(`await tools.workItems.list({ ;;; `, tools);
    // ts.createSourceFile is resilient (error nodes, no throw); the result is still well-formed.
    expect(Array.isArray(r.unknownRefs)).toBe(true);
    expect(Array.isArray(r.refs)).toBe(true);
  });

  it('projects direct validated invocation input reads without evaluating expressions', () => {
    const script = 'await tools.call("plans:get", {slug:inputs.plan,harness:inputs["harness"], optional:inputs.missing});';
    expect(checkScript(script, [mkTool('plans:get')], undefined, { plan: 'p', harness: 'h' }).calls[0])
      .toMatchObject({ args: { slug: 'p', harness: 'h' }, dynamicArgs: false });
    expect(checkScript(script, [mkTool('plans:get')]).calls[0].dynamicArgs).toBe(true);
  });
  it.each(['const inputs={plan:"other"};', 'inputs.plan="other";', 'delete inputs.plan;',
    'const alias=inputs;', 'Object.assign(inputs,{plan:"other"});', 'function f(inputs) {}']) (
    'does not trust invocation inputs after shadowing, mutation or escape: %s', prefix => {
      const script = prefix + 'await tools.call("plans:get",{slug:inputs.plan});';
      expect(checkScript(script, [mkTool('plans:get')], undefined, { plan: 'p' }).calls[0].dynamicArgs).toBe(true);
    });
  it('never calls an input getter while projecting scope', () => {
    const values = Object.defineProperty({}, 'plan', { get() { throw new Error('must not execute'); } });
    expect(checkScript('await tools.call("plans:get",{slug:inputs.plan});', [mkTool('plans:get')], undefined, values)
      .calls[0].dynamicArgs).toBe(true);
  });
  it('does not project mutable array inputs that can escape through a property alias', () => {
    const script = 'const ids=inputs.ids; ids.push("WI-other"); await tools.call("work_items:get",{ids:inputs.ids});';
    expect(checkScript(script, [mkTool('work_items:get')], undefined, { ids: ['WI-bound'] })
      .calls[0].dynamicArgs).toBe(true);
  });
  it('marks parser recovery errors so consumers do not validate recovered pseudo-properties', () => {
    const r = checkScript(
      String.raw`const r = await tools.capability.bash({
        command: "head -n 12 /tmp/x.log | awk '{print NR ":" substr($0,1,600)}'",
        cwd: "/tmp"
      });`,
      [mkTool('capability:bash')],
    );
    expect(r.hasParseErrors).toBe(true);
    expect(r.refs).toContain('capability.bash');
  });
});
