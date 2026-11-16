function integerOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

export function normalizeManualPrimaryIndex(index, identityCount) {
  const count = Number(identityCount);
  if (!Number.isInteger(count) || count <= 0) return null;
  const selected = integerOrNull(index);
  if (selected != null && selected >= 0 && selected < count) return selected;
  return count === 1 ? 0 : null;
}

export function manualPrimaryAfterRemoval(currentIndex, removedIndex, remainingCount) {
  const current = integerOrNull(currentIndex);
  const removed = integerOrNull(removedIndex);
  const count = Number(remainingCount);
  if (current == null || current < 0) return normalizeManualPrimaryIndex(null, count);
  if (removed == null || removed < 0) return normalizeManualPrimaryIndex(current, count);
  if (current === removed) return normalizeManualPrimaryIndex(null, count);
  return normalizeManualPrimaryIndex(current > removed ? current - 1 : current, count);
}

export function reorderManualPrimary(files, primaryIndex) {
  const source = Array.from(files || []);
  const selected = integerOrNull(primaryIndex);
  if (selected == null || selected < 0 || selected >= source.length) {
    throw new RangeError('Primary identity selection is missing or invalid');
  }
  return [source[selected], ...source.filter((_, index) => index !== selected)];
}
