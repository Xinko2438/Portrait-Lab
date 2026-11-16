const TASK_BRIEF_VERSION = 'ai-img-gen.customer-task-brief.v1';
const MAX_TEMPLATE_REFERENCES = 4;

const templateRejectionLabels = {
  identity_risk_too_high: '这张模板可能较难保持像本人，供你选择时参考',
  operator_template_rejected: '你已淘汰此模板；如需恢复，请到“模板标注”改为“正式可用”',
  manual_framing_mismatch: '与手动指定的景别不同',
  manual_style_mismatch: '与手动指定的风格不同',
  generation_difficulty_too_high: '这张模板较复杂，生成效果可能不够稳定',
  face_visibility_not_allowed: '模板中的脸部可见范围不适合当前任务',
  text_on_face_forbidden: '模板文字靠近脸部，生成时可能遮挡五官',
  style_forbidden: '与本次风格要求冲突',
  avoid_temperament_conflict: '与人物气质要求冲突',
};

export function templateRejectionText(codes = []) {
  return codes.map(code => templateRejectionLabels[cleanText(code)] || cleanText(code).replaceAll('_', ' ')).join('；') || '这张模板不适合当前任务';
}

function cleanText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function normalizeTokenList(value) {
  const values = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  return [...new Set(values.map((item) => cleanText(item).toLowerCase()).filter(Boolean))];
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function taskBriefIdentity(taskBrief = {}) {
  return JSON.stringify(canonicalValue(taskBrief));
}

function defaultOperationKey(prefix) {
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '') || `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`.slice(0, 128);
}

