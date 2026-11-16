import test from 'node:test';
import assert from 'node:assert/strict';

let store = {};
try {
  store = await import('../src/face-tag-store.mjs');
} catch {
  store = {};
}

function tag(overrides = {}) {
  const eyes = overrides.eyes || { openness: 'open', gaze: 'camera' };
  const occlusion = overrides.occlusion || { severity: 'none', reasons: [] };
  return {
    horizontal: 'front',
    vertical: 'level',
    tilt: 'level',
    eyes,
    mouth: 'closed',
    usability: 'clear',
    occlusion,
    face_scale: 'large',
    ...overrides,
    eyes,
    occlusion,
  };
}

function confirmed(value, eventId = 'event-confirmed') {
  return { state: 'confirmed', confirmation: { event_id: eventId, image_sha256: 'a'.repeat(64), tag: value } };
}

function identity(ordinal, value, projection = confirmed(value, `event-${ordinal}`)) {
  return { ordinal, image_sha256: String(ordinal).repeat(64).slice(0, 64), projection };
}

test('matcher selects the closest horizontal, vertical, and tilt state independent of input order', () => {
  assert.equal(typeof store.matchIdentityFaceTags, 'function');
  const template = confirmed(tag({
    horizontal: 'image_left_strong',
    vertical: 'slight_down',
    tilt: 'slight_right',
    template_state: 'active',
  }), 'template-confirmed');
  const closest = identity(2, tag({ horizontal: 'image_left_strong', vertical: 'slight_down', tilt: 'slight_right' }));
  const front = identity(1, tag());
  const first = store.matchIdentityFaceTags({ templateProjection: template, identityReferences: [front, closest] });
  const second = store.matchIdentityFaceTags({ templateProjection: template, identityReferences: [closest, front] });
  assert.equal(first.state, 'matched');
  assert.equal(first.selected.ordinal, 2);
  assert.deepEqual(first.ranked.map((item) => item.ordinal), [2, 1]);
  assert.deepEqual(second.ranked.map((item) => item.ordinal), [2, 1]);
});

test('closed-eye template prefers a closed-eye identity when pose is otherwise tied', () => {
  assert.equal(typeof store.matchIdentityFaceTags, 'function');
  const template = confirmed(tag({
    eyes: { openness: 'closed', gaze: 'not_applicable' },
    template_state: 'active',
  }), 'template-closed');
  const result = store.matchIdentityFaceTags({
    templateProjection: template,
    identityReferences: [
      identity(1, tag({ eyes: { openness: 'open', gaze: 'camera' } })),
      identity(2, tag({ eyes: { openness: 'closed', gaze: 'not_applicable' } })),
    ],
  });
  assert.equal(result.selected.ordinal, 2);
  assert.equal(result.ranked[0].components.eyes, 0);
  assert.ok(result.ranked[1].components.eyes > 0);
});

test('diagonal gaze matching prefers the exact direction and ranks an adjacent cardinal direction above the opposite diagonal', () => {
  const template = confirmed(tag({
    eyes: { openness: 'open', gaze: 'image_right_down' },
    template_state: 'active',
  }), 'template-right-down');
  const result = store.matchIdentityFaceTags({
    templateProjection: template,
    identityReferences: [
      identity(1, tag({ eyes: { openness: 'open', gaze: 'image_left_up' } })),
      identity(2, tag({ eyes: { openness: 'open', gaze: 'image_right' } })),
      identity(3, tag({ eyes: { openness: 'open', gaze: 'image_right_down' } })),
    ],
  });
  assert.deepEqual(result.ranked.map((item) => item.ordinal), [3, 2, 1]);
  assert.equal(result.ranked[0].components.gaze, 0);
  assert.ok(result.ranked[1].components.gaze > 0);
  assert.ok(result.ranked[1].components.gaze < result.ranked[2].components.gaze);
  assert.equal(result.matcher_version, 'ai-img-gen.face-matcher.v2');
  assert.equal(result.vocabulary_version, 'ai-img-gen.face-tag.v3');
});

test('suggestion-only, unusable, and heavy-occlusion identities never become winners', () => {
  assert.equal(typeof store.matchIdentityFaceTags, 'function');
  const template = confirmed(tag({ template_state: 'active' }), 'template-active');
  const suggestionOnly = { state: 'suggested', suggestion: { tag: tag() } };
  const result = store.matchIdentityFaceTags({
    templateProjection: template,
    identityReferences: [
      identity(1, tag(), suggestionOnly),
      identity(2, tag({ usability: 'unusable' })),
      identity(3, tag({ occlusion: { severity: 'heavy', reasons: ['hair'] } })),
      identity(4, tag({ horizontal: 'image_right_slight', usability: 'usable' })),
    ],
  });
  assert.equal(result.selected.ordinal, 4);
  assert.deepEqual(result.excluded.map((item) => item.ordinal), [1, 2, 3]);
});

test('unknown template details are ignored and exact ties resolve by original ordinal', () => {
  assert.equal(typeof store.matchIdentityFaceTags, 'function');
  const template = confirmed(tag({
    eyes: { openness: 'unclear', gaze: 'unclear' },
    mouth: 'unclear',
    template_state: 'active',
  }), 'template-unclear');
  const result = store.matchIdentityFaceTags({
    templateProjection: template,
    identityReferences: [identity(3, tag()), identity(1, tag())],
  });
  assert.equal(result.selected.ordinal, 1);
  assert.equal(result.ranked[0].components.eyes, 0);
  assert.equal(result.ranked[0].components.gaze, 0);
  assert.equal(result.ranked[0].components.mouth, 0);
});

test('small faces and light obstruction lose a pose tie to a clear larger identity', () => {
  const template = confirmed(tag({ template_state: 'active' }), 'template-quality');
  const result = store.matchIdentityFaceTags({
    templateProjection: template,
    identityReferences: [
      identity(1, tag({ face_scale: 'small' })),
      identity(2, tag({ occlusion: { severity: 'light', reasons: ['hair'] } })),
      identity(3, tag({ face_scale: 'large', occlusion: { severity: 'none', reasons: [] } })),
    ],
  });
  assert.equal(result.selected.ordinal, 3);
  assert.equal(result.ranked.find((item) => item.ordinal === 1).components.quality, 8);
  assert.equal(result.ranked.find((item) => item.ordinal === 2).components.quality, 5);
  assert.equal(result.ranked.find((item) => item.ordinal === 3).components.quality, 0);
});

test('matcher requires an active confirmed template and returns manual required with no eligible identity', () => {
  assert.equal(typeof store.matchIdentityFaceTags, 'function');
  const unconfirmedTemplate = { state: 'suggested', suggestion: { tag: tag({ template_state: 'active' }) } };
  assert.deepEqual(store.matchIdentityFaceTags({ templateProjection: unconfirmedTemplate, identityReferences: [] }), {
    state: 'manual_required',
    selected: null,
    ranked: [],
    excluded: [],
    reasons: ['template_not_human_confirmed'],
    matcher_version: 'ai-img-gen.face-matcher.v2',
    vocabulary_version: 'ai-img-gen.face-tag.v3',
  });
  const rejected = confirmed(tag({ template_state: 'rejected' }), 'template-rejected');
  assert.equal(store.matchIdentityFaceTags({ templateProjection: rejected, identityReferences: [] }).reasons[0], 'template_not_active');
  const active = confirmed(tag({ template_state: 'active' }), 'template-active');
  assert.equal(store.matchIdentityFaceTags({ templateProjection: active, identityReferences: [] }).state, 'manual_required');
});
