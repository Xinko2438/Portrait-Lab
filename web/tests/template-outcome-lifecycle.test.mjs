import test from 'node:test';
import assert from 'node:assert/strict';

const lifecycle = await import('../src/template-outcome-lifecycle.mjs').catch(() => ({}));
const performance = await import('../src/template-performance-projection.mjs').catch(() => ({}));

const CATALOG_PROJECTION_VERSION = 'catalog-projection-v7';
const RANKING_POLICY_VERSION = 'template-ranking-v1';
const REFERENCE_IMAGE_SHA256 = '1'.repeat(64);
const BLUEPRINT_SHA256 = '2'.repeat(64);
const RUBRIC_VERSION = 'portrait-review-v3';
const REVIEWER_ID = 'primary-user';
const PREFERENCE_SESSION_ID = 'preference-session-final';
const PREFERENCE_SOURCE_EVENT_ID = 'preference-event-final';

function artifactSha256(artifactId) {
  const total = [...String(artifactId)].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return '0123456789abcdef'[total % 16].repeat(64);
}

function outcome({
  outcomeId,
  selectionId = 'sel_lifecycle',
  runId = 'run-lifecycle',
  artifactId = 'artifact-a',
  artifactHash = artifactSha256(artifactId),
  templateUid = 'tpl_portrait_a',
  face = 9,
  naturalness = 8,
  style = 8,
  preference = 'eligible_not_selected',
  rubricVersion = RUBRIC_VERSION,
  reviewerId = REVIEWER_ID,
  reviewSessionId = `review-session-${artifactId}`,
  preferenceSessionId = PREFERENCE_SESSION_ID,
  reviewSourceEventId = `review-event-${artifactId}`,
  preferenceSourceEventId = PREFERENCE_SOURCE_EVENT_ID,
  catalogProjectionVersion = CATALOG_PROJECTION_VERSION,
  rankingPolicyVersion = RANKING_POLICY_VERSION,
  referenceImageSha256 = REFERENCE_IMAGE_SHA256,
  blueprintSha256 = BLUEPRINT_SHA256,
  utilityScore,
  supersedesOutcomeId = null,
} = {}) {
  return {
    outcome_id: outcomeId,
    selection_id: selectionId,
    run_id: runId,
    artifact_id: artifactId,
    artifact_sha256: artifactHash,
    template_uid: templateUid,
    reference_image_sha256: referenceImageSha256,
    generation_blueprint_sha256: blueprintSha256,
    catalog_projection_version: catalogProjectionVersion,
    ranking_policy_version: rankingPolicyVersion,
    rubric_version: rubricVersion,
    reviewer_id: reviewerId,
    review_session_id: reviewSessionId,
    preference_session_id: preferenceSessionId,
    review_source_event_id: reviewSourceEventId,
    preference_source_event_id: preferenceSourceEventId,
    scores: {
      face_consistency: face,
      naturalness,
      style_consistency: style,
    },
    preference_result: preference,
    excluded_from_learning: false,
    ...(utilityScore === undefined ? {} : { utility_score: utilityScore }),
    ...(supersedesOutcomeId ? { supersedes_outcome_id: supersedesOutcomeId } : {}),
  };
}

function recordedEvent({
  selectionId,
  sourceEventId,
  reviewSourceEventId = sourceEventId,
  preferenceSourceEventId,
  recordedAt = '2026-08-31T12:00:00.000Z',
  eventId,
  idempotencyKey,
  value,
} = {}) {
  const normalizedSelectionId = selectionId || value.selection_id || 'sel_lifecycle';
  const normalizedReviewSource = reviewSourceEventId || value.review_source_event_id;
  const normalizedPreferenceSource = preferenceSourceEventId || value.preference_source_event_id;
  const storedOutcome = {
    ...value,
    selection_id: normalizedSelectionId,
    review_source_event_id: normalizedReviewSource,
    preference_source_event_id: normalizedPreferenceSource,
  };
  return {
    schema_version: 'ai-img-gen.template-selection-event.v1',
    event_id: eventId || `event-${storedOutcome.outcome_id}`,
    selection_id: normalizedSelectionId,
    type: 'TemplateSelectionOutcomeRecorded',
    recorded_at: recordedAt,
    idempotency_key: idempotencyKey || `${normalizedSelectionId}:outcome:${storedOutcome.outcome_id}`,
    data: {
      outcome: storedOutcome,
      review_source_event_id: normalizedReviewSource,
      preference_source_event_id: normalizedPreferenceSource,
    },
  };
}

function invalidatedEvent({
  selectionId = 'sel_lifecycle',
  invalidationId,
  outcomeId,
  artifactId = 'artifact-a',
  reason = 'review_revised',
  sourceEventId,
  reviewSourceEventId = reason === 'review_revised' ? sourceEventId : `review-event-${artifactId}`,
  preferenceSourceEventId = reason === 'preference_revised' ? sourceEventId : PREFERENCE_SOURCE_EVENT_ID,
  recordedAt = '2026-08-31T12:01:00.000Z',
  eventId,
  idempotencyKey,
} = {}) {
  return {
    schema_version: 'ai-img-gen.template-selection-event.v1',
    event_id: eventId || `event-${invalidationId}`,
    selection_id: selectionId,
    type: 'TemplateSelectionOutcomeInvalidated',
    recorded_at: recordedAt,
    idempotency_key: idempotencyKey || `${selectionId}:outcome-invalidation:${outcomeId}`,
    data: {
      invalidation: {
        invalidation_id: invalidationId,
        selection_id: selectionId,
        outcome_id: outcomeId,
        artifact_id: artifactId,
        reason,
        review_source_event_id: reviewSourceEventId,
        preference_source_event_id: preferenceSourceEventId,
        recorded_at: recordedAt,
      },
    },
  };
}

