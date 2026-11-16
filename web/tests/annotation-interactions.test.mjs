import test from 'node:test';
import assert from 'node:assert/strict';

import { anchoredShapeGeometry, canEditStrokeWidth, nearestStrokeWidth, resolveEditorShortcut } from '../public/annotation-interactions.js';

test('shape geometry keeps the mouse-down corner fixed while the opposite corner moves', () => {
  assert.deepEqual(
    anchoredShapeGeometry({ x: 120, y: 90 }, { x: 220, y: 170 }),
    { left: 120, top: 90, width: 100, height: 80, originX: 'left', originY: 'top' },
  );
  assert.deepEqual(
    anchoredShapeGeometry({ x: 220, y: 170 }, { x: 120, y: 90 }),
    { left: 120, top: 90, width: 100, height: 80, originX: 'left', originY: 'top' },
  );
});

test('editor shortcuts support delete and undo without stealing keys from text fields', () => {
  assert.equal(resolveEditorShortcut({ key: 'Delete' }), 'delete');
  assert.equal(resolveEditorShortcut({ key: 'Backspace' }), 'delete');
  assert.equal(resolveEditorShortcut({ key: 'z', ctrlKey: true }), 'undo');
  assert.equal(resolveEditorShortcut({ key: 'v', ctrlKey: true }), 'undo');
  assert.equal(resolveEditorShortcut({ key: 'y', ctrlKey: true }), 'redo');
  assert.equal(resolveEditorShortcut({ key: 'z', ctrlKey: true, shiftKey: true }), 'redo');
  assert.equal(resolveEditorShortcut({ key: 'Delete', isTextEditing: true }), null);
  assert.equal(resolveEditorShortcut({ key: 'z', ctrlKey: true, targetTag: 'textarea' }), null);
});

test('selected vector annotations expose the nearest supported stroke width', () => {
  for (const type of ['freehand', 'rectangle', 'ellipse', 'arrow']) assert.equal(canEditStrokeWidth(type), true);
  for (const type of ['text', 'mosaic', '']) assert.equal(canEditStrokeWidth(type), false);
  assert.equal(nearestStrokeWidth(1), 2);
  assert.equal(nearestStrokeWidth(5), 4);
  assert.equal(nearestStrokeWidth(7), 8);
  assert.equal(nearestStrokeWidth(16), 8);
});
