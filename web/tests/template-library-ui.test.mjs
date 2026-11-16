import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const htmlUrl = new URL('../public/index.html', import.meta.url);
const cssUrl = new URL('../public/app.css', import.meta.url);
const libJsUrl = new URL('../public/template-library.js', import.meta.url);
const appJsUrl = new URL('../public/app.js', import.meta.url);

test('workbench exposes dedicated template library entry, modal dialog, and script module', async () => {
  const html = await readFile(htmlUrl, 'utf8');
  assert.match(html, /id="openTemplateLibraryButton"/, 'expected template library trigger button in workbench');
  assert.match(html, /id="templateLibraryDialog"/, 'expected native dialog for template library');
  assert.match(html, /id="templateSearchInput"/, 'expected search input in library dialog');
  assert.match(html, /id="templateStyleFilter"/, 'expected style category filter in library dialog');
  assert.match(html, /id="templateGrid"/, 'expected template gallery grid in library dialog');
  assert.match(html, /id="safeInspirationSection"/, 'expected separate safe inspiration surface');
  assert.match(html, /id="safeInspirationGrid"/, 'expected safe inspiration cards');
  assert.match(html, /id="refreshSafeInspirationButton"/, 'expected safe inspiration refresh action');
  assert.match(html, /id="templateDetailDrawer"/, 'expected template detail drawer/container');
  assert.match(html, /src="template-library.js"/, 'expected index.html to load template-library.js');

  const css = await readFile(cssUrl, 'utf8');
  assert.match(css, /.template-library-dialog/, 'expected dialog styles');
  assert.match(css, /.template-card/, 'expected template card styling');
  assert.match(css, /.template-card.is-selected/, 'expected selection visual indicator');

  const libJs = await readFile(libJsUrl, 'utf8');
  assert.match(libJs, /createTemplateLibraryController/, 'expected controller export or factory');
});

test('template library controller consumes real nested list shape and requires active selection before catalog use', async () => {
  const { createTemplateLibraryController } = await import('../public/template-library.js');
  let fetchedUrl = null;
  const first = {
    template_uid: 'tpl_studio_001',
    template_info: { template_name: 'Classic Studio Portrait' },
    selection_tags: {
      style_category: 'realistic_portrait',
      portrait_scale: 'bust',
      face_angle: 'front',
      identity_preservation_risk: 'low',
      generation_difficulty: 'medium',
    },
    reference_image: {
      url: '/api/templates/tpl_studio_001/reference',
      sha256: 'a'.repeat(64),
      mime_type: 'image/jpeg',
      extension: '.jpg',
    },
  };
  const fakeFetch = async (url) => {
    fetchedUrl = url;
    return { ok: true, json: async () => ({ templates: [first], total: 1 }) };
  };

  const controller = createTemplateLibraryController({ fetch: fakeFetch });
  const listed = await controller.loadTemplates({ style_category: 'realistic_portrait', q: 'studio' });
  assert.equal(listed.templates[0].template_info.template_name, 'Classic Studio Portrait');
  assert.equal(controller.getItems()[0].reference_image.extension, '.jpg');
  assert.match(fetchedUrl, /style_category=realistic_portrait/);
  assert.match(fetchedUrl, /q=studio/);

  const blocked = controller.toggleSelection(first, 0);
  assert.deepEqual(blocked, { selected: false, reason: 'selection_required' });

  controller.setActiveSelection({
    selection_id: 'selection_01',
    top4: [{ template_uid: first.template_uid }],
    top10: [{ template_uid: first.template_uid }],
  });
  const added = controller.toggleSelection(first, 0);
  assert.equal(added.selected, true);
  assert.equal(controller.getSelectedTemplates()[0].name, 'Classic Studio Portrait');
  assert.equal(controller.getSelectedTemplates()[0].image_url, '/api/templates/tpl_studio_001/reference');

  const second = { ...first, template_uid: 'tpl_studio_002', template_info: { template_name: 'Second' } };
  const third = { ...first, template_uid: 'tpl_studio_003', template_info: { template_name: 'Third' } };
  assert.equal(controller.toggleSelection(second, 2).selected, true);
  const overflow = controller.toggleSelection(third, 2);
  assert.equal(overflow.selected, false);
  assert.equal(overflow.reason, 'limit_exceeded');
});

