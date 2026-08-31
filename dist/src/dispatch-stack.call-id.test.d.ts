/**
 * The per-call correlation contract (EI-21548894457555139).
 *
 * A host that opens in-flight state in `onDispatchStart` must be able to close
 * exactly THAT entry in `recordInvocation`. Nothing else in the payload can carry
 * that: runId/spawnId/parentSpawnId are all SESSION-scoped, so two concurrent calls
 * from one agent are indistinguishable without `callId`. These tests pin the three
 * properties a correlating host depends on — same id across the pair, distinct ids
 * across calls, and an id present on the error path too.
 */
export {};
