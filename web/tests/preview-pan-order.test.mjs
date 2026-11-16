import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { clampPreviewZoom, orderedPreviewItems } from '../public/media-preview-state.js';

test('preview order is always template then identity then generated', () => {
  const ordered = orderedPreviewItems({
    templates: [{ kind: 'template', id: 't1' }, { kind: 'template', id: 't2' }],
    identities: [{ kind: 'identity', id: 'i1' }],
    generated: [{ kind: 'generated', id: 'g1' }, { kind: 'generated', id: 'g2' }],
  });
  assert.deepEqual(ordered.map((item) => item.id), ['t1', 't2', 'i1', 'g1', 'g2']);
});

test('preview zoom remains within recoverable bounds', () => {
  assert.equal(clampPreviewZoom(0.1), 0.5);
  assert.equal(clampPreviewZoom(1.75), 1.75);
  assert.equal(clampPreviewZoom(9), 4);
});

test('preview exposes zoom controls, wheel resizing and pointer pan', async () => {
  const [html, app, css] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
  ]);
  for (const id of ['previewZoomOut', 'previewZoomReset', 'previewZoomIn', 'previewZoomValue', 'mediaPreviewStage']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /orderedPreviewItems/);
  assert.match(app, /applyPreviewTransform/);
  assert.match(app, /pointerdown/);
  assert.match(app, /pointermove/);
  assert.match(app, /wheel/);
  assert.match(css, /touch-action:none/);
  assert.match(css, /cursor:grab/);
});
