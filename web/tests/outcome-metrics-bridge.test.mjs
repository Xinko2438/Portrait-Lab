import test from 'node:test';
import assert from 'node:assert/strict';

const outcomeModule = await import('../src/intelligent-workbench/outcome-bridge.mjs').catch(() => ({}));
const metricsModule = await import('../src/intelligent-workbench/metrics-projection.mjs').catch(() => ({}));

function reviewedCatalogRun({
  catalogTemplateCount = 1,
  selectionId = 'sel_0123456789abcdef01234567',
  preferenceDecision = 'winner',
  reviewedArtifactIds = ['artifact-a', 'artifact-b'],
} = {}) {
  const artifacts = [
    { artifact_id: 'artifact-a', sha256: 'a'.repeat(64) },
    { artifact_id: 'artifact-b', sha256: 'b'.repeat(64) },
  ];
  const catalogReferences = Array.from({ length: catalogTemplateCount }, (_, index) => ({
    source_type: 'catalog_template',
    template_uid: `tpl_catalog_${index + 1}`,
    selection_id: selectionId,
    reference_image_sha256: `${index + 1}`.repeat(64),
    generation_blueprint_sha256: `${index + 2}`.repeat(64),
    catalog_projection_version: 'catalog-projection-v7',
    ranking_policy_version: 'template-ranking-v1',
  }));
  const reviews = {
    'artifact-a': {
      face_identity_fidelity: 9.2,
      realism_naturalness: 8.4,
      style_consistency: 8.7,
      review_rubric_version: 'portrait-review-v3',
      reviewer_id: 'primary-user',
      review_session_id: 'review-a',
    },
    'artifact-b': {
      face_identity_fidelity: 7.9,
      realism_naturalness: 9.4,
      style_consistency: 9.1,
      review_rubric_version: 'portrait-review-v3',
      reviewer_id: 'primary-user',
      review_session_id: 'review-b',
    },
  };
  const artifactReviews = Object.fromEntries(reviewedArtifactIds.map((artifactId) => [artifactId, reviews[artifactId]]));
  return {
    manifest: {
      schema_version: 'ai-img-gen.web-run.v6',
      run_id: 'run-outcome-bridge',
      artifacts,
      artifact_reviews: artifactReviews,
      template_references: catalogReferences,
      preference: preferenceDecision ? {
        decision: preferenceDecision,
        winner_artifact_id: preferenceDecision === 'winner' ? 'artifact-a' : null,
        preference_session_id: 'preference-final',
        reviewer_id: 'primary-user',
      } : null,
      prompt_compilation: {
        compiler_id: 'portrait-prompt-compiler-v1',
        compiler_version: 1,
        prompt_sha256: 'f'.repeat(64),
      },
      excluded_from_learning: false,
    },
    events: [],
  };
}

test('derives stable per-artifact outcome commands only from complete single-catalog human evidence', () => {
  assert.equal(typeof outcomeModule.deriveTemplateOutcomeCommands, 'function');
  const first = outcomeModule.deriveTemplateOutcomeCommands({ run: reviewedCatalogRun() });
  const second = outcomeModule.deriveTemplateOutcomeCommands({ run: reviewedCatalogRun() });

  assert.equal(first.status, 'ready');
  assert.equal(first.reason, null);
  assert.equal(first.commands.length, 2);
  assert.deepEqual(first.commands, second.commands);
  assert.deepEqual(first.commands.map((command) => command.outcome.preference_result), ['winner', 'eligible_not_selected']);
  assert.deepEqual(first.commands[0].outcome.scores, {
    face_consistency: 9.2,
    naturalness: 8.4,
    style_consistency: 8.7,
  });
  assert.equal(first.commands[0].selectionId, 'sel_0123456789abcdef01234567');
  assert.equal(first.commands[0].outcome.artifact_sha256, 'a'.repeat(64));
  assert.equal(first.commands[0].outcome.reference_image_sha256, '1'.repeat(64));
  assert.equal(first.commands[0].outcome.generation_blueprint_sha256, '2'.repeat(64));
  assert.equal(first.commands[0].outcome.rubric_version, 'portrait-review-v3');
  assert.equal(first.commands[0].outcome.reviewer_id, 'primary-user');
  assert.equal(first.commands[0].outcome.review_session_id, 'review-a');
  assert.equal(first.commands[0].outcome.preference_session_id, 'preference-final');
  assert.match(first.commands[0].outcome.source_event_id, /^outcome-source-[a-f0-9]{32}$/);
  assert.equal(first.commands[0].outcome.prompt_compiler_version, 1);
  assert.match(first.commands[0].outcomeIdempotencyKey, /^outcome-bridge-[a-f0-9]{32}$/);
});

