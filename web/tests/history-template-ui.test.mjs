import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appJsUrl = new URL('../public/app.js', import.meta.url);

test('history detail renders exact v5 template provenance fields', async () => {
  const appJs = await readFile(appJsUrl, 'utf8');
  for (const field of ['templateUid', 'selectedRank', 'relevanceScore', 'rankingPolicyVersion', 'catalogProjectionVersion', 'referenceImageSha256', 'generationBlueprintSha256']) {
    assert.match(appJs, new RegExp(field), `expected history detail to render ${field}`);
  }
});

test('history defaults to user-language provenance and folds raw identifiers into technical evidence', async () => {
  const appJs = await readFile(appJsUrl, 'utf8');
  assert.match(appJs, /来源：模板库/);
  assert.match(appJs, /系统推荐第 \$\{item\.selectedRank\} 位/);
  assert.match(appJs, /<details class="history-technical-evidence"><summary>技术证据<\/summary>/);
  assert.match(appJs, /模板编号：/);
  assert.match(appJs, /排序规则：/);
  assert.match(appJs, /模板库版本：/);
  assert.doesNotMatch(appJs, /`UID \$\{item\.templateUid\}`/);
});

test('history surfaces degraded template evidence instead of rendering a false zero', async () => {
  const appJs = await readFile(appJsUrl, 'utf8');
  assert.match(appJs, /模板证据异常/);
  assert.match(appJs, /证据异常 · 已确认/);
  assert.match(appJs, /degraded_run_count/);
});

test('history template formatting helper separates recommendations, substitutions, uploads, and legacy refs', async () => {
  const { formatHistoryTemplateItem } = await import('../public/template-library.js');
  const recommended = formatHistoryTemplateItem({
    source_type: 'catalog_template',
    decision_type: 'accepted',
    template_uid: 'tpl_001',
    template_name: 'Studio Soft Light',
    selected_rank: 1,
    relevance_score: 92,
  });
  assert.equal(recommended.badgeText, '推荐 Top 1');
  assert.equal(recommended.isCatalog, true);

  const substituted = formatHistoryTemplateItem({
    source_type: 'catalog_template',
    decision_type: 'substituted',
    template_uid: 'tpl_005',
    template_name: 'Outdoor Sun',
  });
  assert.equal(substituted.badgeText, '模板库替换');
  assert.equal(substituted.isCatalog, true);

  const manual = formatHistoryTemplateItem({ source_type: 'uploaded_reference', filename: 'custom.jpg' });
  assert.equal(manual.badgeText, '人工上传');
  assert.equal(manual.isCatalog, false);

  const legacy = formatHistoryTemplateItem({ filename: '01.png' });
  assert.equal(legacy.badgeText, '');
  assert.equal(legacy.isCatalog, false);
});
