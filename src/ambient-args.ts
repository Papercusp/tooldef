/**
 * ambient-args — host-registered list of DISPATCH-LEVEL argument keys that the
 * transport strips/forwards BEFORE a tool's own schema ever validates the call
 * (EI-22174225494240206).
 *
 * `unknownArgHint`'s "this tool accepts ONLY: …" list is built from the tool's OWN
 * declared schema (`mergedSchemaProperties(rawSchema)`) only. A dispatch-level key —
 * one the transport peels off the raw input before tooldef's validator ever sees it,
 * such as Papercusp's `projection` — can therefore never appear in that list, even
 * though it is genuinely accepted on every call. The rejection then instructed the
 * caller, in imperative terms ("Re-send using only the keys above"), to drop a
 * capability that actually works — a documented, measured cause of at least one
 * agent concluding a working feature did not exist (EI-21736465978852433).
 *
 * `payloadTier` needs NO entry here: it is tooldef's OWN framework-reserved arg
 * (see `payload-tier.ts`, stripped inside `defineTool` itself for every tool), so
 * `unknownArgHint` names it directly via `PAYLOAD_TIER_ARG` — a concept the library
 * already owns needs no host seam. This file exists for the opposite case: a
 * dispatch-level key belonging to a concept a domain-free `libs/generic/*` package
 * must not know the NAME of (Papercusp's `projection` is defined host-side, in
 * `result-projection/types.ts`).
 *
 * The library owns the SEAM (where to fold the extra keys into the rendered hint,
 * and how to fail safe); the HOST owns the POLICY (which keys it actually strips
 * before dispatch) — the same "declare the port here, wire the impl host-side"
 * split as `server-vintage.ts` / `result-annotator.ts`.
 *
 * Default is unregistered (empty list ⇒ `unknownArgHint` is unchanged), so every
 * existing consumer/test is behavior-neutral until a host opts in.
 */

let resolver: (() => readonly string[]) | null = null;

/**
 * Register the host's ambient-dispatch-arg-keys resolver (last registration wins).
 * Must be cheap + synchronous — it runs on the invalid-args failure path, which is
 * already an error case. Return the LITERAL keys the transport strips before
 * dispatch — derived from the same source the transport itself strips with
 * (derived-truth-ladder rung 1), never a second hand-maintained copy.
 */
export function setAmbientArgKeysResolver(fn: (() => readonly string[]) | null): void {
  resolver = fn;
}

/** Clear the registered resolver — test seam + host teardown. */
export function resetAmbientArgKeysResolver(): void {
  resolver = null;
}

/**
 * Read the current ambient dispatch-arg keys, or `[]` when no host resolver is
 * registered, the host has none to report, or the resolver throws (NEVER lets a
 * broken resolver fail the underlying tool-arg validation it is only trying to
 * annotate).
 */
export function readAmbientArgKeys(): readonly string[] {
  if (!resolver) return [];
  try {
    const keys = resolver();
    return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string' && k.length > 0) : [];
  } catch {
    return [];
  }
}
