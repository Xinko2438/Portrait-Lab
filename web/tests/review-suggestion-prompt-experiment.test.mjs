import test from 'node:test';
import assert from 'node:assert/strict';

const reviewModule = await import('../src/intelligent-workbench/review-suggestion.mjs').catch(() => ({}));
const experimentModule = await import('../src/intelligent-workbench/prompt-experiment.mjs').catch(() => ({}));
const providerModule = await import('../src/intelligent-workbench/provider-contracts.mjs').catch(() => ({}));

const validSuggestion = (overrides = {}) => ({
  provider_id: 'opencodex',
  provider_version: '2.29.0',
  model_id: 'review-model-a',
  model_version: '2026-08-25',
  adapter_version: 'opencodex-review-adapter-v1',
  prompt_version: 'portrait-review-prompt-v1',
  input_sha256: 'a'.repeat(64),
  output_sha256: 'b'.repeat(64),
  face_identity_fidelity: 8.4,
  realism_naturalness: 7.2,
  style_consistency: 7.8,
  diagnostic_codes: ['subject_not_primary', 'emotion_unclear', 'subject_not_primary'],
  reasons: {
    face_identity_fidelity: 'Key facial proportions remain consistent.',
    realism_naturalness: 'Skin and pose look mostly natural.',
    style_consistency: 'Lighting follows the selected editorial reference.',
    diagnostics: 'The background competes slightly with the person.',
  },
  confidence: 0.82,
  recommended_action: 'human_review_required',
  ...overrides,
});

const validHumanReview = (overrides = {}) => ({
  event_id: 'review-event-001',
  face_identity_fidelity: 8.0,
  realism_naturalness: 7.2,
  style_consistency: 8.1,
  diagnostic_codes: ['emotion_unclear', 'elements_incoherent'],
  ...overrides,
});

test('ReviewSuggestion v1 normalizes the complete strict contract and can only be suggested', () => {
  assert.equal(typeof reviewModule.normalizeReviewSuggestion, 'function');
  const suggestion = reviewModule.normalizeReviewSuggestion(validSuggestion());

  assert.equal(suggestion.schema_version, 'ai-img-gen.review-suggestion.v1');
  assert.match(suggestion.suggestion_id, /^review-suggestion_[a-f0-9]{24}$/);
  assert.equal(suggestion.status, 'suggested');
  assert.deepEqual(suggestion.diagnostic_codes, ['emotion_unclear', 'subject_not_primary']);
  assert.equal(suggestion.face_identity_fidelity, 8.4);
  assert.equal(suggestion.confidence, 0.82);
  assert.equal(suggestion.provider_version, '2.29.0');
  assert.equal(suggestion.model_version, '2026-08-25');
  assert.equal(suggestion.adapter_version, 'opencodex-review-adapter-v1');
  assert.equal(suggestion.prompt_version, 'portrait-review-prompt-v1');
  assert.equal(suggestion.input_sha256, 'a'.repeat(64));
  assert.equal(suggestion.output_sha256, 'b'.repeat(64));

  assert.throws(() => reviewModule.normalizeReviewSuggestion(validSuggestion({ status: 'confirmed' })), /status.*suggested/i);
});

test('ReviewSuggestion rejects missing, imprecise, unknown, or malformed evidence fields', () => {
  const invalidCases = [
    [validSuggestion({ face_identity_fidelity: 10.1 }), /between 0\.0 and 10\.0/i],
    [validSuggestion({ realism_naturalness: 7.25 }), /one decimal/i],
    [validSuggestion({ style_consistency: undefined }), /style_consistency.*required/i],
    [validSuggestion({ diagnostic_codes: ['invented_issue'] }), /unknown diagnostic/i],
    [validSuggestion({ reasons: { face_identity_fidelity: 'Only one reason.' } }), /reasons.*realism_naturalness/i],
    [validSuggestion({ confidence: 1.01 }), /confidence.*between 0 and 1/i],
    [validSuggestion({ recommended_action: 'auto_approve' }), /recommended_action/i],
    [validSuggestion({ adapter_version: '' }), /adapter_version.*required/i],
    [validSuggestion({ input_sha256: 'not-a-hash' }), /input_sha256.*sha-256/i],
  ];
  for (const [input, expected] of invalidCases) {
    assert.throws(() => reviewModule.normalizeReviewSuggestion(input), expected);
  }
});

