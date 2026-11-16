import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const store = await import('../src/template-style-store.mjs').catch(() => ({}));
const apiModule = await import('../src/template-style-api.mjs').catch(() => ({}));
const ui = await import('../public/template-style-state.js').catch(() => ({}));
const templateUid = 'tpl_temp_aiimg_style_test_001';
const imageSha256 = 'a'.repeat(64);

async function rootFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-style-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'data', 'projections'), { recursive: true });
  await writeFile(join(root, 'data', 'projections', 'template-catalog.json'), `${JSON.stringify({
    schema_version: 'ai-img-gen.template-catalog.v1',
    templates: [{ template_uid: templateUid, reference_image: { sha256: imageSha256 }, selection_tags: { style_category: 'black_white_magazine' } }],
  })}\n`, 'utf8');
  return root;
}

test('style vocabulary exposes ten professional Chinese names with standard English labels', () => {
  assert.equal(store.TEMPLATE_STYLE_VOCABULARY_VERSION, 'ai-img-gen.template-style.v1');
  assert.deepEqual(store.TEMPLATE_STYLE_VOCABULARY.styles.map((item) => item.key), [
    'black_white_magazine', 'bold_color_graphic', 'cinematic_mood', 'dark_grunge', 'retro_poster',
    'luxury_fashion', 'streetwear_editorial', 'clean_magazine', 'documentary_poster', 'minimal_personal_brand',
  ]);
  assert.deepEqual(store.TEMPLATE_STYLE_VOCABULARY.styles.map((item) => item.label), [
    '黑白编辑', '图形海报', '电影叙事', '粗粝实验', '复古编辑', '高级时装', '街头时装', '清透编辑', '纪实人像', '商业形象',
  ]);
  assert.deepEqual(store.TEMPLATE_STYLE_VOCABULARY.styles.map((item) => item.english_label), [
    'Monochrome Editorial', 'Graphic Poster', 'Cinematic Portrait', 'Grunge Editorial', 'Retro Editorial',
    'High-Fashion Editorial', 'Streetwear Editorial', 'Clean Editorial', 'Documentary Portrait', 'Personal Branding Portrait',
  ]);
  assert.deepEqual(store.normalizeTemplateStyleTag({ primary_style: 'cinematic_mood' }), { schema_version: 'ai-img-gen.template-style.v1', primary_style: 'cinematic_mood' });
  assert.throws(() => store.normalizeTemplateStyleTag({ primary_style: 'free-text-style' }), /style/i);
});

test('style suggestions remain unconfirmed until append-only human confirmation and revision', async (t) => {
  const root = await rootFixture(t);
  assert.equal(typeof store.recordTemplateStyleTag, 'function');
  const suggested = await store.recordTemplateStyleTag({ root, templateUid, imageSha256, kind: 'suggestion', idempotencyKey: 'style-suggestion-1', actor: 'terra', modelVersion: 'gpt-5.6-terra', promptVersion: 'template-style-v1', tag: { primary_style: 'cinematic_mood' } });
  assert.equal(suggested.projection.state, 'suggested');
  assert.equal(suggested.projection.confirmation, null);
  assert.deepEqual(await store.loadTemplateStyleProgress({ root }), { total: 1, untagged: 0, suggested: 1, confirmed: 0 });
  const confirmed = await store.recordTemplateStyleTag({ root, templateUid, imageSha256, kind: 'confirmation', idempotencyKey: 'style-confirm-1', actor: 'primary-user', tag: { primary_style: 'cinematic_mood' } });
  assert.equal(confirmed.projection.state, 'confirmed');
  assert.equal(confirmed.projection.confirmation.tag.primary_style, 'cinematic_mood');
  const replay = await store.recordTemplateStyleTag({ root, templateUid, imageSha256, kind: 'confirmation', idempotencyKey: 'style-confirm-1', actor: 'primary-user', tag: { primary_style: 'cinematic_mood' } });
  assert.equal(replay.idempotent_replay, true);
  await assert.rejects(() => store.recordTemplateStyleTag({ root, templateUid, imageSha256, kind: 'confirmation', idempotencyKey: 'style-confirm-2', actor: 'primary-user', tag: { primary_style: 'retro_poster' } }), /supersedes/i);
  const revised = await store.recordTemplateStyleTag({ root, templateUid, imageSha256, kind: 'confirmation', idempotencyKey: 'style-confirm-2', actor: 'primary-user', supersedesEventId: confirmed.event.event_id, tag: { primary_style: 'retro_poster' } });
  assert.equal(revised.projection.confirmation.tag.primary_style, 'retro_poster');
  const rebuilt = await store.rebuildTemplateStyleProjection({ root });
  assert.equal(rebuilt.templates[templateUid].confirmation.event_id, revised.event.event_id);
  assert.equal((await readFile(join(root, 'data', 'events', 'template-style-tags.jsonl'), 'utf8')).trim().split(/\r?\n/).length, 3);
});

