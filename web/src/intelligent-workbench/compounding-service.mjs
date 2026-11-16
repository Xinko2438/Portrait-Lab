import { createHash } from 'node:crypto';
import { executeTemplateOutcomeBridge } from './outcome-bridge.mjs';
import { buildCompoundingMetrics } from './metrics-projection.mjs';
import {
  buildHumanCorrection,
  buildHumanCorrectionEvent,
  buildReviewSuggestionEvent,
} from './review-suggestion.mjs';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function reviewEventInput(review = {}) {
  return {
    event_id: review.review_event_id || review.event_id || review.review_session_id,
    face_identity_fidelity: review.face_identity_fidelity,
    realism_naturalness: review.realism_naturalness,
    style_consistency: review.style_consistency,
    diagnostic_codes: review.diagnostic_codes || [],
  };
}

export function createCompoundingService({
  root,
  loadRun,
  listRuns,
  recordRunEvent,
  recordOutcome,
  invalidateOutcome,
  loadSelection,
  loadReviewerCalibration,
  deriveBridge = executeTemplateOutcomeBridge,
  buildMetrics = buildCompoundingMetrics,
} = {}) {
  if (typeof loadRun !== 'function' || typeof listRuns !== 'function' || typeof recordRunEvent !== 'function') {
    throw new TypeError('loadRun, listRuns, and recordRunEvent dependencies are required');
  }

  async function bridgeRunOutcome({ runId }) {
    const run = await loadRun({ root, runId });
    let activeOutcomes = [];
    const selectionId = run.manifest.template_selection?.selection_id
      || run.manifest.template_references?.find((item) => item?.selection_id)?.selection_id;
    if (selectionId && typeof loadSelection === 'function') {
      try {
        const selection = await loadSelection({ root, selectionId });
        activeOutcomes = selection.active_outcomes || [];
      } catch (error) {
        if (error?.code === 'selection_not_found') activeOutcomes = [];
        else throw error;
      }
    }
    const result = await deriveBridge({ run, recordOutcome, invalidateOutcome, activeOutcomes, root });
    const bridgeIdentity = {
      status: result.status,
      reason: result.reason || null,
      command_keys: (result.commands || []).map((command) => ({
        selection_id: command.selectionId,
        outcome_idempotency_key: command.outcomeIdempotencyKey,
      })),
      invalidation_keys: (result.invalidations || []).map((command) => ({
        selection_id: command.selectionId,
        outcome_id: command.outcomeId,
        reason: command.reason,
      })),
    };
    const data = {
      reason: result.reason || null,
      recorded: Number(result.recorded || 0),
      idempotent: Number(result.idempotent || 0),
      invalidated: Number(result.invalidated || 0),
      invalidation_idempotent: Number(result.invalidation_idempotent || 0),
      deferred: Number(result.deferred || 0),
      command_count: Array.isArray(result.commands) ? result.commands.length : 0,
      bridge_key_sha256: sha256(stableJson(bridgeIdentity)),
    };
    data.payload_sha256 = sha256(stableJson(data));
    const previous = run.manifest.template_outcome_bridge || {};
    if (previous.bridge_key_sha256 === data.bridge_key_sha256) return { ...result, run_event_idempotent: true };
    await recordRunEvent({
      root,
      runId,
      type: result.status === 'ready' ? 'TemplateOutcomeBridgeProcessed' : 'TemplateOutcomeBridgeDeferred',
      data,
    });
    return { ...result, run_event_idempotent: false };
  }

  async function recordReviewSuggestion({ runId, artifactId, suggestion, occurredAt }) {
    const event = buildReviewSuggestionEvent(suggestion, { occurredAt });
    const run = await loadRun({ root, runId });
    const previous = run.manifest.review_suggestions?.[artifactId];
    if (previous?.suggestion_id === event.payload.suggestion_id) return { suggestion: previous, idempotent_replay: true };
    const recorded = await recordRunEvent({
      root,
      runId,
      type: 'ReviewSuggestionRecorded',
      data: { artifact_id: artifactId, suggestion: event.payload, source_event: event },
      recordedAt: event.occurred_at,
    });
    return { suggestion: recorded.manifest.review_suggestions[artifactId], idempotent_replay: false };
  }

  async function recordHumanCorrection({ runId, artifactId, humanReview, correctionReason, occurredAt }) {
    const run = await loadRun({ root, runId });
    const suggestion = run.manifest.review_suggestions?.[artifactId];
    if (!suggestion) return { correction: null, status: 'suggestion_missing', idempotent_replay: false };
    const correction = buildHumanCorrection({ suggestion, humanReviewEvent: reviewEventInput(humanReview), correctionReason });
    const existing = (run.manifest.human_corrections || []).find((item) => item.correction_id === correction.correction_id);
    if (existing) return { correction: existing, status: 'recorded', idempotent_replay: true };
    const event = buildHumanCorrectionEvent({ suggestion, humanReviewEvent: reviewEventInput(humanReview), correctionReason }, { occurredAt });
    const recorded = await recordRunEvent({
      root,
      runId,
      type: 'HumanCorrectionRecorded',
      data: { artifact_id: artifactId, correction: event.payload, source_event: event },
      recordedAt: event.occurred_at,
    });
    return { correction: recorded.manifest.human_corrections.at(-1), status: 'recorded', idempotent_replay: false };
  }

  async function rebuildMetrics() {
    const summaries = await listRuns({ root, includeExcluded: false, artifactsOnly: false, limit: 500 });
    const runs = await Promise.all(summaries.map((item) => loadRun({ root, runId: item.run_id })));
    const outcomes = [];
    if (typeof loadSelection === 'function') {
      const selectionIds = [...new Set(runs.map((run) => run.manifest.template_selection?.selection_id).filter(Boolean))];
      for (const selectionId of selectionIds) {
        try {
          const selection = await loadSelection({ root, selectionId });
          outcomes.push(...(selection.active_outcomes || []));
        } catch (error) {
          if (error?.code !== 'selection_not_found' && error?.code !== 'ENOENT') throw error;
          // Explicitly absent legacy evidence contributes no Outcome support.
        }
      }
    }
    const suggestions = runs.flatMap((run) => Object.values(run.manifest.review_suggestions || {}));
    const corrections = runs.flatMap((run) => run.manifest.human_corrections || []);
    const reviewerCalibration = typeof loadReviewerCalibration === 'function'
      ? await loadReviewerCalibration({ root })
      : null;
    return buildMetrics({ runs, outcomes, suggestions, corrections, reviewerCalibration });
  }

  return Object.freeze({ bridgeRunOutcome, rebuildMetrics, recordReviewSuggestion, recordHumanCorrection });
}
