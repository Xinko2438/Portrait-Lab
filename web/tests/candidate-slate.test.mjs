import test from 'node:test';
import assert from 'node:assert/strict';

const slateModule = await import('../src/intelligent-workbench/candidate-slate.mjs').catch(() => ({}));

const {
  CANDIDATE_SLATE_REQUEST_VERSION,
  CANDIDATE_SLATE_PROJECTION_VERSION,
  GENERATION_REGIME_VERSION,
  CANDIDATE_SLATE_PROMPT_POLICY_VERSION,
  buildCandidateSlateRequest,
  buildCandidateSlateRequestedEvent,
  candidateSlatePromptDirectives,
  projectCandidateSlate,
} = slateModule;

function artifact(index, overrides = {}) {
  return {
    artifact_id: `artifact-${index}`,
    sha256: index.toString(16).padStart(64, '0'),
    ...overrides,
  };
}

function requestEvent(overrides = {}, occurredAt = '2026-08-26T00:00:00.000Z') {
  return buildCandidateSlateRequestedEvent(overrides, { occurredAt });
}

test('CandidateSlateRequest defaults to the exact fixed two-candidate one-submit contract', () => {
  assert.equal(typeof buildCandidateSlateRequest, 'function');
  const request = buildCandidateSlateRequest();

  assert.equal(CANDIDATE_SLATE_REQUEST_VERSION, 'ai-img-gen.candidate-slate-request.v1');
  assert.equal(CANDIDATE_SLATE_PROJECTION_VERSION, 'ai-img-gen.candidate-slate-projection.v1');
  assert.equal(GENERATION_REGIME_VERSION, 'portrait-generation-v7-two-candidate');
  assert.equal(CANDIDATE_SLATE_PROMPT_POLICY_VERSION, 'candidate-slate-prompt-v1');
  assert.equal(request.schema_version, CANDIDATE_SLATE_REQUEST_VERSION);
  assert.match(request.slate_request_id, /^candidate-slate_[a-f0-9]{24}$/);
  assert.equal(request.generation_regime_version, GENERATION_REGIME_VERSION);
  assert.equal(request.requested_count, 2);
  assert.equal(request.minimum_acceptable_count, 1);
  assert.equal(request.maximum_capture_count, 4);
  assert.equal(request.submission_limit, 1);
  assert.equal(request.auto_resubmit, false);
  assert.equal(request.prompt_policy_version, CANDIDATE_SLATE_PROMPT_POLICY_VERSION);
  assert.deepEqual(request.variants, ['template_faithful', 'bounded_variation']);
});

test('CandidateSlateRequest rejects every attempt to weaken fixed count, send, retry, version, or variant limits', () => {
  const invalidOverrides = [
    { requested_count: 1 },
    { requested_count: 3 },
    { minimum_acceptable_count: 0 },
    { maximum_capture_count: 5 },
    { submission_limit: 2 },
    { auto_resubmit: true },
    { generation_regime_version: 'portrait-generation-v7-three-candidate' },
    { prompt_policy_version: 'candidate-slate-prompt-v2' },
    { variants: ['template_faithful'] },
    { variants: ['bounded_variation', 'template_faithful'] },
  ];

  for (const input of invalidOverrides) {
    assert.throws(() => buildCandidateSlateRequest(input), /fixed|must|cannot|contract/i);
  }

  assert.deepEqual(
    buildCandidateSlateRequest({
      requested_count: 2,
      minimum_acceptable_count: 1,
      maximum_capture_count: 4,
      submission_limit: 1,
      auto_resubmit: false,
      generation_regime_version: GENERATION_REGIME_VERSION,
      prompt_policy_version: CANDIDATE_SLATE_PROMPT_POLICY_VERSION,
      variants: ['template_faithful', 'bounded_variation'],
    }),
    buildCandidateSlateRequest(),
  );
});

test('CandidateSlateRequest and CandidateSlateRequested event identities are stable and timestamp-independent', () => {
  assert.equal(typeof buildCandidateSlateRequestedEvent, 'function');
  const requestA = buildCandidateSlateRequest();
  const requestB = buildCandidateSlateRequest({ submission_limit: 1, requested_count: 2 });
  const first = buildCandidateSlateRequestedEvent(requestA, { occurredAt: '2026-08-26T00:00:00.000Z' });
  const repeated = buildCandidateSlateRequestedEvent(requestB, { occurredAt: '2026-08-26T00:00:00.000Z' });
  const later = buildCandidateSlateRequestedEvent(requestB, { occurredAt: '2026-08-27T00:00:00.000Z' });

  assert.deepEqual(requestA, requestB);
  assert.equal(first.type, 'CandidateSlateRequested');
  assert.equal(first.event_id, repeated.event_id);
  assert.equal(first.idempotency_key, repeated.idempotency_key);
  assert.deepEqual(first.data, repeated.data);
  assert.equal(first.idempotency_key, later.idempotency_key);
  assert.equal(first.event_id, later.event_id);
  assert.deepEqual(first.data, later.data);
  assert.notEqual(first.recorded_at, later.recorded_at);
  assert.deepEqual(first.data.candidate_slate_request, requestA);
});

