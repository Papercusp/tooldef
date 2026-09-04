import type { InvalidInputCorrection } from './dispatch-types';

/**
 * P-015 (coordination-spec-adoption-2026-08-03) — make every arg-shape refusal hand back
 * the CORRECTED CALL, resolved against the arguments the caller actually passed.
 *
 * WHY THIS AND NOT THE EXISTING HINTS. The catalogue already identifies corrections
 * (`invalidInputCorrections`) and renders them as advice — "this tool accepts ONLY: …",
 * "Did you mean `scope` for `harness`?", and, on a shape error, a bounded dump of the
 * whole args schema. D-105 established that this is not enough, and named the reason:
 *
 *   "A SCHEMA DUMP IS NOT A TEACHING REFUSAL. The R-2 requirement is not 'return the
 *    schema', it is 'return the CORRECTED CALL, resolved against the arguments actually
 *    passed'. A full schema makes the caller re-derive the fix; a named key or a
 *    did-you-mean hands it over."
 *
 * The measurement behind that (D-104, 7d, papercusp-workspace, same agent / same verb /
 * retry within 5 min) is a within-system comparison, so it controls for agent quality:
 *
 *   improvements:capture  did-you-mean + accepted key list   111 vs 5    96% recovery
 *   dev:pg_query          knownColumns                         2 vs 0
 *   state:subscribe       named correction                     9 vs 0
 *   coord:send            states the violated rule only      165 vs 156   51% recovery
 *
 * And the decisive counter-example, also D-105: `omp:sessions` DOES return its entire args
 * schema on refusal, and ten agents still hit the same wall 66 times (~6.6 attempts each).
 * A caller drowning in schema is not a caller who has been taught. So the unit of help is
 * not the vocabulary, it is the finished call.
 *
 * WHAT THIS IS NOT. This is the REFUSAL half of D-104 only: we refuse, and hand back the
 * corrected call. It never executes anything. D-104 draws that line deliberately —
 * re-encodings (one deterministic candidate, no new information) may auto-run, while a
 * DISAMBIGUATION (we chose among candidates) or a MISSING VALUE must refuse, because
 * "running a guess answers a question the caller did not ask". Every correction reachable
 * here is a disambiguation: `near-name` picked one of several keys by edit distance, and a
 * dropped key is us asserting the caller wanted it gone. Auto-running those is P-016's
 * separate, narrower mandate, and it is gated on a different rule than this one.
 *
 * HONESTY BOUND. A corrected call fixes the keys that were REJECTED. It cannot promise the
 * result validates: the same payload may still carry a bad value, a missing required field,
 * or a nested shape error the unrecognized-key branch never inspected. The rendering says
 * so rather than implying a green light — an over-promise here costs the same wasted
 * round-trip the whole mechanism exists to remove.
 */

/** What happened to one key the caller sent that the tool did not accept. */
export interface CorrectedCallStep {
  /** The key as the caller sent it. */
  readonly rejectedArg: string;
  /** `relocated` — its value moved to `target`. `dropped` — nothing accepts it here. */
  readonly action: 'relocated' | 'dropped';
  /** Destination for `relocated`: a top-level key, or a dotted path for a nested arg. */
  readonly target?: string;
  /** Which correction source chose the destination (absent when dropped). */
  readonly kind?: InvalidInputCorrection['kind'];
  /**
   * Dropped, but the tool DOES declare this key on another variant of a discriminated
   * union — the caller picked the wrong branch, not a nonexistent arg. Distinguishing the
   * two matters: "no counterpart" sends an agent looking for a synonym, which for
   * `omp:sessions`'s `cwd` (declared on op=list/search/link) would be a dead end.
   */
  readonly acceptedOnOtherVariant?: boolean;
}

export interface CorrectedCall {
  readonly tool: string;
  /**
   * The corrected arguments, with FULL values — this is the machine-usable artifact
   * (P-016 executes from it; the rendered string below is the human-readable one and
   * elides bulk). Consumers must not assume it validates: see the honesty bound above.
   */
  readonly args: Record<string, unknown>;
  readonly steps: readonly CorrectedCallStep[];
  /** One-line, copy-pasteable, size-bounded rendering. */
  readonly rendered: string;
  /** True when at least one key had no destination and was removed. */
  readonly droppedUnaccepted: boolean;
}

/**
 * Budget for the rendered call. Deliberately far below `ARGS_SCHEMA_HINT_MAX` (1800): this
 * text is worth more per character than a schema dump, so it must not be the thing that
 * pushes the schema hint out of the result — the two are complements, not rivals.
 */
const RENDERED_MAX = 700;
/** Longest scalar echoed back before it is replaced by a placeholder. */
const VALUE_MAX = 96;

/**
 * Set `path` (dot-delimited) on `target`, creating plain objects along the way.
 *
 * Refuses to descend through a non-object that the caller already supplied, returning false
 * so the caller degrades to `dropped` rather than silently destroying data: overwriting a
 * value the caller sent, in order to advertise a "correction", would make the corrected
 * call lossy in a way nothing downstream could detect.
 */
function setPath(target: Record<string, unknown>, path: string, value: unknown): boolean {
  const segments = path.split('.').filter((segment) => segment.length > 0);
  if (segments.length === 0) return false;
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const existing = cursor[segment];
    if (existing === undefined) {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
      continue;
    }
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) return false;
    cursor = existing as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
  return true;
}