test('catalog-only template selection can satisfy the task without a manual template upload', async () => {
  const html = await readFile(htmlUrl, 'utf8');
  const templateInput = html.match(/<input[^>]+id="templates"[^>]*>/)?.[0] || '';
  assert.ok(templateInput, 'expected template file input');
  assert.doesNotMatch(templateInput, /\brequired\b/, 'catalog-only selection must not be blocked by native file validation');

  const appJs = await readFile(appJsUrl, 'utf8');
  assert.match(
    appJs,
    /if \(!referenceFileState\.templates\.length && !selectedCatalogTemplates\.length\)/,
    'expected explicit combined manual-or-catalog template validation',
  );
});

test('task picker hides operator-rejected templates while preserving catalog data and other task explanations', async () => {
  const { createTemplateLibraryController, templateRejectionText } = await import('../public/template-library.js');
  const templates = [
    {
      template_uid: 'tpl_eligible',
      template_info: { template_name: 'Eligible' },
      selection_tags: { style_category: 'black_white_magazine' },
      reference_image: { url: '/eligible.jpg', sha256: 'a'.repeat(64), mime_type: 'image/jpeg', extension: '.jpg' },
    },
    {
      template_uid: 'tpl_blocked',
      template_info: { template_name: 'Blocked' },
      selection_tags: { style_category: 'dark_grunge' },
      reference_image: { url: '/blocked.jpg', sha256: 'b'.repeat(64), mime_type: 'image/jpeg', extension: '.jpg' },
    },
    {
      template_uid: 'tpl_rejected',
      operator_rejected: true,
      template_info: { template_name: 'Rejected' },
      selection_tags: { style_category: 'dark_grunge' },
      reference_image: { url: '/rejected.jpg', sha256: 'c'.repeat(64), mime_type: 'image/jpeg', extension: '.jpg' },
    },
  ];
  const vocabulary = {
    style_category: ['black_white_magazine', 'dark_grunge'],
    portrait_scale: ['bust'],
    face_angle: ['front'],
    identity_preservation_risk: ['low', 'high'],
    generation_difficulty: ['medium'],
  };
  const controller = createTemplateLibraryController({
    fetch: async () => ({ ok: true, json: async () => ({ templates, total: 124, filters: vocabulary }) }),
  });
  const response = await controller.loadTemplates();
  assert.equal(response.total, 124);
  assert.equal(controller.getTotal(), 124);
  assert.equal(controller.getItems().length, 3, 'fixture page may be partial while total remains full-catalog count');
  assert.deepEqual(controller.getTaskPickerItems().map(item => item.template_uid), ['tpl_eligible', 'tpl_blocked']);
  assert.equal(controller.getTaskPickerHiddenRejectedCount(), 1);
  assert.deepEqual(controller.getFilterVocabulary(), vocabulary);

  controller.setActiveSelection({
    selection_id: 'sel_111111111111111111111111',
    top4: [],
    top10: [],
    ranked_candidates: [{ template_uid: 'tpl_eligible' }],
    exclusions: [{ template_uid: 'tpl_blocked', rejection_codes: ['identity_risk_too_high'] }],
  });
  assert.deepEqual(controller.getTemplateEligibility('tpl_eligible'), {
    state: 'eligible',
    reason_codes: [],
  });
  assert.deepEqual(controller.getTemplateEligibility('tpl_blocked'), {
    state: 'advisory',
    reason_codes: ['identity_risk_too_high'],
  });
  assert.equal(controller.getItems().length, 3, 'raw catalog data remains available to non-task management surfaces');
  assert.equal(templateRejectionText(['identity_risk_too_high']), '这张模板可能较难保持像本人，供你选择时参考');
  assert.equal(templateRejectionText(['text_on_face_forbidden']), '模板文字靠近脸部，生成时可能遮挡五官');
});
