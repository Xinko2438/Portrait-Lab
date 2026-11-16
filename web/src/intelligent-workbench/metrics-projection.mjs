import { deriveTemplateOutcomeCommands } from './outcome-bridge.mjs';

const MINIMUM_SHADOW_SUPPORT = 20;

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function rateMetric(numerator, denominator) {
  return denominator > 0
    ? { numerator, denominator, value: round(numerator / denominator), status: 'ready' }
    : { numerator: 0, denominator: 0, value: null, status: 'insufficient' };
}

function averageMetric(values) {
  return values.length
    ? { sample_count: values.length, value: round(values.reduce((sum, value) => sum + value, 0) / values.length, 2), status: 'ready' }
    : { sample_count: 0, value: null, status: 'insufficient' };
}

function manifestOf(run) {
  return run?.manifest || run || {};
}

function runEvidence(run) {
  const manifest = manifestOf(run);
  const reviews = { ...(manifest.artifact_reviews || {}) };
  let preference = manifest.preference || null;
  for (const event of Array.isArray(run?.events) ? run.events : []) {
    if (event?.type === 'ArtifactReviewRecorded' && event.data?.artifact_id && event.data?.review) {
      reviews[event.data.artifact_id] = event.data.review;
    }
    if (event?.type === 'PreferenceRecorded') preference = event.data?.preference || null;
  }
  return { manifest, reviews, preference };
}

function usesReusableIdentity(manifest) {
  if (manifest.identity_set_id || manifest.customer_identity_set_id) return true;
  if (manifest.identity_source?.identity_set_id || manifest.customer_identity?.identity_set_id || manifest.customer_identity_source?.identity_set_id) return true;
  if (manifest.task_intent?.identity_set_id || manifest.task_intent?.selected_identity_set_id) return true;
  return (manifest.identity_references || []).some((reference) => (
    reference?.identity_set_id
      || ['customer_identity_set', 'reusable_identity_set'].includes(reference?.source_type)
  ));
}

function addOutcomes(target, value) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) addOutcomes(target, item);
    return;
  }
  if (value.outcome && typeof value.outcome === 'object') {
    addOutcomes(target, value.outcome);
    return;
  }
  if (Array.isArray(value.outcomes)) {
    addOutcomes(target, value.outcomes);
    return;
  }
  if (Array.isArray(value.selection?.outcomes)) {
    addOutcomes(target, value.selection.outcomes);
    return;
  }
  if (value.run_id && value.artifact_id && value.scores) target.push(value);
}

function normalizedOutcomes(values) {
  const flattened = [];
  addOutcomes(flattened, values);
  const byArtifact = new Map();
  for (const outcome of flattened) byArtifact.set(`${outcome.run_id}:${outcome.artifact_id}`, outcome);
  return [...byArtifact.values()];
}

function identityEligible(outcome) {
  if (outcome.excluded_from_learning === true) return false;
  if (typeof outcome.identity_eligible === 'boolean') return outcome.identity_eligible;
  return Number(outcome.scores?.face_consistency) >= 8;
}

function aestheticEligible(outcome) {
  if (!identityEligible(outcome)) return false;
  if (typeof outcome.aesthetic_eligible === 'boolean') return outcome.aesthetic_eligible;
  return Number(outcome.scores?.naturalness) >= 7
    && Number(outcome.scores?.style_consistency) >= 7;
}

function correctionChanged(correction) {
  if (correction?.has_correction === true || correction?.has_corrections === true
    || Number(correction?.corrected_count) > 0 || Number(correction?.correction_count) > 0) return true;
  if (Array.isArray(correction?.corrected_fields) && correction.corrected_fields.length) return true;
  const fields = correction?.fields || correction?.field_deltas || correction?.field_corrections || correction?.corrections || {};
  return Object.values(fields).some((field) => {
    if (!field || typeof field !== 'object') return false;
    const state = String(field.state || field.status || '').toLowerCase();
    return state === 'corrected'
      || field.accepted === false
      || (Number.isFinite(Number(field.numeric_delta ?? field.delta)) && Number(field.numeric_delta ?? field.delta) !== 0);
  });
}

function correctionMetric(suggestions, corrections) {
  const suggestionEvidence = (suggestions || []).map((item) => item?.payload || item?.data?.suggestion || item);
  const correctionEvidence = (corrections || []).map((item) => item?.payload || item?.data?.correction || item);
  const suggestionIds = new Set(suggestionEvidence.map((item) => item?.suggestion_id).filter(Boolean));
  const bySuggestion = new Map();
  for (const correction of correctionEvidence) {
    const suggestionId = correction?.suggestion_id;
    if (!suggestionId || (suggestionIds.size && !suggestionIds.has(suggestionId))) continue;
    bySuggestion.set(suggestionId, correction);
  }
  const evidence = [...bySuggestion.values()];
  return rateMetric(evidence.filter(correctionChanged).length, evidence.length);
}

