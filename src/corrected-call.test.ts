import { describe, expect, it } from 'vitest';
import {
  buildCorrectedCall,
  correctedCallHint,
  mutuallyExclusiveArgConflicts,
} from './corrected-call';
import {
  argsAcceptedOnOtherVariant,
  invalidInputCorrections,
  unrecognizedArgKeys,
} from './define-tool';
import type { InvalidInputCorrection } from './dispatch-types';

/**
 * P-015 (coordination-spec-adoption-2026-08-03). The property under test is D-105's
 * sharpened R-2: a refusal must return the CORRECTED CALL resolved against the arguments
 * actually passed — not the vocabulary, and not the schema.
 *
 * A deliberately-wrong control lives at the bottom rather than a mutation of the real
 * source: the repo's mutation-probe guidance forbids mutating the shared tree to prove a
 * guard falsifiable, and a permanent in-file control needs no sweep lock and cannot be
 * committed half-applied.
 */

const near = (rejectedArg: string, target: string): InvalidInputCorrection => ({
  rejectedArg,
  target,
  kind: 'near-name',
});

describe('buildCorrectedCall', () => {
  it('relocates a near-name key and PRESERVES every other arg the caller sent', () => {
    const corrected = buildCorrectedCall({
      toolName: 'work_items:create',
      input: { kind: 'bug', titel: 'a typo', harness: 'papercusp' },
      corrections: [near('titel', 'title')],
      unknownKeys: ['titel'],
    });

    expect(corrected).not.toBeNull();
    // The relocation happened...
    expect(corrected!.args).toEqual({ kind: 'bug', title: 'a typo', harness: 'papercusp' });
    // ...and the untouched args survived it. A "corrected" call that silently drops the
    // caller's other arguments is worse than the refusal, because it looks authoritative.
    expect(corrected!.args.harness).toBe('papercusp');
    expect(corrected!.droppedUnaccepted).toBe(false);
    expect(corrected!.steps).toEqual([
      { rejectedArg: 'titel', action: 'relocated', target: 'title', kind: 'near-name' },
    ]);
  });

  it('wraps a scalar relocation only when the projected destination is an array', () => {
    const targetSchema = {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' } },
        title: { type: 'string' },
      },
    };
    const corrected = buildCorrectedCall({
      toolName: 'plans:get',
      input: { item: 'P-001', title: 'keep scalar' },
      corrections: [near('item', 'items')],
      unknownKeys: ['item'],
      targetSchema,
    });

    expect(corrected!.args).toEqual({ items: ['P-001'], title: 'keep scalar' });
  });

  it('preserves arrays and scalar destinations during relocation', () => {
    const targetSchema = {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' } },
        title: { type: 'string' },
      },
    };
    const arrayValue = buildCorrectedCall({
      toolName: 'plans:get',
      input: { item: ['P-001'] },
      corrections: [near('item', 'items')],
      unknownKeys: ['item'],
      targetSchema,
    });
    const scalarValue = buildCorrectedCall({
      toolName: 'plans:get',
      input: { titel: 'P-001' },
      corrections: [near('titel', 'title')],
      unknownKeys: ['titel'],
      targetSchema,
    });

    expect(arrayValue!.args).toEqual({ items: ['P-001'] });
    expect(scalarValue!.args).toEqual({ title: 'P-001' });
  });

  /**
   * The D-105 case, and the reason this helper exists at all. `omp:sessions` rejected 66
   * calls from ten agents — every one `Unrecognized key: "cwd"` — while returning its
   * ENTIRE args schema. Nothing in that schema says what to do with `cwd`, because the
   * answer is that there is nothing to do with it. The honest correction is to drop it.
   */
  it('drops an unrecognized key that has NO counterpart, rather than leaving a schema wall', () => {
    const corrected = buildCorrectedCall({
      toolName: 'omp:sessions',
      input: { cwd: '/home/dev/project', limit: 10 },
      corrections: [],
      unknownKeys: ['cwd'],
    });

    expect(corrected).not.toBeNull();
    expect(corrected!.args).toEqual({ limit: 10 });
    expect(corrected!.droppedUnaccepted).toBe(true);
    expect(corrected!.steps).toEqual([{ rejectedArg: 'cwd', action: 'dropped' }]);

    const hint = correctedCallHint(corrected);
    expect(hint).toContain('omp:sessions({ "limit": 10 })');
    // It must say WHY, or the next agent goes looking for the synonym that is not there.
    expect(hint).toContain('declares no counterpart');
  });

  it('routes a nested-path correction to its dotted destination', () => {
    const corrected = buildCorrectedCall({
      toolName: 'work_items:create',
      input: { severity: 'major', title: 't' },
      corrections: [{ rejectedArg: 'severity', target: 'payload.severity', kind: 'nested-path' }],
      unknownKeys: ['severity'],
    });

    expect(corrected!.args).toEqual({ title: 't', payload: { severity: 'major' } });
  });

  it('never overwrites a value the caller already sent at the destination path', () => {
    // `payload` is a scalar here, so descending into it would destroy the caller's data.
    // Degrading to `dropped` is the only non-lossy option; silently clobbering would make
    // the corrected call wrong in a way the caller cannot see.
    const corrected = buildCorrectedCall({
      toolName: 'work_items:create',
      input: { severity: 'major', payload: 'not-an-object' },
      corrections: [{ rejectedArg: 'severity', target: 'payload.severity', kind: 'nested-path' }],
      unknownKeys: ['severity'],
    });

    expect(corrected!.args).toEqual({ payload: 'not-an-object' });
    expect(corrected!.steps).toEqual([{ rejectedArg: 'severity', action: 'dropped' }]);
  });

  /**
   * D-104 keeps cross-tool redirects out of the auto-shaped call: the value belongs to a
   * DIFFERENT tool, so there is no in-call destination for it. The key must still leave
   * this call (keeping it re-triggers the identical rejection), and `unknownArgHint`
   * separately renders the redirect's own target.
   */
  it('drops an authored cross-tool redirect from THIS call without inventing a local home', () => {
    const corrected = buildCorrectedCall({
      toolName: 'work_items:update',
      input: { id: 'WI-1', tags: ['a'] },
      corrections: [{ rejectedArg: 'tags', target: 'topics:tag', kind: 'authored-redirect' }],
      unknownKeys: ['tags'],
    });

    expect(corrected!.args).toEqual({ id: 'WI-1' });
    // Crucially NOT relocated into a local `topics:tag` key, which does not exist here.
    expect(corrected!.args['topics:tag']).toBeUndefined();
  });

  it('fills a same-tool authored call shape without discarding accepted caller values', () => {
    const corrected = buildCorrectedCall({
      toolName: 'work_items:tag',
      input: { id: 'WI-1', tags: ['infra'] },
      corrections: [
        {
          rejectedArg: 'tags',
          target: 'work_items:tag({ "id": "<work-item-id>", "topic": "<topic>" })',
          kind: 'authored-redirect',
          call: {
            tool: 'work_items:tag',
            args: { id: '<work-item-id>', topic: '<topic>' },
            source: 'projected-tool-registry',
            registryRevision: 'test-revision',
          },
        },
      ],
      unknownKeys: ['tags'],
    });

    expect(corrected!.args).toEqual({ id: 'WI-1', topic: '<topic>' });
    expect(corrected!.steps).toEqual([
      { rejectedArg: 'tags', action: 'dropped', reason: 'authored-call' },
    ]);
    const hint = correctedCallHint(corrected);
    expect(hint).toContain('work_items:tag({ "id": "WI-1", "topic": "<topic>" })');
    expect(hint).toContain('authored same-tool call shape');
    expect(hint).not.toContain('declares no counterpart');
  });

  it('elides a bulky value instead of truncating the caller data into the snippet', () => {
    const body = 'x'.repeat(5000);
    const corrected = buildCorrectedCall({
      toolName: 'work_items:create',
      input: { bodyy: body, title: 't' },
      corrections: [near('bodyy', 'body')],
      unknownKeys: ['bodyy'],
    });

    // Structured args keep the REAL value — P-016 has to be able to execute from it.
    expect(corrected!.args.body).toBe(body);
    // The rendered snippet does not, and stays bounded.
    expect(corrected!.rendered.length).toBeLessThan(900);
    expect(corrected!.rendered).not.toContain('xxxxxxxxxxxxxxxxxxxx');
    expect(corrected!.rendered).toContain('5000-char string');
  });

  it('returns null when nothing changed, so a refusal gains no empty flourish', () => {
    expect(
      buildCorrectedCall({
        toolName: 't',
        input: { a: 1 },
        corrections: [],
        unknownKeys: [],
      }),
    ).toBeNull();
    // Non-object input has no keys to correct.
    expect(
      buildCorrectedCall({ toolName: 't', input: 'a string', corrections: [], unknownKeys: ['a'] }),
    ).toBeNull();
    expect(correctedCallHint(null)).toBe('');
  });

  it('does not promise the corrected call validates', () => {
    const hint = correctedCallHint(
      buildCorrectedCall({
        toolName: 't',
        input: { titel: 'x' },
        corrections: [near('titel', 'title')],
        unknownKeys: ['titel'],
      }),
    );
    // The overclaim this guards against: an agent reading "corrected" as "will succeed",
    // then reporting a value-level failure as a tool bug.
    expect(hint).toContain('does not');
    expect(hint).toContain('guarantee');
  });
});