function runProjection({
  runId,
  templateUid,
  artifactIds,
  outcomeValues = [],
  selectionId = outcomeValues[0]?.selection_id || 'sel_lifecycle',
  templateReferences,
  reviewedArtifactIds = artifactIds,
  preferenceDecision = 'winner',
  winnerArtifactId = artifactIds?.[0] || null,
  preferenceSessionId = outcomeValues[0]?.preference_session_id || PREFERENCE_SESSION_ID,
  preferenceSourceEventId = outcomeValues[0]?.preference_source_event_id || PREFERENCE_SOURCE_EVENT_ID,
} = {}) {
  const byArtifact = new Map(outcomeValues.map((item) => [item.artifact_id, item]));
  const references = templateReferences || [{
    source_type: 'catalog_template',
    selection_id: selectionId,
    template_uid: templateUid,
    reference_image_sha256: outcomeValues[0]?.reference_image_sha256 || REFERENCE_IMAGE_SHA256,
    generation_blueprint_sha256: outcomeValues[0]?.generation_blueprint_sha256 || BLUEPRINT_SHA256,
    catalog_projection_version: outcomeValues[0]?.catalog_projection_version || CATALOG_PROJECTION_VERSION,
    ranking_policy_version: outcomeValues[0]?.ranking_policy_version || RANKING_POLICY_VERSION,
  }];
  return {
    run_id: runId,
    template_references: references,
    artifacts: (artifactIds || []).map((artifactId) => ({
      artifact_id: artifactId,
      sha256: byArtifact.get(artifactId)?.artifact_sha256 || artifactSha256(artifactId),
    })),
    artifact_reviews: Object.fromEntries((reviewedArtifactIds || []).map((artifactId) => {
      const value = byArtifact.get(artifactId) || outcome({ outcomeId: `fixture-${artifactId}`, selectionId, runId, artifactId, templateUid });
      return [artifactId, {
        face_identity_fidelity: value.scores.face_consistency,
        realism_naturalness: value.scores.naturalness,
        style_consistency: value.scores.style_consistency,
        review_rubric_version: value.rubric_version,
        reviewer_id: value.reviewer_id,
        review_session_id: value.review_session_id,
        review_source_event_id: value.review_source_event_id,
      }];
    })),
    preference: preferenceDecision ? {
      decision: preferenceDecision,
      winner_artifact_id: preferenceDecision === 'winner' ? winnerArtifactId : null,
      preference_session_id: preferenceSessionId,
      preference_source_event_id: preferenceSourceEventId,
      reviewer_id: REVIEWER_ID,
    } : null,
  };
}

test('constructors and validators retain exact Outcome and invalidation identities', () => {
  assert.equal(typeof lifecycle.createTemplateSelectionOutcomeRecorded, 'function');
  assert.equal(typeof lifecycle.createTemplateSelectionOutcomeInvalidated, 'function');
  assert.equal(typeof lifecycle.validateTemplateSelectionOutcomeRecorded, 'function');
  assert.equal(typeof lifecycle.validateTemplateSelectionOutcomeInvalidated, 'function');

  const recordedPayload = outcome({
    outcomeId: undefined,
    preference: 'winner',
    reviewSourceEventId: 'review-event-a',
    preferenceSourceEventId: 'preference-event-a',
  });
  const recorded = lifecycle.createTemplateSelectionOutcomeRecorded({
    selection_id: 'sel_lifecycle',
    review_source_event_id: 'review-event-a',
    preference_source_event_id: 'preference-event-a',
    recorded_at: '2026-08-31T12:00:00.000Z',
    outcome: recordedPayload,
  });
  assert.equal(recorded.type, 'TemplateSelectionOutcomeRecorded');
  assert.equal(recorded.data.outcome.review_source_event_id, 'review-event-a');
  assert.equal(recorded.data.outcome.preference_source_event_id, 'preference-event-a');
  assert.match(recorded.data.outcome.outcome_id, /^out_[a-f0-9]{24}$/);
  assert.deepEqual(lifecycle.validateTemplateSelectionOutcomeRecorded(recorded), recorded);
  const recordedLater = lifecycle.createTemplateSelectionOutcomeRecorded({
    selection_id: 'sel_lifecycle',
    review_source_event_id: 'review-event-a',
    preference_source_event_id: 'preference-event-a',
    recorded_at: '2026-08-31T12:05:00.000Z',
    outcome: recordedPayload,
  });
  assert.equal(recordedLater.data.outcome.outcome_id, recorded.data.outcome.outcome_id);
  assert.equal(recordedLater.idempotency_key, recorded.idempotency_key);
  assert.notEqual(recordedLater.event_id, recorded.event_id);

  const invalidated = lifecycle.createTemplateSelectionOutcomeInvalidated({
    selection_id: 'sel_lifecycle',
    outcome_id: recorded.data.outcome.outcome_id,
    artifact_id: 'artifact-a',
    reason: 'preference_revised',
    review_source_event_id: 'review-event-a',
    preference_source_event_id: 'preference-event-b',
    recorded_at: '2026-08-31T12:01:00.000Z',
  });
  assert.equal(invalidated.type, 'TemplateSelectionOutcomeInvalidated');
  assert.deepEqual(invalidated.data.invalidation, {
    invalidation_id: invalidated.data.invalidation.invalidation_id,
    selection_id: 'sel_lifecycle',
    outcome_id: recorded.data.outcome.outcome_id,
    artifact_id: 'artifact-a',
    reason: 'preference_revised',
    review_source_event_id: 'review-event-a',
    preference_source_event_id: 'preference-event-b',
    recorded_at: '2026-08-31T12:01:00.000Z',
  });
  assert.match(invalidated.data.invalidation.invalidation_id, /^outinval_[a-f0-9]{24}$/);
  assert.deepEqual(lifecycle.validateTemplateSelectionOutcomeInvalidated(invalidated), invalidated);
  const invalidatedLater = lifecycle.createTemplateSelectionOutcomeInvalidated({
    selection_id: 'sel_lifecycle',
    outcome_id: recorded.data.outcome.outcome_id,
    artifact_id: 'artifact-a',
    reason: 'preference_revised',
    review_source_event_id: 'review-event-a',
    preference_source_event_id: 'preference-event-b',
    recorded_at: '2026-08-31T12:06:00.000Z',
  });
  assert.equal(invalidatedLater.data.invalidation.invalidation_id, invalidated.data.invalidation.invalidation_id);
  assert.equal(invalidatedLater.idempotency_key, invalidated.idempotency_key);
  assert.notEqual(invalidatedLater.event_id, invalidated.event_id);

  assert.throws(
    () => lifecycle.createTemplateSelectionOutcomeInvalidated({
      selection_id: 'sel_lifecycle',
      outcome_id: recorded.data.outcome.outcome_id,
      artifact_id: 'artifact-a',
      reason: 'unknown_reason',
      review_source_event_id: 'review-event-a',
      preference_source_event_id: 'preference-event-b',
    }),
    (error) => error?.code === 'invalid_outcome_invalidation',
  );
});

