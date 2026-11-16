import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSendSummary,
  deriveCustomerFieldVisibility,
  derivePrimaryAction,
  deriveStageAvailability,
  deriveSubmitRecoveryState,
  formatRunIdentity,
} from '../public/workbench-optimization-state.js';

test('formatRunIdentity keeps the complete Run ID available while shortening only its visible label', () => {
  const fullId = 'run-20260830123456789-abcdef123456';

  assert.deepEqual(formatRunIdentity(fullId), {
    fullId,
    visibleId: 'run-2026…ef123456',
    title: fullId,
  });
  assert.deepEqual(formatRunIdentity(' run-123 '), {
    fullId: 'run-123',
    visibleId: 'run-123',
    title: 'run-123',
  });
  assert.deepEqual(formatRunIdentity(), { fullId: '', visibleId: '', title: '' });
});

test('deriveSubmitRecoveryState classifies create, continue, submit, capture, and review evidence', () => {
  const cases = [
    ['orphaned prepared state', { status: 'prepared', submission_attempt_count: 0 }, 'orphaned_recovery_blocked'],
    ['prepared', { currentRunId: 'run-1', status: 'prepared', submission_attempt_count: 0 }, 'prepared_continue_same_run'],
    ['provider error before send', { currentRunId: 'run-1', status: 'provider_error', submission_attempt_count: 0 }, 'prepared_continue_same_run'],
    ['rate limit before send', { currentRunId: 'run-1', status: 'provider_rate_limited', submission_attempt_count: 0 }, 'prepared_continue_same_run'],
    ['staged before send', { currentRunId: 'run-1', status: 'staged', submission_attempt_count: 0 }, 'staged_send_once'],
    ['submitted', { currentRunId: 'run-1', status: 'submitted', submission_attempt_count: 0 }, 'submitted_capture'],
    ['capture timeout', { currentRunId: 'run-1', status: 'capture_timeout', submission_attempt_count: 0 }, 'submitted_capture'],
    ['capture recovery', { currentRunId: 'run-1', status: 'capture_pending', submission_attempt_count: 0 }, 'submitted_capture'],
    ['result recovery', { currentRunId: 'run-1', status: 'result_recovery', submission_attempt_count: 0 }, 'submitted_capture'],
    ['uncertain submission', { currentRunId: 'run-1', status: 'submission_uncertain', submission_attempt_count: 0 }, 'submission_uncertain_capture_only'],
    ['recorded attempt from a prepared status', { currentRunId: 'run-1', status: 'prepared', submission_attempt_count: 1 }, 'submission_uncertain_capture_only'],
    ['recorded attempt from a staged status', { currentRunId: 'run-1', status: 'staged', submission_attempt_count: 2 }, 'submission_uncertain_capture_only'],
    ['saved artifact', { currentRunId: 'run-1', status: 'submission_uncertain', submission_attempt_count: 1, artifact_count: 1 }, 'artifacts_review'],
  ];

  for (const [name, input, expected] of cases) {
    assert.equal(deriveSubmitRecoveryState(input), expected, name);
  }
});

test('missing Run identity with lifecycle evidence is blocked for manual recovery instead of treated as new', () => {
  const orphanedCases = [
    { status: 'prepared' },
    { status: 'submitted' },
    { submission_attempt_count: 1 },
    { artifacts: [{ artifact_id: 'artifact-orphaned' }] },
  ];

  for (const input of orphanedCases) {
    assert.equal(deriveSubmitRecoveryState(input), 'orphaned_recovery_blocked');
    assert.deepEqual(deriveStageAvailability(input), {
      references: true,
      generation: false,
      results: false,
      review: false,
    });
    const action = derivePrimaryAction(input);
    assert.equal(action.kind, 'manual_recovery_required');
    assert.equal(action.createsRun, false);
    assert.equal(action.stagesRun, false);
    assert.equal(action.submitsOnce, false);
    assert.equal(action.capturesResults, false);
    assert.equal(action.opensReview, false);
    assert.equal(action.manualRecovery, true);
  }

  assert.equal(deriveSubmitRecoveryState({ status: '', submission_attempt_count: 0, artifacts: [] }), 'new_task');
});