async function startApi(root) {
  const handler = apiModule.createTemplateStyleApiHandler({ root });
  const server = http.createServer(async (req, res) => { if (!(await handler(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('style API exposes vocabulary, progress, suggestion, and confirmation without touching face tags', async (t) => {
  const root = await rootFixture(t);
  assert.equal(typeof apiModule.createTemplateStyleApiHandler, 'function');
  const api = await startApi(root);
  try {
    const vocabulary = await fetch(`${api.base}/api/template-styles/vocabulary`).then((response) => response.json());
    assert.equal(vocabulary.vocabulary.styles.length, 10);
    const before = await fetch(`${api.base}/api/template-styles/progress`).then((response) => response.json());
    assert.equal(before.progress.untagged, 1);
    const suggestion = await fetch(`${api.base}/api/templates/${templateUid}/style-tag`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'suggestion', image_sha256: imageSha256, idempotency_key: 'api-style-suggestion', actor: 'terra', model_version: 'gpt-5.6-terra', prompt_version: 'template-style-v1', tag: { primary_style: 'luxury_fashion' } }) });
    assert.equal(suggestion.status, 201);
    const projected = await fetch(`${api.base}/api/templates/${templateUid}/style-tag`).then((response) => response.json());
    assert.equal(projected.projection.suggestion.tag.primary_style, 'luxury_fashion');
    assert.equal(projected.projection.confirmation, null);
    assert.equal(await readFile(join(root, 'data', 'events', 'template-face-tags.jsonl'), 'utf8').catch(() => ''), '');
  } finally { await api.close(); }
});

test('browser style draft preselects suggestions, lets confirmation win, and builds a human payload', () => {
  assert.equal(typeof ui.createTemplateStyleDraft, 'function');
  const suggested = ui.createTemplateStyleDraft({ projection: { state: 'suggested', suggestion: { event_id: 'suggestion-1', tag: { primary_style: 'dark_grunge' } }, confirmation: null } });
  assert.equal(suggested.primaryStyle, 'dark_grunge');
  assert.equal(suggested.suggested, true);
  const changed = ui.updateTemplateStyleDraft(suggested, 'clean_magazine');
  assert.equal(changed.primaryStyle, 'clean_magazine');
  assert.equal(changed.dirty, true);
  const payload = ui.buildTemplateStyleConfirmationPayload({ draft: changed, imageSha256, idempotencyKey: 'ui-style-confirm' });
  assert.deepEqual(payload, { kind: 'confirmation', image_sha256: imageSha256, idempotency_key: 'ui-style-confirm', actor: 'primary-user', supersedes_event_id: null, tag: { primary_style: 'clean_magazine' } });
  const confirmed = ui.createTemplateStyleDraft({ projection: { state: 'confirmed', suggestion: { event_id: 'suggestion-1', tag: { primary_style: 'dark_grunge' } }, confirmation: { event_id: 'confirm-1', tag: { primary_style: 'retro_poster' } } } });
  assert.equal(confirmed.primaryStyle, 'retro_poster');
  assert.equal(confirmed.supersedesEventId, 'confirm-1');
  assert.equal(confirmed.confirmed, true);
});

test('V1 style API remains readable after formal tagging moves to V2 facets', async () => {
  const [server, html, app, css] = await Promise.all([readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'), readFile(new URL('../public/face-tagging.html', import.meta.url), 'utf8'), readFile(new URL('../public/face-tagging.js', import.meta.url), 'utf8'), readFile(new URL('../public/face-tagging.css', import.meta.url), 'utf8')]);
  assert.match(server, /createTemplateStyleApiHandler/);
  assert.match(server, /createTemplateStyleFacetsV2ApiHandler/);
  assert.doesNotMatch(html, /id="templateStyleChoices"/);
  assert.doesNotMatch(app, /template-style-state\.js/);
  assert.match(html, /id="styleFacetWorkTypeChoices"/);
  assert.match(css, /\.style-facet-grid/);
  assert.equal((html.match(/id="confirmAndNext"/g) || []).length, 1);
});
