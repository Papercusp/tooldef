/**
 * Host-specialized seams — types the framework references but does not own.
 *
 * In Papercusp these were concrete unions (`AgentRole`), capability strings,
 * and a subprocess executor. In the generic framework they are open seams:
 * a role is any string, a capability is any string, and `spawn` is an
 * optional host-supplied subprocess runner.
 *
 * **Roles are host-configured, not baked in (plan P-010 / D-005).** The core
 * never enumerates roles — it only compares strings. A host registers its
 * known roles by augmenting `RoleRegistry` via declaration merging; that
 * narrows `AgentRole` editor autocomplete program-wide while keeping the type
 * `string`-assignable (plugins register arbitrary custom roles at runtime, so
 * the set is never closed). A consumer that registers nothing — e.g. the
 * standalone example (P-051) — gets `AgentRole = string`, fully generic.
 *
 * `Capability` is still a bare `string`; its host-injection (the `tierFor`
 * rule) is P-012, not P-010.
 */
export {};
