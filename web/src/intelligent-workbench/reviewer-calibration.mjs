import { hashCanonicalValue } from './review-suggestion.mjs';

export const CALIBRATION_ANCHOR_SET_VERSION = 'ai-img-gen.calibration-anchor-set.v1';
export const REVIEWER_CALIBRATION_SESSION_VERSION = 'ai-img-gen.reviewer-calibration-session.v1';
export const REVIEWER_CALIBRATION_PROJECTION_VERSION = 'ai-img-gen.reviewer-calibration-projection.v1';

export const REVIEWER_CALIBRATION_EVENT_VERSION = 'ai-img-gen.reviewer-calibration-event.v1';

const SCORE_FIELDS = Object.freeze([
  'face_identity_fidelity',
  'realism_naturalness',
  'style_consistency',
]);
const SOURCE_SCOPES = new Set(['global_identity_neutral', 'non_customer_authorized']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export class ReviewerCalibrationError extends Error {
  constructor(code, message, { status = 400 } = {}) {
    super(message);
    this.name = 'ReviewerCalibrationError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, options) {
  throw new ReviewerCalibrationError(code, message, options);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_calibration_evidence', `${label} must be an object`);
  }
  return value;
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('invalid_calibration_evidence', `${label} is required`);
  }
  return value.trim();
}

function normalizeTimestamp(value, label) {
  const date = new Date(value);
  if (value === undefined || value === null || value === '' || Number.isNaN(date.getTime())) {
    fail('invalid_calibration_evidence', `${label} must be a valid timestamp`);
  }
  return date.toISOString();
}

function normalizePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    fail('invalid_calibration_evidence', `${label} must be a positive integer`);
  }
  return value;
}

function normalizeScore(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) {
    fail('invalid_calibration_evidence', `${label} must be a finite number between 0.0 and 10.0`);
  }
  if (Math.abs(value * 10 - Math.round(value * 10)) > 1e-9) {
    fail('invalid_calibration_evidence', `${label} must use at most one decimal place`);
  }
  return Math.round(value * 10) / 10;
}

function normalizeScores(value, label) {
  const source = requireObject(value, label);
  return Object.fromEntries(SCORE_FIELDS.map((field) => [
    field,
    normalizeScore(source[field], `${label}.${field}`),
  ]));
}

function normalizeSha256(value, label) {
  const hash = requireText(value, label).toLowerCase();
  if (!SHA256_PATTERN.test(hash)) {
    fail('invalid_calibration_evidence', `${label} must be a 64-character SHA-256 hash`);
  }
  return hash;
}

