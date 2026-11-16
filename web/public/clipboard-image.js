export const ACCEPTED_CLIPBOARD_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);

const MIME_EXTENSION = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
});

function timestampToken(now) {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('Z', '');
}

function fileKey(file) {
  return `${file.name || ''}:${file.size || 0}:${file.type || ''}:${file.lastModified || 0}`;
}

export function clipboardImageFiles(dataTransfer, { kind = 'identity', now = Date.now() } = {}) {
  const candidates = [];
  for (const file of Array.from(dataTransfer?.files || [])) candidates.push(file);
  if (!candidates.length) {
    for (const item of Array.from(dataTransfer?.items || [])) {
      if (item?.kind !== 'file') continue;
      const file = item.getAsFile?.();
      if (file) candidates.push(file);
    }
  }
  const accepted = [];
  const seen = new Set();
  for (const file of candidates) {
    if (!ACCEPTED_CLIPBOARD_IMAGE_TYPES.includes(String(file?.type || '').toLowerCase())) continue;
    const key = fileKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push(file);
  }
  const label = kind === 'templates' ? 'template' : 'identity';
  const token = timestampToken(now);
  return accepted.map((file, index) => new File([file], `clipboard-${label}-${token}-${String(index + 1).padStart(2, '0')}.${MIME_EXTENSION[file.type]}`, {
    type: file.type,
    lastModified: Number(now) + index,
  }));
}

export function mergeFilesWithinLimit(existingFiles = [], incomingFiles = [], limit = Infinity) {
  const files = Array.from(existingFiles).slice(0, Math.max(0, limit));
  const known = new Set(files.map(fileKey));
  let addedCount = 0;
  let duplicateCount = 0;
  let rejectedCount = 0;
  for (const file of Array.from(incomingFiles)) {
    const key = fileKey(file);
    if (known.has(key)) {
      duplicateCount += 1;
      continue;
    }
    if (files.length >= limit) {
      rejectedCount += 1;
      continue;
    }
    files.push(file);
    known.add(key);
    addedCount += 1;
  }
  return { files, added_count: addedCount, duplicate_count: duplicateCount, rejected_count: rejectedCount };
}

export function isEditablePasteTarget(target) {
  return Boolean(target?.closest?.('input:not([type="file"]), textarea, select, [contenteditable="true"], [contenteditable=""]'));
}