function compilerForOutcome(outcome, runsById) {
  const compilation = runsById.get(outcome.run_id)?.prompt_compilation || {};
  const compilerId = outcome.prompt_compiler_id || compilation.compiler_id;
  const compilerVersion = outcome.prompt_compiler_version ?? compilation.compiler_version;
  if (!compilerId || compilerVersion === undefined || compilerVersion === null) return null;
  return { compiler_id: compilerId, compiler_version: compilerVersion };
}

function compilerEffectiveness(outcomes, runsById) {
  const groups = new Map();
  for (const outcome of outcomes) {
    if (outcome.excluded_from_learning === true) continue;
    const compiler = compilerForOutcome(outcome, runsById);
    if (!compiler) continue;
    const key = `${compiler.compiler_id}@${compiler.compiler_version}`;
    if (!groups.has(key)) groups.set(key, { ...compiler, outcomes: [] });
    groups.get(key).outcomes.push(outcome);
  }
  return [...groups.values()].map((group) => {
    const identityPassing = group.outcomes.filter(identityEligible);
    const aesthetic = group.outcomes.filter(aestheticEligible);
    return {
      compiler_id: group.compiler_id,
      compiler_version: group.compiler_version,
      support_count: group.outcomes.length,
      identity_pass_rate: group.outcomes.length ? round(identityPassing.length / group.outcomes.length) : null,
      naturalness_average: averageMetric(aesthetic.map((outcome) => Number(outcome.scores.naturalness))).value,
      style_consistency_average: averageMetric(aesthetic.map((outcome) => Number(outcome.scores.style_consistency))).value,
      winner_rate_among_aesthetic_eligible: aesthetic.length
        ? round(aesthetic.filter((outcome) => outcome.preference_result === 'winner').length / aesthetic.length)
        : null,
      readiness: group.outcomes.length >= MINIMUM_SHADOW_SUPPORT ? 'shadow_ready' : 'insufficient',
    };
  }).sort((left, right) => (
    `${left.compiler_id}@${left.compiler_version}`.localeCompare(`${right.compiler_id}@${right.compiler_version}`)
  ));
}

function recipeForOutcome(outcome, runsById) {
  const compilation = runsById.get(outcome.run_id)?.prompt_compilation || {};
  const promptRecipeId = outcome.prompt_recipe_id || compilation.recipe_id;
  if (!promptRecipeId) return null;
  return {
    prompt_recipe_id: promptRecipeId,
    prompt_input_mode: outcome.prompt_input_mode || compilation.prompt_input_mode || 'reference_image',
    applied_correction_ids: [...new Set(
      (outcome.applied_correction_ids || compilation.applied_correction_ids || []).map(String),
    )].sort(),
  };
}

function recipeEffectiveness(outcomes, runsById) {
  const groups = new Map();
  for (const outcome of outcomes) {
    if (outcome.excluded_from_learning === true) continue;
    const recipe = recipeForOutcome(outcome, runsById);
    if (!recipe) continue;
    const key = `${recipe.prompt_recipe_id}:${recipe.prompt_input_mode}:${recipe.applied_correction_ids.join(',')}`;
    if (!groups.has(key)) groups.set(key, { ...recipe, outcomes: [] });
    groups.get(key).outcomes.push(outcome);
  }
  return [...groups.values()].map((group) => {
    const identityPassing = group.outcomes.filter(identityEligible);
    const aesthetic = group.outcomes.filter(aestheticEligible);
    return {
      prompt_recipe_id: group.prompt_recipe_id,
      prompt_input_mode: group.prompt_input_mode,
      applied_correction_ids: group.applied_correction_ids,
      support_count: group.outcomes.length,
      identity_pass_rate: group.outcomes.length ? round(identityPassing.length / group.outcomes.length) : null,
      naturalness_average: averageMetric(aesthetic.map((outcome) => Number(outcome.scores.naturalness))).value,
      style_consistency_average: averageMetric(aesthetic.map((outcome) => Number(outcome.scores.style_consistency))).value,
      winner_rate_among_aesthetic_eligible: aesthetic.length
        ? round(aesthetic.filter((outcome) => outcome.preference_result === 'winner').length / aesthetic.length)
        : null,
      readiness: group.outcomes.length >= MINIMUM_SHADOW_SUPPORT ? 'shadow_ready' : 'insufficient',
    };
  }).sort((left, right) => (
    `${left.prompt_recipe_id}:${left.prompt_input_mode}:${left.applied_correction_ids.join(',')}`
      .localeCompare(`${right.prompt_recipe_id}:${right.prompt_input_mode}:${right.applied_correction_ids.join(',')}`)
  ));
}

