const DEFAULT_TAG = Object.freeze({
  horizontal: 'front',
  vertical: 'level',
  tilt: 'level',
  eyes: Object.freeze({ openness: 'open', gaze: 'camera' }),
  mouth: 'closed',
  usability: 'clear',
  occlusion: Object.freeze({ severity: 'none', reasons: Object.freeze([]) }),
  face_scale: 'medium',
});
import { buildStyleFacetConfirmationPayload, createStyleFacetDraft, toggleStyleFacetPositioning, toggleStyleFacetTreatment, updateStyleFacetDraft } from './template-style-facets-v2-state.js';
import { resolveActiveCustomerPhotoPool } from './active-customer-photo-pool.js';

function clone(value) {
  return globalThis.structuredClone ? globalThis.structuredClone(value) : JSON.parse(JSON.stringify(value));
}

export function escapeTaggingHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function defaultTag(subjectKind) {
  return { ...clone(DEFAULT_TAG), ...(subjectKind === 'template' ? { template_state: 'candidate' } : {}) };
}

export function createTagDraft({ subjectKind = 'template', projection = null } = {}) {
  const confirmation = projection?.confirmation || null;
  const suggestion = projection?.suggestion || null;
  return {
    subjectKind,
    tag: clone(confirmation?.tag || suggestion?.tag || defaultTag(subjectKind)),
    confirmed: Boolean(confirmation),
    suggested: !confirmation && Boolean(suggestion),
    suggestionEventId: suggestion?.event_id || null,
    supersedesEventId: confirmation?.event_id || null,
    dirty: false,
  };
}

function setPath(target, path, value) {
  const parts = String(path).split('.');
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) cursor = cursor[parts[index]];
  cursor[parts.at(-1)] = value;
}

export function updateTagDraft(draft, path, value) {
  const next = clone(draft);
  setPath(next.tag, path, value);
  if (path === 'eyes.openness' && value === 'closed') next.tag.eyes.gaze = 'not_applicable';
  if (path === 'occlusion.severity' && value === 'none') next.tag.occlusion.reasons = [];
  next.dirty = true;
  return next;
}

export function toggleOcclusionReason(draft, reason) {
  const next = clone(draft);
  const values = new Set(next.tag.occlusion.reasons || []);
  if (values.has(reason)) values.delete(reason); else values.add(reason);
  next.tag.occlusion.reasons = [...values];
  if (values.size && next.tag.occlusion.severity === 'none') next.tag.occlusion.severity = 'light';
  if (!values.size && next.tag.occlusion.severity !== 'none') next.tag.occlusion.severity = 'none';
  next.dirty = true;
  return next;
}

export function buildConfirmationPayload({ draft, imageSha256, idempotencyKey }) {
  return {
    kind: 'confirmation',
    image_sha256: String(imageSha256 || ''),
    idempotency_key: String(idempotencyKey || ''),
    actor: 'primary-user',
    supersedes_event_id: draft.supersedesEventId || null,
    tag: clone(draft.tag),
  };
}

export function nextTaggingIndex({ current, total, direction }) {
  if (!Number.isInteger(current) || !Number.isInteger(total) || total <= 0) return 0;
  return Math.max(0, Math.min(total - 1, current + Math.sign(direction || 0)));
}

const TEMPLATE_FILTER_KEYS = Object.freeze(['all', 'active', 'candidate', 'rejected', 'untagged']);

export function buildTemplateFilterView({ templates = [], statuses = [], filter = 'all' } = {}) {
  const selectedFilter = TEMPLATE_FILTER_KEYS.includes(filter) ? filter : 'all';
  const byUid = new Map(statuses.map((item) => [item.template_uid, item]));
  const counts = { all: templates.length, active: 0, candidate: 0, rejected: 0, untagged: 0 };
  for (const template of templates) {
    const status = byUid.get(template.uid);
    const state = ['active', 'candidate', 'rejected'].includes(status?.filter_state) ? status.filter_state : 'untagged';
    counts[state] += 1;
  }
  return {
    filter: selectedFilter,
    counts,
    items: selectedFilter === 'all'
      ? [...templates]
      : templates.filter((template) => {
        const status = byUid.get(template.uid);
        const state = ['active', 'candidate', 'rejected'].includes(status?.filter_state) ? status.filter_state : 'untagged';
        return state === selectedFilter;
      }),
  };
}

