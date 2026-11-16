import { createHash } from 'node:crypto';
import { REVIEW_DIAGNOSTICS } from '../rubric.mjs';

export const REVIEW_SUGGESTION_VERSION = 'ai-img-gen.review-suggestion.v1';
export const HUMAN_REVIEW_CORRECTION_VERSION = 'ai-img-gen.human-review-correction.v1';
export const APPEND_ONLY_EVENT_VERSION = 'ai-img-gen.append-only-event.v1';

export const REVIEW_RECOMMENDED_ACTIONS = Object.freeze([
  'human_review_required',
  'discard',
  'revise_realism',
  'revise_style_prompt',
  'inspect_diagnostics',
  'eligible_for_human_preference',
]);

const SCORE_FIELDS = Object.freeze([
  'face_identity_fidelity',
  'realism_naturalness',
  'style_consistency',
]);

const REASON_FIELDS = Object.freeze([...SCORE_FIELDS, 'diagnostics']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  if (value === undefined) return null;
  return value;
}

export function hashCanonicalValue(value) {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) throw new Error('Cannot hash an undefined canonical value');
  return createHash('sha256').update(serialized).digest('hex');
}

export function buildIdempotencyKey(namespace, value) {
  const normalizedNamespace = requireText(namespace, 'idempotency namespace');
  return `${normalizedNamespace}:${hashCanonicalValue(value)}`;
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requireVersion(value, field) {
  return requireText(value, field);
}

function normalizeSchemaVersion(input, expected) {
  if (input !== undefined && input !== expected) {
    throw new Error(`schema_version must be ${expected}`);
  }
  return expected;
}

function normalizeScore(value, field) {
  if (value === undefined || value === null || value === '') throw new Error(`${field} is required`);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) {
    throw new Error(`${field} must be a finite number between 0.0 and 10.0`);
  }
  if (Math.abs(value * 10 - Math.round(value * 10)) > 1e-9) {
    throw new Error(`${field} must use at most one decimal place`);
  }
  return Math.round(value * 10) / 10;
}

function normalizeConfidence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('confidence must be a finite number between 0 and 1');
  }
  return value;
}

function normalizeHash(value, field) {
  const hash = requireText(value, field).toLowerCase();
  if (!SHA256_PATTERN.test(hash)) throw new Error(`${field} must be a 64-character SHA-256 hash`);
  return hash;
}

function normalizeDiagnostics(values, label = 'diagnostic_codes') {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const selected = new Set();
  for (const value of values) {
    const code = requireText(value, `${label} entry`);
    if (!REVIEW_DIAGNOSTICS.has(code)) throw new Error(`Unknown diagnostic code: ${code}`);
    selected.add(code);
  }
  return [...REVIEW_DIAGNOSTICS.keys()].filter((code) => selected.has(code));
}

function normalizeReasons(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('reasons is required and must be an object');
  return Object.fromEntries(REASON_FIELDS.map((field) => [
    field,
    requireText(value[field], `reasons.${field}`),
  ]));
}

function normalizeRecommendedAction(value) {
  const action = requireText(value, 'recommended_action');
  if (!REVIEW_RECOMMENDED_ACTIONS.includes(action)) {
    throw new Error(`recommended_action must be one of: ${REVIEW_RECOMMENDED_ACTIONS.join(', ')}`);
  }
  return action;
}

