"use strict";
/**
 * Wire types — the transport-facing shapes the framework owns.
 *
 * These were historically defined in `@papercusp/plugin-sdk`; the
 * framework now owns them and the plugin SDK re-exports them (dependency
 * inversion, plan `papercusp-tooldef-extraction-2026-05-29` P-003). Nothing
 * here is host-specific — these are the MCP-shaped result and the streaming
 * callbacks every tool handler sees.
 */
Object.defineProperty(exports, "__esModule", { value: true });
