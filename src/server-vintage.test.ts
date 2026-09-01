/**
 * server-vintage — the host-registered "how stale is this process" resolver
 * (EI-19953470656367880). Pure unit tests for the seam itself; the end-to-end
 * "does the hint actually reach an invalid_args error" wiring is pinned in
 * server-vintage-hint.test.ts, which drives the real dispatch path.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatVintageAge,
  readServerVintage,
  resetServerVintageResolver,
  serverVintageHint,
  setServerVintageResolver,
} from './server-vintage';

afterEach(() => resetServerVintageResolver());

describe('formatVintageAge', () => {
  it('renders sub-minute ages as <1min', () => {
    expect(formatVintageAge(500)).toBe('<1min');
    expect(formatVintageAge(0)).toBe('<1min');
  });

  it('renders minutes for < 1h', () => {
    expect(formatVintageAge(52 * 60_000)).toBe('52min');
  });

  it('renders hours (one decimal) for >= 1h and < 24h', () => {
    expect(formatVintageAge(4.6 * 60 * 60_000)).toBe('4.6h');
  });

  it('renders days (one decimal) for >= 24h', () => {
    expect(formatVintageAge(2.5 * 24 * 60 * 60_000)).toBe('2.5d');
  });

  it('never throws on a negative or non-finite input — falls back to an honest unknown', () => {
    expect(formatVintageAge(-5)).toBe('an unknown time');
    expect(formatVintageAge(NaN)).toBe('an unknown time');
    expect(formatVintageAge(Infinity)).toBe('an unknown time');
  });
});

describe('readServerVintage / setServerVintageResolver', () => {
  it('is null when no resolver is registered (the default, zero-cost no-op)', () => {
    expect(readServerVintage()).toBeNull();
  });

  it('returns exactly what the registered resolver returns', () => {
    setServerVintageResolver(() => ({ buildId: 'abc123', bootedAgoMs: 90_000 }));
    expect(readServerVintage()).toEqual({ buildId: 'abc123', bootedAgoMs: 90_000 });
  });

  it('last registration wins', () => {
    setServerVintageResolver(() => ({ buildId: 'first', bootedAgoMs: 0 }));
    setServerVintageResolver(() => ({ buildId: 'second', bootedAgoMs: 0 }));
    expect(readServerVintage()?.buildId).toBe('second');
  });

  it('resetServerVintageResolver clears back to null', () => {
    setServerVintageResolver(() => ({ buildId: 'abc123', bootedAgoMs: 0 }));
    resetServerVintageResolver();
    expect(readServerVintage()).toBeNull();
  });

  it('a resolver that returns null is honored as null, not coerced', () => {
    setServerVintageResolver(() => null);
    expect(readServerVintage()).toBeNull();
  });

  it('a THROWING resolver never propagates — the annotation is best-effort, never fatal', () => {
    setServerVintageResolver(() => {
      throw new Error('boom');
    });
    expect(() => readServerVintage()).not.toThrow();
    expect(readServerVintage()).toBeNull();
  });
});

describe('serverVintageHint', () => {
  it('is empty when no resolver is registered', () => {
    expect(serverVintageHint()).toBe('');
  });

  it('names the build id and rendered age, and says to restart', () => {
    setServerVintageResolver(() => ({ buildId: '7af3a88344', bootedAgoMs: 4.6 * 60 * 60_000 }));
    const hint = serverVintageHint();
    expect(hint).toContain('7af3a88344');
    expect(hint).toContain('4.6h');
    expect(hint.toLowerCase()).toContain('restart');
  });

  it('renders an optional host-provided route to the current source tree', () => {
    setServerVintageResolver(() => ({
      buildId: '7af3a88344',
      bootedAgoMs: 4.6 * 60 * 60_000,
      freshCodeEndpoint: 'the staging operator at :3170 (with ptool, pass --url=http://127.0.0.1:3170 explicitly)',
    }));
    const hint = serverVintageHint();
    expect(hint).toContain('the staging operator at :3170');
    expect(hint).toContain('--url=http://127.0.0.1:3170');
  });

  it('degrades gracefully to "an unknown build" when buildId is null', () => {
    setServerVintageResolver(() => ({ buildId: null, bootedAgoMs: 60_000 }));
    expect(serverVintageHint()).toContain('an unknown build');
  });
});