test('recorded then invalidated then replacement preserves history and yields one active Outcome', () => {
  assert.equal(typeof lifecycle.projectActiveTemplateOutcomes, 'function');
  const original = recordedEvent({
    sourceEventId: 'review-event-original',
    value: outcome({ outcomeId: 'out_original', preference: 'winner' }),
  });
  const invalidation = invalidatedEvent({
    invalidationId: 'outinval_original',
    outcomeId: 'out_original',
    sourceEventId: 'review-event-revised',
  });
  const replacement = recordedEvent({
    sourceEventId: 'review-event-revised',
    recordedAt: '2026-08-31T12:02:00.000Z',
    value: outcome({
      outcomeId: 'out_replacement',
      preference: 'winner',
      naturalness: 9,
      supersedesOutcomeId: 'out_original',
    }),
  });
  const events = [original, invalidation, replacement];
  const snapshot = structuredClone(events);

  const projection = lifecycle.projectActiveTemplateOutcomes(events);

  assert.deepEqual(events, snapshot);
  assert.equal(projection.event_history.length, 3);
  assert.deepEqual(projection.outcome_history.map((item) => [item.outcome_id, item.lifecycle_state]), [
    ['out_original', 'superseded'],
    ['out_replacement', 'active'],
  ]);
  assert.deepEqual(projection.active_outcomes.map((item) => item.outcome_id), ['out_replacement']);
  assert.deepEqual(projection.invalidations, [invalidation]);
});

test('base Outcome records require separate exact sources and target-aware dedupe', () => {
  const base = recordedEvent({
    sourceEventId: 'review-event-base',
    value: outcome({ outcomeId: 'out_base' }),
  });
  const missingSource = structuredClone(base);
  delete missingSource.data.review_source_event_id;
  delete missingSource.data.outcome.review_source_event_id;
  assert.throws(
    () => lifecycle.validateTemplateSelectionOutcomeRecorded(missingSource),
    (error) => error?.code === 'invalid_outcome_record',
  );

  const replay = {
    ...structuredClone(base),
    event_id: 'event-base-replay',
    recorded_at: '2026-08-31T12:07:00.000Z',
  };
  const replayed = lifecycle.projectActiveTemplateOutcomes([base, replay]);
  assert.equal(replayed.event_history.length, 1);
  assert.equal(replayed.active_outcomes.length, 1);
  assert.equal(replayed.replay_count, 1);

  const conflictingBase = recordedEvent({
    sourceEventId: 'review-event-base',
    value: outcome({ outcomeId: 'out_conflicting_base', naturalness: 8.5 }),
  });
  assert.throws(
    () => lifecycle.projectActiveTemplateOutcomes([base, conflictingBase]),
    (error) => error?.code === 'source_evidence_conflict',
  );
});

test('same-source invalidation and replacement replays are stable while conflicting source evidence fails', () => {
  const original = recordedEvent({
    sourceEventId: 'review-event-original',
    value: outcome({ outcomeId: 'out_original' }),
  });
  const invalidation = invalidatedEvent({
    invalidationId: 'outinval_original',
    outcomeId: 'out_original',
    sourceEventId: 'review-event-revised',
  });
  const replacement = recordedEvent({
    sourceEventId: 'review-event-revised',
    value: outcome({ outcomeId: 'out_replacement', supersedesOutcomeId: 'out_original' }),
  });
  const replayedInvalidation = {
    ...structuredClone(invalidation),
    event_id: 'event-invalidation-replay',
    recorded_at: '2026-08-31T12:05:00.000Z',
  };
  replayedInvalidation.data.invalidation.recorded_at = replayedInvalidation.recorded_at;
  const replayedReplacement = {
    ...structuredClone(replacement),
    event_id: 'event-replacement-replay',
    recorded_at: '2026-08-31T12:06:00.000Z',
  };

  const once = lifecycle.projectActiveTemplateOutcomes([original, invalidation, replacement]);
  const replayed = lifecycle.projectActiveTemplateOutcomes([
    original,
    invalidation,
    replayedInvalidation,
    replacement,
    replayedReplacement,
  ]);
  assert.deepEqual(replayed.active_outcomes, once.active_outcomes);
  assert.deepEqual(replayed.outcome_history, once.outcome_history);
  assert.equal(replayed.replay_count, 2);

  const conflictingInvalidation = invalidatedEvent({
    invalidationId: 'outinval_conflict',
    outcomeId: 'out_original',
    reason: 'preference_revised',
    reviewSourceEventId: 'review-event-revised',
    preferenceSourceEventId: PREFERENCE_SOURCE_EVENT_ID,
    idempotencyKey: 'sel_lifecycle:outcome-invalidation:conflict',
  });
  assert.throws(
    () => lifecycle.projectActiveTemplateOutcomes([original, invalidation, conflictingInvalidation]),
    (error) => error?.code === 'source_evidence_conflict',
  );
});

test('stale or identity-conflicting supersession is rejected', () => {
  const original = recordedEvent({
    sourceEventId: 'review-event-original',
    value: outcome({ outcomeId: 'out_original' }),
  });
  const invalidation = invalidatedEvent({
    invalidationId: 'outinval_original',
    outcomeId: 'out_original',
    sourceEventId: 'review-event-revised',
  });
  const replacement = recordedEvent({
    sourceEventId: 'review-event-revised',
    value: outcome({ outcomeId: 'out_replacement', supersedesOutcomeId: 'out_original' }),
  });
  const conflictingIdentity = recordedEvent({
    sourceEventId: 'review-event-conflict',
    value: outcome({
      outcomeId: 'out_wrong_artifact',
      artifactId: 'artifact-b',
      supersedesOutcomeId: 'out_original',
    }),
  });
  assert.throws(
    () => lifecycle.projectActiveTemplateOutcomes([original, invalidation, conflictingIdentity]),
    (error) => error?.code === 'supersession_identity_conflict',
  );

  const staleReplacement = recordedEvent({
    sourceEventId: 'review-event-stale',
    value: outcome({
      outcomeId: 'out_stale',
      naturalness: 9.5,
      supersedesOutcomeId: 'out_original',
    }),
  });
  assert.throws(
    () => lifecycle.projectActiveTemplateOutcomes([original, invalidation, replacement, staleReplacement]),
    (error) => error?.code === 'stale_supersession',
  );
});