describe('known-key mutually-exclusive refinements', () => {
  const conflictIssues = [
    {
      path: ['patchCommit'],
      message: 'patchCommit requires a review reason and cannot combine with wholeBlob or includeHunksFrom',
    },
  ];

  it('extracts only the named conflicting keys the caller actually supplied', () => {
    expect(
      mutuallyExclusiveArgConflicts(conflictIssues, {
        patchCommit: 'a'.repeat(40),
        wholeBlob: true,
        unrelated: 'preserve me',
      }),
    ).toEqual([{ source: 'patchCommit', conflictingKeys: ['wholeBlob'] }]);
  });

  it('removes known conflicting options even when there are no unrecognized keys', () => {
    const input = {
      op: 'admit',
      paths: ['lib/red.test.ts'],
      patchCommit: 'a'.repeat(40),
      reason: 'reviewed patch source',
      wholeBlob: true,
      includeHunksFrom: ['peer'],
    };
    const corrected = buildCorrectedCall({
      toolName: 'release:repair-queue',
      input,
      corrections: [],
      unknownKeys: [],
      issues: conflictIssues,
    });

    expect(corrected).not.toBeNull();
    expect(corrected!.args).toEqual({
      op: 'admit',
      paths: ['lib/red.test.ts'],
      patchCommit: 'a'.repeat(40),
      reason: 'reviewed patch source',
    });
    expect(corrected!.steps).toEqual([
      {
        rejectedArg: 'wholeBlob',
        action: 'dropped',
        reason: 'mutually-exclusive',
        conflictsWith: 'patchCommit',
      },
      {
        rejectedArg: 'includeHunksFrom',
        action: 'dropped',
        reason: 'mutually-exclusive',
        conflictsWith: 'patchCommit',
      },
    ]);
    // These are valid keys individually; the correction is not an unaccepted-key drop.
    expect(corrected!.droppedUnaccepted).toBe(false);

    const hint = correctedCallHint(corrected);
    expect(hint).toContain('release:repair-queue(');
    expect(hint).toContain('"patchCommit"');
    expect(hint).not.toContain('"wholeBlob"');
    expect(hint).not.toContain('"includeHunksFrom"');
    expect(hint).toContain('keep the named source option');
  });

  it('fails closed for refinement wording that does not explicitly name an exclusion rule', () => {
    expect(
      mutuallyExclusiveArgConflicts(
        [{ path: ['patchCommit'], message: 'patchCommit is incompatible with wholeBlob' }],
        { patchCommit: 'a'.repeat(40), wholeBlob: true },
      ),
    ).toEqual([]);
  });
});