test('candidate slate prompt directives are deterministic Chinese instructions with bounded A/B roles and identity safety', () => {
  assert.equal(typeof candidateSlatePromptDirectives, 'function');
  const request = buildCandidateSlateRequest();
  const first = candidateSlatePromptDirectives(request);
  const second = candidateSlatePromptDirectives(structuredClone(request));

  assert.equal(first, second);
  assert.equal(typeof first, 'string');
  assert.match(first, /一次(?:性)?输出两张|一次输出两张/);
  assert.match(first, /A[^。\n]*(紧贴|严格遵循)[^。\n]*模板/);
  assert.match(first, /B[^。\n]*(姿势|表情|构图)[^。\n]*(有限|受限)/);
  assert.match(first, /身份[^。\n]*用途[^。\n]*风格[^。\n]*安全边界[^。\n]*不变/);
  assert.match(first, /不得[^。\n]*(带入|复制)[^。\n]*模板人物[^。\n]*身份/);
});

test('candidate slate projection maps zero through four active unique artifacts to the fixed business states', () => {
  assert.equal(typeof projectCandidateSlate, 'function');
  const events = [requestEvent()];
  const cases = [
    [0, 'pending'],
    [1, 'partial'],
    [2, 'complete'],
    [3, 'overcomplete'],
    [4, 'overcomplete'],
  ];

  for (const [count, status] of cases) {
    const artifacts = Array.from({ length: count }, (_, index) => artifact(index + 1));
    const projection = projectCandidateSlate({ events, artifacts });
    assert.equal(projection.schema_version, CANDIDATE_SLATE_PROJECTION_VERSION);
    assert.equal(projection.generation_regime_version, GENERATION_REGIME_VERSION);
    assert.equal(projection.requested_count, 2);
    assert.equal(projection.received_count, count);
    assert.deepEqual(projection.artifact_ids, artifacts.map((item) => item.artifact_id).sort());
    assert.equal(projection.status, status);
  }
});

test('candidate slate projection rejects more than four distinct active artifacts', () => {
  const artifacts = Array.from({ length: 5 }, (_, index) => artifact(index + 1));
  assert.throws(
    () => projectCandidateSlate({ events: [requestEvent()], artifacts }),
    /more than four|maximum.*4|exceeds/i,
  );
});

test('candidate slate projection is invariant to request/artifact order and deduplicates by artifact id or sha256', () => {
  const valid = requestEvent({}, '2026-08-26T01:00:00.000Z');
  const invalidLater = {
    ...valid,
    event_id: 'invalid-later',
    idempotency_key: 'invalid-later',
    recorded_at: '2026-08-27T01:00:00.000Z',
    data: { candidate_slate_request: { ...valid.data.candidate_slate_request, submission_limit: 2 } },
  };
  const first = artifact(1);
  const duplicateId = artifact(2, { artifact_id: first.artifact_id });
  const duplicateHash = artifact(3, { sha256: first.sha256 });
  const second = artifact(4, { artifact_id: 'artifact-2' });

  const forward = projectCandidateSlate({
    events: [invalidLater, valid, structuredClone(valid)],
    artifacts: [first, duplicateId, duplicateHash, second, structuredClone(second)],
  });
  const reversed = projectCandidateSlate({
    events: [structuredClone(valid), valid, invalidLater].reverse(),
    artifacts: [structuredClone(second), second, duplicateHash, duplicateId, first].reverse(),
  });

  assert.deepEqual(forward, reversed);
  assert.equal(forward.received_count, 2);
  assert.deepEqual(forward.artifact_ids, ['artifact-1', 'artifact-2']);
  assert.equal(forward.status, 'complete');
});

test('explicit ambiguity has status priority but never bypasses the four-artifact safety cap', () => {
  const events = [requestEvent()];
  const ambiguous = projectCandidateSlate({ events, artifacts: [artifact(1), artifact(2)], ambiguous: true });
  assert.equal(ambiguous.received_count, 2);
  assert.equal(ambiguous.status, 'ambiguous');

  assert.throws(
    () => projectCandidateSlate({
      events,
      artifacts: Array.from({ length: 5 }, (_, index) => artifact(index + 1)),
      ambiguous: true,
    }),
    /more than four|maximum.*4|exceeds/i,
  );
});

test('requested count and assignment-like events never count as artifact evidence', () => {
  const requested = requestEvent();
  const projection = projectCandidateSlate({
    events: [
      requested,
      { type: 'CandidateAssigned', recorded_at: '2026-08-26T02:00:00.000Z', data: { requested_count: 2, artifact_ids: ['claimed-a', 'claimed-b'] } },
    ],
  });

  assert.equal(projection.requested_count, 2);
  assert.equal(projection.received_count, 0);
  assert.deepEqual(projection.artifact_ids, []);
  assert.equal(projection.status, 'pending');
});

test('public candidate slate interface exposes no sender or retry operation and preserves one-send zero-resubmit invariants', () => {
  const request = buildCandidateSlateRequest();
  assert.equal(request.submission_limit, 1);
  assert.equal(request.auto_resubmit, false);
  assert.equal(
    Object.keys(slateModule).some((name) => /(^|_)(send|submit|retry|resubmit)(_|$)/i.test(name)),
    false,
  );
});
