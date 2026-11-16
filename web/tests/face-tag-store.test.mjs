import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let store = {};
try {
  store = await import('../src/face-tag-store.mjs');
} catch {
  store = {};
}

const baseTag = {
  horizontal: 'image_left_slight',
  vertical: 'slight_down',
  tilt: 'slight_right',
  eyes: { openness: 'open', gaze: 'camera' },
  mouth: 'closed',
  usability: 'clear',
  occlusion: { severity: 'none', reasons: [] },
  face_scale: 'large',
};

test('face tag vocabulary exposes the complete plain-language option set without mutable internals', () => {
  assert.equal(typeof store.normalizeFaceTag, 'function');
  assert.equal(store.FACE_TAG_VOCABULARY_VERSION, 'ai-img-gen.face-tag.v3');
  assert.deepEqual(store.FACE_TAG_VOCABULARY.horizontal.map((item) => item.key), [
    'image_left_profile',
    'image_left_strong',
    'image_left_slight',
    'front',
    'image_right_slight',
    'image_right_strong',
    'image_right_profile',
  ]);
  assert.equal(store.FACE_TAG_VOCABULARY.horizontal[0].label, '完整朝左');
  assert.equal(store.FACE_TAG_VOCABULARY.horizontal.at(-1).label, '完整朝右');
  assert.deepEqual(store.FACE_TAG_VOCABULARY.gaze.map((item) => item.key), [
    'camera',
    'image_left',
    'image_right',
    'up',
    'down',
    'image_left_up',
    'image_right_up',
    'image_left_down',
    'image_right_down',
    'unclear',
    'not_applicable',
  ]);
  assert.deepEqual(store.FACE_TAG_VOCABULARY.gaze.slice(5, 9).map((item) => item.label), [
    '看画面左上方',
    '看画面右上方',
    '看画面左下方',
    '看画面右下方',
  ]);
  assert.equal(store.FACE_TAG_VOCABULARY.occlusion_reasons.some((item) => item.key === 'glasses'), false);
  assert.equal(store.FACE_TAG_VOCABULARY.occlusion_reasons.find((item) => item.key === 'opaque_eyewear')?.label, '墨镜/遮眼镜片');
  assert.equal(Object.isFrozen(store.FACE_TAG_VOCABULARY), true);
  assert.equal(Object.isFrozen(store.FACE_TAG_VOCABULARY.horizontal), true);
});

test('diagonal gaze values normalize in v3 while closed eyes still force not applicable', () => {
  const diagonal = store.normalizeFaceTag({
    ...baseTag,
    eyes: { openness: 'open', gaze: 'image_right_down' },
  }, { subjectKind: 'identity' });
  assert.equal(diagonal.schema_version, 'ai-img-gen.face-tag.v3');
  assert.equal(diagonal.eyes.gaze, 'image_right_down');
  const closed = store.normalizeFaceTag({
    ...baseTag,
    eyes: { openness: 'closed', gaze: 'image_left_up' },
  }, { subjectKind: 'identity' });
  assert.equal(closed.eyes.gaze, 'not_applicable');
});

test('v3 accepts real eye-blocking eyewear while legacy v2 glasses remain readable but are not current vocabulary', () => {
  const opaque = store.normalizeFaceTag({
    ...baseTag,
    occlusion: { severity: 'heavy', reasons: ['opaque_eyewear'] },
  }, { subjectKind: 'identity' });
  assert.equal(opaque.schema_version, 'ai-img-gen.face-tag.v3');
  assert.deepEqual(opaque.occlusion.reasons, ['opaque_eyewear']);
  const legacy = store.normalizeFaceTag({
    schema_version: 'ai-img-gen.face-tag.v2',
    ...baseTag,
    occlusion: { severity: 'light', reasons: ['glasses'] },
  }, { subjectKind: 'identity' });
  assert.equal(legacy.schema_version, 'ai-img-gen.face-tag.v3');
  assert.deepEqual(legacy.occlusion.reasons, ['glasses']);
});

test('closed eyes force gaze to not applicable and return an immutable normalized tag', () => {
  assert.equal(typeof store.normalizeFaceTag, 'function');
  const normalized = store.normalizeFaceTag({
    ...baseTag,
    eyes: { openness: 'closed', gaze: 'image_left' },
  }, { subjectKind: 'identity' });
  assert.equal(normalized.eyes.gaze, 'not_applicable');
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.eyes), true);
  assert.equal(Object.isFrozen(normalized.occlusion.reasons), true);
});

