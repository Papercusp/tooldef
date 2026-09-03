/**
 * EI-10883 — an undeclared arg must be a HARD ERROR, never a silent drop.
 *
 * Zod's default object behaviour STRIPS unknown keys, so before this a caller who
 * passed an arg a tool did not declare got back ok:true and the tool's DEFAULT
 * behaviour. That is the worst failure mode available: byte-identical to success
 * while doing something other than what was asked, invisible to the caller AND to
 * the tool-efficiency telemetry (which only counts hard failures).
 *
 * The concrete incident these tests encode: `sessions:read { order:'asc' }` was
 * accepted and ignored — the tool had no `order` arg — so the caller concluded the
 * tool had no head read, burned further calls, and drew a wrong conclusion about
 * the data. Under a closed shape that same call fails loudly and self-corrects.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  isLocalSchemaTarget,
  nestedArgPaths,
  strictArgs,
  suggestArgName,
  toArgsJsonSchema,
  unknownArgHint,
  siblingToolArgOwner,
} from './define-tool';

/** Zod 4 exposes safeParse on the schema; keep the test honest about the shape. */
function parse(schema: unknown, value: unknown): { ok: boolean; message: string } {
  const r = (schema as { safeParse: (v: unknown) => { success: boolean; error?: { message: string } } }).safeParse(value);
  return { ok: r.success, message: r.error?.message ?? '' };
}

describe('strictArgs (EI-10883)', () => {
  const base = z.object({
    session: z.string(),
    limit: z.number().int().optional(),
  });

  it('BASELINE: a plain zod object silently DROPS an undeclared arg (the bug)', () => {
    const r = base.safeParse({ session: 'x', order: 'asc' });
    expect(r.success).toBe(true);
    // The smoking gun: `order` is gone, and the caller was never told.
    expect(r.success && 'order' in (r.data as Record<string, unknown>)).toBe(false);
  });

  it('rejects an undeclared arg', () => {
    const strict = strictArgs(base);
    const r = parse(strict, { session: 'x', order: 'asc' });
    expect(r.ok).toBe(false);
    expect(r.message.toLowerCase()).toContain('unrecognized');
  });

  it('names the offending key so the failure is self-correcting', () => {
    const strict = strictArgs(base);
    const r = parse(strict, { session: 'x', order: 'asc' });
    expect(r.message).toContain('order');
  });

  it('still accepts a fully-declared call (no false positives)', () => {
    const strict = strictArgs(base);
    expect(parse(strict, { session: 'x' }).ok).toBe(true);
    expect(parse(strict, { session: 'x', limit: 5 }).ok).toBe(true);
  });

  it('still enforces the declared constraints', () => {
    const strict = strictArgs(base);
    expect(parse(strict, { session: 'x', limit: 1.5 }).ok).toBe(false);
    expect(parse(strict, {}).ok).toBe(false);
  });

  it('passes through a schema with no .strict() (unions) instead of throwing', () => {
    // A discriminatedUnion has no .strict(); the catalog contains several, and the
    // registration path must never blow up on them — it just leaves them as-is.
    const union = z.discriminatedUnion('op', [
      z.object({ op: z.literal('a'), a: z.string() }),
      z.object({ op: z.literal('b'), b: z.string() }),
    ]);
    const out = strictArgs(union);
    expect(out).toBe(union);
    expect(parse(out, { op: 'a', a: 'x' }).ok).toBe(true);
  });

  it('is a no-op on a non-schema value (never throws at registration)', () => {
    const weird = { not: 'a schema' } as unknown;
    expect(() => strictArgs(weird)).not.toThrow();
    expect(strictArgs(weird)).toBe(weird);
  });
});

