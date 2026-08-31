import { describe, expect, it } from 'vitest';

import { applyDenominator, renderDenominatorText, resolveDenominator } from './denominator';
import type { ToolResult } from './wire';

const ok = (text = '{"rows":[]}'): ToolResult => ({ content: [{ type: 'text', text }] });

/** The rendered stamp appended to content, or `undefined` when none was added. */
function stampOf(r: ToolResult): string | undefined {
  const last = r.content.at(-1);
  if (!last || last.type !== 'text') return undefined;
  return last.text.startsWith('Denominator:') ? last.text : undefined;
}

describe('denominator — the base-rate stamp (EI-19375528138828761)', () => {
  it('renders matched-of-population with the ratio, so a slice is legible as a slice', () => {
    const r = applyDenominator(ok(), { matched: 8, population: 392, of: 'sessions' }, {}, {});
    expect(stampOf(r)).toBe('Denominator: 8 of 392 sessions (2.0%).');
    // Structured half must be present for machine readers, not just the prose.
    expect(r._meta?._denominator).toEqual({ matched: 8, population: 392, of: 'sessions' });
  });

  it('anchors the ratio to its window when one is given', () => {
    const r = applyDenominator(
      ok(),
      { matched: 8, population: 392, of: 'sessions', window: 'last 3h' },
      {},
      {},
    );
    // Unanchored, "8 of 392" over an hour and over a month read identically.
    expect(stampOf(r)).toContain('8 of 392 sessions in last 3h');
  });

  /**
   * THE LOAD-BEARING CASE. An unknown population must be stated in words — the
   * failure this whole primitive exists to stop is a filtered slice being read
   * as a census, and an omitted stamp is indistinguishable from "this IS the
   * whole set". If this assertion is ever relaxed to silence, the primitive
   * still "works" while doing nothing.
   */
  it('says UNKNOWN population out loud, and names what it therefore cannot support', () => {
    const r = applyDenominator(ok(), { matched: 8, population: 'unknown' }, {}, {});
    const stamp = stampOf(r) ?? '';
    expect(stamp).toContain('population UNKNOWN');
    expect(stamp).toContain('FILTERED SLICE, not a census');
    expect(stamp).toMatch(/base-rate/);
  });

  it('reports a zero population as "0 exist" rather than dividing by zero', () => {
    expect(renderDenominatorText({ matched: 0, population: 0 })).toContain('0 exist');
  });

  it('does not imply false resolution on a very small ratio', () => {
    expect(renderDenominatorText({ matched: 1, population: 5_000_000 })).toContain('<0.1%');
  });

  describe('self-gating — an unrelated or failed call pays nothing', () => {
    it('returns the result UNCHANGED when the tool declares no denominator', () => {
      const base = ok();
      expect(applyDenominator(base, undefined, {}, {})).toBe(base);
    });

    it('returns the result UNCHANGED when the callback self-gates with null', () => {
      const base = ok();
      expect(applyDenominator(base, () => null, {}, {})).toBe(base);
    });

    it('does not stamp a soft error — a failed call has no population to report', () => {
      const err: ToolResult = { content: [{ type: 'text', text: 'boom' }], isError: true };
      expect(applyDenominator(err, { matched: 1, population: 2 }, {}, {})).toBe(err);
    });
  });

  it('NEVER fails the underlying tool call when the callback throws', () => {
    const base = ok();
    const thrower = () => {
      throw new Error('denominator callback is broken');
    };
    expect(() => applyDenominator(base, thrower, {}, {})).not.toThrow();
    expect(applyDenominator(base, thrower, {}, {})).toBe(base);
  });

  describe('malformed stamps are DROPPED, never half-rendered', () => {
    it('drops a population smaller than matched — that ratio is arithmetically impossible', () => {
      // Reporting it anyway would launder a counting bug into a confident
      // ">100%" base rate, which is worse than having no denominator at all.
      expect(resolveDenominator({ matched: 10, population: 3 }, ok(), {}, {})).toBeNull();
    });

    it('drops a non-numeric population rather than treating it as unknown', () => {
      const spec = { matched: 1, population: 'lots' } as unknown as never;
      expect(resolveDenominator(spec, ok(), {}, {})).toBeNull();
    });

    it('drops a stamp with no matched count', () => {
      const spec = { population: 100 } as unknown as never;
      expect(resolveDenominator(spec, ok(), {}, {})).toBeNull();
    });

    it('drops negative counts', () => {
      expect(resolveDenominator({ matched: -1, population: 10 }, ok(), {}, {})).toBeNull();
    });
  });

  it('computes from the ACTUAL result, which is why the spec is a function', () => {
    const result = ok(JSON.stringify({ rows: [1, 2, 3], total: 60 }));
    const r = applyDenominator(
      result,
      (res) => {
        const parsed = JSON.parse((res.content[0] as { text: string }).text);
        return { matched: parsed.rows.length, population: parsed.total, of: 'items' };
      },
      {},
      {},
    );
    expect(stampOf(r)).toBe('Denominator: 3 of 60 items (5.0%).');
  });
});
