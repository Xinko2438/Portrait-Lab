import { createHash } from 'node:crypto';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function deferred(reason, invalidations = []) {
  return { status: 'deferred', reason, commands: [], invalidations };
}

function humanReview(review) {
  return review
    && String(review.reviewer_id || '').trim()
    && String(review.reviewer_id).trim() !== 'system'
    && String(review.review_session_id || '').trim()
    && String(review.review_rubric_version || review.rubric_version || '').trim();
}

function mappedScores(review) {
  const scores = {
    face_consistency: Number(review.face_identity_fidelity),
    naturalness: Number(review.realism_naturalness),
    style_consistency: Number(review.style_consistency),
  };
  return Object.values(scores).every((value) => Number.isFinite(value)) ? scores : null;
}

function latestHumanEvidence(run, manifest) {
  const reviews = Object.fromEntries(Object.entries(manifest.artifact_reviews || {}).map(([artifactId, review]) => [
    artifactId,
    {
      ...review,
      review_source_event_id: review.review_source_event_id || review.review_session_id,
    },
  ]));
  let preference = manifest.preference
    ? {
      ...manifest.preference,
      preference_source_event_id: manifest.preference.preference_source_event_id
        || manifest.preference.preference_session_id,
    }
    : null;
  for (const event of Array.isArray(run?.events) ? run.events : []) {
    if (event?.type === 'ArtifactReviewRecorded' && event.data?.artifact_id && event.data?.review) {
      reviews[event.data.artifact_id] = {
        ...event.data.review,
        review_source_event_id: event.event_id
          || event.data.review.review_source_event_id
          || event.data.review.review_session_id,
      };
    }
    if (event?.type === 'PreferenceRecorded') {
      preference = event.data?.preference
        ? {
          ...event.data.preference,
          preference_source_event_id: event.event_id
            || event.data.preference.preference_source_event_id
            || event.data.preference.preference_session_id,
        }
        : null;
    }
  }
  return { reviews, preference };
}

function invalidationReason(reason) {
  if (/review|artifact_hash|human_review/.test(reason)) return 'review_revised';
  if (/preference|winner/.test(reason)) return 'preference_revised';
  return 'attribution_invalidated';
}

function deriveInvalidationCommands({ activeOutcomes, manifest, reviews, preference, reason }) {
  const runId = String(manifest?.run_id || '').trim();
  if (!runId) return [];
  const current = Array.isArray(activeOutcomes) ? activeOutcomes.filter((item) => (
    String(item?.run_id || '').trim() === runId
  )) : [];
  return current.map((outcome) => {
    const review = reviews?.[outcome.artifact_id] || {};
    return {
      selectionId: outcome.selection_id,
      outcomeId: outcome.outcome_id,
      artifactId: outcome.artifact_id,
      reason: invalidationReason(reason),
      reviewSourceEventId: String(
        review.review_source_event_id || review.review_session_id || outcome.review_source_event_id || '',
      ).trim(),
      preferenceSourceEventId: String(
        preference?.preference_source_event_id
          || preference?.preference_session_id
          || outcome.preference_source_event_id
          || '',
      ).trim(),
    };
  }).filter((command) => (
    command.selectionId
      && command.outcomeId
      && command.artifactId
      && command.reviewSourceEventId
      && command.preferenceSourceEventId
  ));
}

