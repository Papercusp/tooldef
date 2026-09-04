/**
 * EI-22174225494240206 — `unknownArgHint`'s "this tool accepts ONLY: …" list is
 * built from the tool's OWN declared schema only, so a dispatch-level arg the
 * transport strips before tooldef ever validates the call (Papercusp's
 * `projection`) could never appear in it, even though it is genuinely accepted on
 * every call — the rejection then instructed the caller to re-send WITHOUT a
 * capability that actually works. This is the library-side seam: a host-registered
 * resolver naming those keys, folded into the rendered hint.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { unknownArgHint } from './define-tool';
import {
  readAmbientArgKeys,
  resetAmbientArgKeysResolver,
  setAmbientArgKeysResolver,
} from './ambient-args';

afterEach(() => resetAmbientArgKeysResolver());

describe('readAmbientArgKeys', () => {
  it('is empty when no host resolver is registered (behavior-neutral default)', () => {
    expect(readAmbientArgKeys()).toEqual([]);
  });

  it('returns exactly what the registered resolver reports', () => {
    setAmbientArgKeysResolver(() => ['projection', 'view']);
    expect(readAmbientArgKeys()).toEqual(['projection', 'view']);
  });

  it('fails SAFE (empty) when the resolver throws, never breaking the caller', () => {
    setAmbientArgKeysResolver(() => {
      throw new Error('boom');
    });
    expect(() => readAmbientArgKeys()).not.toThrow();
    expect(readAmbientArgKeys()).toEqual([]);
  });

  it('filters out non-string / empty-string entries rather than passing them through', () => {
    setAmbientArgKeysResolver(() => ['projection', '', 42 as unknown as string, 'view']);
    expect(readAmbientArgKeys()).toEqual(['projection', 'view']);
  });

  it('a non-array return is treated as empty, not thrown', () => {
    setAmbientArgKeysResolver(() => 'not-an-array' as unknown as string[]);
    expect(readAmbientArgKeys()).toEqual([]);
  });

  it('resetAmbientArgKeysResolver clears a prior registration back to the default', () => {
    setAmbientArgKeysResolver(() => ['projection']);
    expect(readAmbientArgKeys()).toEqual(['projection']);
    resetAmbientArgKeysResolver();
    expect(readAmbientArgKeys()).toEqual([]);
  });

  it('last registration wins over an earlier one', () => {
    setAmbientArgKeysResolver(() => ['first']);
    setAmbientArgKeysResolver(() => ['second']);
    expect(readAmbientArgKeys()).toEqual(['second']);
  });
});

describe('unknownArgHint + ambient-args (EI-22174225494240206)', () => {
  // The rejected key is deliberately NOT an ambient key. This is the case the ambient
  // list exists for: the caller fumbled some OTHER arg, `projection` was peeled by the
  // transport exactly as intended, and the hint must not order them to drop it.
  //
  // EI-22283734191872163: this fixture previously used `projection` as the rejected
  // key, which made these tests assert the contradiction they should forbid — the
  // message naming `projection` as accepted in the same breath as rejecting it. The
  // CONTROL below already stated the correct invariant; these two cases simply were
  // not applying it. The fixture was wrong, not the invariant.
  const issues = [{ message: 'Unrecognized key: "limitt"', keys: ['limitt'] }];
  const schema = { properties: { limit: {}, from: {} } };
  /** The rejected key IS an ambient key — only possible on a dispatch that did not peel it. */
  const ambientRejected = [{ message: 'Unrecognized key: "projection"', keys: ['projection'] }];

  it('CONTROL: payloadTier alone (tooldef\'s own framework arg) is always listed, ambient or not', () => {
    // No host resolver registered — this is the pre-fix shape for a HOST-level key.
    const out = unknownArgHint(ambientRejected, schema);
    expect(out).toContain('this tool accepts ONLY');
    expect(out).toContain('payloadTier');
    // The rejected key itself must not silently appear as if it were accepted.
    expect(out).not.toContain('projection');
  });

  it('folds a registered host key into the dispatch-level list instead of the rejection reading as absolute', () => {
    setAmbientArgKeysResolver(() => ['projection']);
    const out = unknownArgHint(issues, schema);
    expect(out).toContain('Dispatch-level args');
    expect(out).toContain('projection');
    expect(out).toContain('payloadTier');
    // The re-send instruction must acknowledge the dispatch-level keys exist —
    // the whole bug was this hint previously telling the caller to drop them.
    expect(out).toContain('or the dispatch-level ones just listed');
  });

  it('lists MULTIPLE registered host keys, not just the first', () => {
    setAmbientArgKeysResolver(() => ['projection', 'view']);
    const out = unknownArgHint(issues, schema);
    expect(out).toContain('projection');
    expect(out).toContain('view');
  });

  it('a throwing resolver degrades to the payloadTier-only baseline, never breaking the hint', () => {
    setAmbientArgKeysResolver(() => {
      throw new Error('boom');
    });
    expect(() => unknownArgHint(issues, schema)).not.toThrow();
    const out = unknownArgHint(issues, schema);
    expect(out).toContain('payloadTier');
    expect(out).not.toContain('projection');
  });
});

describe('unknownArgHint never contradicts itself (EI-22283734191872163)', () => {
  const schema = { properties: { limit: {}, from: {} } };

  it('does NOT name a key as "also accepted" in the same message that rejects it', () => {
    // The host resolver reports what ITS TRANSPORT strips — a process-wide answer. This
    // dispatch ran beneath that transport (e.g. runToolOrchestration, what a code:run
    // script calls) and peeled nothing, so `projection` arrived as an unrecognized key.
    // That rejection is per-dispatch EVIDENCE the key was not peeled here.
    setAmbientArgKeysResolver(() => ['projection', 'view']);
    const out = unknownArgHint(
      [{ message: 'Unrecognized key: "projection"', keys: ['projection'] }],
      schema,
    );
    expect(out).toContain('this tool accepts ONLY');
    // The measured contradiction: rejected AND advertised as accepted, in one message.
    expect(out).not.toContain('projection');
  });

  it('still lists the ambient keys that were NOT rejected — a blunt drop would lose real capability', () => {
    setAmbientArgKeysResolver(() => ['projection', 'view']);
    const out = unknownArgHint(
      [{ message: 'Unrecognized key: "projection"', keys: ['projection'] }],
      schema,
    );
    expect(out).toContain('Dispatch-level args');
    expect(out).toContain('view');
    expect(out).toContain('payloadTier');
  });

  it('drops the parenthetical entirely when EVERY ambient key was rejected', () => {
    // Exercises the ambientKeys.length === 0 branch: with nothing truthful left to
    // advertise, the hint must fall back to the plain re-send form rather than emit an
    // empty or dangling dispatch-level clause.
    setAmbientArgKeysResolver(() => ['projection']);
    const out = unknownArgHint(
      [{
        message: 'Unrecognized keys: "projection", "payloadTier"',
        keys: ['projection', 'payloadTier'],
      }],
      schema,
    );
    expect(out).not.toContain('Dispatch-level args');
    expect(out).not.toContain('or the dispatch-level ones just listed');
    expect(out).toContain('Re-send using only the keys above.');
  });
});
