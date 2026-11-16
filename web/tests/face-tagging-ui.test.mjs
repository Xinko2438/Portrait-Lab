import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const htmlUrl = new URL('../public/face-tagging.html', import.meta.url);
const cssUrl = new URL('../public/face-tagging.css', import.meta.url);
const jsUrl = new URL('../public/face-tagging.js', import.meta.url);
let ui = {};
try {
  ui = await import('../public/face-tagging.js');
} catch {
  ui = {};
}

const suggestedTag = {
  schema_version: 'ai-img-gen.face-tag.v1',
  horizontal: 'image_left_slight',
  vertical: 'slight_down',
  tilt: 'slight_right',
  eyes: { openness: 'closed', gaze: 'not_applicable' },
  mouth: 'closed',
  usability: 'usable',
  occlusion: { severity: 'light', reasons: ['hair'] },
  face_scale: 'medium',
  template_state: 'candidate',
};

test('tagging page is image-first, plain-language, complete, and exposes one primary action', async () => {
  const [html, css, js] = await Promise.all([readFile(htmlUrl, 'utf8'), readFile(cssUrl, 'utf8'), readFile(jsUrl, 'utf8')]);
  assert.match(html, /id="taggingImage"/);
  assert.match(html, /id="tagPanelScroll"/);
  assert.match(html, /id="confirmAndNext"[^>]*>确认并下一张/);
  assert.match(html, /id="taggingProgress"/);
  assert.match(html, /id="templateStatusFilter"/);
  assert.match(html, /按模板状态筛选/);
  assert.match(html, /模板标注/);
  assert.match(html, /客户照片标注/);
  assert.doesNotMatch(html, /id="identitySetSelect"|身份参考组|请选择身份组/);
  assert.match(js, /resolveActiveCustomerPhotoPool/);
  assert.doesNotMatch(js, /identitySetSelect/);
  for (const label of ['模板状态', '风格分面 V2', '作品类型', '画面处理', '气质定位', '脸朝哪边', '抬头还是低头', '头有没有歪', '眼睛状态', '眼神方向', '嘴部状态', '脸部是否清楚', '遮挡程度', '遮挡位置', '脸部大小']) {
    assert.match(html, new RegExp(label));
  }
  assert.doesNotMatch(html, /\b(?:Yaw|Pitch|Roll)\b|角度数值|填写度数/i);
  assert.match(html, /id="previousItem"/);
  assert.match(html, /id="nextItem"/);
  assert.match(html, /id="matchPreview"/);
  assert.match(html, /普通透明眼镜不算遮挡/);
  assert.match(html, /只有墨镜、深色或强反光镜片真正挡住眼睛时才选择/);
  assert.match(css, /object-fit:\s*contain/);
  assert.match(css, /\.tagging-app[\s\S]*height:\s*100(?:dvh|vh)/);
  assert.match(css, /\.tagging-app[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\.tagging-actions[\s\S]*(?:box-shadow|border-top)/);
  assert.match(css, /\.identity-context\[hidden\][\s\S]*display:\s*none/);
  assert.match(css, /\.image-stage[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\.image-stage img[\s\S]*max-height:\s*100%/);
  assert.match(css, /@media\s*\(max-width:\s*700px\)/);
  assert.match(css, /\.template-filter/);
});

test('template filter view preserves catalog order and derives authoritative counts', () => {
  assert.equal(typeof ui.buildTemplateFilterView, 'function');
  const templates = ['one', 'two', 'three', 'four', 'five'].map((uid) => ({ uid, name: uid }));
  const statuses = [
    { template_uid: 'one', state: 'confirmed', template_state: 'active', filter_state: 'active' },
    { template_uid: 'two', state: 'confirmed', template_state: 'candidate', filter_state: 'candidate' },
    { template_uid: 'three', state: 'confirmed', template_state: 'rejected', filter_state: 'rejected' },
    { template_uid: 'four', state: 'untagged', template_state: null, filter_state: 'untagged' },
    { template_uid: 'five', state: 'suggested', template_state: null, filter_state: 'untagged' },
  ];
  const rejected = ui.buildTemplateFilterView({ templates, statuses, filter: 'rejected' });
  assert.deepEqual(rejected.counts, { all: 5, active: 1, candidate: 1, rejected: 1, untagged: 2 });
  assert.deepEqual(rejected.items.map((item) => item.uid), ['three']);
  assert.equal(rejected.filter, 'rejected');
  const untagged = ui.buildTemplateFilterView({ templates, statuses, filter: 'untagged' });
  assert.deepEqual(untagged.items.map((item) => item.uid), ['four', 'five']);
  const empty = ui.buildTemplateFilterView({ templates, statuses, filter: 'missing' });
  assert.equal(empty.filter, 'all');
  assert.deepEqual(empty.items.map((item) => item.uid), ['one', 'two', 'three', 'four', 'five']);
});

test('draft uses suggestion as unconfirmed preselection and human confirmation wins on reload', () => {
  assert.equal(typeof ui.createTagDraft, 'function');
  const suggested = ui.createTagDraft({
    subjectKind: 'template',
    projection: { state: 'suggested', suggestion: { event_id: 'suggestion-1', tag: suggestedTag }, confirmation: null },
  });
  assert.equal(suggested.tag.horizontal, 'image_left_slight');
  assert.equal(suggested.suggested, true);
  assert.equal(suggested.confirmed, false);
  const confirmedTag = { ...suggestedTag, horizontal: 'front', template_state: 'active' };
  const confirmed = ui.createTagDraft({
    subjectKind: 'template',
    projection: {
      state: 'confirmed',
      suggestion: { event_id: 'suggestion-1', tag: suggestedTag },
      confirmation: { event_id: 'confirmation-1', tag: confirmedTag },
    },
  });
  assert.equal(confirmed.tag.horizontal, 'front');
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.supersedesEventId, 'confirmation-1');
});

test('changing eye state to closed clears contradictory gaze in the draft', () => {
  assert.equal(typeof ui.updateTagDraft, 'function');
  const draft = ui.createTagDraft({ subjectKind: 'identity', projection: null });
  const gazing = ui.updateTagDraft(draft, 'eyes.gaze', 'image_left');
  assert.equal(gazing.tag.eyes.gaze, 'image_left');
  const closed = ui.updateTagDraft(gazing, 'eyes.openness', 'closed');
  assert.equal(closed.tag.eyes.openness, 'closed');
  assert.equal(closed.tag.eyes.gaze, 'not_applicable');
});

test('confirmation payload preserves exact subject hash, supersession, and human authority', () => {
  assert.equal(typeof ui.buildConfirmationPayload, 'function');
  const draft = ui.createTagDraft({
    subjectKind: 'template',
    projection: { state: 'confirmed', confirmation: { event_id: 'confirmation-old', tag: { ...suggestedTag, template_state: 'active' } }, suggestion: null },
  });
  const payload = ui.buildConfirmationPayload({ draft, imageSha256: 'a'.repeat(64), idempotencyKey: 'ui-confirm-001' });
  assert.equal(payload.kind, 'confirmation');
  assert.equal(payload.actor, 'primary-user');
  assert.equal(payload.image_sha256, 'a'.repeat(64));
  assert.equal(payload.idempotency_key, 'ui-confirm-001');
  assert.equal(payload.supersedes_event_id, 'confirmation-old');
  assert.equal(payload.tag.template_state, 'active');
});

test('navigation clamps at list boundaries instead of wrapping unexpectedly', () => {
  assert.equal(typeof ui.nextTaggingIndex, 'function');
  assert.equal(ui.nextTaggingIndex({ current: 0, total: 5, direction: -1 }), 0);
  assert.equal(ui.nextTaggingIndex({ current: 0, total: 5, direction: 1 }), 1);
  assert.equal(ui.nextTaggingIndex({ current: 4, total: 5, direction: 1 }), 4);
});

test('dynamic catalog and customer labels are escaped before HTML rendering', () => {
  assert.equal(typeof ui.escapeTaggingHtml, 'function');
  assert.equal(ui.escapeTaggingHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(ui.escapeTaggingHtml('A & "B"'), 'A &amp; &quot;B&quot;');
});