describe('strictArgs deep nesting (EI-18723223344390510)', () => {
  // The reported bug: loop:checkpoint's `checks: z.array(z.object({ claim,
  // recheck, verified }))` accepted `{ claim, status:'verified', evidence:'Y' }`
  // silently — the row object was never strictified, only the top-level args
  // object was. `.strict()` on the outer schema does not cascade into nested
  // object schemas; the whole tree must be walked and strictified.

  it('rejects an unknown key on an object nested inside an array field', () => {
    const schema = strictArgs(
      z.object({
        checks: z
          .array(
            z.object({
              claim: z.string(),
              recheck: z.string().optional(),
              verified: z.string().optional(),
            }),
          )
          .max(12)
          .optional(),
      }),
    );
    expect(parse(schema, { checks: [{ claim: 'x', verified: 'evidence' }] }).ok).toBe(true);
    const bad = parse(schema, { checks: [{ claim: 'x', status: 'verified', evidence: 'Y' }] });
    expect(bad.ok).toBe(false);
    expect(bad.message.toLowerCase()).toContain('unrecognized');
  });

  it('preserves array constraints (e.g. .max()) while strictifying the element', () => {
    const schema = strictArgs(z.object({ checks: z.array(z.object({ claim: z.string() })).max(2) }));
    expect(parse(schema, { checks: [{ claim: 'a' }, { claim: 'b' }] }).ok).toBe(true);
    expect(parse(schema, { checks: [{ claim: 'a' }, { claim: 'b' }, { claim: 'c' }] }).ok).toBe(false);
  });

  it('rejects an unknown key on the exact loop:checkpoint `checks` shape (z.preprocess wrapping the array)', () => {
    // Mirrors packages/operator-core/lib/agent-tools/loop/checkpoint.ts's real `checks` field.
    const checksField = z
      .preprocess((v) => {
        if (typeof v !== 'string') return v;
        try {
          const parsed = JSON.parse(v);
          return Array.isArray(parsed) ? parsed : v;
        } catch {
          return v;
        }
      }, z.array(z.object({ claim: z.string().min(1), recheck: z.string().optional(), verified: z.string().optional() })).max(12))
      .optional();
    const schema = strictArgs(z.object({ checks: checksField }));
    expect(parse(schema, { checks: [{ claim: 'x', verified: 'ev' }] }).ok).toBe(true);
    expect(parse(schema, { checks: [{ claim: 'x', status: 'verified', evidence: 'ev' }] }).ok).toBe(false);
  });

  it('rejects an unknown key on an object nested inside optional/nullable/default wrappers', () => {
    const row = z.object({ claim: z.string() });
    const schema = strictArgs(
      z.object({
        opt: row.optional(),
        nul: row.nullable(),
        def: row.default({ claim: 'x' }),
      }),
    );
    expect(parse(schema, { opt: { claim: 'a' }, nul: { claim: 'b' } }).ok).toBe(true);
    expect(parse(schema, { opt: { claim: 'a', extra: 1 } }).ok).toBe(false);
    expect(parse(schema, { nul: { claim: 'b', extra: 1 } }).ok).toBe(false);
  });

  it('rejects an unknown key on an object nested inside a union variant, without breaking discriminatedUnion dispatch', () => {
    const union = z.discriminatedUnion('op', [
      z.object({ op: z.literal('a'), a: z.string() }),
      z.object({ op: z.literal('b'), b: z.string() }),
    ]);
    const schema = strictArgs(z.object({ variant: union }));
    expect(parse(schema, { variant: { op: 'a', a: 'x' } }).ok).toBe(true);
    expect(parse(schema, { variant: { op: 'b', b: 'y' } }).ok).toBe(true);
    expect(parse(schema, { variant: { op: 'a', a: 'x', extra: 1 } }).ok).toBe(false);
  });

  it('rejects an unknown key on an object nested inside a record value type', () => {
    const schema = strictArgs(z.object({ byId: z.record(z.string(), z.object({ claim: z.string() })) }));
    expect(parse(schema, { byId: { k1: { claim: 'x' } } }).ok).toBe(true);
    expect(parse(schema, { byId: { k1: { claim: 'x', extra: 1 } } }).ok).toBe(false);
  });

  it('never crashes on a self-referential z.lazy field (left untouched, fail-open)', () => {
    const Node: z.ZodTypeAny = z.lazy(() => z.object({ id: z.string(), children: z.array(Node).optional() }));
    expect(() => strictArgs(z.object({ tree: Node }))).not.toThrow();
  });

  it('still passes a bare top-level union through unchanged (no crash, same referential identity)', () => {
    const union = z.discriminatedUnion('op', [
      z.object({ op: z.literal('a'), a: z.string() }),
      z.object({ op: z.literal('b'), b: z.string() }),
    ]);
    const out = strictArgs(union);
    expect(out).toBe(union);
    expect(parse(out, { op: 'a', a: 'x' }).ok).toBe(true);
  });
});

