/**
 * code-execution-tool-orchestration B-CX-1A — static PARSE-CHECK.
 *
 * A fast-fail, pre-execution guard: scans the script for `tools.<ns>.<verb>(…)` and
 * `tools.call('<ns>:<verb>', …)` references and reports any that aren't in the agent's allowed
 * facade. This turns the common typo / disallowed-tool case into a clean upfront error listing
 * the offenders, before any tool runs.
 *
 * NOT a security boundary: a script can obfuscate access (computed member, aliasing) to dodge a
 * regex scan. The runtime WHITELIST in the facade (a disallowed tool is simply absent) is the
 * boundary; this is a UX + telemetry aid layered on top. (A TS-AST walk would catch more forms
 * — a tracked hardening; the surface here is unchanged by it.)
 */
import type { ProjectedTool } from '../tool-projection';

export interface ParseCheckResult {
  ok: boolean;
  /** Tool references found in the script that are NOT in the allowed facade. */
  unknownRefs: string[];
  /** All tool references the static scan found (for logging/telemetry). */
  refs: string[];
}

const camelVerb = (verb: string): string =>
  verb.replace(/[-_]+([a-z0-9])/gi, (_m, c: string) => c.toUpperCase());

export function checkScript(
  script: string,
  tools: readonly ProjectedTool[],
  allowed?: ReadonlySet<string>,
): ParseCheckResult {
  const memberToName = new Map<string, string>(); // "ns.camelVerb" → full name
  const fullNames = new Set<string>();
  for (const t of tools) {
    const name = t.expose?.mcp?.name;
    if (!name || name.indexOf(':') <= 0) continue;
    if (allowed && !allowed.has(name)) continue;
    const ci = name.indexOf(':');
    memberToName.set(`${name.slice(0, ci)}.${camelVerb(name.slice(ci + 1))}`, name);
    fullNames.add(name);
  }

  const refs = new Set<string>();
  const unknown = new Set<string>();

  for (const m of script.matchAll(/\btools\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
    if (m[1] === 'call') continue; // tools.call(...) handled below
    const member = `${m[1]}.${m[2]}`;
    refs.add(member);
    if (!memberToName.has(member)) unknown.add(member);
  }
  for (const m of script.matchAll(/\btools\.call\(\s*['"`]([^'"`]+)['"`]/g)) {
    refs.add(m[1]);
    if (!fullNames.has(m[1])) unknown.add(m[1]);
  }

  return { ok: unknown.size === 0, unknownRefs: [...unknown].sort(), refs: [...refs].sort() };
}
