import { describe, expect, it } from 'vitest';
import { buildCorrectedCall, correctedCallHint } from './corrected-call';
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
