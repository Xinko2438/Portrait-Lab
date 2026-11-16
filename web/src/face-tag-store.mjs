import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const VOCABULARY_VERSION = 'ai-img-gen.face-tag.v3';
const MATCHER_VERSION = 'ai-img-gen.face-matcher.v2';
const EVENT_VERSION = 'ai-img-gen.face-tag-event.v1';
const TEMPLATE_PROJECTION_VERSION = 'ai-img-gen.template-face-tags.v1';
const IDENTITY_PROJECTION_VERSION = 'ai-img-gen.identity-face-tags.v1';
const TEMPLATE_UID = /^tpl_temp_aiimg_[a-z0-9_-]+$/;
const CUSTOMER_ID = /^cust_[a-f0-9]{16}$/;
const IDENTITY_SET_ID = /^ids_[a-f0-9]{24}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const projectionWriteChains = new Map();

const option = (key, label, anchor = null) => ({ key, label, ...(anchor == null ? {} : { anchor }) });

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const FACE_TAG_VOCABULARY_VERSION = VOCABULARY_VERSION;
export const FACE_TAG_MATCHER_VERSION = MATCHER_VERSION;
export const FACE_TAG_VOCABULARY = deepFreeze({
  schema_version: VOCABULARY_VERSION,
  horizontal: [
    option('image_left_profile', '完整朝左', -90),
    option('image_left_strong', '明显朝左', -60),
    option('image_left_slight', '略朝左', -30),
    option('front', '接近正面', 0),
    option('image_right_slight', '略朝右', 30),
    option('image_right_strong', '明显朝右', 60),
    option('image_right_profile', '完整朝右', 90),
  ],
  vertical: [
    option('strong_up', '明显抬头', -30),
    option('slight_up', '轻微抬头', -15),
    option('level', '平视', 0),
    option('slight_down', '轻微低头', 15),
    option('strong_down', '明显低头', 30),
  ],
  tilt: [
    option('strong_left', '明显向左歪', -30),
    option('slight_left', '轻微向左歪', -15),
    option('level', '不歪', 0),
    option('slight_right', '轻微向右歪', 15),
    option('strong_right', '明显向右歪', 30),
  ],
  eye_openness: [
    option('open', '双眼睁开'),
    option('half_closed', '双眼半闭'),
    option('closed', '双眼闭合'),
    option('one_closed', '单眼闭合'),
    option('unclear', '看不清'),
  ],
  gaze: [
    option('camera', '看镜头'),
    option('image_left', '看画面左边'),
    option('image_right', '看画面右边'),
    option('up', '向上看'),
    option('down', '向下看'),
    option('image_left_up', '看画面左上方'),
    option('image_right_up', '看画面右上方'),
    option('image_left_down', '看画面左下方'),
    option('image_right_down', '看画面右下方'),
    option('unclear', '无法判断'),
    option('not_applicable', '不适用'),
  ],
  mouth: [
    option('closed', '闭嘴'),
    option('slight_smile', '微笑'),
    option('broad_smile', '明显笑容'),
    option('open', '张嘴'),
    option('unclear', '看不清'),
  ],
  usability: [option('clear', '很清楚'), option('usable', '可以使用'), option('unusable', '不要使用')],
  occlusion_severity: [option('none', '无遮挡'), option('light', '轻微遮挡'), option('heavy', '严重遮挡')],
  occlusion_reasons: [
    option('hair', '头发'), option('hand', '手'), option('opaque_eyewear', '墨镜/遮眼镜片'),
    option('object', '物体'), option('text', '文字'), option('crop', '画面裁切'),
  ],
  face_scale: [option('large', '脸部较大'), option('medium', '脸部适中'), option('small', '脸部较小')],
  template_state: [option('active', '正式可用'), option('candidate', '候选观察'), option('rejected', '淘汰')],
});

function keys(field) {
  return new Set(FACE_TAG_VOCABULARY[field].map((item) => item.key));
}