export function buildCompoundingMetrics({ runs = [], outcomes = [], suggestions = [], corrections = [], reviewerCalibration = null } = {}) {
  const runList = Array.isArray(runs) ? runs : [];
  const evidence = runList.map(runEvidence);
  const manifests = evidence.map((item) => item.manifest);
  const flattenedOutcomes = normalizedOutcomes(outcomes);
  const eligibleOutcomes = flattenedOutcomes.filter((outcome) => outcome.excluded_from_learning !== true);

  const artifactCount = evidence.reduce((sum, item) => sum + (item.manifest.artifacts || []).length, 0);
  const reviewedArtifactCount = evidence.reduce((sum, item) => sum + (item.manifest.artifacts || [])
    .filter((artifact) => item.reviews[artifact.artifact_id]).length, 0);
  const runsWithArtifacts = evidence.filter((item) => (item.manifest.artifacts || []).length > 0);
  const finalPreferenceCount = runsWithArtifacts.filter((item) => ['winner', 'none'].includes(item.preference?.decision)).length;

  const expectedOutcomeKeys = new Set();
  for (const run of runList) {
    const derivation = deriveTemplateOutcomeCommands({ run });
    if (derivation.status !== 'ready') continue;
    for (const command of derivation.commands) {
      expectedOutcomeKeys.add(`${command.outcome.run_id}:${command.outcome.artifact_id}`);
    }
  }
  const recordedOutcomeKeys = new Set(flattenedOutcomes.map((outcome) => `${outcome.run_id}:${outcome.artifact_id}`));
  const coveredOutcomes = [...expectedOutcomeKeys].filter((key) => recordedOutcomeKeys.has(key)).length;

  const identityPassing = eligibleOutcomes.filter(identityEligible);
  const aesthetic = eligibleOutcomes.filter(aestheticEligible);
  const runsById = new Map(manifests.map((manifest) => [manifest.run_id, manifest]));
  const rankingSupport = eligibleOutcomes.length;

  return {
    schema_version: 'ai-img-gen.compounding-metrics.v1',
    status: runList.length || flattenedOutcomes.length || corrections.length ? 'ready' : 'insufficient',
    metrics: {
      identity_reuse_rate: rateMetric(manifests.filter(usesReusableIdentity).length, manifests.length),
      v6_run_coverage: rateMetric(manifests.filter((manifest) => manifest.schema_version === 'ai-img-gen.web-run.v6').length, manifests.length),
      prompt_compilation_coverage: rateMetric(manifests.filter((manifest) => Boolean(manifest.prompt_compilation)).length, manifests.length),
      prompt_recipe_coverage: rateMetric(manifests.filter((manifest) => Boolean(manifest.prompt_compilation?.recipe_id)).length, manifests.length),
      artifact_review_coverage: rateMetric(reviewedArtifactCount, artifactCount),
      final_preference_coverage: rateMetric(finalPreferenceCount, runsWithArtifacts.length),
      template_outcome_coverage: rateMetric(coveredOutcomes, expectedOutcomeKeys.size),
      identity_pass_rate: rateMetric(identityPassing.length, eligibleOutcomes.length),
      naturalness_average: averageMetric(aesthetic.map((outcome) => Number(outcome.scores.naturalness))),
      style_consistency_average: averageMetric(aesthetic.map((outcome) => Number(outcome.scores.style_consistency))),
      ai_suggestion_correction_rate: correctionMetric(suggestions, corrections),
    },
    compiler_effectiveness: compilerEffectiveness(eligibleOutcomes, runsById),
    recipe_effectiveness: recipeEffectiveness(eligibleOutcomes, runsById),
    reviewer_calibration: reviewerCalibration,
    ranking: {
      mode: 'shadow',
      production_activation: 'inactive',
      minimum_support: MINIMUM_SHADOW_SUPPORT,
      support_count: rankingSupport,
      readiness: rankingSupport >= MINIMUM_SHADOW_SUPPORT ? 'shadow_ready' : 'insufficient',
    },
  };
}
