/**
 * P-002 (tool-contract-repair-2026-09-05) — a local redirect target may carry a note.
 *
 * `isLocalSchemaTarget` used to test the WHOLE target string against the path
 * regex. Any target carrying explanation therefore classified as CROSS-TOOL and
 * rendered "`x` is not an arg of this tool — it is written by <the whole
 * sentence>", telling a caller who merely used the wrong key on the RIGHT tool
 * that some other tool owned their data. That is the same misattribution
 * EI-21119949290826530 fixed for bare targets and EI-22179796827760943
 * re-reported; it survived because a bare target — the only shape anyone tested —
 * classified correctly.
 *
 * It was not hypothetical: `coord:send` ships `body[].premises — put it inside a
 * section: …`, and that shipped redirect was being rendered with the cross-tool
 * sentence.
 *
 * Run: npm run test:file -- libs/generic/tooldef/src/redirect-target-note.test.ts
 */
import { describe, expect, it } from 'vitest';
import { isLocalSchemaTarget, splitLocalSchemaTarget } from './define-tool';

const KEYS = ['id', 'ids', 'harness', 'detail', 'threadLimit', 'body', 'observation'] as const;

describe('splitLocalSchemaTarget', () => {
  it('treats a bare declared key exactly as before', () => {
    // The back-compat anchor: every already-authored bare target must keep its
    // current classification and produce an empty note, so this change is
    // byte-identical for them.
    expect(splitLocalSchemaTarget('detail', KEYS)).toEqual({ path: 'detail', note: '' });
    expect(isLocalSchemaTarget('detail', KEYS)).toBe(true);
  });

  it('splits a declared key from its explanatory note', () => {
    expect(splitLocalSchemaTarget('detail — set it to true for the full record', KEYS)).toEqual({
      path: 'detail',
      note: 'set it to true for the full record',
    });
  });

  it('classifies a dotted/array path with a note — the shipped coord:send shape', () => {
    // The regression that motivated this. `[]` is the form authors write for an
    // array-valued destination; the old regex allowed only `[0]`.
    expect(
      splitLocalSchemaTarget('body[].premises — put it inside a section: body: [{ text: "..." }]', KEYS),
    ).toEqual({
      path: 'body[].premises',
      note: 'put it inside a section: body: [{ text: "..." }]',
    });
  });

  it('keeps only the FIRST separator, so a note may contain dashes', () => {
    const split = splitLocalSchemaTarget('ids — pass the ids themselves — not a count', KEYS);
    expect(split?.path).toBe('ids');
    expect(split?.note).toBe('pass the ids themselves — not a count');
  });

  it('still refuses a target naming another TOOL', () => {
    // The property the original function existed to protect. A rendered tool call
    // carries a space, `{` or `:` before any separator, so its head is not a path.
    for (const target of [
      'work_items:tag { id, topic }',
      'coord:feed { since }',
      'plans:items { slug } — the exact-item read',
    ]) {
      expect(splitLocalSchemaTarget(target, KEYS), target).toBeNull();
      expect(isLocalSchemaTarget(target, KEYS), target).toBe(false);
    }
  });

  it('still refuses a path this tool does not declare', () => {
    // Undeclared head => not a relocation, however path-shaped it looks. Without
    // this a typo'd target would confidently tell the caller to use a key that
    // does not exist.
    expect(splitLocalSchemaTarget('nosuchkey — go here', KEYS)).toBeNull();
    expect(splitLocalSchemaTarget('nosuchkey', KEYS)).toBeNull();
  });

  it('refuses prose whose first word is not a declared key', () => {
    // The shape that would otherwise render "it is written by not needed — …".
    expect(splitLocalSchemaTarget('not needed — there is nothing to enable', KEYS)).toBeNull();
  });
});