const VALID = Object.freeze({
  horizontal: keys('horizontal'),
  vertical: keys('vertical'),
  tilt: keys('tilt'),
  eye_openness: keys('eye_openness'),
  gaze: keys('gaze'),
  mouth: keys('mouth'),
  usability: keys('usability'),
  occlusion_severity: keys('occlusion_severity'),
  occlusion_reasons: new Set([...keys('occlusion_reasons'), 'glasses']),
  face_scale: keys('face_scale'),
  template_state: keys('template_state'),
});

function requiredChoice(value, field) {
  const normalized = String(value || '').trim();
  if (!VALID[field].has(normalized)) throw new Error(`Invalid face tag ${field}`);
  return normalized;
}

export function normalizeFaceTag(input = {}, { subjectKind = 'identity' } = {}) {
  if (!['template', 'identity'].includes(subjectKind)) throw new Error('Invalid face tag subject kind');
  const eyes = input.eyes && typeof input.eyes === 'object' ? input.eyes : {};
  const openness = requiredChoice(eyes.openness, 'eye_openness');
  const gaze = openness === 'closed' ? 'not_applicable' : requiredChoice(eyes.gaze, 'gaze');
  const occlusion = input.occlusion && typeof input.occlusion === 'object' ? input.occlusion : {};
  const severity = requiredChoice(occlusion.severity, 'occlusion_severity');
  const reasons = [...new Set((Array.isArray(occlusion.reasons) ? occlusion.reasons : []).map((item) => requiredChoice(item, 'occlusion_reasons')))];
  if (severity === 'none' && reasons.length) throw new Error('Occlusion reasons require light or heavy severity');
  if (severity !== 'none' && !reasons.length) throw new Error('Occlusion severity requires at least one reason');
  const templateState = input.template_state == null ? null : requiredChoice(input.template_state, 'template_state');
  if (subjectKind === 'template' && !templateState) throw new Error('Template state is required');
  if (subjectKind === 'identity' && templateState) throw new Error('Template state is not valid for identity tags');
  return deepFreeze({
    schema_version: VOCABULARY_VERSION,
    horizontal: requiredChoice(input.horizontal, 'horizontal'),
    vertical: requiredChoice(input.vertical, 'vertical'),
    tilt: requiredChoice(input.tilt, 'tilt'),
    eyes: { openness, gaze },
    mouth: requiredChoice(input.mouth, 'mouth'),
    usability: requiredChoice(input.usability, 'usability'),
    occlusion: { severity, reasons },
    face_scale: requiredChoice(input.face_scale, 'face_scale'),
    ...(templateState ? { template_state: templateState } : {}),
  });
}

function anchor(field, key) {
  return FACE_TAG_VOCABULARY[field].find((item) => item.key === key)?.anchor ?? 0;
}

function numericComponent(template, identity, field, maximumDelta, weight) {
  return Math.abs(anchor(field, template[field]) - anchor(field, identity[field])) / maximumDelta * weight;
}

function categoricalComponent(templateValue, identityValue, weight, ignored = new Set(['unclear'])) {
  if (ignored.has(templateValue)) return 0;
  if (ignored.has(identityValue)) return weight / 2;
  return templateValue === identityValue ? 0 : weight;
}

const GAZE_COORDINATES = deepFreeze({
  camera: [0, 0],
  image_left: [-1, 0],
  image_right: [1, 0],
  up: [0, -1],
  down: [0, 1],
  image_left_up: [-1, -1],
  image_right_up: [1, -1],
  image_left_down: [-1, 1],
  image_right_down: [1, 1],
});

function gazeComponent(templateValue, identityValue, weight) {
  if (['unclear', 'not_applicable'].includes(templateValue)) return 0;
  if (['unclear', 'not_applicable'].includes(identityValue)) return weight / 2;
  const template = GAZE_COORDINATES[templateValue];
  const identity = GAZE_COORDINATES[identityValue];
  if (!template || !identity) return weight;
  return Math.hypot(template[0] - identity[0], template[1] - identity[1]) / Math.hypot(2, 2) * weight;
}

function projectionTag(projection) {
  if (projection?.state !== 'confirmed' || !projection.confirmation?.tag) return null;
  return projection.confirmation.tag;
}

function manualResult(reason, excluded = []) {
  return {
    state: 'manual_required',
    selected: null,
    ranked: [],
    excluded,
    reasons: [reason],
    matcher_version: MATCHER_VERSION,
    vocabulary_version: VOCABULARY_VERSION,
  };
}