test('canonical Outcome events reject malformed schema, identity, timestamp, evidence, and scores', () => {
  const valid = recordedEvent({
    value: outcome({ outcomeId: 'out_canonical', preference: 'winner' }),
  });
  const cases = [
    ['wrong schema', (event) => { event.schema_version = 'ai-img-gen.template-selection-event.v0'; }],
    ['missing event ID', (event) => { delete event.event_id; }],
    ['missing idempotency key', (event) => { delete event.idempotency_key; }],
    ['untrimmed event ID', (event) => { event.event_id = ' event-canonical '; }],
    ['noncanonical timestamp', (event) => { event.recorded_at = '2026-08-31T20:00:00+08:00'; }],
    ['string score', (event) => { event.data.outcome.scores.face_consistency = '9'; }],
    ['boolean score', (event) => { event.data.outcome.scores.face_consistency = true; }],
    ['fractional score', (event) => { event.data.outcome.scores.face_consistency = 8.25; }],
    ['missing artifact hash', (event) => { delete event.data.outcome.artifact_sha256; }],
    ['selection mismatch', (event) => { event.data.outcome.selection_id = 'sel_foreign'; }],
    ['source mismatch', (event) => { event.data.review_source_event_id = 'review-event-foreign'; }],
  ];
  for (const [name, mutate] of cases) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    assert.throws(
      () => lifecycle.validateTemplateSelectionOutcomeRecorded(candidate),
      (error) => error?.code === 'invalid_outcome_record',
      name,
    );
  }

  const requiredOutcomeFields = [
    'artifact_sha256',
    'rubric_version',
    'reviewer_id',
    'review_session_id',
    'preference_session_id',
    'review_source_event_id',
    'preference_source_event_id',
    'selection_id',
    'catalog_projection_version',
    'ranking_policy_version',
    'reference_image_sha256',
    'generation_blueprint_sha256',
  ];
  for (const field of requiredOutcomeFields) {
    const candidate = structuredClone(valid);
    delete candidate.data.outcome[field];
    if (field === 'review_source_event_id') delete candidate.data.review_source_event_id;
    if (field === 'preference_source_event_id') delete candidate.data.preference_source_event_id;
    assert.throws(
      () => lifecycle.validateTemplateSelectionOutcomeRecorded(candidate),
      (error) => error?.code === 'invalid_outcome_record',
      field,
    );
  }
});

test('event, idempotency, and invalidation identities are globally collision checked', () => {
  const first = recordedEvent({
    value: outcome({ outcomeId: 'out_collision_a', artifactId: 'artifact-a' }),
  });
  const eventCollision = recordedEvent({
    eventId: first.event_id,
    value: outcome({ outcomeId: 'out_collision_b', artifactId: 'artifact-b' }),
  });
  assert.throws(
    () => lifecycle.projectActiveTemplateOutcomes([first, eventCollision]),
    (error) => error?.code === 'event_identity_conflict',
  );
  const timestampCollision = {
    ...structuredClone(first),
    recorded_at: '2026-08-31T12:09:00.000Z',
    idempotency_key: 'sel_lifecycle:outcome:timestamp-collision',
  };
  assert.throws(
    () => lifecycle.projectActiveTemplateOutcomes([first, timestampCollision]),
    (error) => error?.code === 'event_identity_conflict',
  );

  const idempotencyCollision = recordedEvent({
    idempotencyKey: first.idempotency_key,
    value: outcome({ outcomeId: 'out_collision_c', artifactId: 'artifact-c' }),
  });
  assert.throws(
    () => lifecycle.projectActiveTemplateOutcomes([first, idempotencyCollision]),
    (error) => error?.code === 'idempotency_conflict',
  );

  const originalB = recordedEvent({
    value: outcome({ outcomeId: 'out_collision_target_b', artifactId: 'artifact-b' }),
  });
  const invalidationA = invalidatedEvent({
    invalidationId: 'outinval_collision',
    outcomeId: 'out_collision_a',
    artifactId: 'artifact-a',
    sourceEventId: 'review-revised-a',
  });
  const invalidationB = invalidatedEvent({
    invalidationId: 'outinval_collision',
    outcomeId: 'out_collision_target_b',
    artifactId: 'artifact-b',
    sourceEventId: 'review-revised-b',
    eventId: 'event-outinval-collision-b',
  });
  assert.throws(
    () => lifecycle.projectActiveTemplateOutcomes([first, originalB, invalidationA, invalidationB]),
    (error) => error?.code === 'invalidation_identity_conflict',
  );
});

test('canonical invalidations require exact envelope, target, sources, and timestamp', () => {
  const valid = invalidatedEvent({
    invalidationId: 'outinval_canonical',
    outcomeId: 'out_canonical_target',
    artifactId: 'artifact-a',
    sourceEventId: 'review-event-canonical-revised',
  });
  const cases = [
    ['wrong schema', (event) => { event.schema_version = 'ai-img-gen.template-selection-event.v0'; }],
    ['missing event ID', (event) => { delete event.event_id; }],
    ['missing idempotency key', (event) => { delete event.idempotency_key; }],
    ['untrimmed invalidation ID', (event) => { event.data.invalidation.invalidation_id = ' outinval_canonical '; }],
    ['selection mismatch', (event) => { event.data.invalidation.selection_id = 'sel_foreign'; }],
    ['artifact missing', (event) => { delete event.data.invalidation.artifact_id; }],
    ['review source missing', (event) => { delete event.data.invalidation.review_source_event_id; }],
    ['preference source missing', (event) => { delete event.data.invalidation.preference_source_event_id; }],
    ['timestamp mismatch', (event) => { event.data.invalidation.recorded_at = '2026-08-31T12:02:00.000Z'; }],
  ];
  for (const [name, mutate] of cases) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    assert.throws(
      () => lifecycle.validateTemplateSelectionOutcomeInvalidated(candidate),
      (error) => error?.code === 'invalid_outcome_invalidation',
      name,
    );
  }
});

test('same identity cannot be replaced without explicit invalidation and supersession', () => {
  const original = recordedEvent({
    value: outcome({ outcomeId: 'out_explicit_original' }),
  });
  const implicitReplacement = recordedEvent({
    sourceEventId: 'review-event-later',
    recordedAt: '2026-08-31T12:03:00.000Z',
    value: outcome({ outcomeId: 'out_implicit_replacement', naturalness: 9 }),
  });
  assert.throws(
    () => lifecycle.projectActiveTemplateOutcomes([original, implicitReplacement]),
    (error) => error?.code === 'implicit_outcome_replacement',
  );
});

