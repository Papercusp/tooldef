/**
 * A tool records the file that DEFINED it (EI-21351815194031529).
 *
 * This is the derivation the host-side staleness check rests on: without a real
 * source path, "is this tool's schema stale?" has nothing to ask git about. It is
 * captured from the call stack, so the failure mode is silent — a wrong frame index
 * yields `undefined`, not an error, and every consumer then degrades to "unknown"
 * forever while looking perfectly healthy.
 *
 * That is not hypothetical: the previous `deriveNameFromCallSite` took frame `[2]`
 * with a comment asserting `[1]=defineTool`, but it is invoked one level deeper than
 * that comment assumed, so it read `defineTool`'s own frame and returned null for
 * every tool. Nobody noticed, because every first-party tool passes an explicit
 * `name`. These tests exist so the same silence cannot recur.
 */
export {};
