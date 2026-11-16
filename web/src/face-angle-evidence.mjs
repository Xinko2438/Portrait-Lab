const ANALYSIS_SCHEMA = 'ai-img-gen.face-angle-analysis.v1';
const OBSERVATION_SCHEMA = 'ai-img-gen.face-pose-observation.v1';
const MATCH_SCHEMA = 'ai-img-gen.face-angle-match.v1';
const observationStates = new Set(['usable', 'no_face', 'multiple_faces', 'face_too_small', 'invalid_matrix', 'timeout', 'model_unavailable', 'error']);
const reliabilities = new Set(['reliable', 'low', 'unavailable']);
const matchStates = new Set(['recommended', 'low_similarity', 'manual_required']);
const selectionModes = new Set(['automatic', 'manual_override', 'manual_fallback']);
const expressionStates = new Set(['neutral', 'slight_smile', 'smile', 'unavailable_profile', 'unavailable']);

export class FaceAngleEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FaceAngleEvidenceError';
    this.code = code;
    this.status = 400;
  }
}

function parseJson(value, fallback, label) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    throw new FaceAngleEvidenceError('face_angle_evidence_invalid_json', `${label} must be valid JSON`);
  }
}

function finiteAngle(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < -180 || number > 180) {
    throw new FaceAngleEvidenceError('face_angle_observation_invalid', `${label} must be a finite angle between -180 and 180`);
  }
  return number;
}

function validateObservation(value, expectedKind, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FaceAngleEvidenceError('face_angle_observation_invalid', `${label} must be an object`);
  }
  if (value.schema_version !== OBSERVATION_SCHEMA) {
    throw new FaceAngleEvidenceError('face_angle_observation_invalid', `${label} has an unsupported schema_version`);
  }
  if (value.source_kind !== expectedKind) {
    throw new FaceAngleEvidenceError('face_angle_observation_invalid', `${label} source_kind must be ${expectedKind}`);
  }
  if (!Number.isInteger(Number(value.source_index)) || Number(value.source_index) < 0) {
    throw new FaceAngleEvidenceError('face_angle_observation_invalid', `${label} source_index must be a non-negative integer`);
  }
  if (!observationStates.has(value.state) || !reliabilities.has(value.reliability)) {
    throw new FaceAngleEvidenceError('face_angle_observation_invalid', `${label} has an unsupported state or reliability`);
  }
  if (value.semantic_temperament != null && value.semantic_temperament !== 'not_inferred') {
    throw new FaceAngleEvidenceError('face_angle_observation_invalid', `${label} semantic temperament must remain not_inferred`);
  }
  if (value.expression != null) {
    if (typeof value.expression !== 'object' || Array.isArray(value.expression) || !expressionStates.has(value.expression.state) || !reliabilities.has(value.expression.reliability)) {
      throw new FaceAngleEvidenceError('face_angle_observation_invalid', `${label} expression is invalid`);
    }
    if (value.expression.semantic_temperament != null && value.expression.semantic_temperament !== 'not_inferred') {
      throw new FaceAngleEvidenceError('face_angle_observation_invalid', `${label} expression semantic temperament must remain not_inferred`);
    }
    for (const scoreName of ['smile_score', 'eye_closed_left', 'eye_closed_right', 'mouth_open_score']) {
      if (value.expression[scoreName] == null) continue;
      const score = Number(value.expression[scoreName]);
      if (!Number.isFinite(score) || score < 0 || score > 1) {
        throw new FaceAngleEvidenceError('face_angle_observation_invalid', `${label} expression ${scoreName} must be between 0 and 1`);
      }
    }
  }
  const usable = value.state === 'usable';
  if (usable) {
    finiteAngle(value.yaw_deg, `${label}.yaw_deg`);
    finiteAngle(value.pitch_deg, `${label}.pitch_deg`);
    finiteAngle(value.roll_deg, `${label}.roll_deg`);
    if (value.reliability !== 'reliable') {
      throw new FaceAngleEvidenceError('face_angle_observation_invalid', `${label} usable observation must be reliable`);
    }
  } else if ([value.yaw_deg, value.pitch_deg, value.roll_deg].some((angle) => angle != null && angle !== '')) {
    finiteAngle(value.yaw_deg, `${label}.yaw_deg`);
    finiteAngle(value.pitch_deg, `${label}.pitch_deg`);
    finiteAngle(value.roll_deg, `${label}.roll_deg`);
  }
  const faceCount = Number(value.face_count);
  if (!Number.isInteger(faceCount) || faceCount < 0) {
    throw new FaceAngleEvidenceError('face_angle_observation_invalid', `${label}.face_count must be a non-negative integer`);
  }
  if (value.face_coverage_ratio != null) {
    const ratio = Number(value.face_coverage_ratio);
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      throw new FaceAngleEvidenceError('face_angle_observation_invalid', `${label}.face_coverage_ratio must be between 0 and 1`);
    }
  }
  return structuredClone(value);
}

function reliableObservation(observation) {
  return observation?.state === 'usable' && observation?.reliability === 'reliable';
}