test('lifecycle reconstruction is identical across event orderings', () => {
  const original = recordedEvent({
    value: outcome({ outcomeId: 'out_order_original' }),
  });
  const invalidation = invalidatedEvent({
    invalidationId: 'outinval_order_original',
    outcomeId: 'out_order_original',
    sourceEventId: 'review-event-order-revised',
  });
  const replacement = recordedEvent({
    sourceEventId: 'review-event-order-revised',
    recordedAt: '2026-08-31T12:02:00.000Z',
    value: outcome({
      outcomeId: 'out_order_replacement',
      naturalness: 9,
      supersedesOutcomeId: 'out_order_original',
    }),
  });

  const chronological = lifecycle.projectActiveTemplateOutcomes([original, invalidation, replacement]);
  const shuffled = lifecycle.projectActiveTemplateOutcomes([replacement, original, invalidation]);
  assert.deepEqual(shuffled, chronological);
});

test('one preference revision can invalidate and replace multiple artifact Outcomes', () => {
  const selectionId = 'sel_preference_wide';
  const initialPreferenceSource = 'preference-event-initial';
  const revisedPreferenceSource = 'preference-event-revised';
  const revisedPreferenceSession = 'preference-session-revised';
  const originals = ['artifact-a', 'artifact-b'].map((artifactId) => recordedEvent({
    selectionId,
    value: outcome({
      outcomeId: `out-original-${artifactId}`,
      selectionId,
      artifactId,
      preference: artifactId === 'artifact-a' ? 'winner' : 'eligible_not_selected',
      preferenceSourceEventId: initialPreferenceSource,
    }),
  }));
  const invalidations = originals.map((event) => invalidatedEvent({
    selectionId,
    invalidationId: `outinval-${event.data.outcome.artifact_id}`,
    outcomeId: event.data.outcome.outcome_id,
    artifactId: event.data.outcome.artifact_id,
    reason: 'preference_revised',
    reviewSourceEventId: event.data.outcome.review_source_event_id,
    preferenceSourceEventId: revisedPreferenceSource,
  }));
  const replacements = originals.map((event) => recordedEvent({
    selectionId,
    recordedAt: '2026-08-31T12:02:00.000Z',
    value: outcome({
      outcomeId: `out-replacement-${event.data.outcome.artifact_id}`,
      selectionId,
      artifactId: event.data.outcome.artifact_id,
      preference: event.data.outcome.artifact_id === 'artifact-b' ? 'winner' : 'eligible_not_selected',
      reviewSourceEventId: event.data.outcome.review_source_event_id,
      preferenceSourceEventId: revisedPreferenceSource,
      preferenceSessionId: revisedPreferenceSession,
      supersedesOutcomeId: event.data.outcome.outcome_id,
    }),
  }));

  const projection = lifecycle.projectActiveTemplateOutcomes([
    replacements[1],
    invalidations[0],
    originals[1],
    replacements[0],
    originals[0],
    invalidations[1],
  ]);
  assert.deepEqual(
    projection.active_outcomes.map((item) => item.outcome_id).sort(),
    ['out-replacement-artifact-a', 'out-replacement-artifact-b'],
  );
  assert.equal(projection.invalidations.length, 2);
  assert.equal(projection.active_outcomes.every((item) => item.preference_source_event_id === revisedPreferenceSource), true);
  assert.equal(projection.active_outcomes.every((item) => item.selection_id === selectionId), true);

  const run = runProjection({
    runId: 'run-lifecycle',
    templateUid: 'tpl_portrait_a',
    artifactIds: ['artifact-a', 'artifact-b'],
    outcomeValues: replacements.map((event) => event.data.outcome),
    winnerArtifactId: 'artifact-b',
    preferenceSessionId: revisedPreferenceSession,
    preferenceSourceEventId: revisedPreferenceSource,
  });
  const performanceProjection = performance.buildTemplatePerformanceProjectionV2({
    outcome_events: [...originals, ...invalidations, ...replacements],
    run_projections: [run],
  });
  assert.equal(performanceProjection.total_outcome_support_count, 1);
  assert.equal(performanceProjection.outcome_supports[0].selected_outcome_id, 'out-replacement-artifact-b');
});

test('public performance builder rejects malformed non-array inputs', () => {
  for (const field of ['selection_projections', 'selection_events', 'outcome_events', 'run_projections']) {
    for (const invalid of [{}, null, 'not-an-array']) {
      assert.throws(
        () => performance.buildTemplatePerformanceProjectionV2({ [field]: invalid }),
        (error) => error?.code === 'invalid_performance_input',
        `${field}:${String(invalid)}`,
      );
    }
  }
});

test('twenty repeated UI decisions alter choice support at most once and Outcome support by zero', () => {
  assert.equal(typeof performance.buildTemplatePerformanceProjectionV2, 'function');
  const events = Array.from({ length: 20 }, (_, index) => ({
    schema_version: 'ai-img-gen.template-selection-event.v1',
    event_id: `decision-${index}`,
    selection_id: 'sel-repeated-ui',
    type: 'TemplateSelectionDecisionRecorded',
    recorded_at: `2026-08-31T12:${String(index).padStart(2, '0')}:00.000Z`,
    data: {
      decision: index % 2 === 1
        ? { accepted_template_uids: ['tpl_repeated'], removed_template_uids: [], substitutions: [] }
        : { accepted_template_uids: [], removed_template_uids: ['tpl_repeated'], substitutions: [] },
    },
  }));
  events.splice(5, 0, {
    selection_id: 'sel-repeated-ui',
    type: 'TemplateExplorationPresented',
    data: { template_uids: ['tpl_repeated'] },
  });
  events.splice(10, 0, {
    selection_id: 'sel-repeated-ui',
    type: 'TemplateSelectionRunLinked',
    data: { run_id: 'run-ui-only', template_uid: 'tpl_repeated' },
  });

  const projection = performance.buildTemplatePerformanceProjectionV2({ selection_events: events });
  const stats = projection.templates.find((item) => item.template_uid === 'tpl_repeated');
  assert.equal(stats.choice_support_count, 1);
  assert.equal(stats.outcome_support_count, 0);
  assert.equal(projection.total_outcome_support_count, 0);
  assert.equal(projection.activation, 'inactive');
});