export function matchIdentityFaceTags({ templateProjection, identityReferences = [] } = {}) {
  const rawTemplateTag = projectionTag(templateProjection);
  if (!rawTemplateTag) return manualResult('template_not_human_confirmed');
  const templateTag = normalizeFaceTag(rawTemplateTag, { subjectKind: 'template' });
  if (templateTag.template_state !== 'active') return manualResult('template_not_active');
  if (templateTag.usability === 'unusable' || templateTag.occlusion.severity === 'heavy') return manualResult('template_face_not_usable');

  const ranked = [];
  const excluded = [];
  for (const reference of identityReferences) {
    const ordinal = Number(reference?.ordinal);
    const rawIdentityTag = projectionTag(reference?.projection);
    if (!rawIdentityTag) {
      excluded.push({ ordinal, image_sha256: reference?.image_sha256 || null, reason: 'identity_not_human_confirmed' });
      continue;
    }
    let identityTag;
    try {
      identityTag = normalizeFaceTag(rawIdentityTag, { subjectKind: 'identity' });
    } catch {
      excluded.push({ ordinal, image_sha256: reference?.image_sha256 || null, reason: 'identity_tag_invalid' });
      continue;
    }
    if (identityTag.usability === 'unusable') {
      excluded.push({ ordinal, image_sha256: reference?.image_sha256 || null, reason: 'identity_unusable' });
      continue;
    }
    if (identityTag.occlusion.severity === 'heavy') {
      excluded.push({ ordinal, image_sha256: reference?.image_sha256 || null, reason: 'identity_heavy_occlusion' });
      continue;
    }
    const components = {
      horizontal: numericComponent(templateTag, identityTag, 'horizontal', 180, 55),
      vertical: numericComponent(templateTag, identityTag, 'vertical', 60, 20),
      tilt: numericComponent(templateTag, identityTag, 'tilt', 60, 15),
      eyes: categoricalComponent(templateTag.eyes.openness, identityTag.eyes.openness, 5),
      gaze: gazeComponent(templateTag.eyes.gaze, identityTag.eyes.gaze, 3),
      mouth: categoricalComponent(templateTag.mouth, identityTag.mouth, 2),
      quality: (identityTag.face_scale === 'small' ? 8 : 0) + (identityTag.occlusion.severity === 'light' ? 5 : 0),
    };
    const distance = Object.values(components).reduce((sum, value) => sum + value, 0);
    ranked.push({
      ordinal,
      image_sha256: reference?.image_sha256 || null,
      distance: Number(distance.toFixed(4)),
      components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, Number(value.toFixed(4))])),
      confirmation_event_id: reference.projection.confirmation.event_id || null,
    });
  }
  ranked.sort((left, right) => left.distance - right.distance || left.ordinal - right.ordinal);
  excluded.sort((left, right) => left.ordinal - right.ordinal);
  if (!ranked.length) return manualResult('no_eligible_identity_references', excluded);
  return {
    state: 'matched',
    selected: ranked[0],
    ranked,
    excluded,
    reasons: [],
    matcher_version: MATCHER_VERSION,
    vocabulary_version: VOCABULARY_VERSION,
  };
}

async function readJson(path, notFoundMessage) {
  try {
    return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error?.code === 'ENOENT' && notFoundMessage) throw new Error(notFoundMessage);
    throw error;
  }
}