/** Compact, bounded rendering of one value — bulk becomes a labelled placeholder. */
function renderValue(value: unknown): string {
  if (typeof value === 'string') {
    if (value.length <= VALUE_MAX) return JSON.stringify(value);
    // Say what was removed and that the ORIGINAL should be re-sent. A silently clipped
    // string would be copy-pasted as-is and truncate the caller's own data.
    return JSON.stringify(`<your original ${value.length}-char string>`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? 'null';
  } catch {
    return '"<unserializable>"';
  }
  if (serialized.length <= VALUE_MAX) return serialized;
  if (Array.isArray(value)) return `<your original ${value.length}-item array>`;
  return '<your original value>';
}

function renderArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const part = `${JSON.stringify(key)}: ${renderValue(value)}`;
    if (used + part.length > RENDERED_MAX) {
      omitted += 1;
      continue;
    }
    used += part.length + 2;
    parts.push(part);
  }
  // Report the overflow rather than trailing off: a call rendered as if complete, but
  // silently missing keys, is worse than the refusal it replaced.
  const tail = omitted > 0 ? `, /* +${omitted} more arg(s) you sent, unchanged */` : '';
  return `{ ${parts.join(', ')}${tail} }`;
}

/**
 * Build the corrected call for an unrecognized-key refusal.
 *
 * `unknownKeys` must be the FULL set of keys the tool rejected — including ones for which no
 * correction was found. Those are the `dropped` cases, and they are the highest-value half:
 * D-105's `omp:sessions` finding is exactly this shape (66 rejections, ten agents, one
 * undeclared `cwd` with no counterpart), and its stated remedy is the honest
 * "`cwd` is not accepted; drop it" rather than a schema wall.
 *
 * Returns null when there is nothing useful to say — no object input, or no key actually
 * changed — so the caller appends nothing rather than an empty flourish.
 */
export function buildCorrectedCall(params: {
  readonly toolName: string;
  readonly input: unknown;
  readonly corrections: readonly InvalidInputCorrection[];
  readonly unknownKeys: readonly string[];
  /** Subset of `unknownKeys` the tool declares on a different union variant. */
  readonly acceptedOnOtherVariant?: readonly string[];
}): CorrectedCall | null {
  const { toolName, input, corrections, unknownKeys } = params;
  const acceptedElsewhere = new Set(params.acceptedOnOtherVariant ?? []);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (unknownKeys.length === 0) return null;

  const args: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  const steps: CorrectedCallStep[] = [];

  // An authored redirect points at a DIFFERENT tool, so its value cannot be relocated
  // within this call — the key is simply not ours. It is still dropped here (leaving it
  // would re-trigger the same rejection), and the redirect's own rendered call, which
  // `unknownArgHint` already emits, remains the answer for where the value belongs.
  const byArg = new Map<string, InvalidInputCorrection>();
  for (const correction of corrections) {
    if (correction.kind === 'authored-redirect') continue;
    if (!byArg.has(correction.rejectedArg)) byArg.set(correction.rejectedArg, correction);
  }

  for (const key of unknownKeys) {
    if (!(key in args)) continue;
    const value = args[key];
    const correction = byArg.get(key);
    if (correction && setPath(args, correction.target, value)) {
      delete args[key];
      steps.push({
        rejectedArg: key,
        action: 'relocated',
        target: correction.target,
        kind: correction.kind,
      });
      continue;
    }
    delete args[key];
    steps.push({
      rejectedArg: key,
      action: 'dropped',
      ...(acceptedElsewhere.has(key) ? { acceptedOnOtherVariant: true } : {}),
    });
  }

  if (steps.length === 0) return null;

  return {
    tool: toolName,
    args,
    steps,
    rendered: `${toolName}(${renderArgs(args)})`,
    droppedUnaccepted: steps.some((step) => step.action === 'dropped'),
  };
}

/**
 * The sentence appended to the refusal. Leads with the finished call, then explains what was
 * changed — the order matters: pg_query's 42703 path learned the same lesson the hard way
 * ("an advisory emitted after that wall is one the reader has already scrolled past").
 */
export function correctedCallHint(corrected: CorrectedCall | null): string {
  if (!corrected) return '';
  const relocated = corrected.steps
    .filter((step) => step.action === 'relocated')
    .map((step) => `\`${step.rejectedArg}\` -> \`${step.target}\``);
  const droppedSteps = corrected.steps.filter((step) => step.action === 'dropped');
  const wrongVariant = droppedSteps
    .filter((step) => step.acceptedOnOtherVariant)
    .map((step) => `\`${step.rejectedArg}\``);
  const unknownAnywhere = droppedSteps
    .filter((step) => !step.acceptedOnOtherVariant)
    .map((step) => `\`${step.rejectedArg}\``);
  const changes: string[] = [];
  if (relocated.length > 0) changes.push(`moved ${relocated.join(', ')}`);
  if (unknownAnywhere.length > 0) {
    changes.push(
      `removed ${unknownAnywhere.join(', ')} (this tool declares no counterpart — the fix is to drop it, not to look for a synonym)`,
    );
  }
  if (wrongVariant.length > 0) {
    changes.push(
      `removed ${wrongVariant.join(', ')} (declared by this tool, but NOT on the variant your other args select — switch variant if you need it, do not rename it)`,
    );
  }
  return (
    ` CORRECTED CALL — send this: ${corrected.rendered}` +
    ` (${changes.join('; ')}).` +
    ' This resolves the rejected keys against the args you actually sent; it does not' +
    ' guarantee the call validates, since a value-level or missing-field error would' +
    ' not have been visible to this check.'
  );
}