test('one Run-Template counts once and prefers a gate-qualified winner over higher utility', () => {
  const first = recordedEvent({
    selectionId: 'sel-performance',
    sourceEventId: 'review-a',
    value: outcome({
      outcomeId: 'out-high-utility',
      runId: 'run-performance',
      artifactId: 'artifact-a',
      templateUid: 'tpl_performance',
      naturalness: 9.5,
      style: 9.5,
      preference: 'eligible_not_selected',
      utilityScore: 9.5,
    }),
  });
  const winner = recordedEvent({
    selectionId: 'sel-performance',
    sourceEventId: 'review-b',
    value: outcome({
      outcomeId: 'out-winner',
      runId: 'run-performance',
      artifactId: 'artifact-b',
      templateUid: 'tpl_performance',
      naturalness: 8,
      style: 8,
      preference: 'winner',
      utilityScore: 8,
    }),
  });
  const run = runProjection({
    runId: 'run-performance',
    templateUid: 'tpl_performance',
    artifactIds: ['artifact-a', 'artifact-b'],
    outcomeValues: [first.data.outcome, winner.data.outcome],
    winnerArtifactId: 'artifact-b',
  });

  const projection = performance.buildTemplatePerformanceProjectionV2({
    outcome_events: [first, winner],
    run_projections: [run],
  });
  const stats = projection.templates.find((item) => item.template_uid === 'tpl_performance');
  const support = projection.outcome_supports[0];
  assert.equal(stats.outcome_support_count, 1);
  assert.equal(stats.winner_count, 1);
  assert.equal(stats.naturalness_average, 8);
  assert.equal(stats.style_consistency_average, 8);
  assert.equal(support.selection_basis, 'winner');
  assert.equal(support.selected_outcome_id, 'out-winner');
});

test('performance support requires an exact join to current Run, review, preference, and template evidence', () => {
  const validEvent = recordedEvent({
    selectionId: 'sel-evidence-join',
    value: outcome({
      outcomeId: 'out-evidence-join',
      runId: 'run-evidence-join',
      artifactId: 'artifact-evidence-join',
      templateUid: 'tpl_evidence_join',
      preference: 'winner',
    }),
  });
  const run = runProjection({
    runId: 'run-evidence-join',
    templateUid: 'tpl_evidence_join',
    artifactIds: ['artifact-evidence-join'],
    outcomeValues: [validEvent.data.outcome],
    winnerArtifactId: 'artifact-evidence-join',
  });
  const valid = performance.buildTemplatePerformanceProjectionV2({
    outcome_events: [validEvent],
    run_projections: [run],
  });
  assert.equal(valid.total_outcome_support_count, 1);

  const mutations = [
    ['selection', (event) => { event.selection_id = 'sel_foreign'; event.data.outcome.selection_id = 'sel_foreign'; }],
    ['artifact hash', (event) => { event.data.outcome.artifact_sha256 = 'f'.repeat(64); }],
    ['score', (event) => { event.data.outcome.scores.naturalness = 8.1; }],
    ['rubric', (event) => { event.data.outcome.rubric_version = 'portrait-review-v4'; }],
    ['reviewer', (event) => { event.data.outcome.reviewer_id = 'other-reviewer'; }],
    ['review session', (event) => { event.data.outcome.review_session_id = 'review-session-foreign'; }],
    ['review source', (event) => {
      event.data.outcome.review_source_event_id = 'review-event-foreign';
      event.data.review_source_event_id = 'review-event-foreign';
    }],
    ['preference session', (event) => { event.data.outcome.preference_session_id = 'preference-session-foreign'; }],
    ['preference source', (event) => {
      event.data.outcome.preference_source_event_id = 'preference-event-foreign';
      event.data.preference_source_event_id = 'preference-event-foreign';
    }],
    ['catalog version', (event) => { event.data.outcome.catalog_projection_version = 'catalog-projection-v8'; }],
    ['ranking version', (event) => { event.data.outcome.ranking_policy_version = 'template-ranking-v2'; }],
    ['reference hash', (event) => { event.data.outcome.reference_image_sha256 = 'e'.repeat(64); }],
    ['blueprint hash', (event) => { event.data.outcome.generation_blueprint_sha256 = 'd'.repeat(64); }],
  ];
  for (const [name, mutate] of mutations) {
    const candidate = structuredClone(validEvent);
    mutate(candidate);
    const projection = performance.buildTemplatePerformanceProjectionV2({
      outcome_events: [candidate],
      run_projections: [run],
    });
    assert.equal(projection.total_outcome_support_count, 0, name);
    assert.equal(projection.deferred[0]?.reason, 'outcome_evidence_mismatch', name);
  }
});

test('without a winner the highest gate-qualified utility uses Artifact ID as the tie break', () => {
  const events = ['artifact-b', 'artifact-a'].map((artifactId) => recordedEvent({
    selectionId: 'sel-tie',
    sourceEventId: `review-${artifactId}`,
    value: outcome({
      outcomeId: `out-${artifactId}`,
      runId: 'run-tie',
      artifactId,
      templateUid: 'tpl_tie',
      naturalness: 8.5,
      style: 8.5,
      preference: 'none',
      utilityScore: 8.5,
    }),
  }));
  const run = runProjection({
    runId: 'run-tie',
    templateUid: 'tpl_tie',
    artifactIds: ['artifact-a', 'artifact-b'],
    outcomeValues: events.map((event) => event.data.outcome),
    preferenceDecision: 'none',
  });

  const projection = performance.buildTemplatePerformanceProjectionV2({
    outcome_events: events,
    run_projections: [run],
  });
  assert.equal(projection.outcome_supports[0].selection_basis, 'highest_utility');
  assert.equal(projection.outcome_supports[0].selected_artifact_id, 'artifact-a');
});

test('face failures count as evaluation support but remain outside aesthetic summaries', () => {
  const event = recordedEvent({
    selectionId: 'sel-face-fail',
    sourceEventId: 'review-face-fail',
    value: outcome({
      outcomeId: 'out-face-fail',
      runId: 'run-face-fail',
      artifactId: 'artifact-face-fail',
      templateUid: 'tpl_face_fail',
      face: 7.9,
      naturalness: 10,
      style: 10,
      preference: 'winner',
      utilityScore: 10,
    }),
  });
  const run = runProjection({
    runId: 'run-face-fail',
    templateUid: 'tpl_face_fail',
    artifactIds: ['artifact-face-fail'],
    outcomeValues: [event.data.outcome],
    winnerArtifactId: 'artifact-face-fail',
  });

  const projection = performance.buildTemplatePerformanceProjectionV2({
    outcome_events: [event],
    run_projections: [run],
  });
  const stats = projection.templates[0];
  assert.equal(stats.outcome_support_count, 1);
  assert.equal(stats.identity_pass_count, 0);
  assert.equal(stats.aesthetic_outcome_count, 0);
  assert.equal(stats.naturalness_average, null);
  assert.equal(stats.style_consistency_average, null);
  assert.equal(stats.winner_count, 0);
  assert.equal(stats.readiness_support_count, 1);
  assert.equal(stats.readiness, 'insufficient');
  assert.equal(projection.outcome_supports[0].aesthetic_eligible, false);
  assert.equal(projection.outcome_supports[0].evaluation_support_eligible, true);
  assert.equal(Object.hasOwn(projection.outcome_supports[0], 'readiness_eligible'), false);
});