test('occlusion values reject contradictory severity and reason combinations', () => {
  assert.equal(typeof store.normalizeFaceTag, 'function');
  assert.throws(() => store.normalizeFaceTag({
    ...baseTag,
    occlusion: { severity: 'none', reasons: ['hair'] },
  }, { subjectKind: 'identity' }), /occlusion/i);
  assert.throws(() => store.normalizeFaceTag({
    ...baseTag,
    occlusion: { severity: 'light', reasons: [] },
  }, { subjectKind: 'identity' }), /occlusion/i);
});

test('template confirmations require library state while identity tags reject it', () => {
  assert.equal(typeof store.normalizeFaceTag, 'function');
  assert.throws(() => store.normalizeFaceTag(baseTag, { subjectKind: 'template' }), /template state/i);
  const template = store.normalizeFaceTag({ ...baseTag, template_state: 'active' }, { subjectKind: 'template' });
  assert.equal(template.template_state, 'active');
  assert.throws(() => store.normalizeFaceTag({ ...baseTag, template_state: 'active' }, { subjectKind: 'identity' }), /template state/i);
});

async function isolatedRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-face-tags-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'data', 'projections'), { recursive: true });
  await writeFile(join(root, 'data', 'projections', 'template-catalog.json'), `${JSON.stringify({
    schema_version: 'ai-img-gen.template-catalog.v1',
    templates: [{
      template_uid: 'tpl_temp_aiimg_test_001',
      reference_image: { sha256: 'a'.repeat(64) },
    }],
  })}\n`, 'utf8');
  return root;
}

test('template suggestions stay unconfirmed until append-only human confirmation and revision', async (t) => {
  const root = await isolatedRoot(t);
  assert.equal(typeof store.recordTemplateFaceTag, 'function');
  const suggestion = await store.recordTemplateFaceTag({
    root,
    templateUid: 'tpl_temp_aiimg_test_001',
    imageSha256: 'a'.repeat(64),
    kind: 'suggestion',
    idempotencyKey: 'suggestion-test-001',
    actor: 'terra',
    modelVersion: 'gpt-5.6-terra',
    promptVersion: 'face-tag-preselect-v1',
    tag: { ...baseTag, template_state: 'candidate' },
  });
  assert.equal(suggestion.projection.state, 'suggested');
  assert.equal(suggestion.projection.confirmation, null);
  const confirmation = await store.recordTemplateFaceTag({
    root,
    templateUid: 'tpl_temp_aiimg_test_001',
    imageSha256: 'a'.repeat(64),
    kind: 'confirmation',
    idempotencyKey: 'confirmation-test-001',
    actor: 'primary-user',
    tag: { ...baseTag, template_state: 'active' },
  });
  assert.equal(confirmation.projection.state, 'confirmed');
  assert.equal(confirmation.projection.confirmation.tag.template_state, 'active');
  assert.equal(confirmation.projection.suggestion.event_id, suggestion.event.event_id);

  const replay = await store.recordTemplateFaceTag({
    root,
    templateUid: 'tpl_temp_aiimg_test_001',
    imageSha256: 'a'.repeat(64),
    kind: 'confirmation',
    idempotencyKey: 'confirmation-test-001',
    actor: 'primary-user',
    tag: { ...baseTag, template_state: 'active' },
  });
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.event.event_id, confirmation.event.event_id);

  await assert.rejects(() => store.recordTemplateFaceTag({
    root,
    templateUid: 'tpl_temp_aiimg_test_001',
    imageSha256: 'a'.repeat(64),
    kind: 'confirmation',
    idempotencyKey: 'confirmation-test-002',
    actor: 'primary-user',
    tag: { ...baseTag, template_state: 'rejected' },
  }), /supersedes/i);
  const revised = await store.recordTemplateFaceTag({
    root,
    templateUid: 'tpl_temp_aiimg_test_001',
    imageSha256: 'a'.repeat(64),
    kind: 'confirmation',
    idempotencyKey: 'confirmation-test-002',
    supersedesEventId: confirmation.event.event_id,
    actor: 'primary-user',
    tag: { ...baseTag, template_state: 'rejected' },
  });
  assert.equal(revised.projection.confirmation.tag.template_state, 'rejected');
  assert.equal(revised.projection.confirmation.supersedes_event_id, confirmation.event.event_id);
  const lines = (await readFile(join(root, 'data', 'events', 'template-face-tags.jsonl'), 'utf8')).trim().split(/\r?\n/);
  assert.equal(lines.length, 3);
  const progress = await store.loadTemplateFaceTagProgress({ root });
  assert.deepEqual(progress, { total: 1, confirmed: 1, suggested: 0, untagged: 0, active: 0, candidate: 0, rejected: 1 });
});

