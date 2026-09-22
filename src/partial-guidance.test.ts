/**
 * Guards for the partial-guidance projection (P-010 / D-006).
 *
 * FALSIFIABILITY. Per the repo's mutation discipline, the subject here is a
 * MODULE we import, so the control is a deliberately-wrong implementation kept
 * PERMANENTLY in this file — never a mutation of the production source, which
 * on this swept tree can be committed by git-sync mid-probe. `wrongProjection`
 * is what a naive "just take the first paragraph" implementation would do; the
 * safety assertions below must FAIL against it and PASS against the real one.
 * The calibration case proves the assertions are not vacuous.
 */
import { describe, it, expect } from 'vitest';
import {
  GUIDANCE_SECTION_LABELS,
  GUIDANCE_SECTION_SEPARATOR,
  isSafetyClause,
  partialGuidanceDescription,
  summaryGuidanceDescription,
  partialGuidanceLoss,
  guidanceWireBytes,
} from './partial-guidance';

const L = GUIDANCE_SECTION_LABELS;

/** A composed description exactly as `describeFromGuidance` emits one. */
function compose(parts: { when?: string; notWhen?: string; chaining?: string }): string {
  const out: string[] = [];
  if (parts.when) out.push(`${L.when} ${parts.when}`);
  if (parts.notWhen) out.push(`${L.notWhen} ${parts.notWhen}`);
  if (parts.chaining) out.push(`${L.chaining} ${parts.chaining}`);
  return out.join(GUIDANCE_SECTION_SEPARATOR);
}

/**
 * THE CONTROL — a plausible-but-wrong projection: keep the first section, drop
 * everything else unconditionally. It loses hard rails, which is precisely the
 * failure the real projection exists to avoid.
 */
function wrongProjection(description: string): string {
  return description.split(GUIDANCE_SECTION_SEPARATOR)[0] ?? '';
}

describe('partialGuidanceDescription', () => {
  it('keeps the `when` section verbatim — it is the selection signal', () => {
    const when = 'you need the live verdict for a named gate.';
    const out = partialGuidanceDescription(compose({ when, notWhen: 'never mind', chaining: 'x' }));
    expect(out).toContain(when);
    expect(out.startsWith(L.when)).toBe(true);
  });

  it('drops ordinary notWhen/chaining prose', () => {
    const out = partialGuidanceDescription(
      compose({
        when: 'you want a row range.',
        notWhen: 'the file is a generated artifact you plan to rewrite.',
        chaining: 'pairs naturally with capability:write afterwards.',
      }),
    );
    expect(out).not.toContain('generated artifact');
    expect(out).not.toContain('pairs naturally');
  });

  it('RETAINS a hard rail out of an otherwise-dropped section', () => {
    const rail = 'NEVER point this at a live production tree.';
    const source = compose({
      when: 'you are verifying a sandbox.',
      notWhen: `ordinary local checks are enough. ${rail}`,
      chaining: 'follow with a cleanup pass.',
    });

    const real = partialGuidanceDescription(source);
    expect(real).toContain(rail);
    // ...and the ordinary prose around it is still gone.
    expect(real).not.toContain('ordinary local checks');

    // FALSIFIABILITY CONTROL: the naive projection loses the rail entirely.
    expect(wrongProjection(source)).not.toContain(rail);
  });

  it('retains glyph-marked rails from a dropped section', () => {
    const rail = '⛔ this refuses unless confirm:true is passed.';
    const out = partialGuidanceDescription(
      compose({ when: 'you want to deploy.', chaining: `run status first. ${rail}` }),
    );
    expect(out).toContain('confirm:true');
    expect(out).not.toContain('run status first');
  });

  it('treats an explicit (unlabelled) description as content and keeps it', () => {
    const explicit = 'Fetch a URL and answer a prompt against its content.';
    expect(partialGuidanceDescription(explicit)).toBe(explicit);
    expect(partialGuidanceLoss(explicit).unlabelled).toBe(true);
  });

  it('is total: blank/undefined input yields blank output, never a throw', () => {
    expect(partialGuidanceDescription(undefined)).toBe('');
    expect(partialGuidanceDescription('')).toBe('');
    // A control byte via fromCharCode, never a raw one in this source file:
    // lint:no-control-bytes is a green-checkpoint leg (EI-19478121013052934).
    const malformed = `${String.fromCharCode(0)} malformed \n\n\n`;
    expect(malformed.charCodeAt(0)).toBe(0); // the fixture really is control-bearing
    expect(() => partialGuidanceDescription(malformed)).not.toThrow();
  });

  it('CALIBRATION — the rail assertions are not vacuous', () => {
    // The very same assertion style, against text that genuinely contains the
    // rail, must pass; otherwise the "retains a rail" tests could be green for
    // the wrong reason.
    const railText = 'NEVER do this.';
    expect(isSafetyClause(railText)).toBe(true);
    expect(railText).toContain('NEVER');
  });

  it('does not treat ordinary lowercase prose as a rail', () => {
    // Guards the carve-out from swallowing the whole description: if every
    // sentence looked like a rail, the projection would save nothing.
    expect(isSafetyClause('you never need to pass this argument.')).toBe(false);
    expect(isSafetyClause('a plain sentence about behaviour.')).toBe(false);
  });
});