test('review or preference revisions create new exact Outcome source and idempotency identities', () => {
  const originalRun = reviewedCatalogRun();
  const original = outcomeModule.deriveTemplateOutcomeCommands({ run: originalRun });

  const revisedReviewRun = reviewedCatalogRun();
  revisedReviewRun.manifest.artifact_reviews['artifact-a'].review_session_id = 'review-a-revised';
  const revisedReview = outcomeModule.deriveTemplateOutcomeCommands({ run: revisedReviewRun });
  assert.notEqual(revisedReview.commands[0].outcome.source_event_id, original.commands[0].outcome.source_event_id);
  assert.notEqual(revisedReview.commands[0].outcomeIdempotencyKey, original.commands[0].outcomeIdempotencyKey);

  const revisedPreferenceRun = reviewedCatalogRun();
  revisedPreferenceRun.manifest.preference.preference_session_id = 'preference-revised';
  const revisedPreference = outcomeModule.deriveTemplateOutcomeCommands({ run: revisedPreferenceRun });
  for (const command of revisedPreference.commands) {
    assert.equal(command.outcome.preference_session_id, 'preference-revised');
    assert.notEqual(command.outcome.source_event_id, original.commands[0].outcome.source_event_id);
  }
  assert.notDeepEqual(
    revisedPreference.commands.map((command) => command.outcomeIdempotencyKey),
    original.commands.map((command) => command.outcomeIdempotencyKey),
  );
});

test('recipe outcomes retain exact prompt mode and correction lineage for later comparisons', () => {
  const run = reviewedCatalogRun();
  run.manifest.prompt_compilation = {
    schema_version: 'ai-img-gen.prompt-recipe.v1',
    compiler_id: 'portrait-prompt-recipe-v1',
    compiler_version: 1,
    recipe_id: 'prompt-recipe_0123456789abcdef01234567',
    prompt_input_mode: 'reference_image',
    applied_correction_ids: ['prompt-correction_active'],
    shadow_correction_ids: ['prompt-correction_shadow'],
    angle_alignment: {
      state: 'aligned',
      selected_identity_ordinal: 1,
      template_ordinal: 2,
      identity_angle_family: 'frontal',
      template_angle_family: 'frontal',
      selection_reason: 'closest_known_angle',
    },
    prompt_sha256: 'f'.repeat(64),
  };

  const result = outcomeModule.deriveTemplateOutcomeCommands({ run });
  assert.equal(result.status, 'ready');
  for (const command of result.commands) {
    assert.equal(command.outcome.prompt_recipe_id, 'prompt-recipe_0123456789abcdef01234567');
    assert.equal(command.outcome.prompt_input_mode, 'reference_image');
    assert.deepEqual(command.outcome.applied_correction_ids, ['prompt-correction_active']);
    assert.deepEqual(command.outcome.shadow_correction_ids, ['prompt-correction_shadow']);
    assert.deepEqual(command.outcome.angle_alignment, run.manifest.prompt_compilation.angle_alignment);
  }
});

test('reviewed outcomes retain the Run-scoped face-angle match for later face-score measurement', () => {
  const run = reviewedCatalogRun();
  run.manifest.face_angle_analysis = {
    schema_version: 'ai-img-gen.face-angle-analysis.v1',
    pipeline_version: 'hybrid-profile-v2',
    match: {
      schema_version: 'ai-img-gen.face-angle-match.v1',
      state: 'recommended',
      recommended_identity_source_index: 2,
      final_identity_source_index: 2,
      selection_mode: 'automatic',
      match_score: 94.5,
      reason: 'closest_reliable_pose',
    },
  };

  const result = outcomeModule.deriveTemplateOutcomeCommands({ run });

  assert.equal(result.status, 'ready');
  for (const command of result.commands) {
    assert.deepEqual(command.outcome.face_angle_match, run.manifest.face_angle_analysis.match);
    assert.equal(command.outcome.face_angle_pipeline_version, 'hybrid-profile-v2');
  }
});

