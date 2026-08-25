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

interface IssueExtras {
  code?: string;
  origin?: string;
  maximum?: number;
  minimum?: number;
  /** Zod's per-branch sub-issues on an `invalid_union` issue. */
  errors?: ReadonlyArray<ReadonlyArray<StandardSchemaV1.Issue>>;
  /** Zod's names for an `unrecognized_keys` issue. */
  keys?: ReadonlyArray<PropertyKey>;
}

type UnknownKeyNode = {
  remove: Set<PropertyKey>;
  children: Map<PropertyKey, UnknownKeyNode>;
};

const UNKNOWN_KEY_CODES = new Set(['unrecognized_key', 'unrecognized_keys', 'unknown_key', 'unknown_keys']);

function issuePathSegments(issue: StandardSchemaV1.Issue): PropertyKey[] {
  return (issue.path ?? []).map((segment) =>
    typeof segment === 'object' && segment !== null
      ? (segment as { key: PropertyKey }).key
      : (segment as PropertyKey),
  );
}

function isUnknownKeyIssue(issue: StandardSchemaV1.Issue): boolean {
  const code = (issue as IssueExtras).code;
  if (code && UNKNOWN_KEY_CODES.has(code)) return true;
  // `code` is not part of Standard Schema's portable issue contract. Keep a
  // conservative message fallback so another validator can still participate
  // when it reports the same ordinary-language diagnosis.
  return /\b(?:unrecognized|unrecognised|unknown)\s+keys?\b/i.test(issue.message);
}