function validateMatch(value, identityObservations, templateObservations) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema_version !== MATCH_SCHEMA) {
    throw new FaceAngleEvidenceError('face_angle_match_invalid', 'face angle match has an unsupported schema_version');
  }
  if (!matchStates.has(value.state) || !selectionModes.has(value.selection_mode)) {
    throw new FaceAngleEvidenceError('face_angle_match_invalid', 'face angle match has an unsupported state or selection mode');
  }
  const sourceIndexes = new Set(identityObservations.map((item) => Number(item.source_index)));
  const finalIndex = value.final_identity_source_index;
  if (finalIndex != null && !sourceIndexes.has(Number(finalIndex))) {
    throw new FaceAngleEvidenceError('face_angle_match_invalid', 'final identity source index does not resolve to submitted evidence');
  }
  if (identityObservations.length && finalIndex != null && Number(identityObservations[0].source_index) !== Number(finalIndex)) {
    throw new FaceAngleEvidenceError('face_angle_match_order_mismatch', 'final identity must be first in the submitted identity observation order');
  }
  if (value.selection_mode === 'automatic') {
    const recommended = identityObservations.find((item) => Number(item.source_index) === Number(value.recommended_identity_source_index));
    const template = templateObservations.find((item) => reliableObservation(item));
    if (!reliableObservation(recommended) || !template) {
      throw new FaceAngleEvidenceError('face_angle_match_false_certainty', 'automatic recommendation requires reliable identity and template observations');
    }
    if (Number(value.final_identity_source_index) !== Number(value.recommended_identity_source_index)) {
      throw new FaceAngleEvidenceError('face_angle_match_invalid', 'automatic final identity must equal the recommendation');
    }
  }
  return structuredClone(value);
}

export function parseFaceAngleSubmission({
  identityRaw = '',
  uploadedTemplateRaw = '',
  catalogTemplateRaw = '',
  matchRaw = '',
  pipelineVersionRaw = '',
  identityFileCount = 0,
  uploadedTemplateCount = 0,
  catalogTemplateUids = [],
} = {}) {
  if (![identityRaw, uploadedTemplateRaw, catalogTemplateRaw, matchRaw].some((value) => value != null && value !== '')) return null;

  const identityInput = parseJson(identityRaw, [], 'identityFacePoseObservations');
  const uploadedTemplateInput = parseJson(uploadedTemplateRaw, [], 'templateFacePoseObservations');
  const catalogTemplateInput = parseJson(catalogTemplateRaw, {}, 'catalogTemplateFacePoseObservations');
  const matchInput = parseJson(matchRaw, null, 'faceAngleMatch');
  const pipelineVersion = String(pipelineVersionRaw || 'mediapipe-fast-v1');
  if (!['mediapipe-fast-v1', 'hybrid-profile-v2'].includes(pipelineVersion)) {
    throw new FaceAngleEvidenceError('face_angle_pipeline_invalid', 'face angle pipeline version is unsupported');
  }
  if (!Array.isArray(identityInput) || identityInput.length !== Number(identityFileCount)) {
    throw new FaceAngleEvidenceError('face_angle_identity_count_mismatch', 'identity observation count must match submitted identity files');
  }
  if (!Array.isArray(uploadedTemplateInput) || uploadedTemplateInput.length !== Number(uploadedTemplateCount)) {
    throw new FaceAngleEvidenceError('face_angle_template_count_mismatch', 'uploaded template observation count must match submitted template files');
  }
  if (!catalogTemplateInput || typeof catalogTemplateInput !== 'object' || Array.isArray(catalogTemplateInput)) {
    throw new FaceAngleEvidenceError('face_angle_catalog_invalid', 'catalog template observations must be an object');
  }

  const identityObservations = identityInput.map((item, index) => validateObservation(item, 'identity', `identity observation ${index}`));
  const uploadedTemplateObservations = uploadedTemplateInput.map((item, index) => validateObservation(item, 'uploaded_template', `uploaded template observation ${index}`));
  const selectedCatalog = new Set((catalogTemplateUids || []).map(String));
  const catalogTemplateObservations = {};
  for (const [uid, item] of Object.entries(catalogTemplateInput)) {
    if (!selectedCatalog.has(uid)) {
      throw new FaceAngleEvidenceError('face_angle_catalog_invalid', `catalog template observation ${uid} is not selected`);
    }
    catalogTemplateObservations[uid] = validateObservation(item, 'catalog_template', `catalog template observation ${uid}`);
  }
  const allTemplateObservations = [...uploadedTemplateObservations, ...Object.values(catalogTemplateObservations)];
  const validatedMatch = validateMatch(matchInput, identityObservations, allTemplateObservations);
  const reliableCount = identityObservations.filter(reliableObservation).length;
  const legacyCoverageSource = reliableCount === identityObservations.length && reliableCount > 0
    ? 'automatic'
    : reliableCount > 0 ? 'mixed' : 'unavailable';

  return {
    schema_version: ANALYSIS_SCHEMA,
    pipeline_version: pipelineVersion,
    identity_observations: identityObservations,
    uploaded_template_observations: uploadedTemplateObservations,
    catalog_template_observations: catalogTemplateObservations,
    match: validatedMatch,
    legacy_coverage_source: legacyCoverageSource,
  };
}