describe('unknownArgHint argRedirects (EI-20281509195248260)', () => {
  // The measured shape: `tags` on work_items:update. It has no nested home and no
  // near-miss name, so BOTH pre-existing correction sources produce nothing and the
  // caller was told only what the tool does not accept — read as "the capability does
  // not exist", and filed 10+ times.
  const issues = [{ message: 'Unrecognized key: "tags"', keys: ['tags'] }];
  const schema = { properties: { id: {}, title: {}, body: {}, severity: {} } };

  it('names the owning tool for a redirected key', () => {
    const out = unknownArgHint(issues, schema, { tags: 'work_items:tag { id, topic }' });
    expect(out).toContain('`tags` is not an arg of this tool');
    expect(out).toContain('work_items:tag { id, topic }');
  });

  it('CONTROL: without a redirect the same rejection names no owner (the bug)', () => {
    const out = unknownArgHint(issues, schema);
    expect(out).toContain('this tool accepts ONLY');
    expect(out).not.toContain('work_items:tag');
    expect(out).not.toContain('is not an arg of this tool');
  });

  it('an authored redirect OUTRANKS an edit-distance guess, and suppresses it', () => {
    // `summary` would otherwise be corrected to the near-name `summry`; an authored
    // statement of fact must beat a string-distance heuristic, and the contradictory
    // guess must not also be emitted.
    const competing = [{ message: 'Unrecognized key: "summary"', keys: ['summary'] }];
    const out = unknownArgHint(competing, { properties: { id: {}, summry: {} } }, {
      summary: 'some_other:tool { id, summary }',
    });
    expect(out).toContain('some_other:tool { id, summary }');
    expect(out).not.toContain('Did you mean');
  });

  it('leaves NON-redirected unknown keys on the existing correction paths', () => {
    // Regression guard: adding a redirect map must not disturb the two sources that
    // were already there. `summry` still edit-distances to `summary`.
    const out = unknownArgHint(
      [{ message: 'Unrecognized key: "summry"', keys: ['summry'] }],
      { properties: { id: {}, summary: {} } },
      { tags: 'work_items:tag { id, topic }' },
    );
    expect(out).toContain('Did you mean `summary` for `summry`?');
    expect(out).not.toContain('work_items:tag');
  });

  it('an empty-string redirect target falls through rather than emitting a blank pointer', () => {
    const out = unknownArgHint(issues, schema, { tags: '' });
    expect(out).not.toContain('is not an arg of this tool');
  });

  it('END-TO-END: the rendered hint routes around a value-incompatible target (EI-21390759884688723)', () => {
    // The whole point of EI-10883's loud rejection is that ONE failed call teaches the
    // corrected call. A hint naming a target that cannot hold the value inverts that,
    // so assert on the message the caller actually reads, not just the suggester.
    const presenceSchema = {
      properties: {
        scope: { type: 'string', enum: ['hive', 'workspace', 'all'] },
        pot: { type: 'string' },
        owner: { type: 'string' },
      },
    };
    const rejection = [{ message: 'Unrecognized key: "harness"', keys: ['harness'] }];
    const out = unknownArgHint(rejection, presenceSchema, undefined, { harness: 'papercusp' });
    expect(out).toContain('Did you mean `pot` for `harness`?');
    expect(out).not.toContain('`scope` for `harness`');
    // CONTROL: with no input threaded through, the pre-fix misdirection is what appears —
    // this is what makes the assertion above a real measurement rather than a tautology.
    expect(unknownArgHint(rejection, presenceSchema)).toContain('`scope` for `harness`');
  });
});

describe('unknownArgHint same-tool relocation vs cross-tool redirect (EI-21119949290826530)', () => {
  // An authored redirect means two different things and only the CROSS-TOOL one was
  // rendered. `improvements:capture` already redirects `linkTo -> observation.linkTo`
  // (a move within its OWN schema) and the message read "`linkTo` is not an arg of
  // this tool — it is written by observation.linkTo", i.e. it told a caller who merely
  // nested a field wrongly that some other TOOL owns their data. Independently
  // observed as "argRedirects has no same-tool alias form" (EI-22174773207603281).
  const schema = { properties: { title: {}, body: {}, observation: {}, toolFailure: {} } };

  it('renders a SAME-TOOL target as a relocation, not as another tool', () => {
    const issues = [{ message: 'Unrecognized key: "linkTo"', keys: ['linkTo'] }];
    const out = unknownArgHint(issues, schema, { linkTo: 'observation.linkTo' });
    expect(out).toContain('`linkTo` is not a top-level arg of this tool');
    expect(out).toContain('pass it as `observation.linkTo` instead');
    // The cross-tool phrasing must NOT appear: it is the defect being fixed.
    expect(out).not.toContain('it is written by');
  });

  it('still renders a CROSS-TOOL target as the owning tool (EI-20281509195248260 intact)', () => {
    const issues = [{ message: 'Unrecognized key: "tags"', keys: ['tags'] }];
    const out = unknownArgHint(issues, schema, { tags: 'work_items:tag { id, topic }' });
    expect(out).toContain('it is written by work_items:tag { id, topic }');
    expect(out).not.toContain('pass it as');
  });

  it('routes a bare top-level `evidence` to `body` (the capture case)', () => {
    const issues = [{ message: 'Unrecognized key: "evidence"', keys: ['evidence'] }];
    const out = unknownArgHint(issues, schema, { evidence: 'body' });
    expect(out).toContain('pass it as `body` instead');
  });

  it('classifies targets from the tool\'s OWN keys, so a redirect needs no extra flag', () => {
    expect(isLocalSchemaTarget('body', ['title', 'body'])).toBe(true);
    expect(isLocalSchemaTarget('observation.linkTo', ['observation'])).toBe(true);
    // A rendered tool call carries a space/`{`/`:` and can never look like a local path.
    expect(isLocalSchemaTarget('work_items:tag { id, topic }', ['body'])).toBe(false);
    // A dotted path whose ROOT this tool does not declare is not local either.
    expect(isLocalSchemaTarget('other.field', ['body'])).toBe(false);
  });
});

