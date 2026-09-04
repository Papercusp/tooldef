/**
 * P-016 / D-104 — the EXECUTE half's primitive, tested at the boundary the design cares about.
 *
 * Two properties here are not style preferences and each has its own describe block:
 *
 *   PURITY. `reencode-args.ts` argues at length that `tool_invocations.args_json` is the decay
 *   instrument D-104's endgame clause depends on, and that the instrument survives only because
 *   the repair builds a NEW object. A rule that mutated its input would destroy the before/after
 *   series while every functional test still passed, so purity is asserted by IDENTITY, not by
 *   deep-equality — deep-equality cannot tell a fresh object from a mutated one.
 *
 *   DISCLOSURE. EI-10883 established that quietly doing something other than what the caller
 *   asked is indistinguishable from success. Auto-correction is admissible ONLY because it is
 *   announced, so the disclosure's content is a safety assertion rather than a cosmetic one.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  applyArgReencodings,
  boundValue,
  correctedDisclosure,
  type AppliedArgCorrection,
  type ArgReencoding,
} from './reencode-args';

/** A rule that rewrites `input.value` to `to`, disclosing one correction. */
const rewriteValue = (rule: string, to: unknown): ArgReencoding => ({
  rule,
  reencode: (input) => {
    const obj = input as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || obj.value === to) return null;
    return {
      input: { ...obj, value: to },
      corrections: [{ path: 'value', sent: obj.value, ran: to, rule }],
    };
  },
});

const NOOP_RULE: ArgReencoding = { rule: 'noop', reencode: () => null };

describe('applyArgReencodings — when it declines to act', () => {
  it('returns null with no registered rules, so the caller falls through to the ordinary refusal', () => {
    expect(applyArgReencodings(undefined, { value: 1 })).toBeNull();
    expect(applyArgReencodings([], { value: 1 })).toBeNull();
  });

  it('returns null when every rule declines', () => {
    expect(applyArgReencodings([NOOP_RULE, NOOP_RULE], { value: 1 })).toBeNull();
  });

  it('ignores a rule that reports zero corrections rather than treating it as a repair', () => {
    // An "applied" repair with nothing to disclose would produce a correction notice with no
    // content — and, worse, would swap in a rewritten input the caller was never told about.
    const silent: ArgReencoding = {
      rule: 'silent',
      reencode: (input) => ({ input: { ...(input as object), snuck: true }, corrections: [] }),
    };
    expect(applyArgReencodings([silent], { value: 1 })).toBeNull();
  });

  it('skips a rule that throws instead of turning a clean refusal into a handler crash', () => {
    const boom: ArgReencoding = {
      rule: 'boom',
      reencode: () => {
        throw new Error('rule is broken');
      },
    };
    // The broken rule is skipped and the LATER good rule still applies: a broken repair must
    // never be worse than no repair, and must not disable its siblings either.
    const out = applyArgReencodings([boom, rewriteValue('fix', 2)], { value: 1 });
    expect(out?.input).toEqual({ value: 2 });
    expect(out?.corrections.map((c) => c.rule)).toEqual(['fix']);
  });
});

describe('applyArgReencodings — when it repairs', () => {
  it('threads each rule output into the next and accumulates every correction', () => {
    const out = applyArgReencodings([rewriteValue('first', 2), rewriteValue('second', 3)], {
      value: 1,
    });
    expect(out?.input).toEqual({ value: 3 });
    expect(out?.corrections).toEqual([
      { path: 'value', sent: 1, ran: 2, rule: 'first' },
      { path: 'value', sent: 2, ran: 3, rule: 'second' },
    ]);
  });

  it('does not consult later rules with the ORIGINAL input (the threading is real, not parallel)', () => {
    const observed: unknown[] = [];
    const observer: ArgReencoding = {
      rule: 'observer',
      reencode: (input) => {
        observed.push(input);
        return null;
      },
    };
    applyArgReencodings([rewriteValue('first', 2), observer], { value: 1 });
    expect(observed).toEqual([{ value: 2 }]);
  });
});

