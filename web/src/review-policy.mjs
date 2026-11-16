import { REVIEW_RUBRIC, REVIEW_DIMENSIONS, REVIEW_DIAGNOSTICS } from './rubric.mjs';

const inputFields = {
  face_identity_fidelity: ['faceFidelity', 'face_identity_fidelity'],
  realism_naturalness: ['naturalness', 'realismNaturalness', 'realism_naturalness'],
  style_consistency: ['style', 'styleConsistency', 'style_consistency'],
};

const verdictByDimension = {
  face_identity_fidelity: 'identity_rejected',
  realism_naturalness: 'naturalness_revise',
  style_consistency: 'style_revise',
};

function readInput(review, names) {
  for (const name of names) {
    if (review?.[name] !== undefined && review?.[name] !== null && review?.[name] !== '') return review[name];
  }
  return undefined;
}

function normalizeScore(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < REVIEW_RUBRIC.score.min || number > REVIEW_RUBRIC.score.max) {
    throw new Error(`${label} must be between ${REVIEW_RUBRIC.score.min} and ${REVIEW_RUBRIC.score.max}`);
  }
  if (Math.abs(number * 10 - Math.round(number * 10)) > Number.EPSILON * 100) {
    throw new Error(`${label} must use at most one decimal place`);
  }
  return Math.round(number * 10) / 10;
}

function assertNoRetiredScoreInputs(review) {
  const retired = (REVIEW_RUBRIC.retired_score_inputs || []).filter((name) => (
    review?.[name] !== undefined && review?.[name] !== null && review?.[name] !== ''
  ));
  if (retired.length) {
    throw new Error(`Retired score fields must be replaced by diagnostic codes: ${retired.join(', ')}`);
  }
}

function normalizeDiagnosticCodes(review) {
  const raw = review?.diagnosticCodes ?? review?.diagnostic_codes ?? [];
  const values = Array.isArray(raw) ? raw : [raw];
  const selected = new Set();
  for (const value of values) {
    const code = String(value || '').trim();
    if (!code) continue;
    if (!REVIEW_DIAGNOSTICS.has(code)) throw new Error(`Unknown diagnostic code: ${code}`);
    selected.add(code);
  }
  return [...REVIEW_DIAGNOSTICS.keys()].filter((code) => selected.has(code));
}

export function evaluateReview(review = {}) {
  assertNoRetiredScoreInputs(review);
  const scores = {};
  for (const dimension of REVIEW_RUBRIC.dimensions) {
    scores[dimension.id] = normalizeScore(readInput(review, inputFields[dimension.id] || [dimension.id]), dimension.label);
  }

  const failed = REVIEW_RUBRIC.verdict_priority
    .filter((dimensionId) => scores[dimensionId] < REVIEW_DIMENSIONS.get(dimensionId).threshold)
    .map((dimensionId) => {
      const dimension = REVIEW_DIMENSIONS.get(dimensionId);
      return {
        dimension: dimensionId,
        label: dimension.label,
        score: scores[dimensionId],
        threshold: dimension.threshold,
        next_action: dimension.next_action_on_fail,
      };
    });

  const diagnosticCodes = normalizeDiagnosticCodes(review);
  const diagnosticFindings = diagnosticCodes.map((code) => {
    const diagnostic = REVIEW_DIAGNOSTICS.get(code);
    return {
      code,
      label: diagnostic.label,
      group: diagnostic.group,
      group_label: diagnostic.group_label,
      customer_scoped: diagnostic.customer_scoped,
      prompt_guidance: diagnostic.prompt_guidance,
    };
  });

  const primaryFailure = failed[0] || null;
  const verdict = primaryFailure ? verdictByDimension[primaryFailure.dimension] : 'qualified';
  const identityRejected = primaryFailure?.dimension === 'face_identity_fidelity';
  const qualified = failed.length === 0;
  return {
    ...scores,
    diagnostic_codes: diagnosticCodes,
    diagnostic_findings: diagnosticFindings,
    review_rubric_version: REVIEW_RUBRIC.rubric_version,
    failed_dimensions: failed,
    verdict,
    gate_state: identityRejected ? 'terminal_rejected' : (failed.length ? 'needs_revision' : 'qualified'),
    reusable: qualified,
    preference_eligible: qualified,
    identity_reference_eligible: qualified,
    next_action: primaryFailure?.next_action || 'eligible_for_preference',
  };
}