function assertNoCustomerScope(value, path = 'anchor set') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    const hasCustomerIdentity = ['customer_id', 'customer_scope_id', 'customer_identity_set_id'].includes(normalizedKey)
      && child !== undefined && child !== null && child !== '';
    const explicitlyCustomerScoped = normalizedKey === 'customer_scoped' && child === true;
    if (hasCustomerIdentity || explicitlyCustomerScoped) {
      fail('customer_scoped_anchor_rejected', `${path}.${key} contains customer-scoped identity evidence`);
    }
    assertNoCustomerScope(child, `${path}.${key}`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function verifyProvidedIdentity(provided, expected, label) {
  if (provided !== undefined && provided !== expected) {
    fail('invalid_calibration_evidence', `${label} does not match deterministic content identity: expected ${expected}`);
  }
}

function normalizeAnchor(anchorInput, index) {
  const anchor = requireObject(anchorInput, `anchors[${index}]`);
  assertNoCustomerScope(anchor, `anchors[${index}]`);
  const sourceScope = requireText(anchor.source_scope, `anchors[${index}].source_scope`);
  if (!SOURCE_SCOPES.has(sourceScope)) {
    fail(
      'customer_scoped_anchor_rejected',
      `anchors[${index}].source_scope must be global_identity_neutral or non_customer_authorized`,
    );
  }
  return {
    anchor_id: requireText(anchor.anchor_id, `anchors[${index}].anchor_id`),
    asset_sha256: normalizeSha256(anchor.asset_sha256, `anchors[${index}].asset_sha256`),
    source_scope: sourceScope,
    baseline_scores: normalizeScores(anchor.baseline_scores, `anchors[${index}].baseline_scores`),
  };
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail('invalid_calibration_evidence', `duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

export function normalizeCalibrationAnchorSet(input = {}) {
  const source = requireObject(input, 'anchor set');
  assertNoCustomerScope(source);
  if (source.schema_version !== undefined && source.schema_version !== CALIBRATION_ANCHOR_SET_VERSION) {
    fail('invalid_calibration_evidence', `schema_version must be ${CALIBRATION_ANCHOR_SET_VERSION}`);
  }
  if (!Array.isArray(source.anchors) || source.anchors.length < 3) {
    fail('invalid_calibration_evidence', 'anchor set must contain at least 3 anchors');
  }

  const anchors = source.anchors.map(normalizeAnchor)
    .sort((left, right) => left.anchor_id.localeCompare(right.anchor_id));
  assertUnique(anchors.map((anchor) => anchor.anchor_id), 'anchor_id');
  assertUnique(anchors.map((anchor) => anchor.asset_sha256), 'asset_sha256');

  const approvalInput = requireObject(source.approval, 'approval');
  const approval = {
    approved_by: requireText(approvalInput.approved_by, 'approval.approved_by'),
    approved_at: normalizeTimestamp(approvalInput.approved_at, 'approval.approved_at'),
    note: approvalInput.note === undefined || approvalInput.note === null || approvalInput.note === ''
      ? null
      : requireText(approvalInput.note, 'approval.note'),
  };
  const createdAt = normalizeTimestamp(source.created_at ?? approval.approved_at, 'created_at');
  const identitySource = {
    version: normalizePositiveInteger(source.version, 'version'),
    rubric_version: requireText(source.rubric_version, 'rubric_version'),
    anchors,
    approval,
    created_at: createdAt,
  };
  const anchorSetId = `calibration-anchor-set_${hashCanonicalValue(identitySource).slice(0, 24)}`;
  verifyProvidedIdentity(source.anchor_set_id, anchorSetId, 'anchor_set_id');
  return deepFreeze({
    schema_version: CALIBRATION_ANCHOR_SET_VERSION,
    anchor_set_id: anchorSetId,
    ...identitySource,
  });
}

function normalizeEventTime(value, fallback) {
  return normalizeTimestamp(value ?? fallback, 'occurredAt');
}

function buildCalibrationEvent(type, data, identitySource, occurredAt, fallbackTime) {
  const idempotencyKey = `${type}:${hashCanonicalValue(identitySource)}`;
  return deepFreeze({
    schema_version: REVIEWER_CALIBRATION_EVENT_VERSION,
    event_id: `reviewer-calibration-event_${hashCanonicalValue(idempotencyKey).slice(0, 24)}`,
    type,
    occurred_at: normalizeEventTime(occurredAt, fallbackTime),
    idempotency_key: idempotencyKey,
    data,
  });
}

export function buildCalibrationAnchorSetEvent(input, { occurredAt } = {}) {
  const anchorSet = normalizeCalibrationAnchorSet(input);
  return buildCalibrationEvent(
    'CalibrationAnchorSetDefined',
    { anchor_set: anchorSet },
    { anchor_set_id: anchorSet.anchor_set_id, version: anchorSet.version },
    occurredAt,
    anchorSet.created_at,
  );
}

function absoluteDeviation(actual, baseline) {
  return Math.abs(Math.round(actual * 10) - Math.round(baseline * 10)) / 10;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function normalizeRating(ratingInput, index) {
  const rating = requireObject(ratingInput, `ratings[${index}]`);
  return {
    anchor_id: requireText(rating.anchor_id, `ratings[${index}].anchor_id`),
    scores: normalizeScores(rating.scores, `ratings[${index}].scores`),
  };
}

function requireMatching(value, expected, label) {
  if (value !== expected) {
    fail('invalid_calibration_evidence', `${label} must match the active anchor set`);
  }
  return value;
}

export function normalizeReviewerCalibrationSession(input = {}, { anchorSet: anchorSetInput } = {}) {
  const source = requireObject(input, 'reviewer calibration session');
  if (source.schema_version !== undefined && source.schema_version !== REVIEWER_CALIBRATION_SESSION_VERSION) {
    fail('invalid_calibration_evidence', `schema_version must be ${REVIEWER_CALIBRATION_SESSION_VERSION}`);
  }
  const anchorSet = normalizeCalibrationAnchorSet(anchorSetInput);
  const ratingsInput = source.ratings;
  if (!Array.isArray(ratingsInput) || ratingsInput.length !== anchorSet.anchors.length) {
    fail('invalid_calibration_evidence', 'ratings must contain exactly one rating for every anchor');
  }
  const ratings = ratingsInput.map(normalizeRating)
    .sort((left, right) => left.anchor_id.localeCompare(right.anchor_id));
  assertUnique(ratings.map((rating) => rating.anchor_id), 'anchor_id');
  const expectedIds = anchorSet.anchors.map((anchor) => anchor.anchor_id);
  if (ratings.some((rating, index) => rating.anchor_id !== expectedIds[index])) {
    fail('invalid_calibration_evidence', 'ratings must contain exactly one rating for every anchor');
  }

  const anchorById = new Map(anchorSet.anchors.map((anchor) => [anchor.anchor_id, anchor]));
  const deviations = ratings.map((rating) => {
    const baseline = anchorById.get(rating.anchor_id).baseline_scores;
    return {
      anchor_id: rating.anchor_id,
      absolute_deviation: Object.fromEntries(SCORE_FIELDS.map((field) => [
        field,
        absoluteDeviation(rating.scores[field], baseline[field]),
      ])),
    };
  });
  const medianAbsoluteDeviation = Object.fromEntries(SCORE_FIELDS.map((field) => [
    field,
    median(deviations.map((deviation) => deviation.absolute_deviation[field])),
  ]));
  const identitySource = {
    reviewer_id: requireText(source.reviewer_id, 'reviewer_id'),
    anchor_set_id: requireMatching(source.anchor_set_id, anchorSet.anchor_set_id, 'anchor_set_id'),
    anchor_set_version: requireMatching(source.anchor_set_version, anchorSet.version, 'anchor_set_version'),
    rubric_version: requireMatching(source.rubric_version, anchorSet.rubric_version, 'rubric_version'),
    ratings,
    recorded_at: normalizeTimestamp(source.recorded_at, 'recorded_at'),
  };
  const sessionId = `reviewer-calibration_${hashCanonicalValue(identitySource).slice(0, 24)}`;
  verifyProvidedIdentity(source.session_id, sessionId, 'session_id');
  return deepFreeze({
    schema_version: REVIEWER_CALIBRATION_SESSION_VERSION,
    session_id: sessionId,
    ...identitySource,
    deviations,
    median_absolute_deviation: medianAbsoluteDeviation,
  });
}

export function buildReviewerCalibrationSessionEvent(input, { anchorSet, occurredAt } = {}) {
  const session = normalizeReviewerCalibrationSession(input, { anchorSet });
  return buildCalibrationEvent(
    'ReviewerCalibrationRecorded',
    { session },
    { session_id: session.session_id },
    occurredAt,
    session.recorded_at,
  );
}

function logicalEventHash(event) {
  return hashCanonicalValue({ type: event.type, data: event.data });
}

function uniqueCalibrationEvents(events) {
  if (!Array.isArray(events)) fail('invalid_calibration_event', 'events must be an array');
  const byIdempotency = new Map();
  const unique = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') fail('invalid_calibration_event', 'calibration event must be an object');
    if (!['CalibrationAnchorSetDefined', 'ReviewerCalibrationRecorded'].includes(event.type)) continue;
    const key = requireText(event.idempotency_key, 'event.idempotency_key');
    const contentHash = logicalEventHash(event);
    if (byIdempotency.has(key)) {
      if (byIdempotency.get(key) !== contentHash) {
        fail(
          'idempotency_conflict',
          `Calibration event idempotency key was reused with different content: ${key}`,
          { status: 409 },
        );
      }
      continue;
    }
    byIdempotency.set(key, contentHash);
    unique.push(event);
  }
  return unique;
}

function normalizeProjectedAnchor(event) {
  try {
    return normalizeCalibrationAnchorSet(event.data?.anchor_set);
  } catch (error) {
    if (error instanceof ReviewerCalibrationError) {
      fail('invalid_calibration_event', `Invalid CalibrationAnchorSetDefined event: ${error.message}`, { status: 409 });
    }
    throw error;
  }
}

function compareAnchorSets(left, right) {
  return left.version - right.version
    || left.approval.approved_at.localeCompare(right.approval.approved_at)
    || left.anchor_set_id.localeCompare(right.anchor_set_id);
}

function normalizeProjectedSession(event, anchorSet) {
  try {
    return normalizeReviewerCalibrationSession(event.data?.session, { anchorSet });
  } catch (error) {
    if (error instanceof ReviewerCalibrationError) {
      fail('invalid_calibration_event', `Invalid ReviewerCalibrationRecorded event: ${error.message}`, { status: 409 });
    }
    throw error;
  }
}

function emptyProjection(rebuiltAt) {
  return {
    schema_version: REVIEWER_CALIBRATION_PROJECTION_VERSION,
    status: 'not_configured',
    active_anchor_set: null,
    latest_session: null,
    median_absolute_deviation: null,
    valid_until: null,
    rebuilt_at: rebuiltAt,
  };
}

export function projectReviewerCalibration(events, { rubricVersion, now = new Date().toISOString() } = {}) {
  const activeRubricVersion = requireText(rubricVersion, 'rubricVersion');
  const rebuiltAt = normalizeTimestamp(now, 'now');
  const unique = uniqueCalibrationEvents(events);
  const anchorSets = unique
    .filter((event) => event.type === 'CalibrationAnchorSetDefined')
    .map(normalizeProjectedAnchor)
    .sort(compareAnchorSets);
  if (!anchorSets.length) return deepFreeze(emptyProjection(rebuiltAt));

  const activeAnchorSet = anchorSets.at(-1);
  const sessions = unique
    .filter((event) => event.type === 'ReviewerCalibrationRecorded')
    .map((event) => event.data?.session)
    .filter((session) => session?.anchor_set_id === activeAnchorSet.anchor_set_id
      && session?.anchor_set_version === activeAnchorSet.version)
    .map((session) => normalizeProjectedSession({ data: { session } }, activeAnchorSet))
    .sort((left, right) => left.recorded_at.localeCompare(right.recorded_at)
      || left.session_id.localeCompare(right.session_id));
  const latestSession = sessions.at(-1) ?? null;
  const validUntil = latestSession
    ? new Date(Date.parse(latestSession.recorded_at) + THIRTY_DAYS_MS).toISOString()
    : null;
  const medianAbsoluteDeviation = latestSession?.median_absolute_deviation ?? null;

  let status = 'calibrated';
  if (activeAnchorSet.rubric_version !== activeRubricVersion
    || !latestSession
    || latestSession.rubric_version !== activeRubricVersion
    || Date.parse(rebuiltAt) > Date.parse(validUntil)) {
    status = 'stale';
  } else if (SCORE_FIELDS.some((field) => medianAbsoluteDeviation[field] > 1)) {
    status = 'drift_detected';
  }

  return deepFreeze({
    schema_version: REVIEWER_CALIBRATION_PROJECTION_VERSION,
    status,
    active_anchor_set: activeAnchorSet,
    latest_session: latestSession,
    median_absolute_deviation: medianAbsoluteDeviation,
    valid_until: validUntil,
    rebuilt_at: rebuiltAt,
  });
}

export function reviewerCalibrationLogicalEventHash(event) {
  return logicalEventHash(event);
}
