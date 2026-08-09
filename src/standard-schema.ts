/**
 * Standard Schema adoption (plan P-020 / D-002).
 *
 * The engine validates a tool's `args`/`input`/`state` and card payloads against
 * any [Standard Schema](https://standardschema.dev) validator — Zod 3.24+,
 * Valibot, ArkType, … — not Zod specifically. It reads only the `~standard`
 * property every such validator exposes; it never calls Zod-specific methods
 * like `.safeParse`. The Papercusp host keeps Zod for its ~96 tools (D-002 only
 * generalizes the core, not the consumers), and Zod schemas satisfy
 * `StandardSchemaV1` so they flow through unchanged.
 *
 * JSON-Schema generation is a *separate* pluggable concern (Standard Schema has
 * no JSON-Schema export) — see `schema-adapter.ts` (P-021).
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';

export type { StandardSchemaV1 };

/** A validation outcome the engine branches on. */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ReadonlyArray<StandardSchemaV1.Issue> };

/**
 * Validate `input` against a Standard Schema, awaiting async validators (Zod's
 * is synchronous; Valibot/ArkType may be async). Use from an async context.
 */
export async function standardValidate<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
): Promise<ValidationResult<StandardSchemaV1.InferOutput<S>>> {
  const result = await schema['~standard'].validate(input);
  // SuccessResult has `issues?: undefined`; FailureResult has a non-empty
  // `issues`. Truthy-check (not `'issues' in r`) is the correct narrowing.
  if (result.issues) return { ok: false, issues: result.issues };
  return { ok: true, value: result.value };
}

/**
 * Synchronous validation for call paths that cannot await (e.g. the
 * fire-and-forget `ctx.publishState`). Zod validates synchronously; if a host
 * plugs in an async validator on such a path, this throws loudly rather than
 * silently dropping validation.
 */
export function validateSync<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
): ValidationResult<StandardSchemaV1.InferOutput<S>> {
  const result = schema['~standard'].validate(input);
  if (result instanceof Promise) {
    throw new Error(
      'Standard Schema validate() returned a Promise on a synchronous path. ' +
        'Async validators are not supported here (e.g. ctx.publishState); use a synchronous validator like Zod.',
    );
  }
  if (result.issues) return { ok: false, issues: result.issues };
  return { ok: true, value: result.value };
}

/**
 * A validation issue's ZOD-flavoured extras. StandardSchemaV1.Issue only promises
 * `{ message, path? }`, but a Zod issue carries `code`/`origin`/`maximum` at runtime
 * and that is what every validator in this repo actually produces. Read them
 * defensively (all optional): a host plugging in a non-Zod validator simply loses the
 * enrichment and falls back to the plain `path: message` rendering.
 *
 * `errors` is Zod v4's per-branch sub-issues on an `invalid_union` issue — one array
 * per union member, each holding that branch's own issues. See `bestUnionBranch` below
 * for why this needs to be read.
 */
interface IssueExtras {
  code?: string;
  origin?: string;
  maximum?: number;
  minimum?: number;
  errors?: ReadonlyArray<ReadonlyArray<StandardSchemaV1.Issue>>;
}

/**
 * EI-19968462161677390: an `invalid_union` issue's own top-level message is Zod's
 * generic "Invalid input" — it never names which field was wrong, because the union
 * itself has no field. The USEFUL diagnosis lives in `issue.errors`: one sub-issue
 * array per union branch, each carrying the field-level issues THAT branch produced
 * trying to match the input. A caller who sends a well-shaped ARRAY into
 * `z.union([z.string(), z.array(section)])` gets a deep, specific issue from the
 * array branch (e.g. `body[1].forYouBecause.note: Required`) and a shallow
 * "expected string, received array" from the string branch — the deep one is the
 * branch the caller actually meant, so its issues are the ones worth surfacing.
 *
 * Picks the branch reaching the greatest PATH DEPTH (ties keep the first). A branch
 * with depth 0 (e.g. the string branch's bare type mismatch) never wins once any
 * other branch located a specific field — reproduced live: reporting the deepest
 * branch turns "body: Invalid input" into
 * "body[1].forYouBecause.note: forYouBecause.relation:'other' REQUIRES a `note`".
 */
function bestUnionBranch(
  issue: StandardSchemaV1.Issue,
): ReadonlyArray<StandardSchemaV1.Issue> | null {
  const branches = (issue as IssueExtras).errors;
  if (!Array.isArray(branches) || branches.length === 0) return null;
  let best: ReadonlyArray<StandardSchemaV1.Issue> | null = null;
  let bestDepth = 0;
  for (const branch of branches) {
    if (!Array.isArray(branch) || branch.length === 0) continue;
    const depth = Math.max(...branch.map((i) => (i.path ?? []).length));
    if (depth > bestDepth) {
      bestDepth = depth;
      best = branch;
    }
  }
  return best;
}

