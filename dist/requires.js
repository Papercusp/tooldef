/**
 * requires.ts — declarative tool PRECONDITIONS (the preInvoke mirror of `emits:`).
 *
 * A tool declares `requires: [ToolRequireSpec, …]` on `defineTool`: each spec is
 * a declarative condition (a `@papercusp/rules` DataCondition / MatchMap over
 * `{ tool, args, ctx, state }`) that must HOLD for the call to proceed, plus a
 * response when it does not —
 *
 *   - `{ error }`                 → REJECT the call (`precondition_failed`).
 *   - `{ fire, then: 'retry' }`   → AUTO-CORRECT: fire a corrective tool through
 *                                   the host's injectable fire port, re-resolve
 *                                   state, re-evaluate ONCE; reject if it still
 *                                   fails. Always visible (audited), never silent.
 *
 * The dispatcher evaluates these in the `preconditions` dispatch-stack step
 * (after `authorize`, before `timeout`) via `evaluateDataCondition` — the same
 * engine `emits:`-desugared reaction rules run on. This lifts hardcoded
 * `throw`-style guards out of handlers into declarative, inspectable,
 * uniformly-enforced policy (autoloop-pot-operator-rebuild-2026-06-05 D-006).
 *
 * SAFETY INVARIANTS ARE EXCLUDED BY DESIGN (D-007): don't-deploy-on-red,
 * protected-paths, budget/quota caps, the auth perimeter and friends stay
 * imperative + audited gates in code. `requires:` is for *functional*
 * preconditions (an arg shape, a resolvable scope, a resumable resource) —
 * never for a guard whose failure mode is harm.
 *
 * Conditions are DECLARATIVE ONLY — there is deliberately no JS-predicate
 * escape-hatch here (unlike `emits.when`): a predicate would defeat the lift
 * (inspectability, serializability). Host state enters through the spec's
 * `state` resolver instead.
 */
export {};
