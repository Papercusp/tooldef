import { describe, it, expect } from 'vitest';
import { unwrapToolResult } from './dispatch-binding';
import type { ToolResult } from '../wire';

const tr = (r: Partial<ToolResult>) => r as ToolResult;

describe('unwrapToolResult (B-CX-1A dispatch binding)', () => {
  it('prefers structuredContent when present', () => {
    expect(unwrapToolResult(tr({ structuredContent: { items: [1, 2] }, content: [] }))).toEqual({
      items: [1, 2],
    });
  });

  it('parses the JSON text payload when there is no structuredContent', () => {
    expect(
      unwrapToolResult(tr({ content: [{ type: 'text', text: '{"ok":true,"n":3}' }] as never })),
    ).toEqual({ ok: true, n: 3 });
  });

  it('falls back to raw text when the payload is not JSON', () => {
    expect(unwrapToolResult(tr({ content: [{ type: 'text', text: 'hello' }] as never }))).toBe('hello');
  });

  it('returns undefined for a missing result', () => {
    expect(unwrapToolResult(undefined)).toBeUndefined();
  });
});
