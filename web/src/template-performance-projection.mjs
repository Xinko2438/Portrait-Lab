import {
  OUTCOME_INVALIDATED_EVENT_TYPE,
  OUTCOME_RECORDED_EVENT_TYPE,
  projectActiveTemplateOutcomes,
} from './template-outcome-lifecycle.mjs';

export const TEMPLATE_PERFORMANCE_PROJECTION_VERSION = 'ai-img-gen.template-performance.v2';
export const TEMPLATE_PERFORMANCE_MINIMUM_SHADOW_SUPPORT = 20;

export class TemplatePerformanceProjectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TemplatePerformanceProjectionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new TemplatePerformanceProjectionError(code, message);
}

function cleanString(value) {
  return String(value ?? '').trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function requireArray(value, field) {
  if (!Array.isArray(value)) fail('invalid_performance_input', `${field} must be an array`);
  return value;
}

function round(value, precision = 3) {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function average(values) {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function chosenTemplates(decision = {}) {
  const chosen = new Set([
    ...list(decision.accepted_template_uids),
    ...list(decision.selected_template_uids),
  ].map(cleanString).filter(Boolean));
  for (const uid of list(decision.removed_template_uids).map(cleanString).filter(Boolean)) chosen.delete(uid);
  for (const substitution of list(decision.substitutions)) {
    const removed = cleanString(substitution?.removed_template_uid);
    const added = cleanString(substitution?.added_template_uid);
    if (removed) chosen.delete(removed);
    if (added) chosen.add(added);
  }
  return [...chosen].sort((left, right) => left.localeCompare(right));
}

function choiceSupport(selectionProjections, selectionEvents) {
  const latestDecisionBySelection = new Map();
  for (const projection of selectionProjections) {
    const selectionId = cleanString(projection?.selection_id);
    if (selectionId && projection?.decision) latestDecisionBySelection.set(selectionId, projection.decision);
  }
  for (const event of selectionEvents) {
    if (event?.type !== 'TemplateSelectionDecisionRecorded' || !event.data?.decision) continue;
    const selectionId = cleanString(event.selection_id);
    if (selectionId) latestDecisionBySelection.set(selectionId, event.data.decision);
  }
  const support = new Map();
  for (const [selectionId, decision] of latestDecisionBySelection) {
    for (const templateUid of chosenTemplates(decision)) {
      if (!support.has(templateUid)) support.set(templateUid, new Set());
      support.get(templateUid).add(selectionId);
    }
  }
  return support;
}

function normalizedRunProjection(source) {
  const manifest = source?.manifest || source;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  const reviews = { ...(manifest.artifact_reviews || manifest.reviews || {}) };
  let preference = manifest.preference || manifest.final_preference || null;
  for (const event of list(source?.events)) {
    if (event?.type === 'ArtifactReviewRecorded' && event.data?.artifact_id && event.data?.review) {
      reviews[event.data.artifact_id] = {
        ...event.data.review,
        review_source_event_id: event.data.review.review_source_event_id || event.event_id,
      };
    }
    if (event?.type === 'PreferenceRecorded' && event.data?.preference) {
      preference = {
        ...event.data.preference,
        preference_source_event_id: event.data.preference.preference_source_event_id || event.event_id,
      };
    }
  }
  return {
    ...manifest,
    run_id: cleanString(manifest.run_id),
    artifact_reviews: reviews,
    preference,
  };
}

function runMap(runProjections) {
  const result = new Map();
  for (const source of runProjections) {
    const run = normalizedRunProjection(source);
    if (run?.run_id) result.set(run.run_id, run);
  }
  return result;
}

function reviewScores(review) {
  const scores = {
    face_consistency: review?.scores?.face_consistency ?? review?.face_identity_fidelity,
    naturalness: review?.scores?.naturalness ?? review?.realism_naturalness,
    style_consistency: review?.scores?.style_consistency ?? review?.style_consistency,
  };
  return Object.values(scores).every((value) => typeof value === 'number' && Number.isFinite(value))
    ? scores
    : null;
}

function humanReview(review) {
  return review
    && cleanString(review.reviewer_id)
    && cleanString(review.reviewer_id) !== 'system'
    && cleanString(review.review_session_id)
    && cleanString(review.review_rubric_version || review.rubric_version)
    && cleanString(review.review_source_event_id)
    && reviewScores(review);
}

function completePreference(preference, artifactIds) {
  const decision = cleanString(preference?.decision);
  if (!['winner', 'none'].includes(decision)) return false;
  if (!cleanString(preference?.reviewer_id) || cleanString(preference.reviewer_id) === 'system') return false;
  if (!cleanString(preference?.preference_session_id) || !cleanString(preference?.preference_source_event_id)) return false;
  if (decision === 'winner' && !artifactIds.has(cleanString(preference.winner_artifact_id))) return false;
  return true;
}

function attributionReason(run, templateUid) {
  if (!run) return 'run_projection_missing';
  if (run.excluded_from_learning === true) return 'run_excluded_from_learning';
  const references = list(run.template_references);
  if (references.length > 1) return 'multiple_templates';
  if (references.length === 0 || references[0]?.source_type !== 'catalog_template') return 'manual_only';
  if (cleanString(references[0].template_uid) !== templateUid) return 'template_attribution_mismatch';
  const artifactIds = new Set(list(run.artifacts).map((item) => cleanString(item?.artifact_id)).filter(Boolean));
  if (!artifactIds.size) return 'incomplete_review';
  for (const artifactId of artifactIds) {
    if (!humanReview(run.artifact_reviews?.[artifactId])) return 'incomplete_review';
  }
  if (!completePreference(run.preference, artifactIds)) return 'missing_preference';
  return null;
}

function exactOutcomeEvidence(outcomes, run, templateUid) {
  const reference = run.template_references[0];
  const artifacts = new Map(list(run.artifacts).map((item) => [cleanString(item?.artifact_id), item]));
  for (const outcome of outcomes) {
    const artifact = artifacts.get(outcome.artifact_id);
    const review = run.artifact_reviews?.[outcome.artifact_id];
    const scores = reviewScores(review);
    if (!artifact
      || outcome.selection_id !== reference.selection_id
      || outcome.template_uid !== templateUid
      || outcome.artifact_sha256 !== artifact.sha256
      || outcome.reference_image_sha256 !== reference.reference_image_sha256
      || outcome.generation_blueprint_sha256 !== reference.generation_blueprint_sha256
      || outcome.catalog_projection_version !== reference.catalog_projection_version
      || outcome.ranking_policy_version !== reference.ranking_policy_version
      || !scores
      || outcome.scores.face_consistency !== scores.face_consistency
      || outcome.scores.naturalness !== scores.naturalness
      || outcome.scores.style_consistency !== scores.style_consistency
      || outcome.rubric_version !== (review.review_rubric_version || review.rubric_version)
      || outcome.reviewer_id !== review.reviewer_id
      || outcome.review_session_id !== review.review_session_id
      || outcome.review_source_event_id !== review.review_source_event_id
      || outcome.preference_session_id !== run.preference.preference_session_id
      || outcome.preference_source_event_id !== run.preference.preference_source_event_id) {
      return 'outcome_evidence_mismatch';
    }
  }
  return null;
}

function outcomeTruthReason(outcomes, run) {
  const artifactIds = new Set(list(run.artifacts).map((item) => cleanString(item?.artifact_id)).filter(Boolean));
  const countByArtifact = new Map();
  for (const outcome of outcomes) {
    const artifactId = cleanString(outcome.artifact_id);
    countByArtifact.set(artifactId, (countByArtifact.get(artifactId) || 0) + 1);
  }
  if (countByArtifact.size !== artifactIds.size
    || [...artifactIds].some((artifactId) => countByArtifact.get(artifactId) !== 1)
    || [...countByArtifact].some(([artifactId, count]) => !artifactIds.has(artifactId) || count !== 1)) {
    return 'outcome_coverage_mismatch';
  }
  if (run.preference.decision === 'none') {
    return outcomes.every((outcome) => outcome.preference_result === 'none')
      ? null
      : 'preference_outcome_mismatch';
  }
  const winnerArtifactId = cleanString(run.preference.winner_artifact_id);
  const winners = outcomes.filter((outcome) => outcome.preference_result === 'winner');
  if (winners.length !== 1 || winners[0].artifact_id !== winnerArtifactId) return 'preference_outcome_mismatch';
  return outcomes.every((outcome) => outcome.preference_result
    === (outcome.artifact_id === winnerArtifactId ? 'winner' : 'eligible_not_selected'))
    ? null
    : 'preference_outcome_mismatch';
}

function gateQualified(outcome) {
  return Boolean(outcome)
    && outcome.excluded_from_learning !== true
    && outcome.scores.face_consistency >= 8
    && outcome.scores.naturalness >= 7
    && outcome.scores.style_consistency >= 7;
}

function identityPassed(outcome) {
  return outcome.excluded_from_learning !== true && outcome.scores.face_consistency >= 8;
}

function utility(outcome) {
  return outcome.utility_score ?? round((outcome.scores.naturalness + outcome.scores.style_consistency) / 2);
}

function compareCandidates(left, right) {
  const delta = utility(right) - utility(left);
  if (Math.abs(delta) > Number.EPSILON) return delta;
  const artifact = left.artifact_id.localeCompare(right.artifact_id);
  return artifact || left.outcome_id.localeCompare(right.outcome_id);
}

function selectRepresentative(outcomes, run) {
  if (run.preference.decision === 'winner') {
    const winner = outcomes.find((item) => item.artifact_id === run.preference.winner_artifact_id);
    return gateQualified(winner)
      ? { selected: winner, basis: 'winner' }
      : { selected: null, basis: 'winner_not_gate_qualified' };
  }
  const qualified = outcomes.filter(gateQualified).sort(compareCandidates);
  return qualified.length
    ? { selected: qualified[0], basis: 'highest_utility' }
    : { selected: null, basis: 'no_gate_qualified_outcome' };
}

function emptyStats(templateUid, choiceSelections = new Set()) {
  return {
    template_uid: templateUid,
    choice_selections: choiceSelections,
    outcome_support_count: 0,
    identity_pass_count: 0,
    naturalness_values: [],
    style_values: [],
    aesthetic_outcome_count: 0,
    winner_count: 0,
    readiness_support_count: 0,
  };
}

function outputStats(stats) {
  return {
    template_uid: stats.template_uid,
    choice_support_count: stats.choice_selections.size,
    outcome_support_count: stats.outcome_support_count,
    identity_pass_count: stats.identity_pass_count,
    identity_pass_rate: stats.outcome_support_count ? round(stats.identity_pass_count / stats.outcome_support_count) : null,
    aesthetic_outcome_count: stats.aesthetic_outcome_count,
    naturalness_average: average(stats.naturalness_values),
    style_consistency_average: average(stats.style_values),
    winner_count: stats.winner_count,
    winner_rate_among_eligible: stats.aesthetic_outcome_count
      ? round(stats.winner_count / stats.aesthetic_outcome_count)
      : null,
    readiness_support_count: stats.readiness_support_count,
    readiness: stats.outcome_support_count >= TEMPLATE_PERFORMANCE_MINIMUM_SHADOW_SUPPORT
      ? 'shadow_ready'
      : 'insufficient',
  };
}

export function buildTemplatePerformanceProjectionV2(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid_performance_input', 'Performance projection input must be an object');
  }
  const selectionProjections = requireArray(
    input.selection_projections === undefined ? [] : input.selection_projections,
    'selection_projections',
  );
  const directSelectionEvents = requireArray(
    input.selection_events === undefined ? [] : input.selection_events,
    'selection_events',
  );
  const outcomeEvents = requireArray(
    input.outcome_events === undefined ? [] : input.outcome_events,
    'outcome_events',
  );
  const runProjections = requireArray(
    input.run_projections === undefined ? [] : input.run_projections,
    'run_projections',
  );
  const projectionEvents = selectionProjections.flatMap((projection) => list(projection?.events));
  const selectionEvents = [...directSelectionEvents, ...projectionEvents];
  const lifecycleEvents = [
    ...selectionEvents.filter((event) => event?.type === OUTCOME_RECORDED_EVENT_TYPE
      || event?.type === OUTCOME_INVALIDATED_EVENT_TYPE),
    ...outcomeEvents,
  ];
  const choices = choiceSupport(selectionProjections, selectionEvents);
  const lifecycle = projectActiveTemplateOutcomes(lifecycleEvents);
  const runs = runMap(runProjections);
  const statsByTemplate = new Map();
  const ensureStats = (templateUid) => {
    if (!statsByTemplate.has(templateUid)) {
      statsByTemplate.set(templateUid, emptyStats(templateUid, choices.get(templateUid) || new Set()));
    }
    return statsByTemplate.get(templateUid);
  };
  for (const templateUid of choices.keys()) ensureStats(templateUid);

  const groups = new Map();
  for (const outcome of lifecycle.active_outcomes) {
    const key = `${outcome.run_id}\u0000${outcome.template_uid}`;
    ensureStats(outcome.template_uid);
    if (!groups.has(key)) groups.set(key, { run_id: outcome.run_id, template_uid: outcome.template_uid, outcomes: [] });
    groups.get(key).outcomes.push(outcome);
  }

  const deferred = [];
  const supports = [];
  const orderedGroups = [...groups.values()].sort((left, right) => {
    const run = left.run_id.localeCompare(right.run_id);
    return run || left.template_uid.localeCompare(right.template_uid);
  });
  for (const group of orderedGroups) {
    const run = runs.get(group.run_id);
    const reason = attributionReason(run, group.template_uid)
      || exactOutcomeEvidence(group.outcomes, run, group.template_uid)
      || outcomeTruthReason(group.outcomes, run);
    if (reason) {
      deferred.push({
        run_id: group.run_id,
        template_uid: group.template_uid,
        reason,
        active_outcome_count: group.outcomes.length,
      });
      continue;
    }
    if (group.outcomes.some((outcome) => outcome.excluded_from_learning)) {
      deferred.push({
        run_id: group.run_id,
        template_uid: group.template_uid,
        reason: 'run_excluded_from_learning',
        active_outcome_count: group.outcomes.length,
      });
      continue;
    }
    const orderedOutcomes = [...group.outcomes].sort((left, right) => {
      const artifact = left.artifact_id.localeCompare(right.artifact_id);
      return artifact || left.outcome_id.localeCompare(right.outcome_id);
    });
    const { selected, basis } = selectRepresentative(orderedOutcomes, run);
    const identityPass = orderedOutcomes.some(identityPassed);
    const stats = ensureStats(group.template_uid);
    stats.outcome_support_count += 1;
    stats.readiness_support_count += 1;
    if (identityPass) stats.identity_pass_count += 1;
    if (selected) {
      stats.aesthetic_outcome_count += 1;
      stats.naturalness_values.push(selected.scores.naturalness);
      stats.style_values.push(selected.scores.style_consistency);
      if (basis === 'winner') stats.winner_count += 1;
    }
    supports.push({
      support_key: `${group.run_id}::${group.template_uid}`,
      run_id: group.run_id,
      template_uid: group.template_uid,
      selection_id: orderedOutcomes[0].selection_id,
      active_outcome_count: orderedOutcomes.length,
      identity_passed: identityPass,
      aesthetic_eligible: Boolean(selected),
      evaluation_support_eligible: true,
      selection_basis: basis,
      selected_outcome_id: selected?.outcome_id || null,
      selected_artifact_id: selected?.artifact_id || null,
      utility_score: selected ? utility(selected) : null,
      review_source_event_ids: [...new Set(orderedOutcomes.map((item) => item.review_source_event_id))].sort(),
      preference_source_event_id: orderedOutcomes[0].preference_source_event_id,
    });
  }

  const templates = [...statsByTemplate.values()].map(outputStats)
    .sort((left, right) => left.template_uid.localeCompare(right.template_uid));
  const shadowReady = templates.some((item) => item.readiness === 'shadow_ready');
  return {
    schema_version: TEMPLATE_PERFORMANCE_PROJECTION_VERSION,
    status: shadowReady ? 'inactive_shadow_ready' : 'inactive_insufficient_evidence',
    activation: 'inactive',
    evaluation_mode: 'shadow_only',
    production_ranking_active: false,
    production_ranking_policy_version: 'template-ranking-v1',
    minimum_outcome_support_for_shadow: TEMPLATE_PERFORMANCE_MINIMUM_SHADOW_SUPPORT,
    total_choice_support_count: templates.reduce((sum, item) => sum + item.choice_support_count, 0),
    total_outcome_support_count: supports.length,
    templates,
    outcome_supports: supports,
    deferred,
    lifecycle_replay_count: lifecycle.replay_count,
    rebuilt_at: input.recorded_at ?? null,
  };
}
