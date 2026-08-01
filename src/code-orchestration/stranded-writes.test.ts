/**
 * P-020 (fleet-leadership-continuity-and-actuation-2026-08-01) — `detectStrandedWrites`.
 *
 * A thrown call unwinds the vm, so every call written after it never dispatches. Those are
 * invisible to plannedMutations/rejected/uncertain (all recorded AT dispatch), so the result
 * can truthfully say "nothing was written" while omitting that a trailing
 * `work_items:checkpoint` never happened.
 *
 * The contract under test is deliberately CONSERVATIVE: report only what is provable. The
 * neighbouring warning had to be de-cry-wolfed once already (EI-10951) for claiming more than
 * it knew; the negative cases below are what keep this one from repeating that.
 *
 * PURE — no vm, no PG, no dispatcher.
 */
import { describe, expect, it } from 'vitest';
import { detectStrandedWrites } from './orchestrate';
import type { StaticToolCall } from './parse-check';
import type { ProjectedTool } from '../tool-projection';

const tool = (name: string, effect: 'read' | 'write'): ProjectedTool =>
  ({ name, effect }) as unknown as ProjectedTool;

const TOOLS: ProjectedTool[] = [
  tool('sessions:read', 'read'),
  tool('work_items:list', 'read'),
  tool('work_items:checkpoint', 'write'),
  tool('facts:assert', 'write'),
  tool('work_items:complete', 'write'),
];

const calls = (...names: string[]): StaticToolCall[] =>
  names.map((n) => ({ tool: n, args: null, dynamicArgs: false }));

describe('detectStrandedWrites (P-020)', () => {
  it('names a write that was ordered but never dispatched — the motivating case', () => {
    // Script: a read throws on an arg typo, so the checkpoint written after it never runs.
    const stranded = detectStrandedWrites(
      calls('sessions:read', 'work_items:checkpoint'),
      TOOLS,
      [], // nothing dispatched: the read threw first
    );
    expect(stranded).toEqual(['work_items:checkpoint']);
  });

  it('ignores READS that never ran — re-running a read costs nothing', () => {
    const stranded = detectStrandedWrites(calls('sessions:read', 'work_items:list'), TOOLS, []);
    expect(stranded).toEqual([]);
  });

  it('omits a write that dispatched at least once (a loop/branch may have run only some)', () => {
    const stranded = detectStrandedWrites(
      calls('work_items:checkpoint', 'facts:assert'),
      TOOLS,
      ['work_items:checkpoint'],
    );
    expect(stranded).toEqual(['facts:assert']);
  });

  it('reports several stranded writes in SOURCE order', () => {
    const stranded = detectStrandedWrites(
      calls('sessions:read', 'facts:assert', 'work_items:checkpoint'),
      TOOLS,
      [],
    );
    expect(stranded).toEqual(['facts:assert', 'work_items:checkpoint']);
  });

  it('dedupes a write called from several source sites', () => {
    const stranded = detectStrandedWrites(
      calls('facts:assert', 'facts:assert', 'facts:assert'),
      TOOLS,
      [],
    );
    expect(stranded).toEqual(['facts:assert']);
  });

  it('claims nothing when every ordered write dispatched', () => {
    const stranded = detectStrandedWrites(
      calls('work_items:checkpoint', 'facts:assert'),
      TOOLS,
      ['work_items:checkpoint', 'facts:assert'],
    );
    expect(stranded).toEqual([]);
  });

  it('ignores a tool absent from the projected catalog (unknown ref / dynamic dispatch)', () => {
    // `tools.call(someVariable)` is invisible to the static parse; never claim about it.
    const stranded = detectStrandedWrites(calls('nope:missing'), TOOLS, []);
    expect(stranded).toEqual([]);
  });

  it('returns empty for an empty script', () => {
    expect(detectStrandedWrites([], TOOLS, [])).toEqual([]);
  });
});
