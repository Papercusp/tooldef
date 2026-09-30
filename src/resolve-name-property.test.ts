/**
 * P-007 (fuzzy-tool-name-resolution-2026-07-02, D-006): the safety PROPERTY behind the calibrated
 * (T, M) — a fuzzy resolution is never a coin-flip between neighbours.
 *
 *   If `resolveToolName` fuzzy-resolves `input` to tool `m` over catalog `C`, then adding ANY real
 *   rival one edit away from `m` to the catalog makes the resolver ABSTAIN (or, only when the input
 *   folds canonically onto a name, resolve that exact name) — never silently keep guessing.
 *
 * This is the "no input within T of >=2 candidates ever resolves" rule, stated so it is checkable
 * without re-implementing the matcher: the rival is by construction within one raw edit of `m`,
 * hence within the M=2 margin of the input's own distance to `m`.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { resolveToolName } from './resolve-name';
import { FUZZY_RESOLVE_M, FUZZY_RESOLVE_T } from './resolve-name-thresholds';
import { canonicalKey, rankCandidates } from './resolve-name-match';

const CATALOG = [
  'coord:send', 'coord:orient', 'coord:inbox', 'coord:presence', 'coord:declare-intent',
  'plans:get', 'plans:items', 'plans:list', 'plans:new', 'plans:add-decision',
  'work_items:get', 'work_items:claim_next', 'work_items:comment', 'work_items:checkpoint',
  'work_items:list', 'work_items:claimable', 'memory:search', 'memory:remember',
  'facts:list', 'facts:assert', 'locks:acquire', 'locks:release', 'events:await',
  'events:catalog', 'loop:status', 'loop:arm', 'docs:search', 'docs:get',
  'scheduler:get_next', 'testing:run', 'testing:runs', 'build:typecheck',
  'dev:pg_query', 'dev:restart', 'issues:list', 'fleet:assignments', 'tools:find',
  'tools:invoke', 'session:request-compaction', 'search:fulltext',
];

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const opts = { T: FUZZY_RESOLVE_T, M: FUZZY_RESOLVE_M };

/** A single-character mutation of the VERB half (group stays intact). */
function mutateVerb(name: string, kind: 'sub' | 'del' | 'ins' | 'swap', pos: number, ch: string): string {
  const i = name.indexOf(':');
  const group = name.slice(0, i + 1);
  let verb = name.slice(i + 1);
  const p = verb.length === 0 ? 0 : pos % verb.length;
  switch (kind) {
    case 'sub':
      verb = verb.slice(0, p) + (verb[p] === ch ? (ch === 'a' ? 'b' : 'a') : ch) + verb.slice(p + 1);
      break;
    case 'del':
      verb = verb.slice(0, p) + verb.slice(p + 1);
      break;
    case 'ins':
      verb = verb.slice(0, p) + ch + verb.slice(p);
      break;
    case 'swap':
      if (p + 1 < verb.length) verb = verb.slice(0, p) + verb[p + 1] + verb[p] + verb.slice(p + 2);
      break;
  }
  return group + verb;
}

const editKind = fc.constantFrom('sub', 'del', 'ins', 'swap' as const);
const letter = fc.constantFrom(...ALPHABET.split(''));

describe('D-006 property: a fuzzy resolution abstains once a rival sits within the margin', () => {
  it('adding a 1-edit rival of the match never leaves the resolver guessing', () => {
    let fuzzyHits = 0;
    fc.assert(
      fc.property(
        fc.constantFrom(...CATALOG),
        fc.array(fc.tuple(editKind, fc.nat(30), letter), { minLength: 1, maxLength: 2 }),
        fc.tuple(editKind, fc.nat(30), letter),
        (target, edits, rivalEdit) => {
          let input = target;
          for (const [k, p, c] of edits) input = mutateVerb(input, k, p, c);
          const before = resolveToolName(input, CATALOG, opts);
          if (before.via !== 'fuzzy' || before.match === undefined) return true; // only fuzzy hits are in scope
          fuzzyHits++;
          const rival = mutateVerb(before.match, rivalEdit[0], rivalEdit[1], rivalEdit[2]);
          if (rival === before.match || CATALOG.includes(rival)) return true;
          // A rival strictly NEARER the input than the match is a different, legitimate question
          // (it may itself be the unique best by the margin); the property is about rivals that
          // are NOT nearer — those sit within the margin of the match and must force abstention.
          const rawOf = (n: string): number => rankCandidates(input, [n])[0]?.raw ?? Number.POSITIVE_INFINITY;
          if (rawOf(rival) < rawOf(before.match)) return true;
          // OSA (adjacent transposition = 1 edit) does not obey the triangle inequality, so a rival
          // 1 edit from the MATCH can sit >= M edits farther from the INPUT (e.g. a transposed input
          // vs a rival inserting inside the transposed span). The resolver's rule is on raw distance
          // TO THE INPUT, so the property's premise is "rival within M of the match FROM THE INPUT".
          if (rawOf(rival) - rawOf(before.match) >= FUZZY_RESOLVE_M) return true;
          const after = resolveToolName(input, [...CATALOG, rival], opts);
          // Either it abstained, or the input folds canonically onto a registered name (not a guess).
          const guessing = after.via === 'fuzzy' && after.match !== undefined;
          const canonicalFold = canonicalKey(input) === canonicalKey(after.match ?? '');
          expect(guessing && !canonicalFold).toBe(false);
          return true;
        },
      ),
      { numRuns: 400, seed: 20260930 },
    );
    // The property must actually exercise fuzzy hits — a vacuous pass proves nothing.
    expect(fuzzyHits).toBeGreaterThan(30);
  });

  it('control: without the rival the same mangles do resolve (the property is not vacuous)', () => {
    // 'sned' is 0.25 normalized (> T) so it abstains on its own; use a long verb with one typo.
    expect(resolveToolName('coord:declare-intnt', CATALOG, opts).via).toBe('fuzzy');
    expect(resolveToolName('coord:declare-intnt', [...CATALOG, 'coord:declare-intant'], opts).match).toBeUndefined();
  });
});