describe('unknownArgHint tools:invoke envelope hint (EI-21826333890701824)', () => {
  // Wrapping a DIRECT verb call in `tools:invoke`'s `{ name, args }` envelope is a
  // recurring caller error whose remedy the generic message cannot express: it
  // truthfully reports two unknown keys, leaving the caller to infer that their call
  // SHAPE — not their field names — was wrong.
  const schema = { properties: { title: {}, kind: {}, body: {} } };
  const issues = [{ message: 'Unrecognized keys: "name", "args"', keys: ['name', 'args'] }];

  it('names the envelope and both correct forms', () => {
    const out = unknownArgHint(issues, schema, undefined, { name: 'improvements:capture', args: {} });
    expect(out).toContain('`tools:invoke` ENVELOPE');
    expect(out).toContain('directly with its own declared args at top level');
    expect(out).toContain('tools:invoke { name, args }');
  });

  it('does NOT fire for the meta-dispatcher that genuinely declares name/args', () => {
    const invokeSchema = { properties: { name: {}, args: {} } };
    const soloIssue = [{ message: 'Unrecognized key: "tool"', keys: ['tool'] }];
    const out = unknownArgHint(soloIssue, invokeSchema, undefined, { tool: 'x' });
    expect(out).not.toContain('ENVELOPE');
  });

  it('does NOT fire when only ONE of the two envelope keys is present', () => {
    const oneKey = [{ message: 'Unrecognized key: "name"', keys: ['name'] }];
    const out = unknownArgHint(oneKey, schema, undefined, { name: 'x' });
    expect(out).toContain('this tool accepts ONLY');
    expect(out).not.toContain('ENVELOPE');
  });
});

describe('unknownArgHint _meta request-envelope hint (EI-21675134570053141)', () => {
  // `_meta` rides the JSON-RPC `params`, beside the tool's `arguments` — so a caller who
  // puts it INSIDE args gets an ordinary unrecognized-key rejection that cannot say which
  // LAYER the key belongs to. The measured filing concluded a timed-out claim could not be
  // replayed at all; the replay was in fact already automatic at the proxy.
  const schema = { properties: { harness: {}, heldPaths: {}, states: {} } };
  const issues = [{ message: 'Unrecognized key: "_meta"', keys: ['_meta'] }];

  it('names the envelope AND that the key is injected for you', () => {
    const out = unknownArgHint(issues, schema, undefined, {
      _meta: { idempotencyKey: 'k-1' },
    });
    expect(out).toContain('MCP request ENVELOPE');
    expect(out).toContain('reuses it across retries');
  });

  it('does NOT fire for a tool that genuinely declares _meta', () => {
    const metaSchema = { properties: { _meta: {}, harness: {} } };
    const other = [{ message: 'Unrecognized key: "nope"', keys: ['nope'] }];
    const out = unknownArgHint(other, metaSchema, undefined, { nope: 1 });
    expect(out).not.toContain('MCP request ENVELOPE');
  });
});

describe('siblingToolArgOwner (EI-21681203906419973)', () => {
  // `scheduler:get_next` was called with `count` — a real, documented argument, of the
  // SIBLING verb its own see-also names. No revision of get_next ever declared it, so the
  // bare "accepts ONLY" rejection read as live-build/doc drift rather than a wrong target.
  type SiblingRow = { name: string; inputSchema?: unknown; guidance?: { seeAlso?: unknown } };
  const toolRows: SiblingRow[] = [
    {
      name: 'scheduler:get_next',
      inputSchema: { properties: { harness: {}, heldPaths: {}, states: {} } },
      guidance: {
        seeAlso: [
          'work_items:claimable (how many are claimable, WITHOUT claiming)',
          'work_items:claim_next (plain oldest-first self-select, no spec)',
        ],
      },
    },
    { name: 'work_items:claim_next', inputSchema: { properties: { harness: {}, count: {} } } },
    { name: 'work_items:claimable', inputSchema: { properties: { harness: {} } } },
    // Declares `count` but is NOT in get_next's see-also — the scope control.
    { name: 'unrelated:census', inputSchema: { properties: { count: {} } } },
  ];
  // Production passes `resolveMcpName`; a projected row carries no `name` of its own (the
  // registry is keyed by it), so the helper takes a by-name resolver rather than a list.
  const lookup =
    (rows: readonly SiblingRow[]) =>
    (name: string): SiblingRow | null =>
      rows.find((row) => row.name === name) ?? null;
  const tools = lookup(toolRows);

  it('names the see-also sibling that declares the rejected key', () => {
    expect(siblingToolArgOwner('scheduler:get_next', 'count', tools)).toBe('work_items:claim_next');
  });

  it('accepts a structured see-also pointer, not just a leading-token string', () => {
    const pointerRows = [
      {
        name: 'a:one',
        inputSchema: { properties: { x: {} } },
        guidance: { seeAlso: [{ tool: 'b:two', reason: 'the other lens' }] },
      },
      { name: 'b:two', inputSchema: { properties: { cursor: {} } } },
    ];
    expect(siblingToolArgOwner('a:one', 'cursor', lookup(pointerRows))).toBe('b:two');
  });

  it('stays silent for a key no see-also sibling declares', () => {
    expect(siblingToolArgOwner('scheduler:get_next', 'bogusArg', tools)).toBeNull();
  });

  it('does NOT reach outside see-also, even when another tool declares the key', () => {
    const narrow = toolRows.map((tool) =>
      tool.name === 'scheduler:get_next'
        ? { ...tool, guidance: { seeAlso: ['work_items:claimable (no count here)'] } }
        : tool,
    );
    // `unrelated:census` and `work_items:claim_next` both declare `count`; neither is linked.
    expect(siblingToolArgOwner('scheduler:get_next', 'count', lookup(narrow))).toBeNull();
  });

  it('stays silent for a function-form (runtime-resolved) see-also', () => {
    const runtime = [
      { name: 'a:one', inputSchema: { properties: {} }, guidance: { seeAlso: 'runtime-resolved' } },
      { name: 'b:two', inputSchema: { properties: { count: {} } } },
    ];
    expect(siblingToolArgOwner('a:one', 'count', lookup(runtime))).toBeNull();
  });

  it('stays silent without a tool name, and for an unregistered tool', () => {
    expect(siblingToolArgOwner(undefined, 'count', tools)).toBeNull();
    expect(siblingToolArgOwner('nope:missing', 'count', tools)).toBeNull();
  });
});