test('corrupt submission-attempt evidence fails closed and cannot make an existing Run sendable', () => {
  for (const submission_attempt_count of [true, false, 0.5, -1, 'corrupt']) {
    const input = { currentRunId: 'run-corrupt', status: 'staged', submission_attempt_count };
    assert.equal(deriveSubmitRecoveryState(input), 'submission_uncertain_capture_only');
    assert.equal(derivePrimaryAction(input).submitsOnce, false);
  }

  assert.equal(deriveStageAvailability({
    currentRunId: 'run-corrupt-artifacts',
    status: 'prepared',
    artifact_count: true,
  }).review, false);
  assert.equal(deriveStageAvailability({
    currentRunId: 'run-corrupt-artifacts',
    status: 'prepared',
    artifact_count: 1.5,
  }).review, false);
});

test('an existing Run is sendable only from explicit known pre-send statuses', () => {
  for (const status of ['', 'new', 'unknown_status', true, {}]) {
    const input = { currentRunId: 'run-unknown-status', status, submission_attempt_count: 0 };
    assert.equal(deriveSubmitRecoveryState(input), 'orphaned_recovery_blocked');
    const action = derivePrimaryAction(input);
    assert.equal(action.kind, 'manual_recovery_required');
    assert.equal(action.submitsOnce, false);
    assert.equal(action.manualRecovery, true);
  }

  const unknownWithArtifacts = {
    currentRunId: 'run-unknown-with-artifacts',
    status: 'unknown_status',
    submission_attempt_count: 0,
    artifacts: [{ artifact_id: 'artifact-untrusted-status' }],
  };
  assert.equal(deriveSubmitRecoveryState(unknownWithArtifacts), 'orphaned_recovery_blocked');
  assert.deepEqual(deriveStageAvailability(unknownWithArtifacts), {
    references: true,
    generation: false,
    results: false,
    review: false,
  });

  assert.equal(deriveSubmitRecoveryState({
    currentRunId: 'run-prepared',
    status: 'prepared',
    submission_attempt_count: 0,
  }), 'prepared_continue_same_run');
  assert.equal(deriveSubmitRecoveryState({
    currentRunId: 'run-provider-error',
    status: 'provider_error',
    submission_attempt_count: 0,
  }), 'prepared_continue_same_run');
  assert.equal(deriveSubmitRecoveryState({
    currentRunId: 'run-rate-limited',
    status: 'provider_rate_limited',
    submission_attempt_count: 0,
  }), 'prepared_continue_same_run');
  assert.equal(deriveSubmitRecoveryState({
    currentRunId: 'run-staged',
    status: 'staged',
    submission_attempt_count: 0,
  }), 'staged_send_once');
});

test('corrupt Artifact-count evidence is consumed by recovery and blocks staged submission', () => {
  for (const artifact_count of [true, false, 0.5, -1, 'corrupt']) {
    const input = {
      currentRunId: 'run-corrupt-artifact-count',
      status: 'staged',
      submission_attempt_count: 0,
      artifact_count,
    };
    assert.equal(deriveSubmitRecoveryState(input), 'submission_uncertain_capture_only');
    assert.equal(derivePrimaryAction(input).submitsOnce, false);
  }
});

test('nested manifest lifecycle evidence overrides empty wrapper defaults and can never become sendable', () => {
  const attempted = {
    currentRunId: 'run-attempted',
    status: 'prepared',
    submission_attempt_count: 0,
    artifacts: [],
    manifest: {
      run_id: 'run-attempted',
      status: 'provider_error',
      submission_attempt_count: 1,
      artifacts: [],
    },
  };

  assert.equal(deriveSubmitRecoveryState(attempted), 'submission_uncertain_capture_only');
  assert.deepEqual(deriveStageAvailability(attempted), {
    references: true,
    generation: true,
    results: true,
    review: false,
  });
  assert.equal(derivePrimaryAction(attempted).submitsOnce, false);

  const saved = {
    currentRunId: 'run-saved',
    status: '',
    submission_attempt_count: 0,
    artifacts: [],
    manifest: {
      run_id: 'run-saved',
      status: 'artifacts_saved',
      submission_attempt_count: 1,
      artifacts: [{ artifact_id: 'artifact-saved' }],
    },
  };

  assert.equal(deriveSubmitRecoveryState(saved), 'artifacts_review');
  assert.equal(deriveStageAvailability(saved).review, true);
});