test('ReviewSuggestion events are pure, append-only payloads with stable hash and idempotency interfaces', () => {
  assert.equal(typeof reviewModule.buildReviewSuggestionEvent, 'function');
  assert.equal(typeof reviewModule.hashCanonicalValue, 'function');
  assert.equal(typeof reviewModule.buildIdempotencyKey, 'function');

  const input = validSuggestion();
  const snapshot = structuredClone(input);
  const first = reviewModule.buildReviewSuggestionEvent(input, { occurredAt: '2026-08-25T00:00:00.000Z' });
  const second = reviewModule.buildReviewSuggestionEvent(input, { occurredAt: '2026-08-25T00:00:00.000Z' });
  const later = reviewModule.buildReviewSuggestionEvent(input, { occurredAt: '2026-08-26T00:00:00.000Z' });

  assert.deepEqual(input, snapshot);
  assert.equal(first.schema_version, 'ai-img-gen.append-only-event.v1');
  assert.equal(first.event_type, 'review_suggestion.created');
  assert.equal(first.idempotency_key, second.idempotency_key);
  assert.equal(first.event_sha256, second.event_sha256);
  assert.equal(first.idempotency_key, later.idempotency_key);
  assert.notEqual(first.event_sha256, later.event_sha256);
  assert.equal(first.payload.status, 'suggested');
  assert.match(reviewModule.hashCanonicalValue({ b: 2, a: 1 }), /^[a-f0-9]{64}$/);
  assert.equal(
    reviewModule.hashCanonicalValue({ b: 2, a: 1 }),
    reviewModule.hashCanonicalValue({ a: 1, b: 2 }),
  );
});

test('HumanCorrection records field-level deltas without mutating the suggestion', () => {
  assert.equal(typeof reviewModule.buildHumanCorrection, 'function');
  assert.equal(typeof reviewModule.buildHumanCorrectionEvent, 'function');
  const suggestion = reviewModule.normalizeReviewSuggestion(validSuggestion());
  const snapshot = structuredClone(suggestion);

  const correction = reviewModule.buildHumanCorrection({
    suggestion,
    humanReviewEvent: validHumanReview(),
    correctionReason: 'Human inspection found a style improvement and a different hierarchy issue.',
  });

  assert.deepEqual(suggestion, snapshot);
  assert.equal(correction.schema_version, 'ai-img-gen.human-review-correction.v1');
  assert.equal(correction.suggestion_id, suggestion.suggestion_id);
  assert.equal(correction.human_review_event_id, 'review-event-001');
  assert.deepEqual(correction.field_deltas.face_identity_fidelity, {
    suggested: 8.4,
    human: 8,
    delta: -0.4,
    state: 'corrected',
  });
  assert.deepEqual(correction.field_deltas.realism_naturalness, {
    suggested: 7.2,
    human: 7.2,
    delta: 0,
    state: 'accepted',
  });
  assert.deepEqual(correction.field_deltas.diagnostic_codes, {
    suggested: ['emotion_unclear', 'subject_not_primary'],
    human: ['emotion_unclear', 'elements_incoherent'],
    added: ['elements_incoherent'],
    removed: ['subject_not_primary'],
    state: 'corrected',
  });
  assert.equal(correction.has_corrections, true);
  assert.equal(correction.correction_count, 3);

  const event = reviewModule.buildHumanCorrectionEvent({ suggestion, humanReviewEvent: validHumanReview() });
  assert.equal(event.event_type, 'human_review_correction.recorded');
  assert.equal(event.payload.suggestion_id, suggestion.suggestion_id);
});