describe('unknownArgHint on a union-rooted schema (EI-22084251948568820)', () => {
  // Mirrors capability:launch-agent's top-level `z.union([freshBranch, resumeBranch])`
  // args shape (StandardSchemaV1.Issue, real Zod 4 output, real JSON-Schema conversion —
  // not hand-built fixtures, so this proves the actual production path). Two independent
  // pre-fix gaps compound here: (1) `rawSchema.properties` is undefined for a union root
  // (the real shape is `{ anyOf: [...] }`), so the "what does this tool accept" listing
  // came back empty; (2) an `invalid_union` issue's own top-level `.message` is Zod's
  // generic "Invalid input" — the real "Unrecognized key" diagnosis lives in the
  // best-matching branch's sub-issues (see `issueLeaves`/`bestUnionBranch`) — so the
  // `/nrecognized key/i` detector never fired at all. Before this fix `unknownArgHint`
  // returned the EMPTY STRING for every union-rooted tool on an unrecognized key: no
  // "accepts ONLY" listing, no near-name guess, no argRedirects — the whole correction
  // mechanism silently skipped for exactly the tools most likely to need it.
  const freshBranch = z.strictObject({
    brief: z.string(),
    agent: z.string().optional(),
  });
  const resumeBranch = z.strictObject({
    resume: z.object({ agentId: z.string() }),
    brief: z.string(),
  });
  const schema = strictArgs(z.union([freshBranch, resumeBranch]));
  const rawSchema = toArgsJsonSchema('test:union-tool', schema);

  it('reports the merged accepted-key set for an unrecognized key on a union root (no top-level .properties)', () => {
    const r = (schema as z.ZodTypeAny).safeParse({ brief: 'do the thing', carry: 'warm' });
    expect(r.success).toBe(false);
    if (r.success) return;
    const out = unknownArgHint(r.error.issues, rawSchema);
    // Pre-fix: this was ''. The regex never matched the union's own generic message,
    // and even if it had, `rawSchema.properties` is undefined for `{ anyOf: [...] }` —
    // so `keys.length === 0` short-circuited to '' regardless.
    expect(out).not.toBe('');
    expect(out).toContain('this tool accepts ONLY');
    // Merged from BOTH branches — proof `mergedSchemaProperties` descended `anyOf`.
    expect(out).toContain('brief');
    expect(out).toContain('agent');
    expect(out).toContain('resume');

    // CONTROL, falsifiability per CLAUDE.md § "Proving a guard is falsifiable": the
    // pre-fix logic verbatim (top-level `issue.message` + `rawSchema.properties`
    // directly, no leaf descent, no anyOf merge) must reproduce the empty-string bug on
    // this exact input — otherwise the assertions above are not testing anything real.
    const legacyMsgs = r.error.issues.map((i) => i.message).join(' ');
    expect(/nrecognized key/i.test(legacyMsgs)).toBe(false);
    expect((rawSchema as { properties?: unknown }).properties).toBeUndefined();
  });

  it('routes an authored argRedirects entry through a union branch, not just a flat schema', () => {
    // The exact capability:launch-agent shape: `carry` genuinely belongs elsewhere
    // (a fleet member's own field), so the redirect must fire even though the
    // rejection arrives nested inside an `invalid_union` issue rather than a flat
    // `unrecognized_keys` one at the top level.
    const r = (schema as z.ZodTypeAny).safeParse({ brief: 'do the thing', carry: 'warm' });
    expect(r.success).toBe(false);
    if (r.success) return;
    const out = unknownArgHint(r.error.issues, rawSchema, {
      carry: "loop:arm { carry } — set on the LAUNCHED agent's own recurring wake.",
    });
    expect(out).toContain('`carry` is not an arg of this tool');
    expect(out).toContain('loop:arm { carry }');
    // The redirected key must not ALSO draw a contradictory near-name guess.
    expect(out).not.toContain('Did you mean');
  });
});

