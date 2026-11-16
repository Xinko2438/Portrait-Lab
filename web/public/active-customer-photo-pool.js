export function resolveActiveCustomerPhotoPool({ customer = null, identitySets = [] } = {}) {
  const customerId = String(customer?.customer_id || '');
  const activeIdentitySetId = String(customer?.active_identity_set_id || '');
  if (!customerId || !activeIdentitySetId || !Array.isArray(identitySets)) return null;
  const matches = identitySets.filter((identitySet) => identitySet?.customer_id === customerId
    && identitySet?.identity_set_id === activeIdentitySetId);
  return matches.length === 1 ? matches[0] : null;
}