test('HumanCorrection represents a no-difference confirmation stably', () => {
  const suggestion = reviewModule.normalizeReviewSuggestion(validSuggestion());
  const humanReviewEvent = validHumanReview({
    face_identity_fidelity: suggestion.face_identity_fidelity,
    realism_naturalness: suggestion.realism_naturalness,
    style_consistency: suggestion.style_consistency,
    diagnostic_codes: suggestion.diagnostic_codes,
  });
  const first = reviewModule.buildHumanCorrection({ suggestion, humanReviewEvent });
  const second = reviewModule.buildHumanCorrection({ suggestion, humanReviewEvent });

  assert.deepEqual(first, second);
  assert.equal(first.has_corrections, false);
  assert.equal(first.correction_count, 0);
  assert.equal(first.correction_reason, null);
  assert.equal(first.field_deltas.face_identity_fidelity.state, 'accepted');
  assert.equal(first.field_deltas.diagnostic_codes.state, 'accepted');
});

const validExperiment = (overrides = {}) => ({
  experiment_id: 'prompt-exp-001',
  variant_id: 'compiler-v1-policy-a-model-a',
  compiler_id: 'portrait-prompt-compiler',
  compiler_version: '1.0.0',
  policy_id: 'portrait-policy',
  policy_version: '2026-08-25',
  provider_id: 'opencodex',
  model_id: 'review-model-a',
  model_version: '2026-08-25',
  run_id: 'run-001',
  outcome_id: 'outcome-001',
  metrics: { face_identity_fidelity: 8.4, naturalness: 7.2, latency_ms: 1200 },
  ...overrides,
});

test('PromptExperiment v1 links exact versions to run, outcome, and metrics without causal or promotion claims', () => {
  assert.equal(typeof experimentModule.normalizePromptExperiment, 'function');
  assert.equal(typeof experimentModule.buildPromptExperimentEvent, 'function');
  const experiment = experimentModule.normalizePromptExperiment(validExperiment());

  assert.equal(experiment.schema_version, 'ai-img-gen.prompt-experiment.v1');
  assert.equal(experiment.compiler_version, '1.0.0');
  assert.equal(experiment.policy_version, '2026-08-25');
  assert.equal(experiment.model_version, '2026-08-25');
  assert.equal(experiment.run_id, 'run-001');
  assert.equal(experiment.outcome_id, 'outcome-001');
  assert.equal(experiment.claim_scope, 'descriptive_observation_only');
  assert.equal(experiment.causal_claim, false);
  assert.equal(experiment.promotion_state, 'not_promoted');

  const event = experimentModule.buildPromptExperimentEvent(validExperiment(), { occurredAt: '2026-08-25T00:00:00.000Z' });
  assert.equal(event.event_type, 'prompt_experiment.observed');
  assert.equal(event.payload.promotion_state, 'not_promoted');

  assert.throws(() => experimentModule.normalizePromptExperiment(validExperiment({ causal_claim: true })), /causal/i);
  assert.throws(() => experimentModule.normalizePromptExperiment(validExperiment({ promotion_state: 'promoted' })), /promotion/i);
  assert.throws(() => experimentModule.normalizePromptExperiment(validExperiment({ metrics: { score: Number.NaN } })), /metric/i);
  assert.throws(() => experimentModule.normalizePromptExperiment(validExperiment({ outcome_id: '' })), /outcome_id.*required/i);
});