describe('applyArgReencodings — purity (the decay instrument depends on it)', () => {
  it('leaves the caller-supplied object untouched, so args_json keeps the shape actually sent', () => {
    const original = { value: 1, untouched: { deep: true } };
    const snapshot = structuredClone(original);

    const out = applyArgReencodings([rewriteValue('fix', 2)], original);

    expect(original).toEqual(snapshot);
    // Identity, not equality: a mutated-in-place input is deep-equal to itself and would pass
    // an `toEqual` assertion while having already destroyed the before/after series.
    expect(out?.input).not.toBe(original);
  });

  it('returns an untouched nested node BY IDENTITY, so a repair does not deep-copy the world', () => {
    const untouched = { deep: true };
    const out = applyArgReencodings([rewriteValue('fix', 2)], { value: 1, untouched });
    expect((out?.input as { untouched: unknown }).untouched).toBe(untouched);
  });
});

describe('boundValue — a disclosure must not become the bulk of the result', () => {
  it('passes a short string through unchanged', () => {
    expect(boundValue('WI-1234')).toBe('WI-1234');
  });

  it('replaces a long string with a placeholder that NAMES the elision', () => {
    const long = 'x'.repeat(500);
    expect(boundValue(long)).toBe('<your original 500-char string>');
  });

  it('replaces a large array with a placeholder naming its length', () => {
    const many = Array.from({ length: 200 }, (_, i) => `WI-${i}-padding-padding-padding`);
    expect(boundValue(many)).toBe('<your original 200-item array>');
  });

  it('passes a small structured value through so the disclosure stays concrete', () => {
    const small = [{ ref: 'WI-1' }, { ref: 'WI-2' }];
    expect(boundValue(small)).toBe(small);
  });

  it('reports an unserializable value rather than throwing on the failure path', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(boundValue(circular)).toBe('<unserializable>');
  });
});

describe('correctedDisclosure — the announcement EI-10883 requires', () => {
  const base: AppliedArgCorrection = {
    path: 'body.0.premises',
    sent: [{ ref: 'WI-1' }],
    ran: ['WI-1'],
    rule: 'premises.unwrap-ref-objects',
  };

  it('is empty when nothing was corrected', () => {
    expect(correctedDisclosure([])).toBe('');
  });

  it('leads by saying the call SUCCEEDED, so a reader cannot mistake it for a refusal', () => {
    // The failure mode this ordering exists to prevent: a caller reads a correction notice as
    // a rejection and retries a call that already ran — doubling a write.
    const text = correctedDisclosure([base]);
    expect(text.startsWith('AUTO-CORRECTED AND RAN')).toBe(true);
    expect(text).toContain('do not retry it');
  });

  it('names the path, what was sent, what ran, and the rule', () => {
    const text = correctedDisclosure([base]);
    expect(text).toContain('body.0.premises');
    expect(text).toContain('[{"ref":"WI-1"}]');
    expect(text).toContain('["WI-1"]');
    expect(text).toContain('premises.unwrap-ref-objects');
  });

  it('names dropped sibling keys — silently discarding supplied data is the EI-10883 hazard', () => {
    const text = correctedDisclosure([{ ...base, dropped: ['provenance', 'note'] }]);
    expect(text).toContain('DROPPED');
    expect(text).toContain('`provenance`');
    expect(text).toContain('`note`');
  });

  it('says nothing about dropped keys when none were dropped', () => {
    expect(correctedDisclosure([base])).not.toContain('DROPPED');
  });

  it('renders every correction when more than one rule fired', () => {
    const text = correctedDisclosure([base, { ...base, path: 'body.1.premises', rule: 'other' }]);
    expect(text).toContain('body.0.premises');
    expect(text).toContain('body.1.premises');
  });
});

describe('applyArgReencodings — the calibration control', () => {
  it('a deliberately-inert rule set produces no repair, so the assertions above can fail', () => {
    // Without this, every "returns null" assertion above would also pass if `applyArgReencodings`
    // were hard-wired to return null; the positive cases are what distinguish the two, and this
    // pairs a spy with them to prove the rules are genuinely consulted.
    const spy = vi.fn(() => null);
    expect(applyArgReencodings([{ rule: 'spied', reencode: spy }], { value: 1 })).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
