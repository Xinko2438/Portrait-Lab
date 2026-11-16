const CAPTURE_STATUSES = new Set([
  'submitted',
  'capture_timeout',
  'capture_pending',
  'result_recovery',
  'results_recovery',
  'capture_ambiguous',
  'capture_error',
  'artifacts_saved',
  'preference_pending',
  'completed',
]);
const NEW_TASK_STATUSES = new Set(['', 'new', 'new_task']);
const PRE_SEND_CONTINUE_STATUSES = new Set(['prepared', 'provider_error', 'provider_rate_limited']);
const KNOWN_RUN_STATUSES = new Set([
  ...CAPTURE_STATUSES,
  ...PRE_SEND_CONTINUE_STATUSES,
  'staged',
  'submission_uncertain',
]);

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sourceState(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const manifest = source.manifest && typeof source.manifest === 'object' ? source.manifest : source;
  return { source, manifest };
}

function currentRunId(input = {}) {
  const { source, manifest } = sourceState(input);
  return clean(manifest.run_id) || clean(source.currentRunId ?? source.runId ?? source.run_id);
}

function statusOf(input = {}) {
  const { source, manifest } = sourceState(input);
  return (clean(manifest.status) || clean(source.status)).toLowerCase();
}

function deepClone(value) {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // Fall through for non-cloneable, JSON-shaped UI values.
    }
  }
  if (Array.isArray(value)) return value.map((item) => deepClone(item));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepClone(item)]));
}

function countEvidence(value) {
  const present = value !== undefined && value !== null;
  if (!present) return { present: false, valid: true, value: 0 };
  const valid = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  return { present: true, valid, value: valid ? value : 0 };
}

function artifactEvidence(input = {}) {
  const { source, manifest } = sourceState(input);
  const artifacts = Array.isArray(manifest.artifacts)
    ? manifest.artifacts
    : (Array.isArray(source.artifacts) ? source.artifacts : []);
  const explicit = countEvidence(
    manifest.artifact_count ?? source.artifactCount ?? source.artifact_count,
  );
  return {
    count: Math.max(artifacts.length, explicit.valid ? explicit.value : 0),
    invalid: explicit.present && !explicit.valid,
    hasEvidence: artifacts.length > 0 || (explicit.valid && explicit.value > 0),
  };
}

function artifactCount(input = {}) {
  return artifactEvidence(input).count;
}

function submissionAttemptEvidence(input = {}) {
  const { source, manifest } = sourceState(input);
  return countEvidence(
    manifest.submission_attempt_count
      ?? source.submissionAttemptCount
      ?? source.submission_attempt_count,
  );
}

function orphanedLifecycleEvidence(input = {}) {
  const status = statusOf(input);
  const attempts = submissionAttemptEvidence(input);
  const artifacts = artifactEvidence(input);
  return !NEW_TASK_STATUSES.has(status)
    || attempts.invalid
    || attempts.value > 0
    || artifacts.invalid
    || artifacts.hasEvidence;
}

function displayName(value) {
  if (typeof value === 'string') return clean(value);
  if (!value || typeof value !== 'object') return '';
  return clean(value.display_name ?? value.customer_name ?? value.template_name
    ?? value.filename ?? value.name ?? value.label ?? value.role);
}