/**
 * The discriminated-union path, reproduced from the real `omp:sessions` schema — the verb
 * D-105 named, and the worst in D-104's table (66 rejections / 7d, 100% of its calls, ten
 * agents, ~6.6 attempts each). It declares `cwd` on op=list/search/link and NOT on
 * op=get/state, so a merged view of the branches reports `cwd` as accepted and the whole
 * correction mechanism stays silent on exactly the call that needed it.
 */
describe('unrecognizedArgKeys on a discriminated union', () => {
  const ompLike = {
    anyOf: [
      {
        properties: {
          op: { const: 'list' },
          limit: { type: 'number' },
          cwd: { type: 'string' },
        },
      },
      {
        properties: {
          op: { const: 'get' },
          sessionId: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    ],
  };
  const unrecognizedCwd = [{ message: 'Unrecognized key: "cwd"' }];

  it('MERGED view (no input) reports cwd as accepted — the silence this fixes', () => {
    // Pinned deliberately: this is the pre-fix behaviour, and it is still correct for the
    // "what could this tool ever accept" question `accepts ONLY:` answers.
    expect(unrecognizedArgKeys(unrecognizedCwd, ompLike)).toEqual([]);
  });

  it('BRANCH view flags cwd once the caller\'s own op selects the branch', () => {
    expect(
      unrecognizedArgKeys(unrecognizedCwd, ompLike, { op: 'get', sessionId: 's1', cwd: '/x' }),
    ).toEqual(['cwd']);
  });

  it('leaves a key alone when the selected branch DOES declare it', () => {
    expect(
      unrecognizedArgKeys(unrecognizedCwd, ompLike, { op: 'list', cwd: '/x' }),
    ).toEqual([]);
  });

  it('falls back to merged when the branch is ambiguous — fails CLOSED', () => {
    // No discriminator value supplied, so no branch is selectable. Reporting a legitimate
    // key as unrecognized here would advise dropping the caller's data.
    expect(unrecognizedArgKeys(unrecognizedCwd, ompLike, { cwd: '/x' })).toEqual([]);
    // An op matching no branch is equally ambiguous.
    expect(unrecognizedArgKeys(unrecognizedCwd, ompLike, { op: 'nope', cwd: '/x' })).toEqual([]);
  });

  it('never proposes a key as its own relocation target', () => {
    // The defect the operator-core end-to-end test caught. The merged pool contains `cwd`
    // (op=list/search/link declares it), so a name-only near-name search matches it
    // EXACTLY for an op='get' call and returns `cwd -> cwd`. buildCorrectedCall would then
    // setPath the value and delete the same key: the value is lost and the step claims
    // 'relocated'. Both the branch-aware pool and the explicit self-target guard prevent
    // it; this pins the outcome so neither can be removed silently.
    const corrections = invalidInputCorrections(
      unrecognizedCwd,
      ompLike,
      undefined,
      { op: 'get', sessionId: 's1', cwd: '/x' },
    );
    expect(corrections.filter((c) => c.rejectedArg === 'cwd' && c.target === 'cwd')).toEqual([]);
  });

  it('end-to-end: the omp:sessions call gets a corrected call that says WHY', () => {
    const input = { op: 'get', sessionId: 's1', cwd: '/home/dev/project' };
    const unknownKeys = unrecognizedArgKeys(unrecognizedCwd, ompLike, input);
    const corrected = buildCorrectedCall({
      toolName: 'omp:sessions',
      input,
      corrections: [],
      unknownKeys,
      acceptedOnOtherVariant: argsAcceptedOnOtherVariant(ompLike, unknownKeys),
    });

    expect(corrected!.args).toEqual({ op: 'get', sessionId: 's1' });
    expect(corrected!.steps).toEqual([
      { rejectedArg: 'cwd', action: 'dropped', acceptedOnOtherVariant: true },
    ]);

    const hint = correctedCallHint(corrected);
    expect(hint).toContain('omp:sessions(');
    expect(hint).toContain('"op": "get"');
    // The precise diagnosis, not the false one. `cwd` IS declared by this tool.
    expect(hint).toContain('NOT on the variant');
    expect(hint).not.toContain('declares no counterpart');
  });
});

describe('control: a builder that only names the target would pass a weaker assertion', () => {
  /**
   * CALIBRATION + CONTROL in one. The deliberately-wrong implementation below is what the
   * codebase already did before P-015 — it reports the correction WITHOUT resolving it
   * against the caller's args. It satisfies "mentions the right key", which is why that
   * assertion is not sufficient evidence, and fails the assertion this suite actually
   * makes. If a future refactor makes the real builder behave this way, the tests above go
   * red rather than silently passing on a schema-dump-grade refusal.
   */
  const namesTargetOnly = (target: string) => `Did you mean \`${target}\`?`;

  it('names the key (the weak property) but cannot produce the finished call (the real one)', () => {
    const weak = namesTargetOnly('title');
    expect(weak).toContain('title');
    expect(weak).not.toContain('work_items:create(');

    const real = buildCorrectedCall({
      toolName: 'work_items:create',
      input: { titel: 'a typo', kind: 'bug' },
      corrections: [near('titel', 'title')],
      unknownKeys: ['titel'],
    });
    expect(real!.rendered).toContain('work_items:create(');
    expect(real!.rendered).toContain('"title"');
    expect(real!.rendered).toContain('"kind"');
  });
});

/**
 * P-004 (frontier-remediation-...-60d3a8). The item was filed as "emit the corrected-call hint on
 * the FIRST plans:new invalid_input refusal rather than the third". There is no attempt counter
 * anywhere on this path — that framing was folklore. The real gate was a key SHAPE test: the
 * builder only ever processed UNRECOGNIZED keys, so a misspelled key got the hint on attempt #1
 * while a MISSING or MISTYPED declared key never got it at all, on any attempt.
 *
 * The property under test: a refusal whose issues are entirely about DECLARED keys still returns
 * a finished, executable-shaped call — with placeholders that are visibly placeholders.
 */
describe('buildCorrectedCall — declared-key repairs (P-004)', () => {
  /** The exact refusal measured live against `plans:new({ title: 12345 })`. */
  const plansNewIssues = [
    { path: ['slug'], message: 'Invalid input: expected string, received undefined' },
    { path: ['title'], message: 'Invalid input: expected string, received number' },
  ];

  it('produces a corrected call when ZERO keys are unrecognized (the measured regression)', () => {
    const corrected = buildCorrectedCall({
      toolName: 'plans:new',
      input: { title: 12345 },
      corrections: [],
      unknownKeys: [],
      issues: plansNewIssues,
    });

    expect(corrected).not.toBeNull();
    // The missing required key is ADDED, the mistyped one is RETYPED — both as placeholders.
    expect(corrected!.args).toEqual({ title: '<string>', slug: '<string>' });
    expect(corrected!.rendered).toContain('plans:new(');
    expect(corrected!.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rejectedArg: 'slug', action: 'added', reason: 'missing-required' }),
        expect.objectContaining({ rejectedArg: 'title', action: 'retyped', reason: 'wrong-type' }),
      ]),
    );
  });

  it('marks placeholders as placeholders and RETIRES the stale "not visible to this check" caveat', () => {
    const hint = correctedCallHint(
      buildCorrectedCall({
        toolName: 'plans:new',
        input: { title: 12345 },
        corrections: [],
        unknownKeys: [],
        issues: plansNewIssues,
      }),
    );

    expect(hint).toContain('CORRECTED CALL');
    expect(hint).toContain('added the required');
    expect(hint).toContain('retyped');
    expect(hint).toContain('PLACEHOLDER');
    // The old closing sentence claimed a missing-field error "would not have been visible to
    // this check". It is visible now, so asserting its ABSENCE is what keeps the two in sync.
    expect(hint).not.toContain('missing-field error would');
  });

  it('stays SILENT for a caller who sent nothing — a placeholder per required field is a schema dump', () => {
    expect(
      buildCorrectedCall({
        toolName: 'plans:new',
        input: {},
        corrections: [],
        unknownKeys: [],
        issues: plansNewIssues,
      }),
    ).toBeNull();
  });

  it('ignores a NESTED path — a corrected call is a top-level arg object', () => {
    expect(
      buildCorrectedCall({
        toolName: 'plans:new',
        input: { completion: {} },
        corrections: [],
        unknownKeys: [],
        issues: [
          {
            path: ['completion', 'summary'],
            message: 'Invalid input: expected string, received undefined',
          },
        ],
      }),
    ).toBeNull();
  });

  it('lets a RELOCATION fill a required slot instead of overwriting it with a placeholder', () => {
    const corrected = buildCorrectedCall({
      toolName: 'plans:new',
      input: { titel: 'a real title' },
      corrections: [near('titel', 'title')],
      unknownKeys: ['titel'],
      issues: [{ path: ['title'], message: 'Invalid input: expected string, received undefined' }],
    });

    // The caller's real value survives; it is NOT clobbered by `<string>`.
    expect(corrected!.args.title).toBe('a real title');
    expect(corrected!.steps.some((step) => step.action === 'added')).toBe(false);
  });

  /**
   * CONTROL. Same input, same refusal, but with the issues withheld — which is precisely the
   * information the pre-P-004 builder ignored. It must go back to returning null, or these
   * tests would pass against a builder that emits a corrected call unconditionally.
   */
  it('control: withholding the issues reproduces the old silence', () => {
    expect(
      buildCorrectedCall({
        toolName: 'plans:new',
        input: { title: 12345 },
        corrections: [],
        unknownKeys: [],
      }),
    ).toBeNull();
  });
});