test('maps a final none preference to none for every reviewed artifact', () => {
  const result = outcomeModule.deriveTemplateOutcomeCommands({ run: reviewedCatalogRun({ preferenceDecision: 'none' }) });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.commands.map((command) => command.outcome.preference_result), ['none', 'none']);
});

test('defers ambiguous or incomplete provenance without inventing template attribution', () => {
  const ambiguous = outcomeModule.deriveTemplateOutcomeCommands({ run: reviewedCatalogRun({ catalogTemplateCount: 2 }) });
  assert.deepEqual(ambiguous, { status: 'deferred', reason: 'multiple_catalog_templates', commands: [], invalidations: [] });

  const incomplete = outcomeModule.deriveTemplateOutcomeCommands({ run: reviewedCatalogRun({ reviewedArtifactIds: ['artifact-a'] }) });
  assert.deepEqual(incomplete, { status: 'deferred', reason: 'artifact_reviews_incomplete', commands: [], invalidations: [] });

  const pending = outcomeModule.deriveTemplateOutcomeCommands({ run: reviewedCatalogRun({ preferenceDecision: null }) });
  assert.deepEqual(pending, { status: 'deferred', reason: 'final_preference_missing', commands: [], invalidations: [] });
});

test('uses loaded Run events as latest human review and final-preference evidence', () => {
  const run = reviewedCatalogRun({ reviewedArtifactIds: [], preferenceDecision: null });
  const reviews = reviewedCatalogRun().manifest.artifact_reviews;
  run.events = [
    ...Object.entries(reviews).map(([artifactId, review]) => ({
      type: 'ArtifactReviewRecorded',
      data: { artifact_id: artifactId, review },
    })),
    {
      type: 'PreferenceRecorded',
      data: {
        preference: {
          decision: 'none',
          winner_artifact_id: null,
          preference_session_id: 'event-preference',
          reviewer_id: 'primary-user',
        },
      },
    },
  ];

  const result = outcomeModule.deriveTemplateOutcomeCommands({ run });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.commands.map((command) => command.outcome.preference_result), ['none', 'none']);
});

test('executes injected outcome recorder and reports idempotent replay counts', async () => {
  assert.equal(typeof outcomeModule.executeTemplateOutcomeBridge, 'function');
  const seen = new Set();
  const recordOutcome = async (command) => {
    const replay = seen.has(command.outcomeIdempotencyKey);
    seen.add(command.outcomeIdempotencyKey);
    return { idempotent_replay: replay };
  };

  const first = await outcomeModule.executeTemplateOutcomeBridge({ run: reviewedCatalogRun(), recordOutcome });
  assert.deepEqual(
    { status: first.status, reason: first.reason, recorded: first.recorded, idempotent: first.idempotent, deferred: first.deferred },
    { status: 'ready', reason: null, recorded: 2, idempotent: 0, deferred: 0 },
  );
  const replay = await outcomeModule.executeTemplateOutcomeBridge({ run: reviewedCatalogRun(), recordOutcome });
  assert.deepEqual(
    { status: replay.status, reason: replay.reason, recorded: replay.recorded, idempotent: replay.idempotent, deferred: replay.deferred },
    { status: 'ready', reason: null, recorded: 0, idempotent: 2, deferred: 0 },
  );

  const deferred = await outcomeModule.executeTemplateOutcomeBridge({
    run: reviewedCatalogRun({ catalogTemplateCount: 2 }),
    recordOutcome,
  });
  assert.deepEqual(
    { status: deferred.status, reason: deferred.reason, recorded: deferred.recorded, idempotent: deferred.idempotent, deferred: deferred.deferred },
    { status: 'deferred', reason: 'multiple_catalog_templates', recorded: 0, idempotent: 0, deferred: 1 },
  );
});

