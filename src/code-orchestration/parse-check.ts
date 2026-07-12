/**
 * code-execution-tool-orchestration B-CX-1A / B-CX-PARSE — static PARSE-CHECK.
 *
 * A fast-fail, pre-execution guard: walks the script's TypeScript AST for references to the
 * injected `tools` facade and reports any that aren't in the agent's allowed set. It resolves the
 * normal forms — `tools.<ns>.<verb>(…)` and the `tools.call('<ns>:<verb>', …)` escape hatch — and
 * also the obfuscated-but-static forms a regex misses:
 *
 *   - computed string-literal access:  `tools['sys']['admin']`, `tools['workItems'].list`
 *   - `tools` aliasing:                `const t = tools; t.sys.admin()`
 *   - namespace / verb destructuring:  `const { coord } = tools; coord.wakeQueue()`
 *                                      `const { list } = tools.workItems; list()`
 *
 * This turns the common typo / disallowed-tool case (incl. an obfuscation attempt) into a clean
 * upfront error listing the offenders, before any tool runs.
 *
 * NOT a security boundary. The runtime WHITELIST in the facade (a disallowed tool is simply
 * absent, and `tools.call` throws on an unknown name) is the boundary; this static walk is a UX +
 * telemetry aid layered on top (the plan §8 consensus). It resolves everything STATICALLY
 * determinable; genuinely dynamic access (`tools[runtimeVar]`, `tools.call(runtimeVar)`) is left
 * to the runtime whitelist by design and is NOT flagged here. If parsing ever fails the walk falls
 * back to a regex scan so the aid degrades gracefully rather than failing open.
 */
import type { SourceFile, Expression, ObjectBindingPattern, Node } from 'typescript';
import type { ProjectedTool } from '../tool-projection';
import { camelNamespace, camelVerb } from './tool-facade';

// PERF (FCP): `typescript` (the compiler) is ~3.4MB minified. This module is
// re-exported through the `@papercusp/tooldef` + `@papercusp/agent-mcp` barrels,
// which the operator webview imports — a STATIC `import ts from 'typescript'`
// here put the whole compiler into the eager client boot bundle (the
// second-largest FCP cost after js-tiktoken; E2E perf sweep 2026-06-23). The TS
// AST walk is pure server-side (code:run parse-check). Load it via a lazy
// dynamic import so it splits into its own chunk fetched ONLY when checkScript
// actually runs (server). `checkScript` stays synchronous; callers must
// `await ensureParseCheckReady()` once before the first call (the two runtime
// entry points — runToolOrchestration + captureRecipe — already do).
// See /internal/docs/performance.
type TsModule = typeof import('typescript');
let _ts: TsModule | null = null;

/** Lazily load the TS compiler (kept out of the eager client bundle). Await once before checkScript(). Idempotent. */
export async function ensureParseCheckReady(): Promise<void> {
  if (!_ts) {
    const m = (await import('typescript')) as unknown as { default?: TsModule } & TsModule;
    _ts = (m.default ?? m) as TsModule;
  }
}

function tsc(): TsModule {
  if (!_ts) {
    throw new Error(
      'parse-check: ensureParseCheckReady() must be awaited before checkScript() (the TS compiler is lazy-loaded to keep it out of the eager client bundle)',
    );
  }
  return _ts;
}

export interface ParseCheckResult {
  ok: boolean;
  /** Tool references found in the script that are NOT in the allowed facade. */
  unknownRefs: string[];
  /** All tool references the static scan resolved (for logging/telemetry). */
  refs: string[];
}

