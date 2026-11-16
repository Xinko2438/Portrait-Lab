export function anchoredShapeGeometry(start, current) {
  return {
    left: Math.min(start.x, current.x),
    top: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
    originX: 'left',
    originY: 'top',
  };
}

const editableStrokeTypes = new Set(['freehand', 'rectangle', 'ellipse', 'arrow']);
const supportedStrokeWidths = [2, 4, 8];

export function canEditStrokeWidth(annotationType) {
  return editableStrokeTypes.has(annotationType);
}

export function nearestStrokeWidth(value) {
  const width = Number(value);
  return supportedStrokeWidths.reduce((closest, candidate) => (
    Math.abs(candidate - width) < Math.abs(closest - width) ? candidate : closest
  ), supportedStrokeWidths[0]);
}

export function resolveEditorShortcut({
  key = '',
  ctrlKey = false,
  metaKey = false,
  shiftKey = false,
  targetTag = '',
  isContentEditable = false,
  isTextEditing = false,
} = {}) {
  const tag = String(targetTag).toLowerCase();
  if (isContentEditable || isTextEditing || ['input', 'textarea', 'select'].includes(tag)) return null;

  const normalizedKey = String(key).toLowerCase();
  const modifier = ctrlKey || metaKey;
  if (!modifier && ['delete', 'backspace'].includes(normalizedKey)) return 'delete';
  if (!modifier) return null;
  if (normalizedKey === 'z') return shiftKey ? 'redo' : 'undo';
  if (normalizedKey === 'y') return 'redo';
  if (normalizedKey === 'v') return 'undo';
  return null;
}
