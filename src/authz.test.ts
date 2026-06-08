/**
 * Tests for ownerOnly — the floor PolicyDecisionPoint (allow iff the principal
 * owns the resource). Run with:
 *   npx vitest run libs/generic/tooldef/src/authz.test.ts
 */
import { describe, expect, it } from 'vitest';
import { ownerOnly, type AuthzQuery } from './authz';

const query = (over: Partial<AuthzQuery> = {}): AuthzQuery =>
  ({ principal: { slug: 'alice' } as AuthzQuery['principal'], action: 'read', ...over });

describe('ownerOnly (default owner extractor)', () => {
  const pdp = ownerOnly();

  it('denies when there is no resource to check', () => {
    const d = pdp.decide(query());
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/no resource/);
  });

  it('allows when the principal owns the resource (attributes.ownerId)', () => {
    const d = pdp.decide(query({ resource: { type: 'doc', attributes: { ownerId: 'alice' } } }));
    expect(d.allow).toBe(true);
  });

  it('denies + explains when someone else owns the resource', () => {
    const d = pdp.decide(query({ resource: { type: 'doc', attributes: { ownerId: 'bob' } } }));
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/not the owner.*bob/);
  });

  it('denies when no owner id is present (owner: none)', () => {
    const d = pdp.decide(query({ resource: { type: 'doc', attributes: {} } }));
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/owner: none/);
  });
});

describe('ownerOnly (custom owner extractor)', () => {
  it('uses the supplied getOwnerId', () => {
    const pdp = ownerOnly((r) => r.id);
    expect(pdp.decide(query({ resource: { type: 'doc', id: 'alice' } })).allow).toBe(true);
    expect(pdp.decide(query({ resource: { type: 'doc', id: 'bob' } })).allow).toBe(false);
  });
});
