import { createHash } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function orderedReferenceIdentity(references = []) {
  return references.map((reference) => ({
    role: String(reference.role || ''),
    sha256: String(reference.sha256 || '').toLowerCase(),
    width: Number(reference.width),
    height: Number(reference.height),
    mime_type: String(reference.mime_type || reference.mimeType || '').toLowerCase(),
  }));
}

export function identitySetGroupHash({ customerId, references = [] }) {
  return sha256(JSON.stringify({
    customer_id: String(customerId || ''),
    ordered_references: orderedReferenceIdentity(references),
  }));
}

function compareSets(a, b) {
  const versionDifference = Number(a.version || 0) - Number(b.version || 0);
  if (versionDifference !== 0) return versionDifference;
  return String(a.identity_set_id).localeCompare(String(b.identity_set_id));
}

function recoveryEntry(identitySet, canonicalIdentitySetId, groupHash, isReferenced) {
  return {
    customer_id: identitySet.customer_id,
    identity_set_id: identitySet.identity_set_id,
    canonical_identity_set_id: canonicalIdentitySetId,
    version: Number(identitySet.version),
    state: identitySet.state,
    group_hash: groupHash,
    eligible_for_deletion: !isReferenced,
    blocked_reasons: isReferenced ? ['referenced_by_run'] : [],
    identity_set_projection: structuredClone(identitySet),
    identity_set_metadata: {
      schema_version: identitySet.schema_version,
      display_name: identitySet.display_name,
      coverage: Array.isArray(identitySet.coverage) ? [...identitySet.coverage] : [],
      created_at: identitySet.created_at,
      updated_at: identitySet.updated_at,
    },
    references: (identitySet.references || []).map((reference) => ({
      ordinal: reference.ordinal,
      role: reference.role,
      filename: reference.filename,
      original_name: reference.original_name,
      sha256: reference.sha256,
      bytes: reference.bytes,
      width: reference.width,
      height: reference.height,
      mime_type: reference.mime_type,
      extension: reference.extension,
    })),
  };
}

export function buildIdentityDedupPlan({ customer, identitySets = [], referencedIdentitySetIds = [] }) {
  const customerId = String(customer?.customer_id || '');
  if (!customerId) throw new Error('Customer id is required');

  const activeIdentitySetId = String(customer?.active_identity_set_id || '');
  const referenced = new Set(Array.from(referencedIdentitySetIds || [], (value) => String(value)));
  const grouped = new Map();

  for (const identitySet of identitySets || []) {
    if (identitySet?.customer_id !== customerId || identitySet?.state !== 'active') continue;
    const groupHash = identitySetGroupHash({ customerId, references: identitySet.references });
    if (!grouped.has(groupHash)) grouped.set(groupHash, []);
    grouped.get(groupHash).push(identitySet);
  }

  const inventory = [];
  for (const [groupHash, group] of grouped) {
    if (group.length < 2) continue;
    const ordered = [...group].sort(compareSets);
    const canonical = ordered.find((identitySet) => identitySet.identity_set_id === activeIdentitySetId)
      || ordered.at(-1);
    const duplicates = ordered.filter((identitySet) => identitySet.identity_set_id !== canonical.identity_set_id);
    const recoveryEntries = duplicates.map((identitySet) => recoveryEntry(
      identitySet,
      canonical.identity_set_id,
      groupHash,
      referenced.has(identitySet.identity_set_id),
    ));
    inventory.push({
      group_hash: groupHash,
      canonical_identity_set_id: canonical.identity_set_id,
      identity_set_ids: ordered.map((identitySet) => identitySet.identity_set_id),
      duplicate_identity_set_ids: recoveryEntries
        .filter((entry) => entry.eligible_for_deletion)
        .map((entry) => entry.identity_set_id),
      blocked: recoveryEntries
        .filter((entry) => !entry.eligible_for_deletion)
        .map((entry) => ({ identity_set_id: entry.identity_set_id, reason: 'referenced_by_run' })),
      recovery_entries: recoveryEntries,
    });
  }

  inventory.sort((a, b) => {
    const aHasActive = a.identity_set_ids.includes(activeIdentitySetId);
    const bHasActive = b.identity_set_ids.includes(activeIdentitySetId);
    if (aHasActive !== bHasActive) return aHasActive ? -1 : 1;
    return a.group_hash.localeCompare(b.group_hash);
  });
  const primaryGroup = inventory[0] || null;

  return {
    schema_version: 'ai-img-gen.customer-identity-dedup-plan.v1',
    customer_id: customerId,
    canonical_identity_set_id: primaryGroup?.canonical_identity_set_id || null,
    duplicate_identity_set_ids: inventory.flatMap((group) => group.duplicate_identity_set_ids),
    blocked: inventory.flatMap((group) => group.blocked),
    recovery_entries: inventory.flatMap((group) => group.recovery_entries),
    group_hash: primaryGroup?.group_hash || null,
    inventory,
  };
}