test('template store rejects stale image hashes and rebuilds projection from events', async (t) => {
  const root = await isolatedRoot(t);
  assert.equal(typeof store.rebuildTemplateFaceTagProjection, 'function');
  await assert.rejects(() => store.recordTemplateFaceTag({
    root,
    templateUid: 'tpl_temp_aiimg_test_001',
    imageSha256: 'b'.repeat(64),
    kind: 'confirmation',
    idempotencyKey: 'wrong-hash',
    actor: 'primary-user',
    tag: { ...baseTag, template_state: 'active' },
  }), /hash/i);
  await store.recordTemplateFaceTag({
    root,
    templateUid: 'tpl_temp_aiimg_test_001',
    imageSha256: 'a'.repeat(64),
    kind: 'confirmation',
    idempotencyKey: 'right-hash',
    actor: 'primary-user',
    tag: { ...baseTag, template_state: 'active' },
  });
  const rebuilt = await store.rebuildTemplateFaceTagProjection({ root });
  assert.equal(rebuilt.templates.tpl_temp_aiimg_test_001.state, 'confirmed');
  assert.equal(rebuilt.templates.tpl_temp_aiimg_test_001.image_sha256, 'a'.repeat(64));
});

test('template status index keeps suggestions untagged and projects the latest confirmed library state', async (t) => {
  const root = await isolatedRoot(t);
  assert.equal(typeof store.loadTemplateFaceTagStatuses, 'function');
  const initial = await store.loadTemplateFaceTagStatuses({ root });
  assert.deepEqual(initial, {
    total: 1,
    items: [{ template_uid: 'tpl_temp_aiimg_test_001', state: 'untagged', template_state: null, filter_state: 'untagged', confirmation_event_id: null }],
  });
  await store.recordTemplateFaceTag({
    root,
    templateUid: 'tpl_temp_aiimg_test_001',
    imageSha256: 'a'.repeat(64),
    kind: 'suggestion',
    idempotencyKey: 'status-suggestion',
    actor: 'terra',
    modelVersion: 'gpt-5.6-terra',
    promptVersion: 'face-tag-preselect-v1',
    tag: { ...baseTag, template_state: 'candidate' },
  });
  const suggested = await store.loadTemplateFaceTagStatuses({ root });
  assert.equal(suggested.items[0].state, 'suggested');
  assert.equal(suggested.items[0].filter_state, 'untagged');
  const confirmed = await store.recordTemplateFaceTag({
    root,
    templateUid: 'tpl_temp_aiimg_test_001',
    imageSha256: 'a'.repeat(64),
    kind: 'confirmation',
    idempotencyKey: 'status-confirmation',
    actor: 'primary-user',
    tag: { ...baseTag, template_state: 'rejected' },
  });
  const final = await store.loadTemplateFaceTagStatuses({ root });
  assert.equal(final.items[0].filter_state, 'rejected');
  assert.equal(final.items[0].confirmation_event_id, confirmed.event.event_id);
});

test('v1 confirmations remain readable and can be superseded by a v3 diagonal-gaze revision', async (t) => {
  const root = await isolatedRoot(t);
  await mkdir(join(root, 'data', 'events'), { recursive: true });
  const legacyEvent = {
    schema_version: 'ai-img-gen.face-tag-event.v1',
    event_id: 'face-tag-legacy-v1-confirmation',
    event_type: 'FaceTagConfirmed',
    idempotency_key: 'legacy-v1-confirmation',
    recorded_at: '2026-08-29T00:00:00.000Z',
    actor: 'primary-user',
    subject_kind: 'template',
    subject_id: 'tpl_temp_aiimg_test_001',
    image_sha256: 'a'.repeat(64),
    vocabulary_version: 'ai-img-gen.face-tag.v1',
    tag: { schema_version: 'ai-img-gen.face-tag.v1', ...baseTag, template_state: 'active' },
    supersedes_event_id: null,
  };
  await writeFile(join(root, 'data', 'events', 'template-face-tags.jsonl'), `${JSON.stringify(legacyEvent)}\n`, 'utf8');
  const before = await store.loadTemplateFaceTagProjection({ root, templateUid: 'tpl_temp_aiimg_test_001' });
  assert.equal(before.confirmation.vocabulary_version, 'ai-img-gen.face-tag.v1');
  assert.equal(before.confirmation.tag.schema_version, 'ai-img-gen.face-tag.v1');
  const revised = await store.recordTemplateFaceTag({
    root,
    templateUid: 'tpl_temp_aiimg_test_001',
    imageSha256: 'a'.repeat(64),
    kind: 'confirmation',
    idempotencyKey: 'diagonal-v2-revision',
    actor: 'primary-user',
    supersedesEventId: legacyEvent.event_id,
    tag: { ...baseTag, eyes: { openness: 'open', gaze: 'image_left_up' }, template_state: 'active' },
  });
  assert.equal(revised.event.vocabulary_version, 'ai-img-gen.face-tag.v3');
  assert.equal(revised.projection.confirmation.tag.schema_version, 'ai-img-gen.face-tag.v3');
  assert.equal(revised.projection.confirmation.tag.eyes.gaze, 'image_left_up');
});

