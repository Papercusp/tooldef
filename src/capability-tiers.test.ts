/**
 * Tests for the pluggable capability→tier resolver.
 * Run with: npx vitest run libs/generic/tooldef/src/capability-tiers.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultTierResolver,
  setCapabilityTierResolver,
  tierFor,
  type CapabilityTierResolver,
} from './capability-tiers';

// The resolver is module-global; reset to the engine default after each test
// so one test's host-policy override never leaks into the next.
afterEach(() => setCapabilityTierResolver(defaultTierResolver));

describe('defaultTierResolver', () => {
  it('classifies every capability as "low"', () => {
    expect(defaultTierResolver('secrets:read:*')).toBe('low');
    expect(defaultTierResolver('')).toBe('low');
    expect(defaultTierResolver('anything')).toBe('low');
  });
});

describe('tierFor', () => {
  it('uses the engine default ("low") until a host registers a policy', () => {
    expect(tierFor('secrets:read')).toBe('low');
  });

  it('reflects a host-registered resolver', () => {
    const policy: CapabilityTierResolver = (cap) =>
      cap.startsWith('secrets:') ? 'high' : cap.startsWith('tasks:') ? 'medium' : 'low';
    setCapabilityTierResolver(policy);
    expect(tierFor('secrets:read:*')).toBe('high');
    expect(tierFor('tasks:write')).toBe('medium');
    expect(tierFor('fix:read')).toBe('low');
  });

  it('is last-writer-wins (idempotent registration)', () => {
    setCapabilityTierResolver(() => 'high');
    setCapabilityTierResolver(() => 'medium');
    expect(tierFor('whatever')).toBe('medium');
  });

  it('returns to the default after re-registering defaultTierResolver', () => {
    setCapabilityTierResolver(() => 'high');
    expect(tierFor('x')).toBe('high');
    setCapabilityTierResolver(defaultTierResolver);
    expect(tierFor('x')).toBe('low');
  });
});