test('PromptExperiment aggregation is deterministic, variant-scoped, idempotent, and descriptive only', () => {
  assert.equal(typeof experimentModule.aggregatePromptExperiments, 'function');
  const first = experimentModule.buildPromptExperimentEvent(validExperiment(), { occurredAt: '2026-08-25T00:00:00.000Z' });
  const second = experimentModule.buildPromptExperimentEvent(validExperiment({
    experiment_id: 'prompt-exp-002',
    run_id: 'run-002',
    outcome_id: 'outcome-002',
    metrics: { face_identity_fidelity: 7.6, naturalness: 8.0, latency_ms: 800 },
  }), { occurredAt: '2026-08-25T00:01:00.000Z' });
  const other = experimentModule.normalizePromptExperiment(validExperiment({
    experiment_id: 'prompt-exp-003',
    variant_id: 'compiler-v1-policy-b-model-a',
    policy_version: '2026-08-26',
    run_id: 'run-003',
    outcome_id: 'outcome-003',
  }));

  const aggregate = experimentModule.aggregatePromptExperiments([second, first, first, other]);
  assert.equal(aggregate.schema_version, 'ai-img-gen.prompt-experiment-aggregate.v1');
  assert.equal(aggregate.causal_claim, false);
  assert.equal(aggregate.promotion_state, 'not_promoted');
  assert.equal(aggregate.interpretation, 'descriptive_observational_summary_only');
  assert.deepEqual(aggregate.variants.map((item) => item.variant_id), [
    'compiler-v1-policy-a-model-a',
    'compiler-v1-policy-b-model-a',
  ]);
  const variant = aggregate.variants[0];
  assert.equal(variant.observation_count, 2);
  assert.deepEqual(variant.run_ids, ['run-001', 'run-002']);
  assert.deepEqual(variant.metrics.face_identity_fidelity, { count: 2, sum: 16, mean: 8, min: 7.6, max: 8.4 });
  assert.equal('recommended_variant' in aggregate, false);
});

test('Provider Contract keeps only deterministic active and resolves exact provider/model capabilities', () => {
  assert.equal(typeof providerModule.createProviderContractRegistry, 'function');
  assert.equal(typeof providerModule.resolveProviderCapability, 'function');
  const registry = providerModule.createProviderContractRegistry();
  const statuses = registry.statuses();

  assert.equal(statuses.find((item) => item.id === 'deterministic').state, 'active');
  assert.equal(statuses.find((item) => item.id === 'opencodex').state, 'disabled_pending_contract');
  assert.equal(statuses.find((item) => item.id === 'codex-cli').state, 'reserved_offline');

  const resolved = registry.resolve({
    providerId: 'deterministic',
    modelId: 'deterministic-v1',
    capability: 'prompt_compilation',
    inputModalities: ['structured'],
    structuredOutput: true,
  });
  assert.equal(resolved.provider_id, 'deterministic');
  assert.equal(resolved.model_id, 'deterministic-v1');

  assert.throws(() => registry.resolve({ providerId: 'deterministic', modelId: 'different-model', capability: 'prompt_compilation', inputModalities: ['structured'], structuredOutput: true }), /exact model/i);
  assert.throws(() => registry.resolve({ providerId: 'deterministic', modelId: 'deterministic-v1', capability: 'review_suggestion', inputModalities: ['image'], structuredOutput: true }), /exact capability/i);
  assert.throws(() => registry.resolve({ providerId: 'opencodex', modelId: 'review-model-a', capability: 'review_suggestion', inputModalities: ['image'], structuredOutput: true }), /disabled_pending_contract/i);
  assert.throws(() => providerModule.resolveProviderCapability({ providerId: 'codex-cli', modelId: 'codex-offline', capability: 'review_suggestion' }), /reserved_offline/i);
});

test('structured provider response validation rejects invalid or incomplete payloads', () => {
  assert.equal(typeof providerModule.validateStructuredProviderResponse, 'function');
  const schema = {
    type: 'object',
    required: ['score', 'action'],
    additionalProperties: false,
    properties: {
      score: { type: 'number', minimum: 0, maximum: 10 },
      action: { type: 'string', enum: ['review'] },
    },
  };

  assert.deepEqual(
    providerModule.validateStructuredProviderResponse('{"score":8.5,"action":"review"}', { schema }),
    { score: 8.5, action: 'review' },
  );
  assert.throws(() => providerModule.validateStructuredProviderResponse('{"score":8.5}', { schema }), /missing required.*action/i);
  assert.throws(() => providerModule.validateStructuredProviderResponse('{"score":"8.5","action":"review"}', { schema }), /expected number/i);
  assert.throws(() => providerModule.validateStructuredProviderResponse('{"score":8.5,"action":"review","extra":true}', { schema }), /unexpected property.*extra/i);
  assert.throws(() => providerModule.validateStructuredProviderResponse('not-json', { schema }), /valid json/i);
  assert.throws(() => providerModule.validateStructuredProviderResponse({ score: 8.5, action: 'review' }), /schema.*required/i);
});