function fnv1a64(value) {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(cleanText(value).normalize('NFKC').toLowerCase() || 'anonymous-customer');
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

export function createOpaqueCustomerScopeId(customerName) {
  return `cust_${fnv1a64(customerName)}`;
}

export function recommendationAlternatives(selection = {}, { expanded = false, limit = 10 } = {}) {
  const top4 = new Set((selection.top4 || []).map((item) => cleanText(item.template_uid || item.uid)).filter(Boolean));
  const source = Array.isArray(selection.ranked_candidates) && selection.ranked_candidates.length
    ? selection.ranked_candidates
    : selection.top10 || [];
  const seen = new Set();
  const alternatives = [];
  for (const item of source) {
    const uid = cleanText(item?.template_uid || item?.uid);
    if (!uid || top4.has(uid) || seen.has(uid)) continue;
    seen.add(uid);
    alternatives.push(item);
  }
  return expanded ? alternatives : alternatives.slice(0, Math.max(0, limit));
}

export function normalizeCatalogTemplate(template = {}) {
  const tags = template.selection_tags || {};
  const reference = template.reference_image || {};
  return {
    uid: template.template_uid || template.uid || '',
    operator_rejected: template.operator_rejected === true,
    name: template.template_name || template.template_info?.template_name || template.name || '',
    image_url: reference.url || template.image_url || '',
    reference_image_sha256: reference.sha256 || template.reference_image_sha256 || '',
    reference_mime_type: reference.mime_type || template.mime_type || '',
    reference_extension: reference.extension || template.extension || '',
    style_category: tags.style_category || template.style_category || '',
    portrait_scale: tags.portrait_scale || template.portrait_scale || '',
    face_angle: tags.face_angle || template.face_angle || '',
    identity_preservation_risk: tags.identity_preservation_risk || template.identity_preservation_risk || '',
    generation_difficulty: tags.generation_difficulty || template.generation_difficulty || '',
    rank: template.rank ?? null,
    relevance_score: template.relevance_score ?? null,
    reason: template.reason || '',
    raw: template,
  };
}

function selectedTemplateSet(selection) {
  if (!selection?.selection_id) return null;
  return new Set([
    ...(selection.top4 || []).map((item) => item.template_uid),
    ...(selection.top10 || []).map((item) => item.template_uid),
  ]);
}

export function createTemplateLibraryController(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch?.bind(globalThis);
  let selectedTemplates = [];
  let currentItems = [];
  let currentTotal = 0;
  let filterVocabulary = {};
  let activeDetailTemplate = null;
  let activeSelection = null;

  return {
    async loadTemplates(filterParams = {}) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(filterParams)) {
        if (value !== undefined && value !== null && cleanText(value)) query.set(key, cleanText(value));
      }
      const response = await fetchImpl(`/api/templates?${query.toString()}`);
      if (!response.ok) throw new Error(`Failed to load templates: ${response.status}`);
      const data = await response.json();
      currentItems = Array.isArray(data.templates) ? data.templates : [];
      currentTotal = Number(data.total ?? currentItems.length);
      filterVocabulary = data.filters && typeof data.filters === 'object' ? structuredClone(data.filters) : {};
      return data;
    },

    getItems() {
      return currentItems;
    },

    getTaskPickerItems() {
      return currentItems.filter(item => item.operator_rejected !== true);
    },

    getTaskPickerHiddenRejectedCount() {
      return currentItems.filter(item => item.operator_rejected === true).length;
    },

    getTotal() {
      return currentTotal;
    },

    getFilterVocabulary() {
      return structuredClone(filterVocabulary);
    },

    setActiveSelection(selection) {
      activeSelection = selection?.selection_id ? selection : null;
      return activeSelection;
    },

    getActiveSelection() {
      return activeSelection;
    },

    getTemplateEligibility(uid) {
      const templateUid = cleanText(uid);
      if (currentItems.some(item=>(item.template_uid || item.uid)===templateUid && item.operator_rejected)) return {state:'ineligible',reason_codes:['operator_template_rejected']};
      if (!activeSelection?.selection_id || !templateUid) return { state: 'unknown', reason_codes: [] };
      const eligible = [
        ...(Array.isArray(activeSelection.ranked_candidates) ? activeSelection.ranked_candidates : []),
        ...(activeSelection.top10 || []),
        ...(activeSelection.top4 || []),
      ].some((item) => cleanText(item?.template_uid || item?.uid) === templateUid);
      if (eligible) return { state: 'eligible', reason_codes: [] };
      const rejected = (activeSelection.exclusions || activeSelection.filter_results || [])
        .find((item) => cleanText(item?.template_uid || item?.uid) === templateUid);
      if (rejected) {
        return {
          state: rejected.rejection_codes?.includes('operator_template_rejected') ? 'ineligible' : 'advisory',
          reason_codes: [...new Set((rejected.rejection_codes || []).map(cleanText).filter(Boolean))],
        };
      }
      return { state: 'unknown', reason_codes: [] };
    },

    isSelected(uid) {
      return selectedTemplates.some((item) => item.uid === uid);
    },

    getSelectedTemplates() {
      return selectedTemplates.map((item) => ({ ...item }));
    },

    getSelectedCount() {
      return selectedTemplates.length;
    },

    setSelectedTemplates(templates = []) {
      selectedTemplates = templates.map(normalizeCatalogTemplate).filter((item) => item.uid);
    },

    toggleSelection(template, existingManualCount = 0) {
      const normalized = normalizeCatalogTemplate(template);
      const index = selectedTemplates.findIndex((item) => item.uid === normalized.uid);
      if (index >= 0) {
        selectedTemplates.splice(index, 1);
        return { selected: false, template: normalized };
      }
      if (!activeSelection?.selection_id) {
        return { selected: false, reason: 'selection_required' };
      }
      if (normalized.operator_rejected || this.getTemplateEligibility(normalized.uid).reason_codes.includes('operator_template_rejected')) return {selected:false,reason:'operator_template_rejected'};
      if (!normalized.uid) return { selected: false, reason: 'invalid_template' };
      if (selectedTemplates.length + Number(existingManualCount || 0) >= MAX_TEMPLATE_REFERENCES) {
        return { selected: false, reason: 'limit_exceeded', maxAllowed: MAX_TEMPLATE_REFERENCES };
      }
      selectedTemplates.push(normalized);
      return {
        selected: true,
        template: normalized,
        recommended: selectedTemplateSet(activeSelection)?.has(normalized.uid) || false,
      };
    },

    clearSelection() {
      selectedTemplates = [];
    },

    removeSelection(uid) {
      const index = selectedTemplates.findIndex((item) => item.uid === uid);
      if (index < 0) return false;
      selectedTemplates.splice(index, 1);
      return true;
    },

    setActiveDetail(template) {
      activeDetailTemplate = template;
      return activeDetailTemplate;
    },

    getActiveDetail() {
      return activeDetailTemplate;
    },
  };
}