test('pending preference produces exact invalidation-only commands for every prior active Outcome', async () => {
  const run = reviewedCatalogRun();
  run.manifest.preference = {
    decision: 'pending',
    winner_artifact_id: null,
    preference_session_id: 'preference-pending',
    preference_source_event_id: 'preference-event-pending',
    reviewer_id: 'primary-user',
  };
  const activeOutcomes = [
    {
      selection_id: 'sel_0123456789abcdef01234567',
      outcome_id: 'out_prior_a',
      run_id: 'run-outcome-bridge',
      artifact_id: 'artifact-a',
      template_uid: 'tpl_catalog_1',
      review_source_event_id: 'review-a',
      preference_source_event_id: 'preference-final',
    },
    {
      selection_id: 'sel_0123456789abcdef01234567',
      outcome_id: 'out_prior_b',
      run_id: 'run-outcome-bridge',
      artifact_id: 'artifact-b',
      template_uid: 'tpl_catalog_1',
      review_source_event_id: 'review-b',
      preference_source_event_id: 'preference-final',
    },
  ];
  const derived = outcomeModule.deriveTemplateOutcomeCommands({ run, activeOutcomes });
  assert.equal(derived.status, 'deferred');
  assert.equal(derived.reason, 'final_preference_pending');
  assert.equal(derived.commands.length, 0);
  assert.equal(derived.invalidations.length, 2);
  assert.deepEqual(derived.invalidations.map((item) => item.reason), ['preference_revised', 'preference_revised']);
  assert.deepEqual(derived.invalidations.map((item) => item.outcomeId), ['out_prior_a', 'out_prior_b']);
  assert.equal(derived.invalidations.every((item) => item.preferenceSourceEventId === 'preference-event-pending'), true);

  const seen = [];
  const executed = await outcomeModule.executeTemplateOutcomeBridge({
    run,
    activeOutcomes,
    recordOutcome: async () => { throw new Error('recordOutcome must not run'); },
    invalidateOutcome: async (command) => { seen.push(command); return { idempotent_replay: false }; },
  });
  assert.equal(executed.invalidated, 2);
  assert.equal(executed.recorded, 0);
  assert.deepEqual(seen, derived.invalidations);
});

test('attribution or exclusion changes invalidate prior active Outcomes instead of leaving stale active evidence', () => {
  const activeOutcomes = [{
    selection_id: 'sel_0123456789abcdef01234567',
    outcome_id: 'out_prior_a',
    run_id: 'run-outcome-bridge',
    artifact_id: 'artifact-a',
    template_uid: 'tpl_catalog_1',
    review_source_event_id: 'review-a',
    preference_source_event_id: 'preference-final',
  }];
  const ambiguousRun = reviewedCatalogRun({ catalogTemplateCount: 2 });
  const ambiguous = outcomeModule.deriveTemplateOutcomeCommands({ run: ambiguousRun, activeOutcomes });
  assert.equal(ambiguous.reason, 'multiple_catalog_templates');
  assert.equal(ambiguous.invalidations[0].reason, 'attribution_invalidated');

  const excludedRun = reviewedCatalogRun();
  excludedRun.manifest.excluded_from_learning = true;
  const excluded = outcomeModule.deriveTemplateOutcomeCommands({ run: excludedRun, activeOutcomes });
  assert.equal(excluded.reason, 'run_excluded_from_learning');
  assert.equal(excluded.invalidations[0].reason, 'attribution_invalidated');
});