test('safe active face-failure supports count toward shadow readiness without entering aesthetic summaries', () => {
  const fixtures = Array.from({ length: 20 }, (_, index) => {
    const suffix = String(index + 1).padStart(2, '0');
    const runId = `run-face-ready-${suffix}`;
    const artifactId = `artifact-face-ready-${suffix}`;
    const event = recordedEvent({
      selectionId: `sel-face-ready-${suffix}`,
      sourceEventId: `review-face-ready-${suffix}`,
      value: outcome({
        outcomeId: `out-face-ready-${suffix}`,
        runId,
        artifactId,
        templateUid: 'tpl_face_ready',
        face: 7.9,
        naturalness: 10,
        style: 10,
        preference: 'winner',
      }),
    });
    return {
      event,
      run: runProjection({
        runId,
        templateUid: 'tpl_face_ready',
        artifactIds: [artifactId],
        outcomeValues: [event.data.outcome],
        winnerArtifactId: artifactId,
      }),
    };
  });

  const projection = performance.buildTemplatePerformanceProjectionV2({
    outcome_events: fixtures.map((item) => item.event),
    run_projections: fixtures.map((item) => item.run),
  });
  const stats = projection.templates[0];
  assert.equal(stats.outcome_support_count, 20);
  assert.equal(stats.readiness_support_count, 20);
  assert.equal(stats.readiness, 'shadow_ready');
  assert.equal(stats.aesthetic_outcome_count, 0);
  assert.equal(stats.naturalness_average, null);
  assert.equal(stats.style_consistency_average, null);
  assert.equal(stats.winner_count, 0);
  assert.equal(projection.production_ranking_active, false);
});

test('support defers incomplete exact Artifact coverage and final-preference mismatches', () => {
  const missingEvents = [recordedEvent({
    selectionId: 'sel-outcome-missing',
    sourceEventId: 'review-outcome-missing-a',
    value: outcome({
      outcomeId: 'out-outcome-missing-a',
      runId: 'run-outcome-missing',
      artifactId: 'artifact-a',
      templateUid: 'tpl_outcome_missing',
      preference: 'winner',
    }),
  })];
  const missingRun = runProjection({
    runId: 'run-outcome-missing',
    templateUid: 'tpl_outcome_missing',
    artifactIds: ['artifact-a', 'artifact-b'],
    outcomeValues: missingEvents.map((event) => event.data.outcome),
    winnerArtifactId: 'artifact-a',
  });

  const duplicateEvents = ['one', 'two'].map((suffix) => recordedEvent({
    selectionId: `sel-outcome-duplicate-${suffix}`,
    sourceEventId: `review-outcome-duplicate-${suffix}`,
    value: outcome({
      outcomeId: `out-outcome-duplicate-${suffix}`,
      runId: 'run-outcome-duplicate',
      artifactId: 'artifact-a',
      templateUid: 'tpl_outcome_duplicate',
      preference: 'winner',
    }),
  }));
  const duplicateRun = runProjection({
    runId: 'run-outcome-duplicate',
    templateUid: 'tpl_outcome_duplicate',
    artifactIds: ['artifact-a'],
    outcomeValues: [duplicateEvents[0].data.outcome],
    winnerArtifactId: 'artifact-a',
  });

  const mismatchEvents = [
    recordedEvent({
      selectionId: 'sel-winner-mismatch',
      sourceEventId: 'review-winner-mismatch-a',
      value: outcome({
        outcomeId: 'out-winner-mismatch-a',
        runId: 'run-winner-mismatch',
        artifactId: 'artifact-a',
        templateUid: 'tpl_winner_mismatch',
        preference: 'winner',
      }),
    }),
    recordedEvent({
      selectionId: 'sel-winner-mismatch',
      sourceEventId: 'review-winner-mismatch-b',
      value: outcome({
        outcomeId: 'out-winner-mismatch-b',
        runId: 'run-winner-mismatch',
        artifactId: 'artifact-b',
        templateUid: 'tpl_winner_mismatch',
        preference: 'eligible_not_selected',
      }),
    }),
  ];
  const mismatchRun = runProjection({
    runId: 'run-winner-mismatch',
    templateUid: 'tpl_winner_mismatch',
    artifactIds: ['artifact-a', 'artifact-b'],
    outcomeValues: mismatchEvents.map((event) => event.data.outcome),
    winnerArtifactId: 'artifact-b',
  });

  const duplicateWinnerEvents = ['artifact-a', 'artifact-b'].map((artifactId) => recordedEvent({
    selectionId: 'sel-winner-duplicate',
    sourceEventId: `review-winner-duplicate-${artifactId}`,
    value: outcome({
      outcomeId: `out-winner-duplicate-${artifactId}`,
      runId: 'run-winner-duplicate',
      artifactId,
      templateUid: 'tpl_winner_duplicate',
      preference: 'winner',
    }),
  }));
  const duplicateWinnerRun = runProjection({
    runId: 'run-winner-duplicate',
    templateUid: 'tpl_winner_duplicate',
    artifactIds: ['artifact-a', 'artifact-b'],
    outcomeValues: duplicateWinnerEvents.map((event) => event.data.outcome),
    winnerArtifactId: 'artifact-a',
  });

  const projection = performance.buildTemplatePerformanceProjectionV2({
    outcome_events: [
      ...missingEvents,
      ...duplicateEvents,
      ...mismatchEvents,
      ...duplicateWinnerEvents,
    ],
    run_projections: [missingRun, duplicateRun, mismatchRun, duplicateWinnerRun],
  });
  const reasons = Object.fromEntries(projection.deferred.map((item) => [item.run_id, item.reason]));
  assert.deepEqual(reasons, {
    'run-outcome-duplicate': 'outcome_evidence_mismatch',
    'run-outcome-missing': 'outcome_coverage_mismatch',
    'run-winner-duplicate': 'preference_outcome_mismatch',
    'run-winner-mismatch': 'preference_outcome_mismatch',
  });
  assert.equal(projection.total_outcome_support_count, 0);
});

