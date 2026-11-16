import assert from 'node:assert/strict';
import test from 'node:test';

let selectionModule = null;
try {
  selectionModule = await import('../public/manual-primary-selection.js');
} catch {}

test('one identity defaults to primary while multiple identities require an explicit choice', () => {
  assert.equal(typeof selectionModule?.normalizeManualPrimaryIndex, 'function');
  assert.equal(selectionModule.normalizeManualPrimaryIndex(null, 0), null);
  assert.equal(selectionModule.normalizeManualPrimaryIndex(null, 1), 0);
  assert.equal(selectionModule.normalizeManualPrimaryIndex(null, 3), null);
  assert.equal(selectionModule.normalizeManualPrimaryIndex(2, 3), 2);
});

test('removing identities repairs or clears the selected source index', () => {
  assert.equal(typeof selectionModule?.manualPrimaryAfterRemoval, 'function');
  assert.equal(selectionModule.manualPrimaryAfterRemoval(2, 0, 2), 1);
  assert.equal(selectionModule.manualPrimaryAfterRemoval(1, 1, 2), null);
  assert.equal(selectionModule.manualPrimaryAfterRemoval(0, 0, 1), 0);
  assert.equal(selectionModule.manualPrimaryAfterRemoval(null, 0, 2), null);
});

test('submission reorders exact files without mutating the original array', () => {
  assert.equal(typeof selectionModule?.reorderManualPrimary, 'function');
  const files = [{ name: 'one.png' }, { name: 'two.png' }, { name: 'three.png' }];
  const reordered = selectionModule.reorderManualPrimary(files, 1);
  assert.deepEqual(reordered.map((item) => item.name), ['two.png', 'one.png', 'three.png']);
  assert.deepEqual(files.map((item) => item.name), ['one.png', 'two.png', 'three.png']);
  assert.throws(() => selectionModule.reorderManualPrimary(files, null), /primary identity/i);
  assert.throws(() => selectionModule.reorderManualPrimary(files, 9), /primary identity/i);
});

test('reordered browser files become FormData with the selected image first', () => {
  const files = [
    new File([Uint8Array.of(1)], 'one.png', { type: 'image/png' }),
    new File([Uint8Array.of(2)], 'two.png', { type: 'image/png' }),
  ];
  const form = new FormData();
  for (const file of selectionModule.reorderManualPrimary(files, 1)) form.append('identity', file, file.name);
  assert.deepEqual(form.getAll('identity').map((file) => file.name), ['two.png', 'one.png']);
});
