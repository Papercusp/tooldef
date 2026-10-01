/**
 * Tests for the host late-completion READ seam (WI-10004577).
 * Run with: npm run test:file -- libs/generic/tooldef/src/late-completion-read.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultLateCompletionReadClassifier,
  isLateCompletionSafeRead,
  setLateCompletionReadClassifier,
} from './capability-tiers';

// Module-global seam: restore the engine default so one test's policy never leaks into the next.
afterEach(() => setLateCompletionReadClassifier(defaultLateCompletionReadClassifier));

const facts = { name: 'x:y', capabilities: ['intel:read'], effect: 'read' as const };

describe('late-completion read seam', () => {
  it('engine default: nothing is late-completion-safe (the abort stays authoritative)', () => {
    expect(isLateCompletionSafeRead(facts)).toBe(false);
  });

  it('reflects the host-registered classifier and passes it the tool facts', () => {
    const seen: unknown[] = [];
    setLateCompletionReadClassifier((t) => {
      seen.push(t);
      return t.name === 'x:y';
    });
    expect(isLateCompletionSafeRead(facts)).toBe(true);
    expect(isLateCompletionSafeRead({ ...facts, name: 'other' })).toBe(false);
    expect(seen[0]).toEqual(facts);
  });

  it('a THROWING classifier fails CLOSED — a broken policy must never widen the exemption', () => {
    setLateCompletionReadClassifier(() => {
      throw new Error('boom');
    });
    expect(isLateCompletionSafeRead(facts)).toBe(false);
  });

  it('only a literal true admits (a truthy non-boolean does not)', () => {
    setLateCompletionReadClassifier((() => 'yes') as never);
    expect(isLateCompletionSafeRead(facts)).toBe(false);
  });
});