test('deriveStageAvailability enables results and review only after their actual evidence exists', () => {
  const cases = [
    ['new task', {}, { references: true, generation: false, results: false, review: false }],
    ['prepared Run', { currentRunId: 'run-1', status: 'prepared' }, { references: true, generation: true, results: false, review: false }],
    ['staged Run', { currentRunId: 'run-1', status: 'staged' }, { references: true, generation: true, results: false, review: false }],
    ['pre-send provider failure', { currentRunId: 'run-1', status: 'provider_error', submission_attempt_count: 0 }, { references: true, generation: true, results: false, review: false }],
    ['recorded attempt', { currentRunId: 'run-1', status: 'provider_error', submission_attempt_count: 1 }, { references: true, generation: true, results: true, review: false }],
    ['submitted Run', { currentRunId: 'run-1', status: 'submitted' }, { references: true, generation: true, results: true, review: false }],
    ['uncertain Run', { currentRunId: 'run-1', status: 'submission_uncertain' }, { references: true, generation: true, results: true, review: false }],
    ['capture recovery', { currentRunId: 'run-1', status: 'capture_pending' }, { references: true, generation: true, results: true, review: false }],
    ['artifact evidence', { currentRunId: 'run-1', status: 'artifacts_saved', artifacts: [{ artifact_id: 'artifact-1' }] }, { references: true, generation: true, results: true, review: true }],
  ];

  for (const [name, input, expected] of cases) {
    assert.deepEqual(deriveStageAvailability(input), expected, name);
  }
});

test('derivePrimaryAction exposes create and submit permissions for each supplied recovery state', () => {
  const fresh = derivePrimaryAction({});
  assert.equal(fresh.kind, 'create_stage_submit_once');
  assert.equal(fresh.createsRun, true);
  assert.equal(fresh.submitsOnce, true);
  assert.equal(fresh.autoRetry, false);

  const existingCases = [
    [{ currentRunId: 'run-1', status: 'prepared' }, 'continue_same_run', true],
    [{ currentRunId: 'run-1', status: 'staged' }, 'submit_once_same_run', true],
    [{ currentRunId: 'run-1', status: 'submitted', submission_attempt_count: 1 }, 'capture_results', false],
    [{ currentRunId: 'run-1', status: 'submission_uncertain', submission_attempt_count: 1 }, 'capture_only', false],
    [{ currentRunId: 'run-1', status: 'artifacts_saved', artifacts: [{ artifact_id: 'artifact-1' }] }, 'review_artifacts', false],
  ];

  for (const [input, kind, submitsOnce] of existingCases) {
    const action = derivePrimaryAction(input);
    assert.equal(action.kind, kind);
    assert.equal(action.createsRun, false, kind);
    assert.equal(action.submitsOnce, submitsOnce, kind);
    assert.equal(action.autoRetry, false, kind);
  }
});

