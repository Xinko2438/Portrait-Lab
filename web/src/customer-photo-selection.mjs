function positiveOrdinal(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${label}`);
  return parsed;
}

export function selectCustomerIdentityFiles({
  customerId,
  identitySetId,
  materialized,
  selectedOrdinals = [],
  primaryOrdinal = null,
  uploadedFiles = [],
  explicitSelection = false,
  limit = 4,
} = {}) {
  const identitySet = materialized?.identitySet;
  const files = Array.isArray(materialized?.files) ? materialized.files : [];
  if (!identitySet || identitySet.customer_id !== customerId || identitySet.identity_set_id !== identitySetId) throw new Error('Customer identity selection scope mismatch');
  if (uploadedFiles.length) throw new Error('Cannot combine saved customer photos with uploaded identity files');
  const references = Array.isArray(identitySet.references) ? identitySet.references : [];
  if (references.length !== files.length) throw new Error('Identity reference materialization mismatch');
  const byOrdinal = new Map();
  references.forEach((reference, index) => {
    const value = positiveOrdinal(reference.ordinal, 'identity reference ordinal');
    const file = files[index];
    if (!file || String(file.sha256 || '') !== String(reference.sha256 || '')) throw new Error('Identity reference hash mismatch');
    byOrdinal.set(value, { reference, file });
  });

  let requested;
  let primary;
  if (explicitSelection) {
    requested = selectedOrdinals.map((value) => positiveOrdinal(value, 'selected identity reference ordinal'));
    if (!requested.length) throw new Error('At least one saved customer photo must be selected');
    if (requested.length > limit) throw new Error('Saved customer photo selection cannot exceed four');
    if (new Set(requested).size !== requested.length) throw new Error('Selected identity reference ordinals must be unique');
    primary = positiveOrdinal(primaryOrdinal, 'primary identity reference ordinal');
    if (!requested.includes(primary)) throw new Error('Primary identity reference must belong to the selected references');
  } else {
    requested = references.map((reference) => positiveOrdinal(reference.ordinal, 'identity reference ordinal'));
    primary = positiveOrdinal((references.find((reference) => reference.role === 'primary_front') || references[0])?.ordinal, 'primary identity reference ordinal');
  }
  for (const value of requested) if (!byOrdinal.has(value)) throw new Error('Selected identity reference not found');
  const requestedSet = new Set(requested);
  const ordered = [primary, ...references.map((reference) => Number(reference.ordinal)).filter((value) => requestedSet.has(value) && value !== primary)];
  return {
    files: ordered.map((value) => byOrdinal.get(value).file),
    selectedOrdinals: ordered,
    primaryOrdinal: primary,
    source: {
      customer_id: String(customerId),
      identity_set_id: String(identitySetId),
      reference_ordinals: ordered,
      primary_reference_ordinal: primary,
    },
  };
}