function messageUnknownKeys(message: string): PropertyKey[] {
  // Standard Schema only guarantees `message`; validators without Zod's
  // `keys` extension can still be revalidated when they quote the offending
  // names in the conventional `... key: "name"` form.
  const afterColon = message.slice(message.indexOf(':') + 1);
  const keys: PropertyKey[] = [];
  for (const match of afterColon.matchAll(/["'`]([^"'`]+)["'`]/g)) {
    const key = match[1];
    if (key !== undefined) keys.push(key);
  }
  return keys;
}

function unknownKeysForIssue(issue: StandardSchemaV1.Issue): PropertyKey[] {
  if (!isUnknownKeyIssue(issue)) return [];
  const keys = (issue as IssueExtras).keys;
  if (Array.isArray(keys)) return keys.filter((key): key is PropertyKey => isPropertyKey(key));
  return messageUnknownKeys(issue.message);
}

function isPropertyKey(value: unknown): value is PropertyKey {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'symbol';
}

function newUnknownKeyNode(): UnknownKeyNode {
  return { remove: new Set(), children: new Map() };
}

function unknownKeyTree(issues: ReadonlyArray<StandardSchemaV1.Issue>): UnknownKeyNode | null {
  const root = newUnknownKeyNode();
  let found = false;
  for (const issue of issues) {
    const keys = unknownKeysForIssue(issue);
    if (keys.length === 0) continue;
    found = true;
    let node = root;
    for (const segment of issuePathSegments(issue)) {
      let child = node.children.get(segment);
      if (!child) {
        child = newUnknownKeyNode();
        node.children.set(segment, child);
      }
      node = child;
    }
    for (const key of keys) node.remove.add(key);
  }
  return found ? root : null;
}

function stripUnknownKeys(input: unknown, issues: ReadonlyArray<StandardSchemaV1.Issue>): unknown {
  const tree = unknownKeyTree(issues);
  if (!tree) return input;

  const strip = (value: unknown, node: UnknownKeyNode): { value: unknown; changed: boolean } => {
    if (value === null || typeof value !== 'object') return { value, changed: false };

    let copy: Record<PropertyKey, unknown> | unknown[] = value as Record<PropertyKey, unknown>;
    let changed = false;
    const ensureCopy = (): Record<PropertyKey, unknown> | unknown[] => {
      if (!changed) {
        copy = Array.isArray(value) ? value.slice() : { ...(value as Record<PropertyKey, unknown>) };
        changed = true;
      }
      return copy;
    };

    for (const key of node.remove) {
      // `length` is an array implementation detail, never an input field.
      if (Array.isArray(value) && key === 'length') continue;
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        delete (ensureCopy() as Record<PropertyKey, unknown>)[key];
      }
    }

    for (const [key, child] of node.children) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const nested = strip((value as Record<PropertyKey, unknown>)[key], child);
      if (nested.changed) (ensureCopy() as Record<PropertyKey, unknown>)[key] = nested.value;
    }

    return { value: copy, changed };
  };

  const stripped = strip(input, tree);
  return stripped.changed ? stripped.value : input;
}

function issueKey(issue: StandardSchemaV1.Issue): string {
  const code = (issue as IssueExtras).code ?? '';
  return `${issuePathSegments(issue).map(String).join('.')}\u0000${code}\u0000${issue.message}`;
}

function mergeUniqueIssues(
  first: ReadonlyArray<StandardSchemaV1.Issue>,
  second: ReadonlyArray<StandardSchemaV1.Issue>,
): ReadonlyArray<StandardSchemaV1.Issue> {
  const merged: StandardSchemaV1.Issue[] = [];
  const seen = new Set<string>();
  for (const issue of [...first, ...second]) {
    const key = issueKey(issue);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(issue);
  }
  return merged;
}

function validateOnce<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
): Promise<ValidationResult<StandardSchemaV1.InferOutput<S>>> {
  return Promise.resolve(schema['~standard'].validate(input)).then((result) =>
    result.issues ? { ok: false, issues: result.issues } : { ok: true, value: result.value },
  );
}

function validateOnceSync<S extends StandardSchemaV1>(
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
  return result.issues ? { ok: false, issues: result.issues } : { ok: true, value: result.value };
}

/**
 * Validate `input` against a Standard Schema, awaiting async validators (Zod's
 * is synchronous; Valibot/ArkType may be async). Use from an async context.
 *
 * Strict object validators can report an unknown-key issue before running
 * object-level required checks or refinements. Revalidate once after removing
 * only the reported unknown keys, then merge the new issues back into the
 * original result. The original input is never mutated, and the first pass is
 * retained so the caller still learns about the undeclared keys.
 */
export async function standardValidate<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
): Promise<ValidationResult<StandardSchemaV1.InferOutput<S>>> {
  const first = await validateOnce(schema, input);
  if (first.ok) return first;

  const sanitized = stripUnknownKeys(input, first.issues);
  if (sanitized === input) return first;

  const second = await validateOnce(schema, sanitized);
  return second.ok
    ? first
    : { ok: false, issues: mergeUniqueIssues(first.issues, second.issues) };
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
  const first = validateOnceSync(schema, input);
  if (first.ok) return first;

  const sanitized = stripUnknownKeys(input, first.issues);
  if (sanitized === input) return first;

  const second = validateOnceSync(schema, sanitized);
  return second.ok
    ? first
    : { ok: false, issues: mergeUniqueIssues(first.issues, second.issues) };
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

/**
 * Codes whose verdict is about a value's SIZE. These are the only ones suppressed
 * when the same path also failed its type check (see `formatIssues`) — a length
 * verdict on a value of the wrong type describes nothing the caller can act on.
 */
const SIZE_CODES = new Set(['too_big', 'too_small']);

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
/**
 * Resolve issues to their LEAF diagnoses, each with its fully-qualified segment path.
 *
 * This is the traversal `formatIssues` renders from, extracted so other consumers can
 * reach the same leaves. The distinction it encodes is easy to get wrong and expensive
 * when you do: an `invalid_union` issue's own `path` stops at the UNION NODE (`body`),
 * while its real diagnosis lives in per-branch sub-issues several levels deeper
 * (`body.2.couldNotDetermine.0.what`). Anyone reading `issue.path` directly therefore
 * sees a shallow path that does not match the deep one the rendered message shows —
 * which reads as a bug in the renderer rather than a missing descent.
 *
 * Kept as ONE traversal deliberately: a second copy would drift from the rendered
 * message, and a path hint that disagrees with the error beside it is worse than none.
 */
export function issueLeaves(
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
): Array<{ issue: StandardSchemaV1.Issue; segs: PropertyKey[] }> {
  const out: Array<{ issue: StandardSchemaV1.Issue; segs: PropertyKey[] }> = [];
  const walk = (issue: StandardSchemaV1.Issue, prefix: ReadonlyArray<PropertyKey>, depth: number): void => {
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
      if (branch) {
        for (const sub of branch) walk(sub, segs, depth + 1);
        return;
      }
    }
    out.push({ issue, segs });
  };
  for (const issue of issues) walk(issue, [], 0);
  return out;
}

export function formatIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>, input?: unknown): string {
  const render = (
    issue: StandardSchemaV1.Issue,
    segs: ReadonlyArray<PropertyKey>,
  ): { path: string; code: string | undefined; text: string } => {
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
      return { path, code: extras.code, text: path ? `${path}: ${detail}` : detail };
    }
    return {
      path,
      code: extras.code,
      text: path ? `${path}: ${issue.message}` : issue.message,
    };
  };

  const rows = issueLeaves(issues).map(({ issue, segs }) => render(issue, segs));

  // A SIZE verdict on a value that failed its TYPE check is meaningless, and worse
  // than meaningless when rendered actionably. Zod's `.max(n)` on an array is a
  // size check that reads `.length` off whatever it is handed — so a prose STRING
  // passed to an array field reports `too_big { origin: 'string', maximum: n }`
  // ALONGSIDE the invalid_type, and the branch above dutifully renders it as
  // "too long — 312 chars, 292 over the 20-char limit; trim to 20." The 20 bounds
  // ITEMS, not characters, and trimming the prose is the opposite of the fix
  // (pass an array). Being the more specific-sounding of the two messages, it
  // out-competes the correct one.
  //
  // EI-20018883577474576: six independent agents hit this on coord:send's
  // `youMayNotKnow` / `couldNotDetermine`, and every report ends the same way —
  // they shipped by DELETING the structured field. The renderer taught agents to
  // strip the epistemic-honesty fields the protocol exists to carry.
  const typeFailedPaths = new Set(rows.filter((r) => r.code === 'invalid_type').map((r) => r.path));
  const kept = rows.filter((r) => !(r.code && SIZE_CODES.has(r.code) && typeFailedPaths.has(r.path)));

  // Never return an empty string: if suppression somehow removed everything, the
  // caller is better served by the raw issues than by a silent success-shaped "".
  return (kept.length > 0 ? kept : rows).map((r) => r.text).join('; ');
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