test('missing Run identity never becomes a wildcard invalidation across a selection', () => {
  const run = reviewedCatalogRun();
  delete run.manifest.run_id;
  run.manifest.preference.decision = 'pending';
  run.manifest.preference.preference_session_id = 'preference-pending-no-run';
  run.manifest.preference.preference_source_event_id = 'preference-event-pending-no-run';
  const activeOutcomes = [
    { selection_id: 'sel_0123456789abcdef01234567', outcome_id: 'out_other_1', run_id: 'run-other-1', artifact_id: 'artifact-a', template_uid: 'tpl_catalog_1', review_source_event_id: 'review-a', preference_source_event_id: 'preference-old' },
    { selection_id: 'sel_0123456789abcdef01234567', outcome_id: 'out_other_2', run_id: 'run-other-2', artifact_id: 'artifact-b', template_uid: 'tpl_catalog_1', review_source_event_id: 'review-b', preference_source_event_id: 'preference-old' },
  ];
  const result = outcomeModule.deriveTemplateOutcomeCommands({ run, activeOutcomes });
  assert.equal(result.reason, 'final_preference_pending');
  assert.deepEqual(result.invalidations, []);
});

test('rebuilds compounding coverage, quality, compiler, and suggestion-correction metrics from source evidence', () => {
  assert.equal(typeof metricsModule.buildCompoundingMetrics, 'function');
  const catalogRun = reviewedCatalogRun();
  catalogRun.manifest.identity_source = { customer_id: 'cust_example', identity_set_id: 'ids_reused' };
  catalogRun.manifest.identity_references = [{ sha256: '9'.repeat(64) }];
  const legacyRun = {
    manifest: {
      schema_version: 'ai-img-gen.web-run.v4',
      run_id: 'run-legacy-upload',
      identity_references: [{ sha256: '8'.repeat(64) }],
      template_references: [],
      artifacts: [{ artifact_id: 'artifact-legacy', sha256: '7'.repeat(64) }],
      artifact_reviews: {},
      preference: null,
    },
    events: [],
  };
  const outcomes = outcomeModule.deriveTemplateOutcomeCommands({ run: catalogRun }).commands.map((command) => command.outcome);

  const projection = metricsModule.buildCompoundingMetrics({
    runs: [catalogRun, legacyRun],
    outcomes,
    suggestions: [{ suggestion_id: 'suggestion-1' }, { suggestion_id: 'suggestion-2' }, { suggestion_id: 'suggestion-unreviewed' }],
    corrections: [
      { suggestion_id: 'suggestion-1', has_corrections: true, correction_count: 1, field_deltas: { face_identity_fidelity: { state: 'accepted', delta: 0 }, realism_naturalness: { state: 'corrected', delta: 0.8 } } },
      { suggestion_id: 'suggestion-2', has_corrections: false, correction_count: 0, field_deltas: { face_identity_fidelity: { state: 'accepted', delta: 0 }, realism_naturalness: { state: 'accepted', delta: 0 } } },
    ],
  });

  assert.equal(projection.schema_version, 'ai-img-gen.compounding-metrics.v1');
  assert.deepEqual(projection.metrics.identity_reuse_rate, { numerator: 1, denominator: 2, value: 0.5, status: 'ready' });
  assert.deepEqual(projection.metrics.v6_run_coverage, { numerator: 1, denominator: 2, value: 0.5, status: 'ready' });
  assert.deepEqual(projection.metrics.prompt_compilation_coverage, { numerator: 1, denominator: 2, value: 0.5, status: 'ready' });
  assert.deepEqual(projection.metrics.prompt_recipe_coverage, { numerator: 0, denominator: 2, value: 0, status: 'ready' });
  assert.deepEqual(projection.metrics.artifact_review_coverage, { numerator: 2, denominator: 3, value: 0.667, status: 'ready' });
  assert.deepEqual(projection.metrics.final_preference_coverage, { numerator: 1, denominator: 2, value: 0.5, status: 'ready' });
  assert.deepEqual(projection.metrics.template_outcome_coverage, { numerator: 2, denominator: 2, value: 1, status: 'ready' });
  assert.deepEqual(projection.metrics.identity_pass_rate, { numerator: 1, denominator: 2, value: 0.5, status: 'ready' });
  assert.deepEqual(projection.metrics.naturalness_average, { sample_count: 1, value: 8.4, status: 'ready' });
  assert.deepEqual(projection.metrics.style_consistency_average, { sample_count: 1, value: 8.7, status: 'ready' });
  assert.deepEqual(projection.metrics.ai_suggestion_correction_rate, { numerator: 1, denominator: 2, value: 0.5, status: 'ready' });
  assert.deepEqual(projection.compiler_effectiveness, [{
    compiler_id: 'portrait-prompt-compiler-v1',
    compiler_version: 1,
    support_count: 2,
    identity_pass_rate: 0.5,
    naturalness_average: 8.4,
    style_consistency_average: 8.7,
    winner_rate_among_aesthetic_eligible: 1,
    readiness: 'insufficient',
  }]);
  assert.deepEqual(projection.recipe_effectiveness, []);
  assert.deepEqual(projection.ranking, {
    mode: 'shadow',
    production_activation: 'inactive',
    minimum_support: 20,
    support_count: 2,
    readiness: 'insufficient',
  });
});