function displayValue(value) {
  if (Array.isArray(value)) return value.map((item) => displayValue(item)).join('、');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function formatRunIdentity(runId) {
  const fullId = clean(runId);
  const visibleId = fullId.length > 17
    ? `${fullId.slice(0, 8)}…${fullId.slice(-8)}`
    : fullId;
  return { fullId, visibleId, title: fullId };
}

export function deriveSubmitRecoveryState(input = {}) {
  if (!currentRunId(input)) {
    return orphanedLifecycleEvidence(input) ? 'orphaned_recovery_blocked' : 'new_task';
  }
  const status = statusOf(input);
  if (!KNOWN_RUN_STATUSES.has(status)) return 'orphaned_recovery_blocked';

  const artifacts = artifactEvidence(input);
  if (artifacts.count > 0) return 'artifacts_review';

  const attempts = submissionAttemptEvidence(input);
  if (status === 'submission_uncertain') return 'submission_uncertain_capture_only';
  if (CAPTURE_STATUSES.has(status)) return 'submitted_capture';
  if (status !== 'staged' && !PRE_SEND_CONTINUE_STATUSES.has(status)) {
    return 'orphaned_recovery_blocked';
  }
  if (artifacts.invalid || !attempts.valid || attempts.value > 0) {
    return 'submission_uncertain_capture_only';
  }
  if (status === 'staged') return 'staged_send_once';
  return 'prepared_continue_same_run';
}

export function deriveStageAvailability(input = {}) {
  const hasRun = Boolean(currentRunId(input));
  const hasArtifacts = artifactCount(input) > 0;
  const recoveryState = deriveSubmitRecoveryState(input);
  if (recoveryState === 'orphaned_recovery_blocked') {
    return { references: true, generation: false, results: false, review: false };
  }
  const hasResultEvidence = hasRun && (
    hasArtifacts
    || recoveryState === 'submitted_capture'
    || recoveryState === 'submission_uncertain_capture_only'
  );

  return {
    references: true,
    generation: hasRun,
    results: hasResultEvidence,
    review: hasRun && hasArtifacts,
  };
}

export function derivePrimaryAction(input = {}) {
  const recoveryState = deriveSubmitRecoveryState(input);
  const actions = {
    new_task: {
      kind: 'create_stage_submit_once',
      createsRun: true,
      stagesRun: true,
      submitsOnce: true,
      capturesResults: false,
      opensReview: false,
    },
    orphaned_recovery_blocked: {
      kind: 'manual_recovery_required',
      createsRun: false,
      stagesRun: false,
      submitsOnce: false,
      capturesResults: false,
      opensReview: false,
    },
    prepared_continue_same_run: {
      kind: 'continue_same_run',
      createsRun: false,
      stagesRun: true,
      submitsOnce: true,
      capturesResults: false,
      opensReview: false,
    },
    staged_send_once: {
      kind: 'submit_once_same_run',
      createsRun: false,
      stagesRun: false,
      submitsOnce: true,
      capturesResults: false,
      opensReview: false,
    },
    submitted_capture: {
      kind: 'capture_results',
      createsRun: false,
      stagesRun: false,
      submitsOnce: false,
      capturesResults: true,
      opensReview: false,
    },
    submission_uncertain_capture_only: {
      kind: 'capture_only',
      createsRun: false,
      stagesRun: false,
      submitsOnce: false,
      capturesResults: true,
      opensReview: false,
    },
    artifacts_review: {
      kind: 'review_artifacts',
      createsRun: false,
      stagesRun: false,
      submitsOnce: false,
      capturesResults: false,
      opensReview: true,
    },
  };

  return {
    recoveryState,
    ...actions[recoveryState],
    autoRetry: false,
    manualRecovery: recoveryState === 'orphaned_recovery_blocked',
  };
}

export function buildSendSummary(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const customerSource = source.customer ?? source.customerName ?? source.customer_name;
  const customerObject = customerSource && typeof customerSource === 'object' ? customerSource : {};
  const customer = {
    id: clean(customerObject.customer_id ?? customerObject.id ?? source.customerId ?? source.customer_id),
    label: displayName(customerSource) || clean(source.customerName ?? source.customer_name),
  };

  const identityReferences = Array.isArray(source.identityReferences)
    ? source.identityReferences
    : (Array.isArray(source.identity_references) ? source.identity_references : []);
  const explicitIdentityCount = countEvidence(source.identityCount ?? source.identity_count);
  const identityCount = explicitIdentityCount.present && explicitIdentityCount.valid
    ? explicitIdentityCount.value
    : identityReferences.length;
  const primarySource = source.primaryIdentity ?? source.primary_identity ?? identityReferences.find((reference) => (
    reference?.is_primary === true
    || reference?.primary === true
    || ['primary', 'primary_front', 'front_primary'].includes(clean(reference?.role).toLowerCase())
  ));
  const primaryIdentity = displayName(primarySource);

  const templateReferences = Array.isArray(source.templateReferences)
    ? source.templateReferences
    : (Array.isArray(source.template_references) ? source.template_references : []);
  const templateNames = templateReferences.map((template) => displayName(template)).filter(Boolean);
  const explicitTemplateCount = countEvidence(source.templateCount ?? source.template_count);
  const templateCount = explicitTemplateCount.present && explicitTemplateCount.valid
    ? explicitTemplateCount.value
    : templateReferences.length;

  const useCase = clean(source.useCase ?? source.use_case ?? source.intendedUse ?? source.intended_use);
  const explicitOverrides = source.explicitOverrides ?? source.explicit_overrides ?? {};
  const labels = source.overrideLabels ?? source.override_labels ?? {};
  const overrides = explicitOverrides && typeof explicitOverrides === 'object' && !Array.isArray(explicitOverrides)
    ? Object.keys(explicitOverrides)
      .sort()
      .filter((key) => {
        const value = explicitOverrides[key];
        return value !== undefined && value !== null && !(typeof value === 'string' && !value.trim());
      })
      .map((key) => ({ key, label: clean(labels[key]) || key, value: deepClone(explicitOverrides[key]) }))
    : [];

  const identityLine = identityCount ? `客户图：${identityCount} 张${primaryIdentity ? `（主图：${primaryIdentity}）` : ''}` : '客户图：还未添加';
  const templateLine = templateNames.length ? `模板：${templateNames.join('、')}` : '模板：还未选择';
  const overrideLine = overrides.length
    ? overrides.map((item) => `${item.label}=${displayValue(item.value)}`).join('；')
    : '无';

  return {
    transient: true,
    authorizesSubmission: false,
    persists: false,
    customer,
    identities: { count: identityCount, primary: primaryIdentity },
    templates: { count: templateCount, names: templateNames },
    useCase,
    overrides,
    lines: [
      ...(customer.label ? [`客户：${customer.label}`] : []),
      identityLine,
      templateLine,
      ...(useCase ? [`用途：${useCase}`] : []),
      ...(overrides.length ? [`你调整了：${overrideLine}`] : []),
    ],
  };
}

export function deriveCustomerFieldVisibility(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const mode = clean(source.mode ?? source.customerMode ?? source.customer_mode).toLowerCase() === 'new'
    ? 'new'
    : 'existing';
  const isNew = mode === 'new';
  return {
    mode,
    showExistingCustomerFields: !isNew,
    showNewCustomerFields: isNew,
    requiresExistingCustomerSelection: !isNew,
    requiresNewCustomerName: isNew,
    requiresIdentityUpload: isNew,
  };
}