test('a terminal final winner is never replaced by utility sorting around human preference', () => {
  const events = [
    recordedEvent({
      selectionId: 'sel-terminal-winner',
      sourceEventId: 'review-terminal-winner-a',
      value: outcome({
        outcomeId: 'out-terminal-winner-a',
        runId: 'run-terminal-winner',
        artifactId: 'artifact-a',
        templateUid: 'tpl_terminal_winner',
        face: 7.9,
        naturalness: 10,
        style: 10,
        preference: 'winner',
        utilityScore: 10,
      }),
    }),
    recordedEvent({
      selectionId: 'sel-terminal-winner',
      sourceEventId: 'review-terminal-winner-b',
      value: outcome({
        outcomeId: 'out-terminal-winner-b',
        runId: 'run-terminal-winner',
        artifactId: 'artifact-b',
        templateUid: 'tpl_terminal_winner',
        preference: 'eligible_not_selected',
        utilityScore: 9,
      }),
    }),
  ];
  const run = runProjection({
    runId: 'run-terminal-winner',
    templateUid: 'tpl_terminal_winner',
    artifactIds: ['artifact-a', 'artifact-b'],
    outcomeValues: events.map((event) => event.data.outcome),
    winnerArtifactId: 'artifact-a',
  });

  const projection = performance.buildTemplatePerformanceProjectionV2({
    outcome_events: events,
    run_projections: [run],
  });
  assert.equal(projection.outcome_supports[0].selection_basis, 'winner_not_gate_qualified');
  assert.equal(projection.outcome_supports[0].selected_outcome_id, null);
  assert.equal(projection.templates[0].aesthetic_outcome_count, 0);
  assert.equal(projection.templates[0].naturalness_average, null);
});

test('multi-template, manual-only, incomplete-review, and missing-preference Runs stay deferred', () => {
  const cases = [
    {
      runId: 'run-multiple',
      templateUid: 'tpl_multiple',
      artifactId: 'artifact-multiple',
      run: runProjection({
        runId: 'run-multiple',
        templateUid: 'tpl_multiple',
        artifactIds: ['artifact-multiple'],
        templateReferences: [
          { source_type: 'catalog_template', template_uid: 'tpl_multiple' },
          { source_type: 'catalog_template', template_uid: 'tpl_other' },
        ],
      }),
      reason: 'multiple_templates',
    },
    {
      runId: 'run-manual',
      templateUid: 'tpl_manual_claim',
      artifactId: 'artifact-manual',
      run: runProjection({
        runId: 'run-manual',
        templateUid: 'tpl_manual_claim',
        artifactIds: ['artifact-manual'],
        templateReferences: [{ source_type: 'manual_upload' }],
      }),
      reason: 'manual_only',
    },
    {
      runId: 'run-incomplete',
      templateUid: 'tpl_incomplete',
      artifactId: 'artifact-reviewed',
      run: runProjection({
        runId: 'run-incomplete',
        templateUid: 'tpl_incomplete',
        artifactIds: ['artifact-reviewed', 'artifact-unreviewed'],
        reviewedArtifactIds: ['artifact-reviewed'],
      }),
      reason: 'incomplete_review',
    },
    {
      runId: 'run-preference-missing',
      templateUid: 'tpl_preference_missing',
      artifactId: 'artifact-preference-missing',
      run: runProjection({
        runId: 'run-preference-missing',
        templateUid: 'tpl_preference_missing',
        artifactIds: ['artifact-preference-missing'],
        preferenceDecision: null,
      }),
      reason: 'missing_preference',
    },
  ];
  const events = cases.map((item) => recordedEvent({
    selectionId: `sel-${item.runId}`,
    sourceEventId: `review-${item.runId}`,
    value: outcome({
      outcomeId: `out-${item.runId}`,
      runId: item.runId,
      artifactId: item.artifactId,
      templateUid: item.templateUid,
      preference: 'winner',
    }),
  }));

  const projection = performance.buildTemplatePerformanceProjectionV2({
    outcome_events: events,
    run_projections: cases.map((item) => item.run),
  });
  assert.equal(projection.total_outcome_support_count, 0);
  assert.deepEqual(
    [...new Set(projection.deferred.map((item) => item.reason))].sort(),
    ['incomplete_review', 'manual_only', 'missing_preference', 'multiple_templates'],
  );
});

test('shadow readiness requires twenty unique active Run-Template supports and never activates production ranking', () => {
  const fixtures = Array.from({ length: 20 }, (_, index) => {
    const suffix = String(index + 1).padStart(2, '0');
    const runId = `run-ready-${suffix}`;
    const artifactId = `artifact-ready-${suffix}`;
    const event = recordedEvent({
      selectionId: `sel-ready-${suffix}`,
      sourceEventId: `review-ready-${suffix}`,
      value: outcome({
        outcomeId: `out-ready-${suffix}`,
        runId,
        artifactId,
        templateUid: 'tpl_ready',
        preference: 'winner',
        utilityScore: 8,
      }),
    });
    return {
      event,
      run: runProjection({
        runId,
        templateUid: 'tpl_ready',
        artifactIds: [artifactId],
        outcomeValues: [event.data.outcome],
        winnerArtifactId: artifactId,
      }),
    };
  });

  const nineteen = performance.buildTemplatePerformanceProjectionV2({
    outcome_events: fixtures.slice(0, 19).map((item) => item.event),
    run_projections: fixtures.slice(0, 19).map((item) => item.run),
  });
  assert.equal(nineteen.templates[0].outcome_support_count, 19);
  assert.equal(nineteen.templates[0].readiness, 'insufficient');

  const twenty = performance.buildTemplatePerformanceProjectionV2({
    outcome_events: fixtures.map((item) => item.event),
    run_projections: fixtures.map((item) => item.run),
  });
  assert.equal(twenty.templates[0].outcome_support_count, 20);
  assert.equal(twenty.templates[0].readiness_support_count, 20);
  assert.equal(twenty.templates[0].readiness, 'shadow_ready');
  assert.equal(twenty.status, 'inactive_shadow_ready');
  assert.equal(twenty.activation, 'inactive');
  assert.equal(twenty.evaluation_mode, 'shadow_only');
  assert.equal(twenty.production_ranking_active, false);
  assert.equal(twenty.production_ranking_policy_version, 'template-ranking-v1');
});
