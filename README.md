# @papercusp/tooldef

A **function-as-truth** tool framework. Write one typed function:

```ts
(input, ctx) => ToolResult
```

…declare a small manifest (capabilities, roles, quotas, exposure), and the
framework projects it onto **HTTP**, **MCP**, **IPC**, and **in-process**
callers — all through one dispatcher with uniform auth / role / quota /
timeout / telemetry / streaming behavior. You don't write per-transport glue.

Design goals that make it reusable outside Papercusp:

- **Schema-agnostic.** Args/events/state accept any
  [Standard Schema](https://standardschema.dev) validator (Zod 3.24+,
  Valibot, ArkType) plus a pluggable `toJsonSchema` adapter.
- **Host-agnostic.** Every side effect — quota reads, telemetry writes,
  principal resolution, spawn-context signing, capability→tier mapping — is
  injected. The core depends on no database, no web framework, and no
  `@papercusp/*` package.
- **Streaming-or-not, no rewrite.** A handler that calls `ctx.progress()` /
  `ctx.emit()` gets MCP notifications and SSE events for free; one that
  doesn't returns a single result.

## Status

🚧 **Extraction in progress.** This package is being carved out of
`@papercusp/agent-mcp`'s endpoint system. Tracking plan:
[`apps/operator/docs/plans/papercusp-tooldef-extraction-2026-05-29.md`](../../apps/operator/docs/plans/papercusp-tooldef-extraction-2026-05-29.md).

- **Phase 1 (current):** package scaffold + wire-type ownership (`ToolResult`,
  `RolesQuota`, `ProgressCallback`, `EmitCallback`). `@papercusp/plugin-sdk`
  now re-exports these from here.
- **Next:** move the dispatcher, registry, and `defineTool`; replace the six
  Papercusp-specific rules with injected interfaces; Standard Schema adoption.

The conceptual reference for the system this packages up lives at
`/internal/docs/endpoint-system/*` (overview, function-as-truth, transports).