async function readEvents(path) {
  try {
    const text = await readFile(path, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid face tag event at line ${index + 1}: ${error.message}`);
      }
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function atomicJson(path, value) {
  const previous = projectionWriteChains.get(path) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  });
  projectionWriteChains.set(path, operation);
  try {
    await operation;
  } finally {
    if (projectionWriteChains.get(path) === operation) projectionWriteChains.delete(path);
  }
}

function cleanOperationKey(value) {
  const key = String(value || '').trim();
  if (!/^[a-zA-Z0-9._:-]{4,128}$/.test(key)) throw new Error('Invalid face tag idempotency key');
  return key;
}

function cleanActor(value) {
  const actor = String(value || '').trim();
  if (!actor || actor.length > 128) throw new Error('Face tag actor is required');
  return actor;
}

function assertSha256(value, label = 'image hash') {
  const hash = String(value || '').trim().toLowerCase();
  if (!SHA256.test(hash)) throw new Error(`Invalid ${label}`);
  return hash;
}

function projectSubjectEvents(events, { subjectKind, subjectId, imageSha256 }) {
  const relevant = events.filter((event) => event.subject_kind === subjectKind
    && event.subject_id === subjectId
    && event.image_sha256 === imageSha256);
  let suggestion = null;
  let confirmation = null;
  for (const event of relevant) {
    if (event.event_type === 'FaceTagSuggested') suggestion = event;
    if (event.event_type === 'FaceTagConfirmed') confirmation = event;
  }
  return deepFreeze({
    state: confirmation ? 'confirmed' : suggestion ? 'suggested' : 'untagged',
    subject_kind: subjectKind,
    subject_id: subjectId,
    image_sha256: imageSha256,
    suggestion,
    confirmation,
  });
}

function createEvent({ kind, subjectKind, subjectId, imageSha256, idempotencyKey, actor, tag, modelVersion, promptVersion, supersedesEventId, scope = {} }) {
  if (!['suggestion', 'confirmation'].includes(kind)) throw new Error('Invalid face tag event kind');
  if (kind === 'suggestion' && (!String(modelVersion || '').trim() || !String(promptVersion || '').trim())) {
    throw new Error('Suggestion model and prompt versions are required');
  }
  return {
    schema_version: EVENT_VERSION,
    event_id: `face-tag-${randomUUID()}`,
    event_type: kind === 'suggestion' ? 'FaceTagSuggested' : 'FaceTagConfirmed',
    idempotency_key: cleanOperationKey(idempotencyKey),
    recorded_at: new Date().toISOString(),
    actor: cleanActor(actor),
    subject_kind: subjectKind,
    subject_id: subjectId,
    image_sha256: assertSha256(imageSha256),
    vocabulary_version: VOCABULARY_VERSION,
    tag,
    ...(kind === 'suggestion' ? { model_version: String(modelVersion).trim(), prompt_version: String(promptVersion).trim() } : {}),
    ...(kind === 'confirmation' ? { supersedes_event_id: supersedesEventId ? String(supersedesEventId) : null } : {}),
    ...scope,
  };
}

function assertSupersession({ events, event, currentProjection }) {
  const replay = events.find((item) => item.idempotency_key === event.idempotency_key);
  if (replay) return { replay };
  if (event.event_type !== 'FaceTagConfirmed') return {};
  const currentId = currentProjection.confirmation?.event_id || null;
  if (currentId && event.supersedes_event_id !== currentId) throw new Error(`Confirmation revision requires supersedes_event_id ${currentId}`);
  if (!currentId && event.supersedes_event_id) throw new Error('Initial confirmation cannot supersede an event');
  return {};
}

async function appendEvent(path, event) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
}

async function templateCatalog(root) {
  const value = await readJson(join(root, 'data', 'projections', 'template-catalog.json'), 'Template catalog not found');
  if (!Array.isArray(value.templates)) throw new Error('Template catalog is invalid');
  return value;
}

function templateEventPaths(root) {
  return {
    events: join(root, 'data', 'events', 'template-face-tags.jsonl'),
    projection: join(root, 'data', 'projections', 'template-face-tags.json'),
  };
}

// Read-only view of existing confirmed operator choices, not inferred aesthetic labels.
export async function loadTemplateExclusions({ root }) {
  const events = await readEvents(templateEventPaths(root).events);
  const catalog = events.length ? await templateCatalog(root) : {templates:[]};
  const rejectedHashes = new Set();
  for (const template of catalog.templates) {
    const item = projectSubjectEvents(events, {subjectKind:'template',subjectId:template.template_uid,imageSha256:template.reference_image?.sha256});
    if (item.confirmation?.tag?.template_state === 'rejected') rejectedHashes.add(template.reference_image.sha256);
  }
  const imageHashes = [...rejectedHashes].sort();
  const templateUids = catalog.templates.filter(t=>rejectedHashes.has(t.reference_image?.sha256)).map(t=>t.template_uid).sort();
  return {policy_version:'operator-template-exclusion-v1',template_uids:templateUids,image_hashes:imageHashes,
    fingerprint:createHash('sha256').update(JSON.stringify({templateUids,imageHashes})).digest('hex')};
}

export async function assertTemplatesNotRejected({root,templateUids=[],imageHashes=[]}) {
  if (!templateUids.length && !imageHashes.length) return;
  const excluded = await loadTemplateExclusions({root});
  if (templateUids.some(uid=>excluded.template_uids.includes(uid)) || imageHashes.some(hash=>excluded.image_hashes.includes(hash))) {
    throw Object.assign(new Error('你已淘汰此模板，请重新选择；尚未发送。恢复请到模板标注中明确改为正式可用。'),{status:422,code:'operator_template_rejected'});
  }
}

export async function rebuildTemplateFaceTagProjection({ root }) {
  const catalog = await templateCatalog(root);
  const paths = templateEventPaths(root);
  const events = await readEvents(paths.events);
  const templates = {};
  for (const template of catalog.templates) {
    const uid = String(template.template_uid || '');
    const imageSha256 = assertSha256(template.reference_image?.sha256, 'template image hash');
    templates[uid] = projectSubjectEvents(events, { subjectKind: 'template', subjectId: uid, imageSha256 });
  }
  const projection = {
    schema_version: TEMPLATE_PROJECTION_VERSION,
    vocabulary_version: VOCABULARY_VERSION,
    event_count: events.length,
    templates,
  };
  await atomicJson(paths.projection, projection);
  return deepFreeze(projection);
}

export async function loadTemplateFaceTagProjection({ root, templateUid }) {
  if (!TEMPLATE_UID.test(String(templateUid || ''))) throw new Error('Invalid template uid');
  const projection = await rebuildTemplateFaceTagProjection({ root });
  const item = projection.templates[templateUid];
  if (!item) throw new Error('Template not found');
  return item;
}

export async function recordTemplateFaceTag({
  root,
  templateUid,
  imageSha256,
  kind,
  idempotencyKey,
  actor,
  tag,
  modelVersion = '',
  promptVersion = '',
  supersedesEventId = null,
}) {
  if (!TEMPLATE_UID.test(String(templateUid || ''))) throw new Error('Invalid template uid');
  const catalog = await templateCatalog(root);
  const template = catalog.templates.find((item) => item.template_uid === templateUid);
  if (!template) throw new Error('Template not found');
  const expectedHash = assertSha256(template.reference_image?.sha256, 'template image hash');
  if (assertSha256(imageSha256) !== expectedHash) throw new Error('Template image hash mismatch');
  const paths = templateEventPaths(root);
  const events = await readEvents(paths.events);
  const current = projectSubjectEvents(events, { subjectKind: 'template', subjectId: templateUid, imageSha256: expectedHash });
  const normalizedTag = normalizeFaceTag(tag, { subjectKind: 'template' });
  const event = createEvent({ kind, subjectKind: 'template', subjectId: templateUid, imageSha256: expectedHash, idempotencyKey, actor, tag: normalizedTag, modelVersion, promptVersion, supersedesEventId });
  const { replay } = assertSupersession({ events, event, currentProjection: current });
  if (replay) return { event: replay, projection: current, idempotent_replay: true };
  await appendEvent(paths.events, event);
  const projection = await rebuildTemplateFaceTagProjection({ root });
  return { event, projection: projection.templates[templateUid], idempotent_replay: false };
}

export async function loadTemplateFaceTagProgress({ root }) {
  const projection = await rebuildTemplateFaceTagProjection({ root });
  const items = Object.values(projection.templates);
  const result = { total: items.length, confirmed: 0, suggested: 0, untagged: 0, active: 0, candidate: 0, rejected: 0 };
  for (const item of items) {
    result[item.state] += 1;
    const state = item.confirmation?.tag?.template_state;
    if (state && Object.hasOwn(result, state)) result[state] += 1;
  }
  return result;
}

export async function loadTemplateFaceTagStatuses({ root }) {
  const projection = await rebuildTemplateFaceTagProjection({ root });
  return deepFreeze({
    total: Object.keys(projection.templates).length,
    items: Object.values(projection.templates).map((item) => {
      const templateState = item.confirmation?.tag?.template_state || null;
      return {
        template_uid: item.subject_id,
        state: item.state,
        template_state: templateState,
        filter_state: item.state === 'confirmed' && templateState ? templateState : 'untagged',
        confirmation_event_id: item.confirmation?.event_id || null,
      };
    }),
  });
}

function identityPaths(root, customerId, identitySetId) {
  if (!CUSTOMER_ID.test(String(customerId || ''))) throw new Error('Invalid customer id');
  if (!IDENTITY_SET_ID.test(String(identitySetId || ''))) throw new Error('Invalid identity set id');
  const setRoot = join(root, 'data', 'customers', customerId, 'identity-sets', identitySetId);
  return {
    setRoot,
    setProjection: join(setRoot, 'identity-set.json'),
    events: join(setRoot, 'face-tag-events.jsonl'),
    projection: join(setRoot, 'face-tags.json'),
  };
}

async function identitySet(root, customerId, identitySetId) {
  const paths = identityPaths(root, customerId, identitySetId);
  const value = await readJson(paths.setProjection, 'Identity set not found');
  if (value.customer_id !== customerId || value.identity_set_id !== identitySetId || !Array.isArray(value.references)) throw new Error('Identity set not found');
  return { paths, value };
}

export async function rebuildIdentityFaceTagProjection({ root, customerId, identitySetId }) {
  const { paths, value } = await identitySet(root, customerId, identitySetId);
  const events = await readEvents(paths.events);
  const references = {};
  for (const reference of value.references) {
    const ordinal = Number(reference.ordinal);
    const imageSha256 = assertSha256(reference.sha256, 'identity image hash');
    references[String(ordinal)] = {
      ordinal,
      original_name: reference.original_name || reference.filename || '',
      ...projectSubjectEvents(events, { subjectKind: 'identity', subjectId: imageSha256, imageSha256 }),
    };
  }
  const projection = {
    schema_version: IDENTITY_PROJECTION_VERSION,
    vocabulary_version: VOCABULARY_VERSION,
    customer_id: customerId,
    identity_set_id: identitySetId,
    event_count: events.length,
    references,
  };
  await atomicJson(paths.projection, projection);
  return deepFreeze(projection);
}

export async function loadIdentityFaceTagProjections(args) {
  return rebuildIdentityFaceTagProjection(args);
}

export async function recordIdentityFaceTag({
  root,
  customerId,
  identitySetId,
  ordinal,
  imageSha256,
  kind,
  idempotencyKey,
  actor,
  tag,
  modelVersion = '',
  promptVersion = '',
  supersedesEventId = null,
}) {
  const { paths, value } = await identitySet(root, customerId, identitySetId);
  const reference = value.references.find((item) => Number(item.ordinal) === Number(ordinal));
  if (!reference) throw new Error('Identity reference not found');
  const expectedHash = assertSha256(reference.sha256, 'identity image hash');
  if (assertSha256(imageSha256) !== expectedHash) throw new Error('Identity reference hash mismatch');
  const events = await readEvents(paths.events);
  const current = projectSubjectEvents(events, { subjectKind: 'identity', subjectId: expectedHash, imageSha256: expectedHash });
  const normalizedTag = normalizeFaceTag(tag, { subjectKind: 'identity' });
  const event = createEvent({
    kind,
    subjectKind: 'identity',
    subjectId: expectedHash,
    imageSha256: expectedHash,
    idempotencyKey,
    actor,
    tag: normalizedTag,
    modelVersion,
    promptVersion,
    supersedesEventId,
    scope: { customer_id: customerId, identity_set_id: identitySetId, reference_ordinal: Number(ordinal) },
  });
  const { replay } = assertSupersession({ events, event, currentProjection: current });
  if (replay) return { event: replay, projection: current, idempotent_replay: true };
  await appendEvent(paths.events, event);
  const projection = await rebuildIdentityFaceTagProjection({ root, customerId, identitySetId });
  return { event, projection: projection.references[String(Number(ordinal))], idempotent_replay: false };
}