export function deriveTemplateOutcomeCommands({ run, activeOutcomes = [] } = {}) {
  const manifest = run?.manifest || run;
  if (!manifest || typeof manifest !== 'object') return deferred('run_manifest_missing');
  if (manifest.image_api) return deferred('api_provider_evaluation_pending');
  const { reviews, preference } = latestHumanEvidence(run, manifest);
  const defer = (reason) => deferred(reason, deriveInvalidationCommands({
    activeOutcomes,
    manifest,
    reviews,
    preference,
    reason,
  }));

  const catalogReferences = (manifest.template_references || [])
    .filter((reference) => reference?.source_type === 'catalog_template');
  if (!catalogReferences.length) return defer('catalog_template_missing');
  if (catalogReferences.length > 1) return defer('multiple_catalog_templates');

  const template = catalogReferences[0];
  if (!String(template.selection_id || '').trim()) return defer('selection_id_missing');
  if (!String(template.template_uid || '').trim()) return defer('template_uid_missing');
  if (!String(template.reference_image_sha256 || '').trim()
    || !String(template.generation_blueprint_sha256 || '').trim()
    || !String(template.catalog_projection_version || '').trim()
    || !String(template.ranking_policy_version || '').trim()) {
    return defer('template_provenance_incomplete');
  }

  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  if (!artifacts.length) return defer('artifacts_missing');
  if (artifacts.some((artifact) => !reviews[artifact.artifact_id])) {
    return defer('artifact_reviews_incomplete');
  }
  if (artifacts.some((artifact) => !String(artifact.sha256 || '').trim())) {
    return defer('artifact_hash_missing');
  }
  if (artifacts.some((artifact) => !humanReview(reviews[artifact.artifact_id]))) {
    return defer('human_review_lineage_incomplete');
  }
  if (artifacts.some((artifact) => !mappedScores(reviews[artifact.artifact_id]))) {
    return defer('human_review_scores_incomplete');
  }

  if (manifest.excluded_from_learning === true) return defer('run_excluded_from_learning');
  if (!preference) return defer('final_preference_missing');
  if (preference.decision === 'pending') return defer('final_preference_pending');
  if (!['winner', 'none'].includes(preference.decision)) return defer('final_preference_invalid');
  if (!String(preference.reviewer_id || '').trim()
    || preference.reviewer_id === 'system'
    || !String(preference.preference_session_id || '').trim()
    || !String(preference.preference_source_event_id || '').trim()) {
    return defer('human_preference_missing');
  }
  if (preference.decision === 'winner'
    && !artifacts.some((artifact) => artifact.artifact_id === preference.winner_artifact_id)) {
    return defer('winner_artifact_invalid');
  }

  const runId = String(manifest.run_id || '').trim();
  if (!runId) return defer('run_id_missing');
  const compilation = manifest.prompt_compilation || {};
  const commands = artifacts.map((artifact) => {
    const review = reviews[artifact.artifact_id];
    const reviewSourceEventId = String(review.review_source_event_id || review.review_session_id || '').trim();
    const preferenceSourceEventId = String(
      preference.preference_source_event_id || preference.preference_session_id || '',
    ).trim();
    const identity = {
      selection_id: template.selection_id,
      run_id: runId,
      artifact_id: artifact.artifact_id,
      review_source_event_id: reviewSourceEventId,
      preference_source_event_id: preferenceSourceEventId,
    };
    const sourceEventId = `outcome-source-${sha256(stableJson(identity)).slice(0, 32)}`;
    return {
      selectionId: template.selection_id,
      outcomeIdempotencyKey: `outcome-bridge-${sha256(stableJson(identity)).slice(0, 32)}`,
      outcome: {
        selection_id: template.selection_id,
        run_id: runId,
        artifact_id: artifact.artifact_id,
        artifact_sha256: artifact.sha256,
        template_uid: template.template_uid,
        reference_image_sha256: template.reference_image_sha256,
        generation_blueprint_sha256: template.generation_blueprint_sha256,
        catalog_projection_version: template.catalog_projection_version,
        ranking_policy_version: template.ranking_policy_version,
        rubric_version: review.review_rubric_version || review.rubric_version,
        review_session_id: review.review_session_id,
        reviewer_id: review.reviewer_id,
        preference_session_id: preference.preference_session_id,
        review_source_event_id: reviewSourceEventId,
        preference_source_event_id: preferenceSourceEventId,
        source_event_id: sourceEventId,
        scores: mappedScores(review),
        preference_result: preference.decision === 'none'
          ? 'none'
          : (artifact.artifact_id === preference.winner_artifact_id ? 'winner' : 'eligible_not_selected'),
        excluded_from_learning: manifest.excluded_from_learning === true,
        prompt_compiler_id: compilation.compiler_id || null,
        prompt_compiler_version: compilation.compiler_version ?? null,
        prompt_recipe_id: compilation.recipe_id || null,
        prompt_input_mode: compilation.prompt_input_mode || null,
        applied_correction_ids: Array.isArray(compilation.applied_correction_ids) ? compilation.applied_correction_ids : [],
        shadow_correction_ids: Array.isArray(compilation.shadow_correction_ids) ? compilation.shadow_correction_ids : [],
        angle_alignment: compilation.angle_alignment || null,
        face_angle_match: manifest.face_angle_analysis?.match || null,
        face_angle_pipeline_version: manifest.face_angle_analysis?.pipeline_version || null,
        prompt_sha256: compilation.prompt_sha256 || manifest.prompt_sha256 || null,
      },
    };
  });

  return { status: 'ready', reason: null, commands, invalidations: [] };
}

export async function executeTemplateOutcomeBridge({
  run,
  recordOutcome,
  invalidateOutcome,
  activeOutcomes = [],
  root,
} = {}) {
  const derivation = deriveTemplateOutcomeCommands({ run, activeOutcomes });
  if (derivation.status !== 'ready') {
    let invalidated = 0;
    let invalidationIdempotent = 0;
    const invalidationResults = [];
    if (derivation.invalidations.length) {
      if (typeof invalidateOutcome !== 'function') {
        throw new TypeError('invalidateOutcome dependency is required for stale active Outcomes');
      }
      for (const command of derivation.invalidations) {
        const result = await invalidateOutcome({ ...(root === undefined ? {} : { root }), ...command });
        if (result?.idempotent_replay === true) invalidationIdempotent += 1;
        else invalidated += 1;
        invalidationResults.push(result);
      }
    }
    return {
      ...derivation,
      recorded: 0,
      idempotent: 0,
      invalidated,
      invalidation_idempotent: invalidationIdempotent,
      deferred: 1,
      results: [],
      invalidation_results: invalidationResults,
    };
  }
  if (typeof recordOutcome !== 'function') {
    throw new TypeError('recordOutcome dependency is required');
  }

  let recorded = 0;
  let idempotent = 0;
  const results = [];
  for (const command of derivation.commands) {
    const result = await recordOutcome({ ...(root === undefined ? {} : { root }), ...command });
    if (result?.idempotent_replay === true) idempotent += 1;
    else recorded += 1;
    results.push(result);
  }
  return {
    ...derivation,
    recorded,
    idempotent,
    invalidated: 0,
    invalidation_idempotent: 0,
    deferred: 0,
    results,
    invalidation_results: [],
  };
}
