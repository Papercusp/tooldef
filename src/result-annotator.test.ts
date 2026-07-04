import { afterEach, describe, expect, it } from 'vitest';
import {
  applyResultAnnotator,
  resetResultAnnotator,
  setResultAnnotator,
} from './result-annotator';
import type { ToolResult } from './wire';

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });

afterEach(() => resetResultAnnotator());

describe('result-annotator seam', () => {
  it('is a no-op passthrough when no annotator is registered', () => {
    const r = ok('hello');
    expect(applyResultAnnotator(r, {})).toBe(r);
  });

  it('applies the registered annotator', () => {
    setResultAnnotator((result) => ({
      ...result,
      content: [...result.content, { type: 'text', text: 'ANNOTATED' }],
    }));
    const out = applyResultAnnotator(ok('hi'), {});
    expect(out.content).toHaveLength(2);
    expect(out.content[1]).toEqual({ type: 'text', text: 'ANNOTATED' });
  });

  it('passes the ctx through to the annotator', () => {
    let seen: unknown = null;
    setResultAnnotator((result, ctx) => {
      seen = ctx;
      return result;
    });
    applyResultAnnotator(ok('hi'), { ownerId: 'su-x' });
    expect(seen).toEqual({ ownerId: 'su-x' });
  });

  it('does NOT annotate a soft-error result (ambient lines never ride a failed call)', () => {
    setResultAnnotator((result) => ({
      ...result,
      content: [...result.content, { type: 'text', text: 'ANNOTATED' }],
    }));
    const err: ToolResult = { content: [{ type: 'text', text: 'boom' }], isError: true };
    expect(applyResultAnnotator(err, {})).toBe(err);
  });

  it('swallows a thrown annotator error and returns the original result', () => {
    setResultAnnotator(() => {
      throw new Error('annotator blew up');
    });
    const r = ok('hi');
    expect(applyResultAnnotator(r, {})).toBe(r);
  });

  it('reset clears the annotator back to the no-op', () => {
    setResultAnnotator((result) => ({
      ...result,
      content: [...result.content, { type: 'text', text: 'X' }],
    }));
    resetResultAnnotator();
    const r = ok('hi');
    expect(applyResultAnnotator(r, {})).toBe(r);
  });
});