describe('partialGuidanceLoss', () => {
  it('measures a real reduction and names the reduced sections', () => {
    const loss = partialGuidanceLoss(
      compose({
        when: 'short trigger.',
        notWhen: 'a long explanation of every case in which you should not reach for this tool.',
        chaining: 'an equally long description of what it combines with downstream.',
      }),
    );
    expect(loss.savedBytes).toBeGreaterThan(0);
    expect(loss.partialBytes).toBeLessThan(loss.fullBytes);
    expect(loss.reducedSections).toEqual([L.notWhen, L.chaining]);
    expect(loss.retainedSafetyClauses).toBe(0);
  });

  it('counts retained rails so the trade can be argued from numbers', () => {
    const loss = partialGuidanceLoss(
      compose({ when: 'w.', notWhen: 'ordinary. NEVER on a live tree. ⛔ also destructive.' }),
    );
    expect(loss.retainedSafetyClauses).toBeGreaterThanOrEqual(2);
  });

  it('never reports a negative saving (the projection cannot grow a description)', () => {
    for (const sample of [
      '',
      'plain',
      compose({ when: 'a' }),
      compose({ when: 'a', notWhen: 'NEVER', chaining: '⛔' }),
    ]) {
      expect(partialGuidanceLoss(sample).savedBytes).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('summaryGuidanceDescription', () => {
  it('reduces an explicit description to its lead sentence — the case partial cannot touch', () => {
    const explicit =
      'Claim the next eligible item. It applies global floors, then the stored claim-spec filter, ' +
      'then ranks by affinity, and finally returns either the claimed item or a diagnosed miss.';
    // Partial keeps an unlabelled description WHOLE; summary is what cuts it.
    expect(partialGuidanceDescription(explicit)).toBe(explicit);
    const summary = summaryGuidanceDescription(explicit);
    expect(summary.length).toBeLessThan(explicit.length);
    expect(summary).toContain('Claim the next eligible item.');
  });

  it('NEVER trades a hard rail for the lead sentence', () => {
    const rail = 'NEVER run this against a live tree.';
    const source = `Does a thing. Some filler prose. ${rail}`;
    const summary = summaryGuidanceDescription(source, 40);
    expect(summary).toContain(rail);
    // The control loses it — proving the assertion can fail.
    expect(wrongProjection(source).slice(0, 40)).not.toContain(rail);
  });

  it('marks a truncation so a reader knows prose is missing', () => {
    const long = `${'word '.repeat(80)}end.`;
    expect(summaryGuidanceDescription(long, 60)).toContain('…');
  });

  it('does not emit the lead twice when the lead is itself a rail', () => {
    const only = 'NEVER do this.';
    const summary = summaryGuidanceDescription(only);
    expect(summary).toBe(only);
    expect(summary.match(/NEVER/g)?.length).toBe(1);
  });

  it('is total on blank/undefined input', () => {
    expect(summaryGuidanceDescription(undefined)).toBe('');
    expect(summaryGuidanceDescription('')).toBe('');
  });

  it('is never longer than the description it summarises', () => {
    for (const sample of [
      'short.',
      'a much longer description that rambles on for a while about many things.',
      compose({ when: 'w.', notWhen: 'n.', chaining: 'c.' }),
    ]) {
      expect(summaryGuidanceDescription(sample).length).toBeLessThanOrEqual(sample.length);
    }
  });
});

describe('guidanceWireBytes', () => {
  it('orders the three prose tiers full >= partial >= compact', () => {
    const b = guidanceWireBytes(
      compose({ when: 'trigger.', notWhen: 'a much longer explanation here.', chaining: 'more.' }),
    );
    expect(b.full).toBeGreaterThanOrEqual(b.partial);
    expect(b.partial).toBeGreaterThanOrEqual(b.compact);
    expect(b.compact).toBe(0);
  });
});