/**
 * Value-level issue codes: the caller used a KEY THAT EXISTS and supplied a value the
 * field would not take. Contrast with a shape problem (an unrecognized key, a missing
 * required field, a wrong type) where the caller demonstrably does not know the schema.
 * The distinction drives `issuesAreValueLevel` below — see its doc.
 */
const VALUE_LEVEL_CODES = new Set(['too_big', 'too_small', 'invalid_format', 'invalid_value', 'not_multiple_of']);

export function issuePath(issue: StandardSchemaV1.Issue): string {
  return (issue.path ?? [])
    .map((seg) => (typeof seg === 'object' && seg !== null ? String((seg as { key: PropertyKey }).key) : String(seg)))
    .join('.');
}

/**
 * True when EVERY issue is a value-level violation on a NAMED field — i.e. the caller
 * knows the tool's shape and simply sent a value one field would not accept (too long,
 * a bad enum value, a malformed string).
 *
 * EI-10943: this is the signal that a full args-schema dump is pure context burn. The
 * dump (P-004) earns its keep for a SHAPE-blind caller — an unrecognized key, an omitted
 * required field — where one failure should teach the whole contract. But a 1,800-char
 * schema appended to "foundDuring: too long — 3 chars over the 120-char limit" teaches
 * nothing the caller did not already know, and it lands in the context of the agent least
 * able to spare it. An unnamed-path issue (a whole-object refinement) is treated as a
 * shape problem, so it keeps the schema.
 */
export function issuesAreValueLevel(issues: ReadonlyArray<StandardSchemaV1.Issue>): boolean {
  if (issues.length === 0) return false;
  return issues.every((issue) => {
    const code = (issue as IssueExtras).code;
    return !!code && VALUE_LEVEL_CODES.has(code) && issuePath(issue).length > 0;
  });
}

/**
 * Render issues into a single `path: message; …` string (Zod-error-like).
 *
 * A string `too_big` is rendered ACTIONABLY — how far over the cap the value is and the
 * exact target length — so the caller trims deterministically in ONE retry instead of
 * blind-retrying the same value (a telemetry audit traced ~1,000+ tool calls/14d failing
 * purely on over-length args, and Zod's own "Too big: expected string to have <=120
 * characters" never says by how much). Needs the input to measure the actual length;
 * without it the message degrades gracefully to the target-only form.
 */
export function formatIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>, input?: unknown): string {
  const render = (
    issue: StandardSchemaV1.Issue,
    prefix: ReadonlyArray<PropertyKey>,
    depth: number,
  ): string[] => {
    const segs = [
      ...prefix,
      ...(issue.path ?? []).map((seg) =>
        typeof seg === 'object' && seg !== null ? (seg as { key: PropertyKey }).key : (seg as PropertyKey),
      ),
    ];
    // An `invalid_union` issue's real diagnosis lives in its per-branch sub-issues
    // (see `bestUnionBranch`) — surface the branch that located an actual field
    // instead of the union's own generic "Invalid input". Bounded recursion so a
    // union of unions cannot spin.
    if (depth < 4) {
      const branch = bestUnionBranch(issue);
      if (branch) return branch.flatMap((sub) => render(sub, segs, depth + 1));
    }
    const path = segs.map((s) => String(s)).join('.');
    const extras = issue as IssueExtras;
    if (extras.code === 'too_big' && extras.origin === 'string' && typeof extras.maximum === 'number') {
      const max = extras.maximum;
      const actual = input !== undefined ? valueAtPath(input, segs) : undefined;
      const actualLen = typeof actual === 'string' ? actual.length : null;
      const over = actualLen !== null ? actualLen - max : null;
      const detail =
        over !== null && over > 0
          ? `too long — ${actualLen} chars, ${over} over the ${max}-char limit; trim to ${max}.`
          : `too long — over the ${max}-char limit; trim to ${max}.`;
      return [path ? `${path}: ${detail}` : detail];
    }
    return [path ? `${path}: ${issue.message}` : issue.message];
  };
  return issues.flatMap((issue) => render(issue, [], 0)).join('; ');
}

/** Walk `input` to the value at a resolved (already-flattened) segment path. */
function valueAtPath(input: unknown, segs: ReadonlyArray<PropertyKey>): unknown {
  let cur: unknown = input;
  for (const seg of segs) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur;
}