export function checkScript(
  script: string,
  tools: readonly ProjectedTool[],
  allowed?: ReadonlySet<string>,
): ParseCheckResult {
  const ts = tsc(); // lazy-loaded TS compiler (see ensureParseCheckReady)
  const memberToName = new Map<string, string>(); // "ns.camelVerb" → full name
  const fullNames = new Set<string>();
  for (const t of tools) {
    const name = t.expose?.mcp?.name;
    if (!name || name.indexOf(':') <= 0) continue;
    if (allowed && !allowed.has(name)) continue;
    const ci = name.indexOf(':');
    memberToName.set(`${camelNamespace(name.slice(0, ci))}.${camelVerb(name.slice(ci + 1))}`, name);
    fullNames.add(name);
  }

  const refs = new Set<string>();
  const unknown = new Set<string>();
  // Accept the snake_case OR camelCase spelling of a `ns.verb` member: the
  // facade exposes BOTH (the canonical MCP name is snake_case), so normalize to
  // the camel key before deciding "unknown". Deterministic, not fuzzy — mirrors
  // the raw-alias registration in buildToolFacade. A member is always exactly
  // `ns.verb` (one dot) as built by `step`.
  const canonMember = (member: string): string => {
    const dot = member.indexOf('.');
    if (dot <= 0) return member;
    return `${camelNamespace(member.slice(0, dot))}.${camelVerb(member.slice(dot + 1))}`;
  };
  const recordMember = (member: string): void => {
    refs.add(member);
    if (!memberToName.has(member) && !memberToName.has(canonMember(member))) unknown.add(member);
  };
  const recordFull = (name: string): void => {
    refs.add(name);
    if (!fullNames.has(name)) unknown.add(name);
  };

  let source: SourceFile;
  try {
    source = ts.createSourceFile('script.ts', script, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  } catch {
    return regexFallback(script, memberToName, fullNames);
  }

  // Binding maps, populated in source order during the walk. Straight-line scripts declare an
  // alias (`const t = tools`) before they use it, and chained bindings (`const w = tools.x; const
  // f = w.y`) resolve because the walk is depth-first in source order. The runtime whitelist is
  // the real boundary, so an unusual out-of-order binding that this misses is caught there.
  const toolsAliases = new Set<string>(['tools']);
  const nsBindings = new Map<string, string>(); // ident → ns
  const funcBindings = new Map<string, string>(); // ident → "ns.camelVerb" member

  type Resolved =
    | { kind: 'tools' }
    | { kind: 'callHatch' }
    | { kind: 'ns'; ns: string }
    | { kind: 'member'; member: string }
    | null;

  const literalKey = (node: Expression): string | null =>
    ts.isStringLiteralLike(node) ? node.text : null;

  /** One property step within the facade, given the resolved base. */
  const step = (base: NonNullable<Resolved>, prop: string): Resolved => {
    if (base.kind === 'tools') {
      // `tools.call` is the escape hatch, never a namespace (mirrors buildToolFacade).
      return prop === 'call' ? { kind: 'callHatch' } : { kind: 'ns', ns: prop };
    }
    if (base.kind === 'ns') return { kind: 'member', member: `${base.ns}.${prop}` };
    return null; // 'member' / 'callHatch' have no further facade step
  };

  /** Resolve an expression to a facade position, or null if it isn't one / is dynamically computed. */
  const resolve = (node: Expression): Resolved => {
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
      return resolve(node.expression);
    }
    if (ts.isIdentifier(node)) {
      const n = node.text;
      if (toolsAliases.has(n)) return { kind: 'tools' };
      const ns = nsBindings.get(n);
      if (ns !== undefined) return { kind: 'ns', ns };
      const member = funcBindings.get(n);
      if (member !== undefined) return { kind: 'member', member };
      return null;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const base = resolve(node.expression);
      return base ? step(base, node.name.text) : null;
    }
    if (ts.isElementAccessExpression(node)) {
      const base = resolve(node.expression);
      if (!base) return null;
      const key = literalKey(node.argumentExpression);
      return key == null ? null : step(base, key); // dynamic key → unresolvable → runtime boundary
    }
    return null;
  };

  const bindElements = (pattern: ObjectBindingPattern, r: { kind: 'tools' } | { kind: 'ns'; ns: string }): void => {
    for (const el of pattern.elements) {
      if (!ts.isIdentifier(el.name)) continue; // nested patterns aren't facade bindings
      const local = el.name.text;
      const pn = el.propertyName;
      const key = pn && ts.isIdentifier(pn)
        ? pn.text
        : pn && ts.isStringLiteralLike(pn)
          ? pn.text
          : local;
      if (r.kind === 'tools') {
        if (key === 'call') continue; // destructured escape hatch — not a namespace
        nsBindings.set(local, key);
      } else {
        funcBindings.set(local, `${r.ns}.${key}`);
      }
    }
  };

  const visit = (node: Node): void => {
    // 1) Binding collection (source order, before this node's own references are recorded).
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const r = resolve(node.initializer);
      if (r) {
        if (ts.isIdentifier(node.name)) {
          if (r.kind === 'tools') toolsAliases.add(node.name.text);
          else if (r.kind === 'ns') nsBindings.set(node.name.text, r.ns);
          else if (r.kind === 'member') funcBindings.set(node.name.text, r.member);
        } else if (ts.isObjectBindingPattern(node.name) && (r.kind === 'tools' || r.kind === 'ns')) {
          bindElements(node.name, r);
        }
      }
    }

    // 2) Reference recording.
    if (ts.isCallExpression(node)) {
      const r = resolve(node.expression);
      if (r?.kind === 'callHatch') {
        const name = node.arguments[0] ? literalKey(node.arguments[0]) : null;
        if (name != null) recordFull(name); // dynamic arg → runtime boundary
      } else if (r?.kind === 'member') {
        recordMember(r.member);
      }
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const r = resolve(node);
      if (r?.kind === 'member') recordMember(r.member);
    }

    ts.forEachChild(node, visit);
  };
  visit(source);

  return { ok: unknown.size === 0, unknownRefs: [...unknown].sort(), refs: [...refs].sort() };
}

/** Degrade gracefully if AST parsing ever throws: the original regex scan (dotted + call only). */
function regexFallback(
  script: string,
  memberToName: ReadonlyMap<string, string>,
  fullNames: ReadonlySet<string>,
): ParseCheckResult {
  const refs = new Set<string>();
  const unknown = new Set<string>();
  for (const m of script.matchAll(/\btools\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
    if (m[1] === 'call') continue;
    const member = `${m[1]}.${m[2]}`;
    const canon = `${camelNamespace(m[1])}.${camelVerb(m[2])}`; // snake OR camel spelling
    refs.add(member);
    if (!memberToName.has(member) && !memberToName.has(canon)) unknown.add(member);
  }
  for (const m of script.matchAll(/\btools\.call\(\s*['"`]([^'"`]+)['"`]/g)) {
    refs.add(m[1]);
    if (!fullNames.has(m[1])) unknown.add(m[1]);
  }
  return { ok: unknown.size === 0, unknownRefs: [...unknown].sort(), refs: [...refs].sort() };
}
