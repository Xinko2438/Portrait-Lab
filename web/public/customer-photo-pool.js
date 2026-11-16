const DEFAULT_LIMIT = 4;

function ordinal(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function stableReferences(identitySet) {
  return (Array.isArray(identitySet?.references) ? identitySet.references : [])
    .map((reference) => ({ ...reference, ordinal: ordinal(reference.ordinal) }))
    .filter((reference) => reference.ordinal != null)
    .sort((left, right) => left.ordinal - right.ordinal);
}

function stateCopy(state, updates = {}) {
  return {
    ...state,
    references: state.references.map((reference) => ({ ...reference })),
    selectedOrdinals: [...state.selectedOrdinals],
    ...updates,
  };
}

export function createCustomerPhotoPoolState({ customerId = '', identitySet = null, limit = DEFAULT_LIMIT } = {}) {
  const references = stableReferences(identitySet);
  const normalizedLimit = Math.max(1, Number(limit) || DEFAULT_LIMIT);
  if (!customerId || !identitySet?.identity_set_id || !references.length) {
    return { customerId: String(customerId || ''), identitySetId: identitySet?.identity_set_id || '', references, selectedOrdinals: [], primaryOrdinal: null, limit: normalizedLimit, limitReached: false };
  }
  const primary = references.find((reference) => reference.role === 'primary_front') || references[0];
  const ordered = [primary, ...references.filter((reference) => reference.ordinal !== primary.ordinal)];
  const selectedOrdinals = ordered.slice(0, normalizedLimit).map((reference) => reference.ordinal);
  return {
    customerId: String(customerId),
    identitySetId: String(identitySet.identity_set_id),
    references,
    selectedOrdinals,
    primaryOrdinal: primary.ordinal,
    limit: normalizedLimit,
    limitReached: false,
  };
}

export function toggleCustomerPhotoSelection(state, referenceOrdinal) {
  const target = ordinal(referenceOrdinal);
  if (!target || !state.references.some((reference) => reference.ordinal === target)) return stateCopy(state, { limitReached: false });
  const selected = new Set(state.selectedOrdinals);
  if (selected.has(target)) {
    selected.delete(target);
    const selectedOrdinals = state.references.map((reference) => reference.ordinal).filter((value) => selected.has(value));
    return stateCopy(state, {
      selectedOrdinals,
      primaryOrdinal: state.primaryOrdinal === target ? selectedOrdinals[0] || null : state.primaryOrdinal,
      limitReached: false,
    });
  }
  if (selected.size >= state.limit) return stateCopy(state, { limitReached: true });
  selected.add(target);
  return stateCopy(state, { selectedOrdinals: [...state.selectedOrdinals, target], primaryOrdinal: state.primaryOrdinal || target, limitReached: false });
}

export function setCustomerPhotoPrimary(state, referenceOrdinal) {
  const target = ordinal(referenceOrdinal);
  if (!target || !state.selectedOrdinals.includes(target)) throw new Error('Primary customer photo must be selected');
  return stateCopy(state, { primaryOrdinal: target, limitReached: false });
}

export function orderedCustomerPhotoOrdinals(state) {
  if (!state?.selectedOrdinals?.length || !state.primaryOrdinal) return [];
  const selected = new Set(state.selectedOrdinals);
  const remaining = state.references.map((reference) => reference.ordinal).filter((value) => selected.has(value) && value !== state.primaryOrdinal);
  return [state.primaryOrdinal, ...remaining];
}

export function customerPhotoReferenceUrl({ customerId, identitySetId, ordinal: referenceOrdinal }) {
  return `/api/customers/${encodeURIComponent(customerId)}/identity-sets/${encodeURIComponent(identitySetId)}/references/${Number(referenceOrdinal)}/file`;
}

export function reconcileCustomerPhotoPoolState({ previousState = null, customerId = '', identitySet = null, limit = DEFAULT_LIMIT } = {}) {
  const next = createCustomerPhotoPoolState({ customerId, identitySet, limit });
  if (!previousState || previousState.customerId !== next.customerId || !next.references.length) return next;

  const previousByOrdinal = new Map(previousState.references.map((reference) => [reference.ordinal, reference]));
  const used = new Set();
  const mappedOrdinals = new Map();
  for (const previousOrdinal of previousState.selectedOrdinals || []) {
    const previous = previousByOrdinal.get(previousOrdinal);
    if (!previous) continue;
    const exact = next.references.find((reference) => reference.ordinal === previous.ordinal
      && String(reference.sha256 || '') === String(previous.sha256 || '')
      && !used.has(reference.ordinal));
    const fallback = exact || next.references.find((reference) => String(reference.sha256 || '') === String(previous.sha256 || '')
      && !used.has(reference.ordinal));
    if (!fallback) continue;
    used.add(fallback.ordinal);
    mappedOrdinals.set(previousOrdinal, fallback.ordinal);
  }

  const selectedOrdinals = next.references
    .map((reference) => reference.ordinal)
    .filter((value) => used.has(value))
    .slice(0, next.limit);
  if (!selectedOrdinals.length) return next;
  const mappedPrimary = mappedOrdinals.get(previousState.primaryOrdinal);
  return stateCopy(next, {
    selectedOrdinals,
    primaryOrdinal: selectedOrdinals.includes(mappedPrimary) ? mappedPrimary : selectedOrdinals[0],
    limitReached: false,
  });
}

export function customerPhotoContextMenuPosition({
  x = 0,
  y = 0,
  menuWidth = 0,
  menuHeight = 0,
  viewportWidth = 0,
  viewportHeight = 0,
  margin = 8,
} = {}) {
  const safeMargin = Math.max(0, Number(margin) || 0);
  const safeWidth = Math.max(0, Number(menuWidth) || 0);
  const safeHeight = Math.max(0, Number(menuHeight) || 0);
  const rightmost = Math.max(safeMargin, (Number(viewportWidth) || 0) - safeWidth - safeMargin);
  const bottommost = Math.max(safeMargin, (Number(viewportHeight) || 0) - safeHeight - safeMargin);
  return {
    left: Math.round(Math.min(Math.max(Number(x) || 0, safeMargin), rightmost)),
    top: Math.round(Math.min(Math.max(Number(y) || 0, safeMargin), bottommost)),
  };
}