describe('suggestArgName', () => {
  it('corrects a typo to the nearest declared field', () => {
    expect(suggestArgName('summry', ['id', 'summary', 'harness'])).toBe('summary');
  });

  it('maps common CRUD aliases to the valid name exposed by this tool', () => {
    expect(suggestArgName('assignee', ['id', 'assign_to', 'state'])).toBe('assign_to');
    expect(suggestArgName('summary', ['id', 'body', 'confirmShrink'])).toBe('body');
    expect(suggestArgName('found_during', ['id', 'foundDuring'])).toBe('foundDuring');
  });

  it('teaches the canonical alpha-stage vocabulary without accepting aliases', () => {
    expect(suggestArgName('rubricId', ['rubricRef', 'rubricRefs'])).toBe('rubricRef');
    expect(suggestArgName('rubricIds', ['rubricRef', 'rubricRefs'])).toBe('rubricRefs');
    expect(suggestArgName('itemId', ['slug', 'item', 'itemIds'])).toBe('item');
    expect(suggestArgName('body', ['slug', 'content', 'ownerEmail'])).toBe('content');
    expect(suggestArgName('description', ['slug', 'content'])).toBe('content');
    expect(suggestArgName('owner', ['slug', 'ownerEmail'])).toBe('ownerEmail');
    expect(suggestArgName('code', ['script', 'timeout_ms'])).toBe('script');
  });

  /**
   * EI-21670512679890540 / EI-21679236680294291 — `<declaredKey><TypeSuffix>`.
   *
   * Distance scores by characters, so a 4-char suffix (`plan` -> `planSlug`) exceeds
   * the `max(len)/3` threshold of 2 and the match was refused. The caller was then
   * told the tool "declares no counterpart" and handed a corrected call with `plan`
   * DROPPED — invalid, since `plan` is required. Two agents hit it 2h19m apart.
   */
  it('maps a declared key wearing a type suffix (EI-21670512679890540)', () => {
    expect(suggestArgName('planSlug', ['plan', 'harness'])).toBe('plan');
    expect(suggestArgName('plan_slug', ['plan', 'harness'])).toBe('plan');
    expect(suggestArgName('harnessName', ['plan', 'harness'])).toBe('harness');
    expect(suggestArgName('scopeRef', ['scope', 'body'])).toBe('scope');
  });

  /**
   * The CONTROL for the rule above, and the reason it is a closed suffix set rather
   * than a prefix or containment test: `planetarium` starts with `plan` too. A general
   * rule would relocate an unrelated argument onto `plan` with full confidence — the
   * precise failure (a confident misdirection teaching a false vocabulary) that the
   * suffix rung is meant to fix, merely pointed elsewhere.
   */
  it('does not treat an arbitrary prefix as a type suffix', () => {
    expect(suggestArgName('planetarium', ['plan', 'harness'])).not.toBe('plan');
    expect(suggestArgName('keyboard', ['key', 'harness'])).not.toBe('key');
  });

  /**
   * ISOLATION CONTROL — proves the SUFFIX SET produced the match above, not a widened
   * distance rule. `planSlug` and `planZorf` are both 8 chars and both sit at edit
   * distance 4 from `plan`, past the threshold of 2; the only thing separating them is
   * membership in ARG_TYPE_SUFFIXES. Without this pair, a future change that simply
   * loosened the distance threshold would keep the tests above green while quietly
   * reintroducing the confident-misdirection failure they exist to prevent.
   */
  it('matches on suffix-set membership, not on a loosened edit distance', () => {
    expect(suggestArgName('planSlug', ['plan', 'harness'])).toBe('plan');
    expect(suggestArgName('planZorf', ['plan', 'harness'])).toBeNull();
  });

  /**
   * EI-21667775013157341 — the REVERSE of the suffix rung above: here the CALLER's name
   * is the short one and the DECLARED key spells out which plan relation it means
   * (`sourcePlanSlug` on work_items:list, `current_plan_slug` on coord:declare-intent).
   * Distance cannot rescue it — `plan` sits 10 edits from `sourceplanslug` against a
   * threshold capped at 3 — and the containment test that would catch it is refused for
   * the same reason the prefix test above is refused, so this is carried as a curated
   * alias entry instead.
   *
   * Worth more than a saved round-trip: the natural recovery from "this tool declares no
   * counterpart" is to DROP the filter, and dropping THIS one does not fail — it silently
   * widens the read from one plan to every plan.
   */
  it('suggests the spelled-out plan key for the short name `plan`', () => {
    expect(suggestArgName('plan', ['harness', 'q', 'sourcePlanSlug', 'limit'])).toBe('sourcePlanSlug');
    expect(suggestArgName('plan', ['intent', 'current_plan_slug', 'items'])).toBe('current_plan_slug');
  });

  /**
   * ISOLATION CONTROLS for the alias above — one per direction of its blast radius.
   *
   * A tool declaring NO plan counterpart must stay SILENT: there, "declares no
   * counterpart" is TRUE, and manufacturing a relocation would be precisely the
   * confident misdirection this file exists to prevent. The fixture is the real accepted
   * set from EI-21680072657147477, which reported this same short name against
   * plan_items:my_items — a row that must stay correctly unfixed by this change.
   *
   * And a tool that genuinely declares `plan` must keep its own vocabulary through the
   * exact-declared-match precedence, never be redirected into the alias list.
   */
  it('stays silent with no plan counterpart, and never overrides a declared `plan`', () => {
    expect(suggestArgName('plan', ['agent_name', 'harness'])).toBeNull();
    expect(suggestArgName('plan', ['plan', 'sourcePlanSlug'])).toBe('plan');
  });

  /**
   * A suffix match must not override proof that the destination cannot hold the value
   * (`candidateRefutesValue`): `scope` here is an enum that does not admit the slug,
   * so the relocation is refuted and the rung stays silent rather than advising a
   * move that would fail on the next call.
   */
  it('does not suffix-match onto a destination whose enum refuses the value', () => {
    expect(
      suggestArgName('scopeRef', ['scope', 'harness'], {
        value: 'papercusp',
        props: { scope: { enum: ['workspace', 'owner'] } },
      }),
    ).not.toBe('scope');
  });

  it('maps the EI-13475 semantic near-synonyms distance alone cannot reach', () => {
    // The 2026-07-17 live incidents, verbatim: plans:new { summary } and
    // improvements:capture { harness } both got a bare key list because the
    // alias map lacked these entries (edit distance 7 is over threshold).
    expect(suggestArgName('summary', ['harness', 'slug', 'title', 'status', 'rationale', 'content', 'force'])).toBe('content');
    expect(suggestArgName('harness', ['title', 'kind', 'body', 'severity', 'scope', 'foundDuring'])).toBe('scope');
    expect(suggestArgName('scope', ['slug', 'harness', 'title'])).toBe('harness');
    // Appending `content` to summary's aliases must NOT shift tools where an
    // earlier alias already matches (body outranks content by list order).
    expect(suggestArgName('summary', ['id', 'body', 'content'])).toBe('body');
  });

  it('does not invent a correction for an unrelated field', () => {
    expect(suggestArgName('completelyDifferent', ['id', 'state', 'harness'])).toBeNull();
  });

  it('refuses a name-correct suggestion whose target provably cannot hold the value (EI-21390759884688723)', () => {
    // MEASURED 2026-08-31: `coord:presence { harness: 'papercusp' }` was answered with
    // "Did you mean `scope` for `harness`?", but that tool's `scope` is an enum of
    // hive|workspace|all — so obeying the hint produced a SECOND invalid_args
    // (`scope: Invalid option: expected one of "hive"|"workspace"|"all"`). The call
    // that actually works is `pot: '<harness slug>'`.
    const presenceProps = {
      scope: { type: 'string', enum: ['hive', 'workspace', 'all'] },
      pot: { type: 'string' },
      workspace: { type: 'string' },
      owner: { type: 'string' },
    };
    const accepted = Object.keys(presenceProps);
    expect(suggestArgName('harness', accepted, { value: 'papercusp', props: presenceProps })).toBe('pot');
    // The refutation is VALUE-specific, not a blanket ban on the enum key: a caller who
    // did pass an admissible member is still sent to `scope`.
    expect(suggestArgName('harness', accepted, { value: 'workspace', props: presenceProps })).toBe('scope');
  });

  it('keeps harness -> scope where scope genuinely takes a slug', () => {
    // The SAME alias pair is CORRECT on improvements:capture, whose `scope` is a free
    // string (pinned above at the EI-13475 case). This is why the fix could not simply
    // drop the alias: the discriminator is the target's admissibility, not the name pair.
    const captureProps = {
      title: { type: 'string' },
      kind: { type: 'string' },
      scope: { type: 'string' },
      foundDuring: { type: 'string' },
    };
    expect(
      suggestArgName('harness', Object.keys(captureProps), { value: 'papercusp', props: captureProps }),
    ).toBe('scope');
  });

  it('stays silent rather than misdirecting when no viable target remains', () => {
    // No `pot` declared and `scope` refuted. A suggestion that cannot work costs a
    // guaranteed extra round-trip AND teaches a false vocabulary the caller carries to
    // other tools, so no suggestion is the better answer.
    const props = { scope: { enum: ['hive', 'all'] }, limit: { type: 'number' } };
    expect(suggestArgName('harness', ['scope', 'limit'], { value: 'papercusp', props })).toBeNull();
  });

  it('treats only enum/const as proof — it never guesses from type', () => {
    // `const` enumerates the admissible set exactly as an enum does.
    expect(
      suggestArgName('harness', ['scope'], { value: 'papercusp', props: { scope: { const: 'hive' } } }),
    ).toBeNull();
    // An unconstrained target yields NO proof, so the name-based suggestion stands — a
    // wrong suppression would be exactly as harmful as the wrong suggestion, just quieter.
    expect(
      suggestArgName('harness', ['scope'], { value: 'papercusp', props: { scope: { type: 'number' } } }),
    ).toBe('scope');
    // A structured value against an enum of primitives is not decidable by identity.
    expect(
      suggestArgName('harness', ['scope'], {
        value: { slug: 'papercusp' },
        props: { scope: { enum: ['hive'] } },
      }),
    ).toBe('scope');
  });

  it('is name-only when no value is supplied — every existing caller is unaffected', () => {
    // The opts bag is optional, and a value-less call cannot refute anything, so
    // behaviour is exactly as it was before the filter existed.
    expect(suggestArgName('harness', ['scope', 'pot'])).toBe('scope');
    expect(suggestArgName('harness', ['scope', 'pot'], { props: { scope: { enum: ['hive'] } } })).toBe('scope');
  });

  it('maps the WI-38059 measured burst — the natural-language spellings agents actually reach for', () => {
    // Verbatim from EIGHT arg-shape rejections in ~35 min of one agent's ordinary
    // work (EI-20204653748131789). Each was correct-intent/wrong-spelling, and each
    // was verified to fall OUTSIDE the edit-distance threshold before this fix, so
    // the caller got a bare key list and had to re-read a schema.
    // memory:remember { text, category } → { content, kind }
    expect(suggestArgName('text', ['content', 'kind', 'harness_slug', 'force'])).toBe('content');
    expect(suggestArgName('category', ['content', 'kind', 'harness_slug', 'force'])).toBe('kind');
    // facts:assert { value, ttl_days } → { body, ttlSec }
    expect(suggestArgName('value', ['scope', 'key', 'body', 'ttlSec'])).toBe('body');
    expect(suggestArgName('ttl_days', ['scope', 'key', 'body', 'ttlSec'])).toBe('ttlSec');
    // The inverse direction must work too — a tool naming it `category` should
    // catch a caller who typed `kind`.
    expect(suggestArgName('kind', ['category', 'label'])).toBe('category');
  });

  it('maps the EI-20246935995110683 q/query cross-tool near-synonym, both directions', () => {
    // The live filing: search:fulltext { q } was refused with a bare key list.
    // `q` is not a typo — `issues:list` declares `q` and the search tools declare
    // `query`, so the two spellings are BOTH live in this catalogue.
    expect(suggestArgName('q', ['query', 'scope', 'harness_slug', 'limit'])).toBe('query');
    // …and the inverse, for the caller who learned `query` from the search tools.
    expect(suggestArgName('query', ['q', 'state', 'assignee', 'limit'])).toBe('q');
    expect(suggestArgName('search', ['query', 'scope'])).toBe('query');
    // Pin WHY the alias row is needed at all: distance alone can never reach it.
    // compact('q')→compact('query') is 4 against a threshold of 1, so a tool with
    // no `query`-ish field must still produce NO suggestion rather than a guess.
    expect(suggestArgName('q', ['harness', 'limit', 'state'])).toBeNull();
  });

  it('does not let the new aliases hijack a tool that declares the typed name itself', () => {
    // `q` and `query` are aliases of each other, so each must lose to a declared
    // field of its own name — otherwise issues:list would be told to rename its
    // real `q` arg to `query` and vice versa.
    expect(suggestArgName('q', ['q', 'query'])).toBe('q');
    expect(suggestArgName('query', ['query', 'q'])).toBe('query');
    // Regression guard for the real risk of widening an alias map: `text` must not
    // out-rank a declared `text`, and a tool exposing BOTH gets the earlier alias
    // by list order, never a surprise remap.
    expect(suggestArgName('text', ['text', 'content'])).toBe('text');
    expect(suggestArgName('value', ['value', 'body'])).toBe('value');
    expect(suggestArgName('ttl', ['ttlSec', 'ttlMs'])).toBe('ttlSec');
  });
});