export function mapFormToTaskBrief(formValues = {}) {
  const targetFraming = cleanText(formValues.targetFraming);
  const targetAngle = cleanText(formValues.targetAngle);
  const scaleMap = {
    headshot: 'close_up',
    close_up: 'close_up',
    bust: 'bust',
    half_body: 'half_body',
    three_quarter: 'half_body',
    full_body: 'full_body',
    environmental_portrait: 'environmental_portrait',
  };
  const angleMap = {
    frontal: 'front',
    front: 'front',
    front_15_degree: 'front_15_degree',
    front_30_degree: 'front_30_degree',
    left_45: 'side_45_degree',
    right_45: 'side_45_degree',
    side_45_degree: 'side_45_degree',
    full_profile: 'extreme_side',
    extreme_side: 'extreme_side',
  };
  const intendedUse = cleanText(formValues.intendedUse);
  const businessDomain = cleanText(formValues.businessDomain);
  const prompt = cleanText(formValues.prompt);
  const mappedScale = scaleMap[targetFraming] || '';
  const mappedAngle = angleMap[targetAngle] || '';

  return {
    schema_version: TASK_BRIEF_VERSION,
    customer_scope_id: cleanText(formValues.customerScopeId) || createOpaqueCustomerScopeId(formValues.customerName),
    parent_selection_id: formValues.parentSelectionId ? cleanText(formValues.parentSelectionId) : null,
    use_case: intendedUse.toLowerCase(),
    style_keywords: normalizeTokenList(formValues.styleKeywords),
    avoid_keywords: normalizeTokenList(formValues.avoidKeywords),
    target_portrait_scales: mappedScale ? [mappedScale] : [],
    target_face_angles: mappedAngle ? [mappedAngle] : [],
    temperament_keywords: normalizeTokenList(formValues.temperamentKeywords),
    face_feature_observations: normalizeTokenList(formValues.faceFeatureObservations),
    required_face_visibility: ['high', 'medium'],
    allow_text_on_face: false,
    max_identity_preservation_risk: 'medium',
    max_generation_difficulty: 'high',
    diversity_preference: cleanText(formValues.diversityPreference || 'balanced').toLowerCase(),
    free_text_intent: [intendedUse, businessDomain, prompt].filter(Boolean).join(' '),
  };
}

export function buildSelectionDecision({
  selection,
  selectedTemplateUids = [],
  linkedRunIds = [],
  notes = '',
  selectionSources = {},
}) {
  if (!selection?.selection_id || !Array.isArray(selection.top4)) throw new Error('An active template selection is required');
  const selected = [...new Set(selectedTemplateUids.map(cleanText).filter(Boolean))];
  if (!selected.length || selected.length > MAX_TEMPLATE_REFERENCES) {
    throw new Error('Select between one and four catalog templates');
  }
  const top4Uids = selection.top4.map((item) => item.template_uid);
  const top4Set = new Set(top4Uids);
  const accepted = selected.filter((uid) => top4Set.has(uid));
  const added = selected.filter((uid) => !top4Set.has(uid));
  const removed = top4Uids.filter((uid) => !accepted.includes(uid));
  return {
    actor: 'primary-user',
    accepted_template_uids: accepted,
    removed_template_uids: removed,
    substitutions: added.map((uid, index) => {
      const source = selectionSources?.[uid] || {source_kind:'full_library'};
      return {
        removed_template_uid: removed[index] || null,
        added_template_uid: uid,
        reason: source.source_kind === 'exploration_slate'
          ? 'operator_replaced_recommendation_from_safe_inspiration'
          : 'operator_replaced_recommendation_from_template_library',
        ...(source.source_kind ? { source_kind: source.source_kind } : {}),
        ...(source.source_slate_id ? { source_slate_id: source.source_slate_id } : {}),
      };
    }),
    linked_run_ids: [...new Set(linkedRunIds.map(cleanText).filter(Boolean))],
    notes: cleanText(notes),
  };
}

