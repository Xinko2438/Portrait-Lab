export function wrappedPreviewIndex(current, delta, length) {
  if (!Number.isInteger(length) || length <= 0) return 0;
  return ((Number(current || 0) + Number(delta || 0)) % length + length) % length;
}

export function clampPreviewZoom(value, minimum = 0.5, maximum = 4) {
  const zoom = Number(value);
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(maximum, Math.max(minimum, zoom));
}

export function orderedPreviewItems({ templates = [], identities = [], generated = [] } = {}) {
  return [...templates, ...identities, ...generated];
}