test('buildSendSummary reports exact transient inputs without becoming an authorization or persistent record', () => {
  const input = {
    customer: { customer_id: 'cust-opaque', display_name: '姑姑' },
    identityReferences: [
      { display_name: '正面主图', role: 'primary' },
      { display_name: '侧面补充', role: 'profile' },
    ],
    templateReferences: [
      { template_name: '湖边散步' },
      { template_name: '现代艺术馆' },
    ],
    useCase: '旅行环境写真',
    explicitOverrides: { requested_count: 2, aspect_ratio: '3:4', ignored_empty: '' },
    overrideLabels: { requested_count: '生成数量', aspect_ratio: '画幅' },
  };
  const before = structuredClone(input);

  const summary = buildSendSummary(input);

  assert.equal(summary.transient, true);
  assert.equal(summary.authorizesSubmission, false);
  assert.equal(summary.persists, false);
  assert.deepEqual(summary.customer, { id: 'cust-opaque', label: '姑姑' });
  assert.deepEqual(summary.identities, { count: 2, primary: '正面主图' });
  assert.deepEqual(summary.templates, { count: 2, names: ['湖边散步', '现代艺术馆'] });
  assert.equal(summary.useCase, '旅行环境写真');
  assert.deepEqual(summary.overrides, [
    { key: 'aspect_ratio', label: '画幅', value: '3:4' },
    { key: 'requested_count', label: '生成数量', value: 2 },
  ]);
  assert.deepEqual(summary.lines, [
    '客户：姑姑',
    '客户图：2 张（主图：正面主图）',
    '模板：湖边散步、现代艺术馆',
    '用途：旅行环境写真',
    '你调整了：画幅=3:4；生成数量=2',
  ]);
  assert.deepEqual(input, before);
});

test('buildSendSummary keeps missing optional details explicit instead of inventing them', () => {
  const summary = buildSendSummary({
    customer: '临时客户',
    identityCount: 3,
    primaryIdentity: '',
    templateReferences: [],
    useCase: '',
    explicitOverrides: {},
  });

  assert.deepEqual(summary.identities, { count: 3, primary: '' });
  assert.deepEqual(summary.templates, { count: 0, names: [] });
  assert.deepEqual(summary.lines, [
    '客户：临时客户',
    '客户图：3 张',
    '模板：还未选择',
  ]);
});

test('buildSendSummary deep-clones nested override values before returning its transient DTO', () => {
  const input = {
    explicitOverrides: {
      render: { crop: { ratio: '3:4' }, flags: ['soft-light'] },
    },
  };
  const summary = buildSendSummary(input);

  summary.overrides[0].value.crop.ratio = '1:1';
  summary.overrides[0].value.flags.push('changed');

  assert.deepEqual(input.explicitOverrides.render, {
    crop: { ratio: '3:4' },
    flags: ['soft-light'],
  });
});

test('buildSendSummary accepts only nonnegative integer counts and otherwise falls back to observed references', () => {
  const identityReferences = [{ name: 'identity-1' }, { name: 'identity-2' }];
  const templateReferences = [{ template_name: 'template-1' }];

  for (const invalidCount of [true, false, 1.5, -1, '2', 'corrupt']) {
    const summary = buildSendSummary({
      identityReferences,
      identityCount: invalidCount,
      templateReferences,
      templateCount: invalidCount,
    });
    assert.equal(summary.identities.count, 2);
    assert.equal(summary.templates.count, 1);
  }

  const explicit = buildSendSummary({ identityReferences, identityCount: 3, templateReferences, templateCount: 4 });
  assert.equal(explicit.identities.count, 3);
  assert.equal(explicit.templates.count, 4);
});

test('deriveCustomerFieldVisibility separates existing-customer reuse from new-customer creation', () => {
  assert.deepEqual(deriveCustomerFieldVisibility({ mode: 'existing', selectedCustomerId: 'cust-1' }), {
    mode: 'existing',
    showExistingCustomerFields: true,
    showNewCustomerFields: false,
    requiresExistingCustomerSelection: true,
    requiresNewCustomerName: false,
    requiresIdentityUpload: false,
  });

  assert.deepEqual(deriveCustomerFieldVisibility({ customerMode: 'new' }), {
    mode: 'new',
    showExistingCustomerFields: false,
    showNewCustomerFields: true,
    requiresExistingCustomerSelection: false,
    requiresNewCustomerName: true,
    requiresIdentityUpload: true,
  });

  assert.equal(deriveCustomerFieldVisibility({ mode: 'unexpected' }).mode, 'existing');
});