/**
 * WI-10002056. A relocation used to write its destination unconditionally, so a stray key
 * whose near-name target the caller had ALREADY filled overwrote a correct value and the
 * suggested call silently named the wrong subject — the worst failure shape for this feature,
 * because the corrected call still looks authoritative and executable.
 *
 * The property: a relocation may only FILL a vacant destination, never REPLACE a supplied one.
 */
describe('buildCorrectedCall — a relocation never overwrites a value the caller supplied', () => {
  it('keeps the caller value and drops the stray key when the destination is occupied', () => {
    const corrected = buildCorrectedCall({
      toolName: 'plans:get',
      input: { harness: 'papercusp', slug: 'REAL-SLUG-KEEP-ME', slug2: 'BOGUS-SHOULD-NOT-WIN' },
      corrections: [near('slug2', 'slug')],
      unknownKeys: ['slug2'],
    });

    expect(corrected).not.toBeNull();
    expect(corrected!.args).toEqual({ harness: 'papercusp', slug: 'REAL-SLUG-KEEP-ME' });
    expect(corrected!.steps).toEqual([
      { rejectedArg: 'slug2', action: 'dropped', reason: 'target-occupied', conflictsWith: 'slug' },
    ]);
    // The key HAD a destination — it was refused, not unrecognized. Conflating the two would
    // send the reader hunting for a synonym that already exists and is already populated.
    expect(corrected!.droppedUnaccepted).toBe(false);
  });

  it('applies the same rule to a nested dotted destination', () => {
    const corrected = buildCorrectedCall({
      toolName: 'demo:tool',
      input: { opts: { slug: 'REAL-NESTED' }, slug2: 'BOGUS-NESTED' },
      corrections: [{ rejectedArg: 'slug2', target: 'opts.slug', kind: 'nested-path' }],
      unknownKeys: ['slug2'],
    });

    expect(corrected!.args).toEqual({ opts: { slug: 'REAL-NESTED' } });
    expect(corrected!.steps[0]).toMatchObject({ reason: 'target-occupied', conflictsWith: 'opts.slug' });
  });

  it('CONTROL: a VACANT destination still relocates, so the guard is not blanket-refusing', () => {
    const corrected = buildCorrectedCall({
      toolName: 'plans:get',
      input: { harness: 'papercusp', slug2: 'MOVE-ME' },
      corrections: [near('slug2', 'slug')],
      unknownKeys: ['slug2'],
    });

    expect(corrected!.args).toEqual({ harness: 'papercusp', slug: 'MOVE-ME' });
    expect(corrected!.steps).toEqual([
      { rejectedArg: 'slug2', action: 'relocated', target: 'slug', kind: 'near-name' },
    ]);
  });

  it('relocates into a destination holding a literal undefined, which counts as absent', () => {
    const corrected = buildCorrectedCall({
      toolName: 'plans:get',
      input: { slug: undefined, slug2: 'MOVE-ME' },
      corrections: [near('slug2', 'slug')],
      unknownKeys: ['slug2'],
    });

    expect(corrected!.args.slug).toBe('MOVE-ME');
    expect(corrected!.steps[0]).toMatchObject({ action: 'relocated' });
  });

  it('tells the caller WHICH value survived, and does not call it a missing counterpart', () => {
    const hint = correctedCallHint(
      buildCorrectedCall({
        toolName: 'plans:get',
        input: { slug: 'REAL-SLUG-KEEP-ME', slug2: 'BOGUS' },
        corrections: [near('slug2', 'slug')],
        unknownKeys: ['slug2'],
      }),
    );

    expect(hint).toContain('REAL-SLUG-KEEP-ME');
    expect(hint).not.toContain('BOGUS');
    // Names the surviving key, so the reader can tell this from a key with no destination.
    expect(hint).toContain('`slug` already had a value, which was kept');
    expect(hint).not.toContain('declares no counterpart');
  });

  /**
   * The deliberately-wrong control, kept permanently in-file per this suite's convention
   * (never mutate the shared tree to prove a guard falsifiable). This is the pre-fix
   * relocation: write the destination unconditionally. The assertions above must FAIL
   * against it, or they are not actually testing the property.
   */
  it('CONTROL: the unconditional-write relocation this guard replaced does overwrite', () => {
    const naiveRelocate = (
      input: Record<string, unknown>,
      rejectedArg: string,
      target: string,
    ): Record<string, unknown> => {
      const args = { ...input };
      args[target] = args[rejectedArg];
      delete args[rejectedArg];
      return args;
    };

    const clobbered = naiveRelocate(
      { harness: 'papercusp', slug: 'REAL-SLUG-KEEP-ME', slug2: 'BOGUS-SHOULD-NOT-WIN' },
      'slug2',
      'slug',
    );

    // The exact defect WI-10002056 reported: the typo's value wins.
    expect(clobbered.slug).toBe('BOGUS-SHOULD-NOT-WIN');
    // And the shipped implementation disagrees with it on the same input — which is what
    // makes the first test in this block a real assertion rather than a restatement.
    const shipped = buildCorrectedCall({
      toolName: 'plans:get',
      input: { harness: 'papercusp', slug: 'REAL-SLUG-KEEP-ME', slug2: 'BOGUS-SHOULD-NOT-WIN' },
      corrections: [near('slug2', 'slug')],
      unknownKeys: ['slug2'],
    });
    expect(shipped!.args.slug).not.toBe(clobbered.slug);
    expect(shipped!.args.slug).toBe('REAL-SLUG-KEEP-ME');
  });
});