function api(path, options) {
  return fetch(path, options).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || `请求失败 ${response.status}`);
    return body;
  });
}

const FIELD_BINDINGS = [
  ['template_state', 'templateStateChoices', 'template_state'],
  ['horizontal', 'horizontalChoices', 'horizontal'],
  ['vertical', 'verticalChoices', 'vertical'],
  ['tilt', 'tiltChoices', 'tilt'],
  ['eyes.openness', 'eyeOpennessChoices', 'eye_openness'],
  ['eyes.gaze', 'gazeChoices', 'gaze'],
  ['mouth', 'mouthChoices', 'mouth'],
  ['face_scale', 'faceScaleChoices', 'face_scale'],
  ['usability', 'usabilityChoices', 'usability'],
  ['occlusion.severity', 'occlusionSeverityChoices', 'occlusion_severity'],
];

function valueAt(tag, path) {
  return String(path).split('.').reduce((value, key) => value?.[key], tag);
}

function operationKey(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`.slice(0, 128);
}

function boot() {
  const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map((item) => [item.id, item]));
  const state = {
    mode: 'template',
    vocabulary: null,
    templates: [],
    templateStatuses: [],
    templateFilter: 'all',
    customers: [],
    items: [],
    index: 0,
    draft: null,
    projection: null,
    styleFacetVocabulary: null,
    styleFacetProjection: null,
    styleFacetDraft: createStyleFacetDraft(),
    customerId: '',
    identitySetId: '',
  };

  function current() { return state.items[state.index] || null; }

  function renderStyleDraft() {
    if (!elements.styleFacetWorkTypeChoices) return;
    const clear = () => { elements.styleFacetWorkTypeChoices.innerHTML = ''; elements.styleFacetTreatmentChoices.innerHTML = ''; elements.styleFacetPositioningChoices.innerHTML = ''; };
    if (state.mode !== 'template' || !state.styleFacetVocabulary) {
      clear();
      elements.styleFacetSourceState.textContent = '等待预选';
      elements.styleFacetSourceState.className = 'style-source-state';
      return;
    }
    const active = state.draft?.tag?.template_state === 'active';
    elements.styleFacetRejectedNotice.hidden = active;
    elements.styleFacetContent.hidden = !active;
    if (!active) {
      clear();
      elements.styleFacetRejectedNotice.textContent = '整张模板不再推荐；旧的人脸、角度和风格参数不作为匹配或学习依据。';
      elements.styleFacetSourceState.textContent = '不参与风格标注';
      elements.styleFacetSourceState.className = 'style-source-state';
      return;
    }
    const button = (item, selected, attr) => `<button type="button" class="choice-button style-facet-choice${selected ? ' is-selected' : ''}" ${attr}="${escapeTaggingHtml(item.key)}" title="${escapeTaggingHtml(item.description || '')}"><b>${escapeTaggingHtml(item.label)}</b><small>${escapeTaggingHtml(item.english_label || '')}</small></button>`;
    elements.styleFacetWorkTypeChoices.innerHTML = state.styleFacetVocabulary.work_types.map((item) => button(item, state.styleFacetDraft?.workType === item.key, 'data-style-facet-work-type')).join('');
    elements.styleFacetTreatmentChoices.innerHTML = state.styleFacetVocabulary.treatments.map((item) => button(item, state.styleFacetDraft?.treatments?.includes(item.key), 'data-style-facet-treatment')).join('');
    elements.styleFacetPositioningChoices.innerHTML = state.styleFacetVocabulary.positioning.map((item) => button(item, state.styleFacetDraft?.positioning?.includes(item.key), 'data-style-facet-positioning')).join('');
    elements.styleFacetSourceState.textContent = state.styleFacetDraft?.confirmed ? '人工已确认' : state.styleFacetDraft?.suggested ? 'AI预选 · 未确认' : '尚未预选';
    elements.styleFacetSourceState.className = `style-source-state${state.styleFacetDraft?.confirmed ? ' is-confirmed' : state.styleFacetDraft?.suggested ? ' is-suggested' : ''}`;
  }

  function renderTemplateFilter(counts) {
    const labels = { all: '全部', active: '正式可用', candidate: '候选观察', rejected: '已淘汰', untagged: '未标注' };
    elements.templateStatusFilter.innerHTML = TEMPLATE_FILTER_KEYS.map((key) => `<option value="${key}">${labels[key]} · ${counts[key]}</option>`).join('');
    elements.templateStatusFilter.value = state.templateFilter;
  }

  function applyTemplateFilter({ index = 0 } = {}) {
    const view = buildTemplateFilterView({ templates: state.templates, statuses: state.templateStatuses, filter: state.templateFilter });
    state.templateFilter = view.filter;
    state.items = view.items;
    state.index = Math.max(0, Math.min(index, Math.max(0, state.items.length - 1)));
    renderTemplateFilter(view.counts);
    return view;
  }

  async function refreshTemplateStatuses() {
    const { statuses } = await api('/api/face-tags/templates/statuses');
    state.templateStatuses = statuses.items || [];
    return statuses;
  }

  function renderChoiceGroup(path, elementId, vocabularyField) {
    const container = elements[elementId];
    if (!container || !state.vocabulary) return;
    const selected = valueAt(state.draft?.tag, path);
    const closedEyes = state.draft?.tag?.eyes?.openness === 'closed';
    container.innerHTML = state.vocabulary[vocabularyField].map((item) => `<button type="button" class="choice-button${selected === item.key ? ' is-selected' : ''}" data-tag-field="${escapeTaggingHtml(path)}" data-value="${escapeTaggingHtml(item.key)}"${path === 'eyes.gaze' && closedEyes && item.key !== 'not_applicable' ? ' disabled' : ''}>${escapeTaggingHtml(item.label)}</button>`).join('');
  }

  function renderReasons() {
    if (!state.vocabulary) return;
    const selected = new Set(state.draft?.tag?.occlusion?.reasons || []);
    const disabled = state.draft?.tag?.occlusion?.severity === 'none';
    elements.occlusionReasonChoices.innerHTML = state.vocabulary.occlusion_reasons.map((item) => `<button type="button" class="choice-button${selected.has(item.key) ? ' is-selected' : ''}" data-occlusion-reason="${escapeTaggingHtml(item.key)}"${disabled ? ' disabled' : ''}>${escapeTaggingHtml(item.label)}</button>`).join('');
  }

  function renderDraft() {
    for (const binding of FIELD_BINDINGS) renderChoiceGroup(...binding);
    renderReasons();
    renderStyleDraft();
    document.querySelectorAll('[data-template-only]').forEach((item) => { item.hidden = state.mode !== 'template'; });
    elements.suggestionBadge.hidden = !state.draft?.suggested;
    elements.sourceState.className = `source-state ${state.draft?.confirmed ? 'is-confirmed' : state.draft?.suggested ? 'is-suggested' : ''}`;
    elements.sourceState.textContent = state.draft?.confirmed ? '人工已确认' : state.draft?.suggested ? 'AI预选 · 未确认' : '尚未标注';
    elements.saveState.textContent = state.draft?.dirty ? '有修改，尚未保存' : state.draft?.confirmed ? '当前标签已保存' : '选择完成后确认';
  }

  async function loadCurrent() {
    const item = current();
    if (!item) {
      elements.taggingTitle.textContent = state.mode === 'template' ? '当前筛选下没有模板' : '请选择客户';
      elements.taggingImage.removeAttribute('src');
      elements.taggingImage.hidden = true;
      elements.imageLoading.hidden = false;
      elements.imageLoading.textContent = state.mode === 'template' ? '换一个模板状态即可继续' : '请选择客户';
      elements.itemPosition.textContent = '0 张';
      elements.previousItem.disabled = true;
      elements.nextItem.disabled = true;
      elements.confirmAndNext.disabled = true;
      state.projection = null;
      state.draft = null;
      state.styleFacetProjection = null;
      state.styleFacetDraft = createStyleFacetDraft();
      renderDraft();
      elements.sourceState.textContent = '无结果';
      return;
    }
    elements.confirmAndNext.disabled = false;
    elements.previousItem.disabled = state.index <= 0;
    elements.nextItem.disabled = state.index >= state.items.length - 1;
    elements.taggingImage.hidden = false;
    elements.imageLoading.hidden = false;
    elements.imageLoading.textContent = '正在加载图片…';
    elements.taggingImage.onload = () => { elements.imageLoading.hidden = true; };
    elements.taggingImage.src = item.imageUrl;
    elements.taggingTitle.textContent = item.name;
    elements.itemPosition.textContent = `第 ${state.index + 1} 张，共 ${state.items.length} 张`;
    elements.subjectKindLabel.textContent = state.mode === 'template' ? 'TEMPLATE' : 'CUSTOMER IDENTITY';
    const [response, styleResponse] = state.mode === 'template'
      ? await Promise.all([
        api(`/api/templates/${encodeURIComponent(item.uid)}/face-tag`),
        state.styleFacetVocabulary ? api(`/api/templates/${encodeURIComponent(item.uid)}/style-facets-v2`).catch(() => ({ projection: null })) : Promise.resolve({ projection: null }),
      ])
      : [{ projection: state.identityProjection?.references?.[String(item.ordinal)] || null }, { projection: null }];
    state.projection = response.projection;
    state.draft = createTagDraft({ subjectKind: state.mode, projection: state.projection });
    state.styleFacetProjection = styleResponse.projection;
    state.styleFacetDraft = createStyleFacetDraft({ projection: state.styleFacetProjection });
    renderDraft();
  }

  async function updateProgress() {
    if (state.mode === 'template') {
      const { progress } = await api('/api/face-tags/templates/progress');
      elements.taggingProgress.textContent = `${progress.confirmed} / ${progress.total}`;
      elements.taggingProgressText.textContent = `已确认 · ${progress.untagged} 张未标注`;
    } else {
      const references = Object.values(state.identityProjection?.references || {});
      const confirmed = references.filter((item) => item.state === 'confirmed').length;
      elements.taggingProgress.textContent = `${confirmed} / ${references.length}`;
      elements.taggingProgressText.textContent = '当前客户照片池';
    }
  }

  async function loadTemplates() {
    const [{ vocabulary }, catalog, { statuses }, styleVocabularyResponse] = await Promise.all([api('/api/face-tags/vocabulary'), api('/api/templates?limit=124'), api('/api/face-tags/templates/statuses'), api('/api/template-style-facets-v2/vocabulary').catch(() => ({ vocabulary: null }))]);
    state.vocabulary = vocabulary;
    state.styleFacetVocabulary = styleVocabularyResponse.vocabulary;
    state.templates = (catalog.templates || []).map((item) => ({
      uid: item.template_uid,
      name: item.template_info?.template_name || item.template_uid,
      imageSha256: item.reference_image?.sha256,
      imageUrl: item.reference_image?.url,
    }));
    state.templateStatuses = statuses.items || [];
    applyTemplateFilter({ index: state.index });
    elements.matchTemplateSelect.innerHTML = '<option value="">请选择模板</option>' + state.templates.map((item) => `<option value="${escapeTaggingHtml(item.uid)}">${escapeTaggingHtml(item.name)}</option>`).join('');
    await Promise.all([loadCurrent(), updateProgress()]);
  }

  async function loadCustomers() {
    const { customers } = await api('/api/customers');
    state.customers = customers || [];
    elements.customerSelect.innerHTML = '<option value="">请选择客户</option>' + state.customers.map((item) => `<option value="${escapeTaggingHtml(item.customer_id)}">${escapeTaggingHtml(item.display_name || item.customer_id)}</option>`).join('');
  }

  async function loadActiveCustomerPhotoPool() {
    state.customerId = elements.customerSelect.value;
    state.items = [];
    state.identityProjection = null;
    state.identitySetId = '';
    if (!state.customerId) {
      await Promise.all([loadCurrent(), updateProgress()]);
      return;
    }
    const data = await api(`/api/customers/${encodeURIComponent(state.customerId)}/identity-sets`);
    const customer = state.customers.find((item) => item.customer_id === state.customerId);
    const set = resolveActiveCustomerPhotoPool({ customer, identitySets: data.identity_sets || [] });
    if (!set) { await Promise.all([loadCurrent(), updateProgress()]); return; }
    await loadIdentityReferences(set);
  }

  async function loadIdentityReferences(set) {
    state.identitySetId = set.identity_set_id;
    const response = await api(`/api/customers/${encodeURIComponent(state.customerId)}/identity-sets/${encodeURIComponent(state.identitySetId)}/face-tags`);
    state.identityProjection = response.projection;
    state.items = (set.references || []).map((item) => ({
      ordinal: Number(item.ordinal),
      name: item.original_name || item.filename || `身份图 ${item.ordinal}`,
      imageSha256: item.sha256,
      imageUrl: `/api/customers/${encodeURIComponent(state.customerId)}/identity-sets/${encodeURIComponent(state.identitySetId)}/references/${item.ordinal}/file`,
    }));
    state.index = 0;
    await Promise.all([loadCurrent(), updateProgress()]);
  }

  async function setMode(mode) {
    state.mode = mode;
    elements.templateModeButton.classList.toggle('is-active', mode === 'template');
    elements.identityModeButton.classList.toggle('is-active', mode === 'identity');
    elements.identityContext.hidden = mode !== 'identity';
    elements.templateFilterWrap.hidden = mode !== 'template';
    state.index = 0;
    if (mode === 'template') await loadTemplates();
    else {
      if (!state.vocabulary || !state.templates.length) await loadTemplates();
      state.items = [];
      await loadCustomers();
      await loadActiveCustomerPhotoPool();
    }
  }

  async function saveAndAdvance() {
    const item = current();
    if (!item || !state.draft) return;
    const payload = buildConfirmationPayload({ draft: state.draft, imageSha256: item.imageSha256, idempotencyKey: operationKey('face-tag-ui') });
    const endpoint = state.mode === 'template'
      ? `/api/templates/${encodeURIComponent(item.uid)}/face-tag`
      : `/api/customers/${encodeURIComponent(state.customerId)}/identity-sets/${encodeURIComponent(state.identitySetId)}/references/${item.ordinal}/face-tag`;
    elements.confirmAndNext.disabled = true;
    elements.saveState.textContent = '正在保存…';
    try {
      await api(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (state.mode === 'template' && state.draft?.tag?.template_state === 'active' && state.styleFacetDraft?.workType) {
        const stylePayload = buildStyleFacetConfirmationPayload({ draft: state.styleFacetDraft, imageSha256: item.imageSha256, idempotencyKey: operationKey('template-style-facets-v2-ui') });
        await api(`/api/templates/${encodeURIComponent(item.uid)}/style-facets-v2`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(stylePayload) });
      }
      if (state.mode === 'identity') {
        state.identityProjection = (await api(`/api/customers/${encodeURIComponent(state.customerId)}/identity-sets/${encodeURIComponent(state.identitySetId)}/face-tags`)).projection;
        state.index = nextTaggingIndex({ current: state.index, total: state.items.length, direction: 1 });
      } else {
        const previousIndex = state.index;
        const savedUid = item.uid;
        await refreshTemplateStatuses();
        applyTemplateFilter({ index: previousIndex });
        const savedIndex = state.items.findIndex((template) => template.uid === savedUid);
        state.index = savedIndex >= 0
          ? nextTaggingIndex({ current: savedIndex, total: state.items.length, direction: 1 })
          : Math.min(previousIndex, Math.max(0, state.items.length - 1));
      }
      await Promise.all([loadCurrent(), updateProgress()]);
    } catch (error) {
      elements.saveState.textContent = error.message;
    } finally {
      elements.confirmAndNext.disabled = false;
    }
  }

  async function runMatch() {
    if (!state.customerId || !state.identitySetId || !elements.matchTemplateSelect.value) return;
    const { result } = await api('/api/face-tags/match', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template_uid: elements.matchTemplateSelect.value, customer_id: state.customerId, identity_set_id: state.identitySetId }),
    });
    elements.matchPreview.hidden = false;
    if (result.state !== 'matched') {
      elements.matchPreviewBody.textContent = '没有足够的已确认照片，请手动选择主身份图。';
      return;
    }
    const selected = state.items.find((item) => item.ordinal === result.selected.ordinal);
    elements.matchPreviewBody.innerHTML = `<div class="match-result-card"><img src="${escapeTaggingHtml(selected.imageUrl)}" alt="匹配出的客户照片"><div><strong>${escapeTaggingHtml(selected.name)}</strong><small>方向、抬低头、歪头和眼睛状态最接近当前模板</small></div></div>`;
  }

  document.addEventListener('click', (event) => {
    const choice = event.target.closest('[data-tag-field]');
    if (choice && state.draft) { state.draft = updateTagDraft(state.draft, choice.dataset.tagField, choice.dataset.value); renderDraft(); }
    const reason = event.target.closest('[data-occlusion-reason]');
    if (reason && state.draft) { state.draft = toggleOcclusionReason(state.draft, reason.dataset.occlusionReason); renderDraft(); }
    const workType = event.target.closest('[data-style-facet-work-type]');
    if (workType && state.mode === 'template') { state.styleFacetDraft = updateStyleFacetDraft(state.styleFacetDraft, { workType: workType.dataset.styleFacetWorkType }); renderStyleDraft(); }
    const treatment = event.target.closest('[data-style-facet-treatment]');
    if (treatment && state.mode === 'template') { state.styleFacetDraft = toggleStyleFacetTreatment(state.styleFacetDraft, treatment.dataset.styleFacetTreatment); renderStyleDraft(); }
    const positioning = event.target.closest('[data-style-facet-positioning]');
    if (positioning && state.mode === 'template') { state.styleFacetDraft = toggleStyleFacetPositioning(state.styleFacetDraft, positioning.dataset.styleFacetPositioning); renderStyleDraft(); }
  });
  elements.templateModeButton.addEventListener('click', () => setMode('template'));
  elements.identityModeButton.addEventListener('click', () => setMode('identity'));
  elements.previousItem.addEventListener('click', async () => { state.index = nextTaggingIndex({ current: state.index, total: state.items.length, direction: -1 }); await loadCurrent(); });
  elements.nextItem.addEventListener('click', async () => { state.index = nextTaggingIndex({ current: state.index, total: state.items.length, direction: 1 }); await loadCurrent(); });
  elements.confirmAndNext.addEventListener('click', saveAndAdvance);
  elements.customerSelect.addEventListener('change', loadActiveCustomerPhotoPool);
  elements.templateStatusFilter.addEventListener('change', async () => {
    state.templateFilter = elements.templateStatusFilter.value;
    applyTemplateFilter({ index: 0 });
    await loadCurrent();
  });
  elements.runMatchPreview.addEventListener('click', runMatch);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' && !event.target.closest('select,button')) elements.previousItem.click();
    if (event.key === 'ArrowRight' && !event.target.closest('select,button')) elements.nextItem.click();
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); elements.confirmAndNext.click(); }
  });
  loadTemplates().catch((error) => { elements.saveState.textContent = error.message; });
}

if (typeof document !== 'undefined') boot();