test('uses null and insufficient for zero denominators and never activates production ranking', () => {
  const empty = metricsModule.buildCompoundingMetrics({ runs: [], outcomes: [] });
  for (const metric of Object.values(empty.metrics)) {
    assert.equal(metric.value, null);
    assert.equal(metric.status, 'insufficient');
  }
  assert.deepEqual(empty.compiler_effectiveness, []);
  assert.deepEqual(empty.recipe_effectiveness, []);
  assert.equal(empty.ranking.readiness, 'insufficient');
  assert.equal(empty.ranking.mode, 'shadow');
  assert.equal(empty.ranking.production_activation, 'inactive');

  const base = outcomeModule.deriveTemplateOutcomeCommands({ run: reviewedCatalogRun() }).commands[0].outcome;
  const supported = metricsModule.buildCompoundingMetrics({
    runs: [reviewedCatalogRun()],
    outcomes: Array.from({ length: 20 }, (_, index) => ({ ...base, artifact_id: `artifact-supported-${index}` })),
  });
  assert.equal(supported.ranking.support_count, 20);
  assert.equal(supported.ranking.readiness, 'shadow_ready');
  assert.equal(supported.ranking.mode, 'shadow');
  assert.equal(supported.ranking.production_activation, 'inactive');
});

test('recipe metrics group outcomes by effective recipe without mixing prompt modes', () => {
  const run = reviewedCatalogRun();
  run.manifest.prompt_compilation = {
    schema_version: 'ai-img-gen.prompt-recipe.v1',
    compiler_id: 'portrait-prompt-recipe-v1',
    compiler_version: 1,
    recipe_id: 'prompt-recipe_0123456789abcdef01234567',
    prompt_input_mode: 'reference_image',
    applied_correction_ids: ['prompt-correction_active'],
    shadow_correction_ids: [],
    prompt_sha256: 'f'.repeat(64),
  };
  const outcomes = outcomeModule.deriveTemplateOutcomeCommands({ run }).commands.map((command) => command.outcome);
  const projection = metricsModule.buildCompoundingMetrics({ runs: [run], outcomes });

  assert.deepEqual(projection.metrics.prompt_recipe_coverage, { numerator: 1, denominator: 1, value: 1, status: 'ready' });
  assert.deepEqual(projection.recipe_effectiveness, [{
    prompt_recipe_id: 'prompt-recipe_0123456789abcdef01234567',
    prompt_input_mode: 'reference_image',
    applied_correction_ids: ['prompt-correction_active'],
    support_count: 2,
    identity_pass_rate: 0.5,
    naturalness_average: 8.4,
    style_consistency_average: 8.7,
    winner_rate_among_aesthetic_eligible: 1,
    readiness: 'insufficient',
  }]);
});

test('accepts append-only suggestion and correction event payloads without mixing them into human truth', () => {
  const projection = metricsModule.buildCompoundingMetrics({
    suggestions: [{ event_type: 'review_suggestion.created', payload: { suggestion_id: 'suggestion-event' } }],
    corrections: [{ event_type: 'human_review_correction.recorded', payload: { suggestion_id: 'suggestion-event', has_corrections: true, correction_count: 1 } }],
  });
  assert.deepEqual(projection.metrics.ai_suggestion_correction_rate, {
    numerator: 1,
    denominator: 1,
    value: 1,
    status: 'ready',
  });
  assert.equal(projection.metrics.artifact_review_coverage.value, null);
});