export function createRecommendationController(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch?.bind(globalThis);
  const selectionKeyFactory = options.selectionIdempotencyKeyFactory || (() => defaultOperationKey('selection'));
  const decisionKeyFactory = options.decisionIdempotencyKeyFactory || (() => defaultOperationKey('decision'));
  const explorationKeyFactory = options.explorationIdempotencyKeyFactory || (() => defaultOperationKey('exploration'));
  let selection = null;
  let safeInspiration = null;
  let lastSelectionIdempotencyKey = null;
  let lastDecisionIdempotencyKey = null;
  let activeTaskBriefIdentity = null;
  let safeInspirationFlight = null;
  let pendingExplorationKey = null;
  let recommendationRevision = 0;

  return {
    async requestRecommendations(taskBrief, { idempotencyKey } = {}) {
      const requestRevision=++recommendationRevision;
      const operationKey = cleanText(idempotencyKey || selectionKeyFactory(taskBrief));
      const response = await fetchImpl('/api/template-selections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idempotency_key: operationKey, task_brief: taskBrief }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || `Failed to create selection: ${response.status}`);
      if (!data.selection?.selection_id) throw new Error('Template selection response is incomplete');
      if(requestRevision!==recommendationRevision)throw new Error('任务已更新，过期推荐已忽略');
      selection = data.selection;
      activeTaskBriefIdentity = taskBriefIdentity(taskBrief);
      safeInspiration = null;
      pendingExplorationKey = null;
      lastSelectionIdempotencyKey = operationKey;
      return data;
    },

    getSelectionId() {
      return selection?.selection_id || null;
    },
    invalidatePendingRecommendations(){recommendationRevision++;},

    getSelection() {
      return selection;
    },

    matchesTaskBrief(taskBrief) {
      return Boolean(selection?.selection_id)
        && activeTaskBriefIdentity === taskBriefIdentity(taskBrief);
    },

    clearSelectionState() {
      recommendationRevision++;
      selection = null;
      safeInspiration = null;
      activeTaskBriefIdentity = null;
      pendingExplorationKey = null;
      lastSelectionIdempotencyKey = null;
      lastDecisionIdempotencyKey = null;
    },

    getRecommendation() {
      return selection;
    },

    getTop4() {
      return selection?.top4 || [];
    },

    getTop10() {
      return selection?.top10 || [];
    },

    getRankedCandidates() {
      return selection?.ranked_candidates || selection?.top10 || [];
    },

    getAlternatives(options = {}) {
      return recommendationAlternatives(selection || {}, options);
    },

    getFilterSummary() {
      return selection?.filter_summary || {};
    },

    getRejectionSummary() {
      return selection?.filter_summary?.rejection_counts || {};
    },

    getWarnings() {
      return selection?.warnings || [];
    },

    getStatus() {
      return selection?.status || null;
    },

    getSafeInspiration() {
      return safeInspiration ? structuredClone(safeInspiration) : null;
    },

    async requestSafeInspiration({ idempotencyKey } = {}) {
      if (!selection?.selection_id) throw new Error('No active selection ID');
      if (safeInspirationFlight) return safeInspirationFlight;
      const operationKey = cleanText(idempotencyKey || pendingExplorationKey || explorationKeyFactory(selection));
      pendingExplorationKey = operationKey;
      const selectionId = selection.selection_id;
      safeInspirationFlight = (async () => {
        const response = await fetchImpl(`/api/template-selections/${encodeURIComponent(selectionId)}/explorations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ exploration_idempotency_key: operationKey }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error?.message || `Failed to create safe inspiration: ${response.status}`);
        if (selection?.selection_id !== selectionId) throw new Error('Template selection changed while safe inspiration was loading');
        safeInspiration = data;
        pendingExplorationKey = null;
        return structuredClone(data);
      })();
      try {
        return await safeInspirationFlight;
      } finally {
        safeInspirationFlight = null;
      }
    },

    getSelectionIdempotencyKey() {
      return lastSelectionIdempotencyKey;
    },

    getDecisionIdempotencyKey() {
      return lastDecisionIdempotencyKey;
    },

    setSelectionState(nextSelection, legacySelection) {
      recommendationRevision++;
      selection = typeof nextSelection === 'string'
        ? { ...(legacySelection || {}), selection_id: nextSelection }
        : nextSelection;
      safeInspiration = null;
      pendingExplorationKey = null;
      activeTaskBriefIdentity = selection?.task_brief ? taskBriefIdentity(selection.task_brief) : null;
      return selection;
    },

    async recordDecision(decisionPayload, { decisionIdempotencyKey } = {}) {
      if (!selection?.selection_id) throw new Error('No active selection ID');
      const operationKey = cleanText(
        decisionIdempotencyKey
        || decisionPayload?.decision_idempotency_key
        || decisionKeyFactory(decisionPayload),
      );
      const body = {
        decision_idempotency_key: operationKey,
        actor: decisionPayload.actor || 'primary-user',
        accepted_template_uids: decisionPayload.accepted_template_uids || [],
        removed_template_uids: decisionPayload.removed_template_uids || [],
        substitutions: decisionPayload.substitutions || [],
        linked_run_ids: decisionPayload.linked_run_ids || [],
        notes: decisionPayload.notes || '',
      };
      const response = await fetchImpl(`/api/template-selections/${encodeURIComponent(selection.selection_id)}/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || `Failed to record decision: ${response.status}`);
      selection = data.selection;
      lastDecisionIdempotencyKey = operationKey;
      return data;
    },
  };
}

export function formatHistoryTemplateItem(templateItem = {}) {
  const isCatalog = templateItem.source_type === 'catalog_template' || templateItem.source_type === 'catalog';
  let badgeText = '';
  if (isCatalog) {
    badgeText = templateItem.decision_type === 'substituted'
      ? '模板库替换'
      : templateItem.selected_rank != null || templateItem.rank != null
        ? `推荐 Top ${templateItem.selected_rank ?? templateItem.rank}`
        : '系统选择';
  } else if (templateItem.source_type === 'uploaded_reference' || templateItem.source_type === 'manual_upload') {
    badgeText = '人工上传';
  }
  return {
    badgeText,
    isCatalog,
    name: templateItem.template_name || templateItem.original_filename || templateItem.filename || '参考模板',
    templateUid: templateItem.template_uid || null,
  };
}