test('concurrent template projection reads serialize atomic projection writes', async (t) => {
  const root = await isolatedRoot(t);
  await store.recordTemplateFaceTag({
    root,
    templateUid: 'tpl_temp_aiimg_test_001',
    imageSha256: 'a'.repeat(64),
    kind: 'confirmation',
    idempotencyKey: 'concurrent-confirmation',
    actor: 'primary-user',
    tag: { ...baseTag, template_state: 'active' },
  });
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => (
    index % 2
      ? store.loadTemplateFaceTagProgress({ root })
      : store.loadTemplateFaceTagProjection({ root, templateUid: 'tpl_temp_aiimg_test_001' })
  )));
  assert.equal(results.length, 20);
  assert.equal((await store.loadTemplateFaceTagProgress({ root })).confirmed, 1);
});

async function createIdentityFixture(t) {
  const root = await isolatedRoot(t);
  const customerId = 'cust_1111111111111111';
  const identitySetId = 'ids_222222222222222222222222';
  const setRoot = join(root, 'data', 'customers', customerId, 'identity-sets', identitySetId);
  await mkdir(join(setRoot, 'references'), { recursive: true });
  const projection = {
    schema_version: 'ai-img-gen.customer-identity-set.v1',
    customer_id: customerId,
    identity_set_id: identitySetId,
    state: 'active',
    references: [
      { ordinal: 1, filename: '01-primary.png', sha256: '1'.repeat(64), original_name: 'front.png' },
      { ordinal: 2, filename: '02-support.png', sha256: '2'.repeat(64), original_name: 'closed.png' },
    ],
  };
  await writeFile(join(setRoot, 'identity-set.json'), `${JSON.stringify(projection)}\n`, 'utf8');
  await writeFile(join(setRoot, 'references', '01-primary.png'), Buffer.from('one'));
  await writeFile(join(setRoot, 'references', '02-support.png'), Buffer.from('two'));
  return { root, customerId, identitySetId, setRoot };
}

test('identity tag events stay inside one customer set and reject wrong members', async (t) => {
  const fixture = await createIdentityFixture(t);
  assert.equal(typeof store.recordIdentityFaceTag, 'function');
  await assert.rejects(() => store.recordIdentityFaceTag({
    ...fixture,
    ordinal: 3,
    imageSha256: '3'.repeat(64),
    kind: 'confirmation',
    idempotencyKey: 'missing-member',
    actor: 'primary-user',
    tag: baseTag,
  }), /reference/i);
  const saved = await store.recordIdentityFaceTag({
    ...fixture,
    ordinal: 2,
    imageSha256: '2'.repeat(64),
    kind: 'confirmation',
    idempotencyKey: 'identity-confirm-001',
    actor: 'primary-user',
    tag: { ...baseTag, eyes: { openness: 'closed', gaze: 'image_left' } },
  });
  assert.equal(saved.projection.confirmation.tag.eyes.gaze, 'not_applicable');
  const replay = await store.recordIdentityFaceTag({
    ...fixture,
    ordinal: 2,
    imageSha256: '2'.repeat(64),
    kind: 'confirmation',
    idempotencyKey: 'identity-confirm-001',
    actor: 'primary-user',
    tag: { ...baseTag, eyes: { openness: 'closed', gaze: 'image_left' } },
  });
  assert.equal(replay.idempotent_replay, true);
  const loaded = await store.loadIdentityFaceTagProjections(fixture);
  assert.equal(loaded.references['2'].state, 'confirmed');
  await assert.rejects(() => store.loadIdentityFaceTagProjections({
    root: fixture.root,
    customerId: 'cust_9999999999999999',
    identitySetId: fixture.identitySetId,
  }), /not found/i);
  const globalProjection = await store.rebuildTemplateFaceTagProjection({ root: fixture.root });
  assert.equal(JSON.stringify(globalProjection).includes(fixture.customerId), false);
});
