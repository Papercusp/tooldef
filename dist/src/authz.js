/**
 * The most common resource rule, as a ready-made `PolicyDecisionPoint`: allow iff the
 * principal owns the resource. `getOwnerId` extracts the owner id from the resource
 * (default: `resource.attributes.ownerId`); ownership is compared against
 * `principal.slug`. Hosts needing relationship/attribute rules supply their own PDP
 * instead — this is the floor, not the ceiling.
 */
export function ownerOnly(getOwnerId = (r) => r.attributes?.ownerId) {
    return {
        decide(q) {
            if (!q.resource) {
                return { allow: false, reason: 'ownerOnly: no resource to check ownership against' };
            }
            const owner = getOwnerId(q.resource);
            const allow = owner != null && owner === q.principal.slug;
            return allow
                ? { allow: true }
                : {
                    allow: false,
                    reason: `ownerOnly: principal "${q.principal.slug}" is not the owner (owner: ${owner ?? 'none'})`,
                };
        },
    };
}