function suggestionIdentitySource(suggestion) {
  return {
    provider_id: suggestion.provider_id,
    provider_version: suggestion.provider_version,
    model_id: suggestion.model_id,
    model_version: suggestion.model_version,
    adapter_version: suggestion.adapter_version,
    prompt_version: suggestion.prompt_version,
    input_sha256: suggestion.input_sha256,
    output_sha256: suggestion.output_sha256,
    face_identity_fidelity: suggestion.face_identity_fidelity,
    realism_naturalness: suggestion.realism_naturalness,
    style_consistency: suggestion.style_consistency,
    diagnostic_codes: suggestion.diagnostic_codes,
    reasons: suggestion.reasons,
    confidence: suggestion.confidence,
    recommended_action: suggestion.recommended_action,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function normalizeReviewSuggestion(input = {}) {
  normalizeSchemaVersion(input.schema_version, REVIEW_SUGGESTION_VERSION);
  if (input.status !== undefined && input.status !== 'suggested') {
    throw new Error('ReviewSuggestion status must remain suggested');
  }

  const normalized = {
    schema_version: REVIEW_SUGGESTION_VERSION,
    provider_id: requireText(input.provider_id, 'provider_id'),
    provider_version: requireVersion(input.provider_version, 'provider_version'),
    model_id: requireText(input.model_id, 'model_id'),
    model_version: requireVersion(input.model_version, 'model_version'),
    adapter_version: requireVersion(input.adapter_version, 'adapter_version'),
    prompt_version: requireVersion(input.prompt_version, 'prompt_version'),
    input_sha256: normalizeHash(input.input_sha256, 'input_sha256'),
    output_sha256: normalizeHash(input.output_sha256, 'output_sha256'),
    face_identity_fidelity: normalizeScore(input.face_identity_fidelity, 'face_identity_fidelity'),
    realism_naturalness: normalizeScore(input.realism_naturalness, 'realism_naturalness'),
    style_consistency: normalizeScore(input.style_consistency, 'style_consistency'),
    diagnostic_codes: normalizeDiagnostics(input.diagnostic_codes),
    reasons: normalizeReasons(input.reasons),
    confidence: normalizeConfidence(input.confidence),
    recommended_action: normalizeRecommendedAction(input.recommended_action),
    status: 'suggested',
  };
  const expectedId = `review-suggestion_${hashCanonicalValue(suggestionIdentitySource(normalized)).slice(0, 24)}`;
  if (input.suggestion_id !== undefined && input.suggestion_id !== expectedId) {
    throw new Error(`suggestion_id does not match the deterministic ReviewSuggestion identity: expected ${expectedId}`);
  }
  return deepFreeze({ ...normalized, suggestion_id: expectedId });
}

function normalizeOccurredAt(value) {
  const date = value === undefined ? new Date(0) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('occurredAt must be a valid timestamp');
  return date.toISOString();
}

export function buildAppendOnlyEvent({
  eventType,
  payload,
  idempotencySource = payload,
  occurredAt,
}) {
  const normalizedType = requireText(eventType, 'eventType');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('event payload must be an object');
  }
  const idempotencyKey = buildIdempotencyKey(normalizedType, idempotencySource);
  const eventBase = {
    schema_version: APPEND_ONLY_EVENT_VERSION,
    event_id: `event_${hashCanonicalValue(idempotencyKey).slice(0, 24)}`,
    event_type: normalizedType,
    occurred_at: normalizeOccurredAt(occurredAt),
    idempotency_key: idempotencyKey,
    payload: structuredClone(payload),
  };
  return deepFreeze({
    ...eventBase,
    event_sha256: hashCanonicalValue(eventBase),
  });
}

export function buildReviewSuggestionEvent(input, { occurredAt } = {}) {
  const suggestion = normalizeReviewSuggestion(input);
  return buildAppendOnlyEvent({
    eventType: 'review_suggestion.created',
    payload: suggestion,
    idempotencySource: {
      suggestion_id: suggestion.suggestion_id,
      input_sha256: suggestion.input_sha256,
      output_sha256: suggestion.output_sha256,
    },
    occurredAt,
  });
}

function normalizeHumanReviewEvent(input = {}) {
  const eventId = input.event_id ?? input.review_event_id ?? input.id;
  return {
    event_id: requireText(eventId, 'human review event_id'),
    face_identity_fidelity: normalizeScore(input.face_identity_fidelity, 'humanReviewEvent.face_identity_fidelity'),
    realism_naturalness: normalizeScore(input.realism_naturalness, 'humanReviewEvent.realism_naturalness'),
    style_consistency: normalizeScore(input.style_consistency, 'humanReviewEvent.style_consistency'),
    diagnostic_codes: normalizeDiagnostics(input.diagnostic_codes, 'humanReviewEvent.diagnostic_codes'),
  };
}

function numericDelta(suggested, human) {
  const delta = Math.round((human - suggested) * 10) / 10;
  return {
    suggested,
    human,
    delta,
    state: delta === 0 ? 'accepted' : 'corrected',
  };
}

function diagnosticDelta(suggested, human) {
  const suggestedSet = new Set(suggested);
  const humanSet = new Set(human);
  const added = human.filter((code) => !suggestedSet.has(code));
  const removed = suggested.filter((code) => !humanSet.has(code));
  return {
    suggested: [...suggested],
    human: [...human],
    added,
    removed,
    state: added.length || removed.length ? 'corrected' : 'accepted',
  };
}

export function buildHumanCorrection({
  suggestion: suggestionInput,
  humanReviewEvent: humanInput,
  correctionReason,
} = {}) {
  const suggestion = normalizeReviewSuggestion(suggestionInput);
  const humanReview = normalizeHumanReviewEvent(humanInput);
  const fieldDeltas = {
    face_identity_fidelity: numericDelta(suggestion.face_identity_fidelity, humanReview.face_identity_fidelity),
    realism_naturalness: numericDelta(suggestion.realism_naturalness, humanReview.realism_naturalness),
    style_consistency: numericDelta(suggestion.style_consistency, humanReview.style_consistency),
    diagnostic_codes: diagnosticDelta(suggestion.diagnostic_codes, humanReview.diagnostic_codes),
  };
  const correctionCount = Object.values(fieldDeltas).filter((field) => field.state === 'corrected').length;
  const normalizedReason = correctionReason === undefined || correctionReason === null || correctionReason === ''
    ? null
    : requireText(correctionReason, 'correctionReason');
  const identitySource = {
    suggestion_id: suggestion.suggestion_id,
    human_review_event_id: humanReview.event_id,
    field_deltas: fieldDeltas,
    correction_reason: normalizedReason,
  };
  return deepFreeze({
    schema_version: HUMAN_REVIEW_CORRECTION_VERSION,
    correction_id: `human-correction_${hashCanonicalValue(identitySource).slice(0, 24)}`,
    ...identitySource,
    has_corrections: correctionCount > 0,
    correction_count: correctionCount,
  });
}

export function buildHumanCorrectionEvent(input, { occurredAt } = {}) {
  const correction = buildHumanCorrection(input);
  return buildAppendOnlyEvent({
    eventType: 'human_review_correction.recorded',
    payload: correction,
    idempotencySource: {
      suggestion_id: correction.suggestion_id,
      human_review_event_id: correction.human_review_event_id,
    },
    occurredAt,
  });
}
