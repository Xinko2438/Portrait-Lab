import { createHash } from 'node:crypto';

export const TEMPLATE_SELECTION_EVENT_VERSION = 'ai-img-gen.template-selection-event.v1';
export const TEMPLATE_OUTCOME_ACTIVE_PROJECTION_VERSION = 'ai-img-gen.template-outcome-active-projection.v1';
export const OUTCOME_RECORDED_EVENT_TYPE = 'TemplateSelectionOutcomeRecorded';
export const OUTCOME_INVALIDATED_EVENT_TYPE = 'TemplateSelectionOutcomeInvalidated';

const INVALIDATION_REASONS = new Set([
  'review_revised',
  'preference_revised',
  'attribution_invalidated',
]);
const PREFERENCE_RESULTS = new Set(['winner', 'eligible_not_selected', 'none', 'pending']);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,240}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REQUIRED_OUTCOME_IDS = [
  'outcome_id',
  'selection_id',
  'run_id',
  'artifact_id',
  'template_uid',
  'catalog_projection_version',
  'ranking_policy_version',
  'rubric_version',
  'reviewer_id',
  'review_session_id',
  'preference_session_id',
  'review_source_event_id',
  'preference_source_event_id',
];
const REQUIRED_HASHES = [
  'artifact_sha256',
  'reference_image_sha256',
  'generation_blueprint_sha256',
];
const REQUIRED_SCORES = ['face_consistency', 'naturalness', 'style_consistency'];

export class TemplateOutcomeLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TemplateOutcomeLifecycleError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new TemplateOutcomeLifecycleError(code, message);
}

