import {
  FACE_ANGLE_MATCH_SCHEMA_VERSION,
  recommendIdentityPose,
  reorderPrimaryIdentity,
} from './face-angle-core.js';

function errorObservation(context) {
  return {
    schema_version: 'ai-img-gen.face-pose-observation.v1',
    source_kind: context.sourceKind,
    source_index: context.sourceIndex,
    source_sha256: String(context.sourceSha256 || ''),
    analyzer: { name: 'unknown', version: 'unknown', model_sha256: '' },
    state: 'error',
    yaw_deg: null,
    pitch_deg: null,
    roll_deg: null,
    angle_family: 'unknown',
    legacy_angle: 'other',
    display_label: '无法自动判断',
    face_count: 0,
    face_coverage_ratio: null,
    reliability: 'unavailable',
  };
}

export function createFaceAngleWorkflow({ analyze }) {
  if (typeof analyze !== 'function') throw new TypeError('Face-angle workflow requires an analyze function');
  let revision = 0;
  let pending = Promise.resolve();
  let state = {
    revision,
    status: 'idle',
    identityObservations: [],
    uploadedTemplateObservations: [],
    catalogTemplateObservations: [],
    catalogTemplateUids: [],
    match: null,
  };

  function getState() {
    return structuredClone(state);
  }

  async function analyzeGroup(sources, sourceKind) {
    return Promise.all(sources.map(async (source, sourceIndex) => {
      const context = {
        sourceKind,
        sourceIndex,
        sourceSha256: source?.source_sha256 || source?.sha256 || '',
      };
      try {
        return await analyze(source?.source ?? source, context);
      } catch {
        return errorObservation(context);
      }
    }));
  }

  function setInputs({ identitySources = [], uploadedTemplateSources = [], catalogTemplateSources = [] } = {}) {
    const activeRevision = ++revision;
    state = {
      revision,
      status: 'analyzing',
      identityObservations: [],
      uploadedTemplateObservations: [],
      catalogTemplateObservations: [],
      catalogTemplateUids: catalogTemplateSources.map((item) => String(item?.uid || '')),
      match: null,
    };
    pending = Promise.all([
      analyzeGroup(identitySources, 'identity'),
      analyzeGroup(uploadedTemplateSources, 'uploaded_template'),
      analyzeGroup(catalogTemplateSources, 'catalog_template'),
    ]).then(([identityObservations, uploadedTemplateObservations, catalogTemplateObservations]) => {
      if (activeRevision !== revision) return getState();
      const templateObservation = uploadedTemplateObservations[0] || catalogTemplateObservations[0] || null;
      state = {
        revision,
        status: 'ready',
        identityObservations,
        uploadedTemplateObservations,
        catalogTemplateObservations,
        catalogTemplateUids: catalogTemplateSources.map((item) => String(item?.uid || '')),
        match: recommendIdentityPose(identityObservations, templateObservation),
      };
      return getState();
    });
    return pending;
  }

  function overridePrimary(sourceIndex) {
    const requested = Number(sourceIndex);
    if (!state.identityObservations.some((item) => Number(item.source_index) === requested)) {
      throw new RangeError('Selected primary identity does not exist');
    }
    const automatic = state.match?.recommended_identity_source_index;
    state.match = {
      ...(state.match || {
        schema_version: FACE_ANGLE_MATCH_SCHEMA_VERSION,
        state: 'manual_required',
        template_source_kind: null,
        template_source_index: null,
        recommended_identity_source_index: null,
        match_score: null,
        distance: null,
      }),
      final_identity_source_index: requested,
      selection_mode: automatic == null ? 'manual_fallback' : (Number(automatic) === requested ? 'automatic' : 'manual_override'),
      reason: automatic == null ? 'operator_manual_fallback' : (Number(automatic) === requested ? 'closest_reliable_pose' : 'operator_override'),
    };
    return getState();
  }

  async function prepareSubmission(identityFiles = []) {
    await pending;
    let match = state.match;
    if (!match) throw new Error('Face-angle analysis has not run');
    if (match.final_identity_source_index == null) {
      if (identityFiles.length !== 1) {
        const error = new Error('请先选择一张主身份图。');
        error.code = 'manual_primary_required';
        throw error;
      }
      const sourceIndex = Number(state.identityObservations[0]?.source_index ?? 0);
      match = {
        ...match,
        final_identity_source_index: sourceIndex,
        selection_mode: 'manual_fallback',
        reason: 'single_identity_fallback',
      };
      state.match = match;
    }
    const reordered = reorderPrimaryIdentity(identityFiles, state.identityObservations, match.final_identity_source_index);
    const catalogTemplateObservations = {};
    state.catalogTemplateObservations.forEach((observation, index) => {
      const uid = state.catalogTemplateUids[index];
      if (uid) catalogTemplateObservations[uid] = observation;
    });
    return {
      files: reordered.files,
      identityObservations: reordered.observations,
      uploadedTemplateObservations: structuredClone(state.uploadedTemplateObservations),
      catalogTemplateObservations,
      match: structuredClone(match),
    };
  }

  return {
    setInputs,
    getState,
    overridePrimary,
    prepareSubmission,
    waitForCurrentAnalysis: () => pending,
  };
}