describe('nestedArgPaths (WI-38059) — a relocation, not a typo', () => {
  it('maps a key declared one level down to its dotted path', () => {
    // The observed case: improvements:capture rejects top-level `refs`, but `refs`
    // genuinely exists at observation.refs. Before this, the rejection read as
    // "this tool has no refs concept", so the natural fix was to DROP the arg and
    // silently lose the attribution it carried — quieter, and worse, than a retry.
    const nested = nestedArgPaths({
      title: { type: 'string' },
      observation: {
        type: 'object',
        properties: { refs: { type: 'array' }, ratings: { type: 'object' }, subject: { type: 'object' } },
      },
    });
    expect(nested.get('refs')).toBe('observation.refs');
    expect(nested.get('subject')).toBe('observation.subject');
  });

  it('returns nothing for a schema with no nested objects (no false relocations)', () => {
    expect(nestedArgPaths({ id: { type: 'string' }, state: { type: 'string' } }).size).toBe(0);
    expect(nestedArgPaths(undefined).size).toBe(0);
  });

  it('is first-declaration-wins on a collision, and never claims a top-level name', () => {
    // Deliberately narrow: this exists to name an obvious relocation, not to search
    // a schema tree. An ambiguous child resolves to the first parent that declared
    // it rather than guessing between them.
    const nested = nestedArgPaths({
      alpha: { type: 'object', properties: { shared: { type: 'string' } } },
      beta: { type: 'object', properties: { shared: { type: 'string' } } },
    });
    expect(nested.get('shared')).toBe('alpha.shared');
  });
});