function clone(value) {
  return structuredClone(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function requireCanonicalId(value, field, code) {
  if (typeof value !== 'string' || value !== value.trim() || !SAFE_ID.test(value)) {
    fail(code, `${field} must be a non-empty, already-trimmed safe identifier`);
  }
  return value;
}

function requireSha256(value, field, code) {
  if (typeof value !== 'string' || value !== value.trim() || !SHA256.test(value)) {
    fail(code, `${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireTimestamp(value, field, code) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) fail(code, `${field} must be canonical UTC ISO-8601`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail(code, `${field} must be canonical UTC ISO-8601`);
  }
  return value;
}

function requireScore(value, field, code) {
  if (typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || value > 10
    || Math.abs(value * 10 - Math.round(value * 10)) > 1e-9) {
    fail(code, `${field} must be a numeric 0.0-10.0 score with one decimal place`);
  }
  return value;
}

function validateEnvelope(event, type, code) {
  if (!plainObject(event)) fail(code, 'Event must be an object');
  if (event.schema_version !== TEMPLATE_SELECTION_EVENT_VERSION) fail(code, 'Event schema version is invalid');
  if (event.type !== type) fail(code, `Event type must be ${type}`);
  requireCanonicalId(event.event_id, 'event_id', code);
  requireCanonicalId(event.idempotency_key, 'idempotency_key', code);
  requireCanonicalId(event.selection_id, 'selection_id', code);
  requireTimestamp(event.recorded_at, 'recorded_at', code);
  if (!plainObject(event.data)) fail(code, 'Event data must be an object');
}

function validateOutcome(outcome, selectionId, data, code) {
  if (!plainObject(outcome)) fail(code, 'Outcome must be an object');
  for (const field of REQUIRED_OUTCOME_IDS) requireCanonicalId(outcome[field], field, code);
  for (const field of REQUIRED_HASHES) requireSha256(outcome[field], field, code);
  if (outcome.selection_id !== selectionId) fail(code, 'Outcome selection_id conflicts with its event');
  if (data.review_source_event_id !== outcome.review_source_event_id
    || data.preference_source_event_id !== outcome.preference_source_event_id) {
    fail(code, 'Outcome source evidence conflicts with its event data');
  }
  if (!plainObject(outcome.scores)) fail(code, 'Outcome scores must be an object');
  for (const field of REQUIRED_SCORES) requireScore(outcome.scores[field], field, code);
  if (!PREFERENCE_RESULTS.has(outcome.preference_result)) fail(code, 'preference_result is invalid');
  if (typeof outcome.excluded_from_learning !== 'boolean') {
    fail(code, 'excluded_from_learning must be a boolean');
  }
  if (outcome.utility_score !== undefined) requireScore(outcome.utility_score, 'utility_score', code);
  if (outcome.supersedes_outcome_id !== undefined) {
    requireCanonicalId(outcome.supersedes_outcome_id, 'supersedes_outcome_id', code);
    if (outcome.supersedes_outcome_id === outcome.outcome_id) fail(code, 'An Outcome cannot supersede itself');
  }
}

export function validateTemplateSelectionOutcomeRecorded(event) {
  const code = 'invalid_outcome_record';
  validateEnvelope(event, OUTCOME_RECORDED_EVENT_TYPE, code);
  requireCanonicalId(event.data.review_source_event_id, 'review_source_event_id', code);
  requireCanonicalId(event.data.preference_source_event_id, 'preference_source_event_id', code);
  validateOutcome(event.data.outcome, event.selection_id, event.data, code);
  return clone(event);
}

export function validateTemplateSelectionOutcomeInvalidated(event) {
  const code = 'invalid_outcome_invalidation';
  validateEnvelope(event, OUTCOME_INVALIDATED_EVENT_TYPE, code);
  const invalidation = event.data.invalidation;
  if (!plainObject(invalidation)) fail(code, 'Invalidation data is required');
  for (const field of [
    'invalidation_id',
    'selection_id',
    'outcome_id',
    'artifact_id',
    'review_source_event_id',
    'preference_source_event_id',
  ]) requireCanonicalId(invalidation[field], field, code);
  if (!INVALIDATION_REASONS.has(invalidation.reason)) fail(code, 'Invalidation reason is invalid');
  requireTimestamp(invalidation.recorded_at, 'invalidation.recorded_at', code);
  if (invalidation.selection_id !== event.selection_id) fail(code, 'Invalidation selection conflicts with its event');
  if (invalidation.recorded_at !== event.recorded_at) fail(code, 'Invalidation timestamp conflicts with its event');
  return clone(event);
}

export function createTemplateSelectionOutcomeRecorded({
  selection_id: selectionId,
  review_source_event_id: reviewSourceEventId,
  preference_source_event_id: preferenceSourceEventId,
  recorded_at: recordedAt,
  outcome,
} = {}) {
  const code = 'invalid_outcome_record';
  requireCanonicalId(selectionId, 'selection_id', code);
  requireCanonicalId(reviewSourceEventId, 'review_source_event_id', code);
  requireCanonicalId(preferenceSourceEventId, 'preference_source_event_id', code);
  requireTimestamp(recordedAt, 'recorded_at', code);
  if (!plainObject(outcome)) fail(code, 'Outcome must be an object');
  const storedOutcome = {
    ...clone(outcome),
    selection_id: outcome.selection_id ?? selectionId,
    review_source_event_id: outcome.review_source_event_id ?? reviewSourceEventId,
    preference_source_event_id: outcome.preference_source_event_id ?? preferenceSourceEventId,
  };
  if (storedOutcome.outcome_id == null || storedOutcome.outcome_id === '') {
    const identity = {
      selection_id: selectionId,
      review_source_event_id: reviewSourceEventId,
      preference_source_event_id: preferenceSourceEventId,
      outcome: Object.fromEntries(Object.entries(storedOutcome).filter(([key]) => key !== 'outcome_id')),
    };
    storedOutcome.outcome_id = `out_${sha256(stableJson(identity)).slice(0, 24)}`;
  }
  const logical = {
    selection_id: selectionId,
    review_source_event_id: reviewSourceEventId,
    preference_source_event_id: preferenceSourceEventId,
    artifact_id: storedOutcome.artifact_id,
    outcome: storedOutcome,
  };
  const logicalHash = sha256(stableJson(logical));
  const eventHash = sha256(stableJson({ logical, recorded_at: recordedAt }));
  return validateTemplateSelectionOutcomeRecorded({
    schema_version: TEMPLATE_SELECTION_EVENT_VERSION,
    event_id: `evt_${eventHash.slice(0, 24)}`,
    selection_id: selectionId,
    type: OUTCOME_RECORDED_EVENT_TYPE,
    recorded_at: recordedAt,
    idempotency_key: `${selectionId}:outcome:${logicalHash.slice(0, 24)}`,
    data: {
      outcome: storedOutcome,
      review_source_event_id: reviewSourceEventId,
      preference_source_event_id: preferenceSourceEventId,
    },
  });
}

export function createTemplateSelectionOutcomeInvalidated({
  selection_id: selectionId,
  outcome_id: outcomeId,
  artifact_id: artifactId,
  reason,
  review_source_event_id: reviewSourceEventId,
  preference_source_event_id: preferenceSourceEventId,
  recorded_at: recordedAt,
} = {}) {
  const code = 'invalid_outcome_invalidation';
  for (const [field, value] of [
    ['selection_id', selectionId],
    ['outcome_id', outcomeId],
    ['artifact_id', artifactId],
    ['review_source_event_id', reviewSourceEventId],
    ['preference_source_event_id', preferenceSourceEventId],
  ]) requireCanonicalId(value, field, code);
  if (!INVALIDATION_REASONS.has(reason)) fail(code, 'Invalidation reason is invalid');
  requireTimestamp(recordedAt, 'recorded_at', code);
  const logical = {
    selection_id: selectionId,
    outcome_id: outcomeId,
    artifact_id: artifactId,
    reason,
    review_source_event_id: reviewSourceEventId,
    preference_source_event_id: preferenceSourceEventId,
  };
  const logicalHash = sha256(stableJson(logical));
  const eventHash = sha256(stableJson({ logical, recorded_at: recordedAt }));
  return validateTemplateSelectionOutcomeInvalidated({
    schema_version: TEMPLATE_SELECTION_EVENT_VERSION,
    event_id: `evt_${eventHash.slice(0, 24)}`,
    selection_id: selectionId,
    type: OUTCOME_INVALIDATED_EVENT_TYPE,
    recorded_at: recordedAt,
    idempotency_key: `${selectionId}:outcome-invalidation:${logicalHash.slice(0, 24)}`,
    data: {
      invalidation: {
        invalidation_id: `outinval_${logicalHash.slice(0, 24)}`,
        selection_id: selectionId,
        outcome_id: outcomeId,
        artifact_id: artifactId,
        reason,
        review_source_event_id: reviewSourceEventId,
        preference_source_event_id: preferenceSourceEventId,
        recorded_at: recordedAt,
      },
    },
  });
}

function withoutTimestamps(event) {
  if (event.type === OUTCOME_RECORDED_EVENT_TYPE) {
    return { selection_id: event.selection_id, type: event.type, data: event.data };
  }
  const invalidation = { ...event.data.invalidation };
  delete invalidation.recorded_at;
  return { selection_id: event.selection_id, type: event.type, data: { invalidation } };
}

function logicalKey(event) {
  if (event.type === OUTCOME_RECORDED_EVENT_TYPE) {
    const outcome = event.data.outcome;
    return stableJson({
      type: event.type,
      selection_id: event.selection_id,
      artifact_id: outcome.artifact_id,
      review_source_event_id: outcome.review_source_event_id,
      preference_source_event_id: outcome.preference_source_event_id,
    });
  }
  const invalidation = event.data.invalidation;
  return stableJson({
    type: event.type,
    selection_id: event.selection_id,
    outcome_id: invalidation.outcome_id,
    artifact_id: invalidation.artifact_id,
    review_source_event_id: invalidation.review_source_event_id,
    preference_source_event_id: invalidation.preference_source_event_id,
  });
}

function eventSort(left, right) {
  const time = left.recorded_at.localeCompare(right.recorded_at);
  if (time) return time;
  const type = left.type.localeCompare(right.type);
  if (type) return type;
  const selection = left.selection_id.localeCompare(right.selection_id);
  if (selection) return selection;
  return left.event_id.localeCompare(right.event_id);
}

function chooseCanonicalEvent(left, right) {
  return eventSort(left, right) <= 0 ? left : right;
}

function identityKey(outcome) {
  return [outcome.selection_id, outcome.run_id, outcome.artifact_id, outcome.template_uid].join('\u0000');
}

function sameIdentity(left, right) {
  return identityKey(left) === identityKey(right);
}

function validateAndDedupe(events) {
  const eventIds = new Map();
  const idempotencyKeys = new Map();
  const outcomeIds = new Map();
  const invalidationIds = new Map();
  const logical = new Map();
  let replayCount = 0;

  for (const source of events) {
    if (source?.type !== OUTCOME_RECORDED_EVENT_TYPE && source?.type !== OUTCOME_INVALIDATED_EVENT_TYPE) continue;
    const event = source.type === OUTCOME_RECORDED_EVENT_TYPE
      ? validateTemplateSelectionOutcomeRecorded(source)
      : validateTemplateSelectionOutcomeInvalidated(source);
    const businessHash = sha256(stableJson(withoutTimestamps(event)));
    const envelopeHash = sha256(stableJson(event));
    if (eventIds.has(event.event_id) && eventIds.get(event.event_id) !== envelopeHash) {
      fail('event_identity_conflict', `Conflicting event identity: ${event.event_id}`);
    }
    eventIds.set(event.event_id, envelopeHash);
    if (idempotencyKeys.has(event.idempotency_key)
      && idempotencyKeys.get(event.idempotency_key) !== businessHash) {
      fail('idempotency_conflict', `Conflicting event identity: ${event.idempotency_key}`);
    }
    idempotencyKeys.set(event.idempotency_key, businessHash);

    if (event.type === OUTCOME_RECORDED_EVENT_TYPE) {
      const outcome = event.data.outcome;
      const outcomeHash = sha256(stableJson(outcome));
      if (outcomeIds.has(outcome.outcome_id) && outcomeIds.get(outcome.outcome_id) !== outcomeHash) {
        fail('outcome_identity_conflict', `Outcome identity conflicts: ${outcome.outcome_id}`);
      }
      outcomeIds.set(outcome.outcome_id, outcomeHash);
    } else {
      const invalidation = event.data.invalidation;
      const invalidationHash = sha256(stableJson(withoutTimestamps(event).data.invalidation));
      if (invalidationIds.has(invalidation.invalidation_id)
        && invalidationIds.get(invalidation.invalidation_id) !== invalidationHash) {
        fail('invalidation_identity_conflict', `Invalidation identity conflicts: ${invalidation.invalidation_id}`);
      }
      invalidationIds.set(invalidation.invalidation_id, invalidationHash);
    }

    const key = logicalKey(event);
    const payloadHash = sha256(stableJson(withoutTimestamps(event)));
    if (logical.has(key)) {
      const existing = logical.get(key);
      if (existing.payload_hash !== payloadHash) fail('source_evidence_conflict', 'Source evidence conflicts for the same target');
      existing.event = chooseCanonicalEvent(existing.event, event);
      replayCount += 1;
    } else {
      logical.set(key, { payload_hash: payloadHash, event });
    }
  }
  return {
    events: [...logical.values()].map((item) => item.event).sort(eventSort),
    replay_count: replayCount,
  };
}

export function projectActiveTemplateOutcomes(events = []) {
  if (!Array.isArray(events)) fail('invalid_outcome_event_stream', 'Outcome event stream must be an array');
  const deduped = validateAndDedupe(events);
  const recordedEvents = deduped.events.filter((event) => event.type === OUTCOME_RECORDED_EVENT_TYPE);
  const invalidationEvents = deduped.events.filter((event) => event.type === OUTCOME_INVALIDATED_EVENT_TYPE);
  const outcomeById = new Map(recordedEvents.map((event) => [event.data.outcome.outcome_id, event.data.outcome]));
  const invalidationsByOutcome = new Map();

  for (const event of invalidationEvents) {
    const invalidation = event.data.invalidation;
    const target = outcomeById.get(invalidation.outcome_id);
    if (!target) fail('stale_invalidation', `Invalidation target does not exist: ${invalidation.outcome_id}`);
    if (target.selection_id !== invalidation.selection_id || target.artifact_id !== invalidation.artifact_id) {
      fail('invalidation_identity_conflict', 'Invalidation target identity conflicts with its Outcome');
    }
    if (!invalidationsByOutcome.has(invalidation.outcome_id)) invalidationsByOutcome.set(invalidation.outcome_id, []);
    invalidationsByOutcome.get(invalidation.outcome_id).push(event);
  }
  for (const list of invalidationsByOutcome.values()) list.sort(eventSort);

  const childByOutcome = new Map();
  const groups = new Map();
  for (const outcome of outcomeById.values()) {
    const key = identityKey(outcome);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(outcome);
  }
  for (const outcome of outcomeById.values()) {
    if (outcome.supersedes_outcome_id === undefined) continue;
    const prior = outcomeById.get(outcome.supersedes_outcome_id);
    if (!prior) fail('stale_supersession', `Superseded Outcome does not exist: ${outcome.supersedes_outcome_id}`);
    if (!sameIdentity(prior, outcome)) {
      fail('supersession_identity_conflict', 'Replacement Outcome does not match the intended prior identity');
    }
    if (!invalidationsByOutcome.has(prior.outcome_id)) {
      fail('invalid_supersession', `Superseded Outcome is not invalidated: ${prior.outcome_id}`);
    }
    if (childByOutcome.has(prior.outcome_id) && childByOutcome.get(prior.outcome_id) !== outcome.outcome_id) {
      fail('stale_supersession', `Superseded Outcome already has a replacement: ${prior.outcome_id}`);
    }
    childByOutcome.set(prior.outcome_id, outcome.outcome_id);
  }

  const orderedOutcomes = [];
  for (const key of [...groups.keys()].sort()) {
    const nodes = groups.get(key);
    const roots = nodes.filter((outcome) => outcome.supersedes_outcome_id === undefined);
    if (roots.length !== 1) {
      fail('implicit_outcome_replacement', 'Same-identity Outcomes require one explicit invalidation and supersession chain');
    }
    const seen = new Set();
    let current = roots[0];
    while (current) {
      if (seen.has(current.outcome_id)) fail('supersession_cycle', 'Outcome supersession graph contains a cycle');
      seen.add(current.outcome_id);
      orderedOutcomes.push(current);
      current = outcomeById.get(childByOutcome.get(current.outcome_id));
    }
    if (seen.size !== nodes.length) {
      fail('implicit_outcome_replacement', 'Same-identity Outcomes are not one explicit supersession chain');
    }
  }

  const outcomeHistory = orderedOutcomes.map((outcome) => {
    const outcomeId = outcome.outcome_id;
    const child = childByOutcome.get(outcomeId) || null;
    const invalidations = invalidationsByOutcome.get(outcomeId) || [];
    return {
      ...clone(outcome),
      lifecycle_state: child ? 'superseded' : invalidations.length ? 'invalidated' : 'active',
      invalidation_ids: invalidations.map((event) => event.data.invalidation.invalidation_id),
      superseded_by_outcome_id: child,
    };
  });

  return {
    schema_version: TEMPLATE_OUTCOME_ACTIVE_PROJECTION_VERSION,
    event_history: deduped.events,
    outcome_history: outcomeHistory,
    active_outcomes: outcomeHistory
      .filter((item) => item.lifecycle_state === 'active')
      .map(({ lifecycle_state, invalidation_ids, superseded_by_outcome_id, ...item }) => item),
    invalidations: invalidationEvents,
    replay_count: deduped.replay_count,
  };
}
