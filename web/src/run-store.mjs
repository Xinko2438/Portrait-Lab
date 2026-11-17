import {
  CatalogRunIntegrationError,
  linkCatalogSelectionToRun,
  resolveCatalogSelectionForRun,
} from './catalog-run-integration.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { inspectImage } from './image-metadata.mjs';
import { buildSubmissionSnapshot } from './generation-details.mjs';
import { assertTemplatesNotRejected } from './face-tag-store.mjs';
import { evaluateReview } from './review-policy.mjs';
import { REVIEW_RUBRIC } from './rubric.mjs';
import { evaluateReferencePlan, REFERENCE_POLICY_VERSION } from './reference-policy.mjs';
import { loadReviewGuidance, rebuildReviewGuidance } from './learning-projection.mjs';
import { readAnnotationSession, writeAnnotationSession } from './annotation-store.mjs';
import { buildCandidateSlateRequest, buildCandidateSlateRequestedEvent, GENERATION_REGIME_VERSION, projectCandidateSlate } from './intelligent-workbench/candidate-slate.mjs';
import { normalizeArtifactStyleSuggestion } from './template-style-facets-v2.mjs';
import { loadTemplateSelection } from './template-selection.mjs';

function safeName(name, fallback) {
  const ext = extname(name || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
  const stem = basename(name || fallback, extname(name || ''))
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
  return `${stem}${ext || '.png'}`;
}

function assertRunId(runId) {
  if (!/^run-[a-zA-Z0-9-]+$/.test(String(runId || ''))) throw new Error('Invalid run id');
}

function pathsFor(root, runId) {
  assertRunId(runId);
  const runDir = join(root, 'data', 'runs', runId);
  return {
    runDir,
    manifestPath: join(runDir, 'manifest.json'),
    eventsPath: join(runDir, 'events.jsonl'),
    promptPath: join(runDir, 'prompt.txt'),
  };
}

const runCreationFlights = new Map();
const runEventMutationTails = new Map();

async function acquireRunEventMutation(root, runId) {
  const key = `${join(String(root || ''), 'data', 'runs')}\u0000${String(runId || '')}`;
  const previous = runEventMutationTails.get(key) || Promise.resolve();
  let releaseSlot;
  const slot = new Promise((resolve) => { releaseSlot = resolve; });
  const tail = previous.catch(() => {}).then(() => slot);
  runEventMutationTails.set(key, tail);
  await previous.catch(() => {});
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseSlot();
    if (runEventMutationTails.get(key) === tail) runEventMutationTails.delete(key);
  };
}

function runCreationError(code, message, { status = 409, runId = null } = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.runId = runId;
  return error;
}

function normalizeRunCreationIdempotencyKey(value) {
  if (value == null || String(value).trim() === '') return null;
  const key = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key)) {
    throw runCreationError(
      'invalid_run_creation_idempotency_key',
      'Run creation idempotency key must be 8-128 URL-safe characters',
      { status: 422 },
    );
  }
  return key;
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalJsonValue(value[key])]),
    );
  }
  return value === undefined ? null : value;
}

function fileRequestEvidence(files = []) {
  return files.map((file, index) => {
    const bytes = Buffer.from(file.bytes || file.buffer || []);
    return {
      ordinal: index + 1,
      name: String(file.name || file.originalname || ''),
      role: String(file.role || ''),
      face_angle: String(file.face_angle || ''),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
}

function runCreationRequestSha256({
  customerName = '',
  customerId = null,
  prompt,
  identityFiles = [],
  templateFiles = [],
  referencePlan = {},
  customerContext = {},
  templateSelectionId = null,
  catalogTemplateUids = [],
  templateDecisionIdempotencyKey = null,
  taskIntent = null,
  promptCompilation = null,
  customerIdentitySource = null,
  candidateSlateRequest = null,
  faceAngleAnalysis = null,
  templateSelectionTaskBrief = null,
  sourceRunId = null,
  taskResolution = null,
}) {
  const effectivePrompt = String(promptCompilation?.compiled_prompt || prompt || '').trim();
  const evidence = canonicalJsonValue({
    customer_name: String(customerName || '').trim(),
    customer_id: customerId || null,
    prompt: effectivePrompt,
    identity_files: fileRequestEvidence(identityFiles),
    template_files: fileRequestEvidence(templateFiles),
    reference_plan: referencePlan,
    customer_context: customerContext,
    template_selection_id: templateSelectionId || null,
    catalog_template_uids: catalogTemplateUids.map(String),
    template_decision_idempotency_key: templateDecisionIdempotencyKey || null,
    task_intent: taskIntent,
    prompt_compilation: promptCompilation,
    customer_identity_source: customerIdentitySource,
    candidate_slate_request: candidateSlateRequest,
    face_angle_analysis: faceAngleAnalysis,
    template_selection_task_brief: templateSelectionTaskBrief,
    ...(sourceRunId ? {source_run_id:sourceRunId} : {}),
    ...(taskResolution ? {task_resolution:taskResolution} : {}),
  });
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

async function findRunCreationReplay({ root, idempotencyKey, requestSha256 }) {
  const runsRoot = join(root, 'data', 'runs');
  let entries = [];
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const matches = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !/^run-[a-zA-Z0-9-]+$/.test(entry.name)) continue;
    try {
      const manifest = JSON.parse(await readFile(join(runsRoot, entry.name, 'manifest.json'), 'utf8'));
      if (manifest?.run_creation?.idempotency_key === idempotencyKey) matches.push({ runId: entry.name, manifest });
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  if (matches.length > 1) {
    throw runCreationError(
      'duplicate_run_creation_idempotency_key',
      'Multiple canonical Runs share one creation idempotency key',
      { status: 409, runId: matches[0].runId },
    );
  }
  if (!matches.length) return null;
  const match = matches[0];
  if (match.manifest.run_creation.request_sha256 !== requestSha256) {
    throw runCreationError(
      'run_creation_idempotency_conflict',
      'Run creation idempotency key is already bound to different request evidence',
      { status: 409, runId: match.runId },
    );
  }
  return loadRun({ root, runId: match.runId });
}

async function storeGroup(dir, files = [], catalogRefs = [], { manualSourceType = null } = {}) {
  await mkdir(dir, { recursive: true });
  const stored = [];
  for (const [index, file] of files.entries()) {
    const bytes = Buffer.from(file.bytes || file.buffer);
    const filename = `${String(index + 1).padStart(2, '0')}-${safeName(file.name || file.originalname || 'reference', 'reference')}`;
    const path = join(dir, filename);
    await writeFile(path, bytes);
    stored.push({
      path,
      filename,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      ...(file.role ? {role:file.role} : {}),
      ...(manualSourceType ? {
        source_type: manualSourceType,
        original_filename: file.name || file.originalname || filename,
      } : {}),
    });
  }
  for (const catalogReference of catalogRefs) {
    const bytes = Buffer.from(catalogReference.image_bytes);
    const metadata = inspectImage(bytes);
    if (metadata.extension !== catalogReference.reference_image_extension
      || metadata.mimeType !== catalogReference.reference_image_mime_type) {
      throw new CatalogRunIntegrationError(
        'template_selection_link_failed',
        `Catalog reference metadata does not match immutable evidence: ${catalogReference.template_uid}`,
        { details: [{ source_code: 'reference_metadata_mismatch', template_uid: catalogReference.template_uid }] },
      );
    }
    const safeTemplateStem = safeName(catalogReference.template_uid, 'catalog-template').replace(/\.[^.]+$/, '');
    const filename = `${String(stored.length + 1).padStart(2, '0')}-${safeTemplateStem}${metadata.extension}`;
    const path = join(dir, filename);
    await writeFile(path, bytes);
    stored.push({
      path,
      filename,
      sha256: catalogReference.reference_image_sha256,
      bytes: bytes.length,
      width: metadata.width,
      height: metadata.height,
      mime_type: metadata.mimeType,
      extension: metadata.extension,
      source_type: 'catalog_template',
      decision_type: catalogReference.decision_type,
      substituted_for_template_uid: catalogReference.substituted_for_template_uid,
      selection_source_kind: catalogReference.selection_source_kind || null,
      selection_source_slate_id: catalogReference.selection_source_slate_id || null,
      template_uid: catalogReference.template_uid,
      template_name: catalogReference.template_name,
      source_ordinal: catalogReference.source_ordinal,
      selected_rank: catalogReference.selected_rank,
      relevance_score: catalogReference.relevance_score,
      selection_id: catalogReference.selection_id,
      reference_image_sha256: catalogReference.reference_image_sha256,
      generation_blueprint_sha256: catalogReference.generation_blueprint_sha256,
      catalog_projection_version: catalogReference.catalog_projection_version,
      ranking_policy_version: catalogReference.ranking_policy_version,
    });
  }
  return stored;
}

async function atomicWriteJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

async function readEvents(eventsPath) {
  try {
    const text = await readFile(eventsPath, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function legacyArtifacts(manifest) {
  if (Array.isArray(manifest.artifacts)) return manifest.artifacts;
  return (manifest.results || []).map((result, index) => ({
    artifact_id: `legacy-${String(result.sha256 || index + 1).slice(0, 20)}-${index + 1}`,
    ordinal: index + 1,
    path: result.path,
    filename: result.filename,
    sha256: result.sha256,
    bytes: result.bytes,
    width: result.width || null,
    height: result.height || null,
    mime_type: result.mime_type || null,
    capture_method: 'legacy_result',
    captured_at: manifest.result_saved_at || manifest.updated_at,
    legacy: true,
  }));
}

function projectManifest(manifest) {
  const artifacts = legacyArtifacts(manifest);
  const base={...manifest};
  if((manifest.status==='submitted'&&manifest.submitted_at&&Number(manifest.submission_attempt_count||0)>0)||(artifacts.length&&['artifacts_saved','completed','preference_pending'].includes(manifest.status)))delete base.last_error;
  const artifactReviews = { ...(manifest.artifact_reviews || {}) };
  if (!Object.keys(artifactReviews).length && manifest.latest_review && artifacts.length === 1) {
    artifactReviews[artifacts[0].artifact_id] = { ...manifest.latest_review, legacy: true };
  }
  const storedPreflight = manifest.reference_preflight;
  const referencePreflight = storedPreflight
    && manifest.task_resolution?.policy_version !== 'image-first-task-v1'
    && storedPreflight.policy_version !== REFERENCE_POLICY_VERSION
    && manifest.reference_plan
    ? evaluateReferencePlan({ referencePlan: manifest.reference_plan, customerContext: manifest.customer_context })
    : storedPreflight;
  return {
    ...base,
    artifacts,
    invalidated_artifacts: [...(manifest.invalidated_artifacts || [])],
    restored_artifacts: [...(manifest.restored_artifacts || [])],
    artifact_reviews: artifactReviews,
    artifact_annotations: { ...(manifest.artifact_annotations || {}) },
    artifact_style_suggestions: { ...(manifest.artifact_style_suggestions || {}) },
    aesthetic_comparisons: [...(manifest.aesthetic_comparisons || [])],
    review_suggestions: { ...(manifest.review_suggestions || {}) },
    human_corrections: [...(manifest.human_corrections || [])],
    template_outcome_bridge: { ...(manifest.template_outcome_bridge || {}) },
    preference: manifest.preference || null,
    reference_preflight: referencePreflight,
  };
}

function resultProjection(artifacts) {
  return artifacts.map(({ artifact_id, path, filename, sha256, bytes, width, height, mime_type }) => ({
    artifact_id, path, filename, sha256, bytes, width, height, mime_type,
  }));
}

function candidateSlateEvent(request, recordedAt = new Date(0).toISOString()) {
  return {
    type: 'CandidateSlateRequested',
    recorded_at: recordedAt,
    data: { candidate_slate_request: request },
  };
}

function updateCandidateSlateProjection(manifest, { ambiguous = false } = {}) {
  if (!manifest.candidate_slate_request) return manifest;
  return {
    ...manifest,
    candidate_slate: projectCandidateSlate({
      events: [candidateSlateEvent(manifest.candidate_slate_request, manifest.created_at)],
      artifacts: manifest.artifacts || [],
      ambiguous,
    }),
  };
}

function applyEvent(manifest, event) {
  const next = {
    ...manifest,
    artifacts: [...(manifest.artifacts || [])],
    invalidated_artifacts: [...(manifest.invalidated_artifacts || [])],
    restored_artifacts: [...(manifest.restored_artifacts || [])],
    artifact_reviews: { ...(manifest.artifact_reviews || {}) },
    artifact_annotations: { ...(manifest.artifact_annotations || {}) },
    artifact_style_suggestions: { ...(manifest.artifact_style_suggestions || {}) },
    aesthetic_comparisons: [...(manifest.aesthetic_comparisons || [])],
    review_suggestions: { ...(manifest.review_suggestions || {}) },
    human_corrections: [...(manifest.human_corrections || [])],
    template_outcome_bridge: { ...(manifest.template_outcome_bridge || {}) },
    updated_at: event.recorded_at,
  };
  switch (event.type) {
    case 'RunPrepared':
      next.status = 'prepared';
      break;
    case 'CandidateSlateRequested':
      next.candidate_slate_request = buildCandidateSlateRequest(event.data?.candidate_slate_request || {});
      next.generation_regime_version = GENERATION_REGIME_VERSION;
      Object.assign(next, updateCandidateSlateProjection(next));
      break;
    case 'TemplateSelectionLinked':
      next.template_selection = {
        ...(next.template_selection || {}),
        ...(event.data?.template_selection || {}),
        link_state: 'linked',
        linked_at: event.recorded_at,
      };
      delete next.template_selection.link_error;
      break;
    case 'TemplateSelectionLinkFailed':
      next.template_selection = {
        ...(next.template_selection || {}),
        link_state: 'failed',
        link_failed_at: event.recorded_at,
        link_error: event.data?.error || {
          code: 'template_selection_link_failed',
          message: 'Template selection linkage failed',
          details: [],
        },
      };
      break;
    case 'RunStaged':
      if(Number(next.submission_attempt_count||0)>0||next.artifacts.length)break;
      next.status = 'staged';
      next.staged_at = event.recorded_at;
      delete next.last_error;
      break;
    case 'RunSubmissionAttemptStarted':
      if(event.data?.api_submission)next.image_api=structuredClone(event.data.api_submission);
      next.status = 'submission_uncertain';
      next.submission_attempt_count = Math.max(Number(next.submission_attempt_count || 0), Number(event.data?.submission_attempt || 1));
      next.submission_attempt_id = String(event.data?.attempt_id || '');
      next.submission_attempt_started_at = event.recorded_at;
      next.last_error = {
        state: 'submission_uncertain',
        message: 'Submission attempt was durably registered before the external send action; retry is forbidden until resolved',
        recorded_at: event.recorded_at,
      };
      break;
    case 'RunStageFailed':
      if(Number(next.submission_attempt_count||0)>0||next.artifacts.length)break;
      next.status = event.data?.state || 'provider_error';
      next.last_error = { state: next.status, message: event.data?.message || '', recorded_at: event.recorded_at };
      break;
    case 'RunSubmitted':
      next.status = next.artifacts.length ? (next.status==='completed'?'completed':'artifacts_saved') : 'submitted';
      delete next.last_error;
      next.submitted_at = event.recorded_at;
      next.capture_context = event.data?.capture_context || next.capture_context || null;
      next.submission_attempt_count = Math.max(Number(next.submission_attempt_count || 0), Number(event.data?.submission_attempt || 1));
      break;
    case 'RunSubmissionUncertain':
      next.status = 'submission_uncertain';
      next.capture_context = event.data?.capture_context || next.capture_context || null;
      next.submission_attempt_count = Math.max(Number(next.submission_attempt_count || 0), Number(event.data?.submission_attempt || 1));
      next.last_error = { state: next.status, message: event.data?.message || '', recorded_at: event.recorded_at };
      break;
    case 'RunSubmissionFailed':
      {
        const failureState = event.data?.state || 'provider_error';
        const attempted = Math.max(Number(next.submission_attempt_count || 0), Number(event.data?.submission_attempt || 1));
        next.status = next.status === 'submission_uncertain' && attempted > 0
          && ['provider_error', 'provider_rate_limited'].includes(failureState)
          ? 'submission_uncertain'
          : failureState;
        next.submission_attempt_count = attempted;
        next.last_error = { state: failureState, message: event.data?.message || '', recorded_at: event.recorded_at };
      }
      break;
    case 'CaptureContextUpdated':
      next.capture_context = event.data?.capture_context || next.capture_context || null;
      break;
    case 'ArtifactImported':
    case 'ArtifactCaptured': {
      const artifact = event.data?.artifact;
      if (artifact && !next.artifacts.some((item) => item.sha256 === artifact.sha256)) next.artifacts.push(artifact);
      next.results = resultProjection(next.artifacts);
      next.status = 'artifacts_saved';
      delete next.last_error;
      next.result_saved_at = event.recorded_at;
      Object.assign(next, updateCandidateSlateProjection(next));
      break;
    }
    case 'ArtifactCaptureInvalidated': {
      const ids = new Set((event.data?.artifact_ids || []).map(String));
      const invalidated = next.artifacts
        .filter((artifact) => ids.has(artifact.artifact_id))
        .map((artifact) => ({
          ...artifact,
          invalidated_at: event.recorded_at,
          invalidation_reason: event.data?.reason || 'capture_mismatch',
        }));
      next.invalidated_artifacts.push(...invalidated.filter((artifact) => (
        !next.invalidated_artifacts.some((existing) => existing.artifact_id === artifact.artifact_id)
      )));
      next.artifacts = next.artifacts.filter((artifact) => !ids.has(artifact.artifact_id));
      for (const artifactId of ids) delete next.artifact_reviews[artifactId];
      for (const artifactId of ids) delete next.artifact_annotations[artifactId];
      if (ids.has(next.preference?.winner_artifact_id)) next.preference = { decision: 'pending', winner_artifact_id: null };
      next.results = resultProjection(next.artifacts);
      next.status = next.artifacts.length ? 'artifacts_saved' : 'submitted';
      next.capture = {
        state: 'invalidated',
        message: event.data?.reason || 'Automatic capture was invalidated',
        checked_at: event.recorded_at,
        real_provider_verified: false,
      };
      Object.assign(next, updateCandidateSlateProjection(next));
      break;
    }
    case 'ArtifactCaptureRestored': {
      const artifactId = String(event.data?.artifact_id || '');
      const archived = next.invalidated_artifacts.find((artifact) => artifact.artifact_id === artifactId);
      if (archived && !next.artifacts.some((artifact) => artifact.artifact_id === artifactId)) {
        const { invalidated_at, invalidation_reason, ...activeArtifact } = archived;
        next.artifacts.push(activeArtifact);
        next.artifacts.sort((left, right) => Number(left.ordinal || 0) - Number(right.ordinal || 0));
      }
      if (archived && !next.restored_artifacts.some((item) => item.artifact_id === artifactId)) {
        next.restored_artifacts.push({
          artifact_id: artifactId,
          restored_at: event.recorded_at,
          restoration_reason: event.data?.reason || 'capture_verified',
        });
      }
      next.results = resultProjection(next.artifacts);
      next.status = next.artifacts.length ? 'artifacts_saved' : 'submitted';
      if (next.artifacts.length) {
        next.capture = {
          state: 'saved',
          artifact_count: next.artifacts.length,
          checked_at: event.recorded_at,
          real_provider_verified: false,
        };
      }
      Object.assign(next, updateCandidateSlateProjection(next));
      break;
    }
    case 'ResultSaved':
      next.status = 'result_saved';
      next.results = event.data?.results || [];
      next.result_saved_at = event.recorded_at;
      break;
    case 'ArtifactReviewRecorded':
      if (event.data?.artifact_id && event.data?.review) {
        next.artifact_reviews[event.data.artifact_id] = event.data.review;
        const reviewedCount = Object.keys(next.artifact_reviews).length;
        next.review_status = reviewedCount >= next.artifacts.length ? 'reviewed' : 'in_progress';
        if (event.data.compatibility_run_review) next.latest_review = event.data.review;
      }
      break;
    case 'AestheticComparisonRecorded':
      if (event.data?.comparison) next.aesthetic_comparisons.push(event.data.comparison);
      break;
    case 'ReviewSuggestionRecorded':
      if (event.data?.artifact_id && event.data?.suggestion) next.review_suggestions[event.data.artifact_id] = event.data.suggestion;
      break;
    case 'ArtifactStyleSuggested': {
      const artifactId = String(event.data?.artifact_id || '').trim();
      if (!next.artifacts.some((artifact) => artifact.artifact_id === artifactId)) throw new Error('Artifact style suggestion references an unknown artifact');
      next.artifact_style_suggestions[artifactId] = normalizeArtifactStyleSuggestion({
        ...(event.data?.suggestion || {}),
        artifact_id: artifactId,
      });
      break;
    }
    case 'HumanCorrectionRecorded':
      if (event.data?.correction) next.human_corrections.push(event.data.correction);
      break;
    case 'TemplateOutcomeBridgeProcessed':
    case 'TemplateOutcomeBridgeDeferred':
      next.template_outcome_bridge = {
        status: event.type === 'TemplateOutcomeBridgeProcessed' ? 'processed' : 'deferred',
        ...(event.data || {}),
        recorded_at: event.recorded_at,
      };
      break;
    case 'ArtifactAnnotationRecorded':
      if (event.data?.artifact_id && event.data?.annotation) {
        next.artifact_annotations[event.data.artifact_id] = event.data.annotation;
      }
      break;
    case 'ReviewRecorded':
      next.review_status = 'reviewed';
      next.latest_review = event.data?.review;
      break;
    case 'PreferenceRecorded':
      next.preference = event.data?.preference || null;
      next.status = next.preference?.decision === 'pending' ? 'preference_pending' : 'completed';
      break;
    case 'CaptureRecoveryRequested':
      next.status = 'capture_pending';
      next.capture_context = event.data?.capture_context || next.capture_context || null;
      next.capture = {
        state: 'capture_pending',
        message: event.data?.reason || 'verified_late_result_recovery',
        checked_at: event.recorded_at,
        real_provider_verified: false,
      };
      break;
    case 'CaptureChecked':
      next.capture = event.data?.capture || next.capture;
      Object.assign(next, updateCandidateSlateProjection(next, {
        ambiguous: next.capture?.state === 'capture_ambiguous',
      }));
      break;
    case 'RunExcludedFromLearning':
      next.excluded_from_learning = true;
      next.exclusion_reason = event.data?.reason || 'verification';
      break;
    case 'HistoricalRunImported':
      next.history_import = {
        source_type: event.data?.source_type || 'manual_history_import',
        batch_label: event.data?.batch_label || '',
        result_count: Number(event.data?.result_count || next.artifacts.length || 0),
        imported_at: event.recorded_at,
      };
      next.status = next.artifacts.length ? 'artifacts_saved' : next.status;
      break;
    case 'RunRecordUpdated':
      next.customer_name = String(event.data?.customer_name || '').trim();
      next.prompt_sha256 = String(event.data?.prompt_sha256 || next.prompt_sha256 || '');
      next.customer_context = {
        ...(next.customer_context || {}),
        intended_use: String(event.data?.intended_use || '').trim(),
      };
      next.history_import = {
        ...(next.history_import || { source_type: 'record_update', result_count: next.artifacts.length || 0 }),
        batch_label: String(event.data?.batch_label || '').trim(),
      };
      next.record_revision = Number(next.record_revision || 0) + 1;
      next.record_updated_at = event.recorded_at;
      break;
    case 'RunPreparationRevised':
      Object.assign(next,event.data.preparation);
      next.status='prepared';
      next.preparation_revision_id=event.data.revision_id;
      break;
    default:
      break;
  }
  return next;
}

async function createRunSnapshotInternal({
  root,
  customerName = '',
  customerId = null,
  prompt,
  identityFiles = [],
  templateFiles = [],
  referencePlan = {},
  customerContext = {},
  templateSelectionId = null,
  catalogTemplateUids = [],
  templateDecisionIdempotencyKey = null,
  selectionDecisionRecorder,
  taskIntent = null,
  promptCompilation = null,
  customerIdentitySource = null,
  candidateSlateRequest = null,
  faceAngleAnalysis = null,
  runCreation = null,
  templateSelectionTaskBrief = null,
  imageApi = null,
  sourceRunId = null,
  revisionSource = null,
  taskResolution = null,
}) {
  const normalizedCandidateSlateRequest = candidateSlateRequest
    ? buildCandidateSlateRequest(candidateSlateRequest)
    : null;
  const effectivePrompt = String(promptCompilation?.compiled_prompt || prompt || '').trim();
  if(taskResolution && (!taskResolution.ready || taskResolution.customer_id!==customerId))throw Object.assign(new Error(taskResolution.blocking_issues?.[0]?.message||taskResolution.conflicts?.[0]?.message||'任务解析未通过'),{status:422});
  if (!effectivePrompt) throw new Error('Prompt is required');
  if (!identityFiles.length && !imageApi) throw new Error('At least one identity image is required');
  if (customerId && !/^cust_[a-f0-9]{16}$/.test(String(customerId))) throw new Error('Invalid customer id');
  const totalTemplateReferences = templateFiles.length + catalogTemplateUids.length;
  if (!totalTemplateReferences && !imageApi) throw new Error('At least one template image is required');
  if (totalTemplateReferences > 4) {
    throw new CatalogRunIntegrationError(
      'template_reference_limit_exceeded',
      'Total template references cannot exceed 4',
      { status: 422 },
    );
  }

  const resolvedCatalog = await resolveCatalogSelectionForRun({
    root,
    templateSelectionId,
    catalogTemplateUids,
    expectedTaskBrief: templateSelectionTaskBrief,
  });
  await assertTemplatesNotRejected({root,imageHashes:templateFiles.map(file=>createHash('sha256').update(file.bytes).digest('hex'))});
  const hasCatalogReferences = resolvedCatalog.catalogReferences.length > 0;
  const now = new Date().toISOString();
  const runId = `run-${now.replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`;
  const { runDir, manifestPath, eventsPath, promptPath } = pathsFor(root, runId);
  const identity = await storeGroup(join(runDir, 'identity'), identityFiles);
  const templates = await storeGroup(
    join(runDir, 'templates'),
    templateFiles,
    resolvedCatalog.catalogReferences,
    { manualSourceType: hasCatalogReferences ? 'uploaded_reference' : null },
  );
  await mkdir(runDir, { recursive: true });
  await writeFile(promptPath, `${effectivePrompt}\n`, 'utf8');

  const referencePreflight = taskResolution?.reference_preflight || evaluateReferencePlan({ referencePlan, customerContext });
  if (imageApi && !taskResolution) {
    referencePreflight.state = 'passed';
    referencePreflight.blocking_issues = [];
  }
  const learningGuidance = await loadReviewGuidance({ root });
  const manifest = {
    schema_version: normalizedCandidateSlateRequest ? 'ai-img-gen.web-run.v7' : (taskIntent || promptCompilation ? 'ai-img-gen.web-run.v6' : (hasCatalogReferences ? 'ai-img-gen.web-run.v5' : 'ai-img-gen.web-run.v4')),
    run_id: runId,
    status: 'prepared',
    review_status: 'not_reviewed',
    created_at: now,
    updated_at: now,
    customer_name: customerName.trim(),
    ...(customerId ? { customer_id: String(customerId) } : {}),
    customer_context: referencePreflight.normalized_customer_context,
    reference_plan: referencePreflight.normalized_reference_plan,
    reference_preflight: referencePreflight,
    learning_guidance_snapshot: {
      schema_version: learningGuidance.schema_version,
      rubric_version: learningGuidance.rubric_version,
      status: learningGuidance.status,
      sample_count: learningGuidance.sample_count,
      prompt_input_mode: learningGuidance.prompt_input_mode || 'reference_image',
      observational_corrections: learningGuidance.observational_corrections || [],
      shadow_corrections: learningGuidance.shadow_corrections || [],
      active_corrections: learningGuidance.active_corrections || [],
      active_guidance: learningGuidance.active_guidance,
      rebuilt_at: learningGuidance.rebuilt_at,
    },
    prompt_sha256: createHash('sha256').update(effectivePrompt).digest('hex'),
    ...(sourceRunId ? {source_run_id:sourceRunId} : {}),
    ...(revisionSource ? {run_kind:'artifact_revision',parent_run_id:revisionSource.parent_run_id,parent_artifact_id:revisionSource.parent_artifact_id,revision_source:structuredClone(revisionSource)} : {}),
    ...(taskResolution ? {task_resolution:structuredClone(taskResolution)} : {}),
    ...(runCreation ? { run_creation: { ...runCreation } } : {}),
    ...(taskIntent ? { task_intent: taskIntent } : {}),
    ...(promptCompilation ? { prompt_compilation: promptCompilation } : {}),
    ...(faceAngleAnalysis ? { face_angle_analysis: structuredClone(faceAngleAnalysis) } : {}),
    ...(normalizedCandidateSlateRequest ? {
      generation_regime_version: GENERATION_REGIME_VERSION,
      candidate_slate_request: normalizedCandidateSlateRequest,
    } : {}),
    ...(customerIdentitySource?.identity_set_id ? {
      customer_identity_source: {
        customer_id: String(customerIdentitySource.customer_id || ''),
        identity_set_id: String(customerIdentitySource.identity_set_id),
        source_type: 'customer_identity_set',
        ...(Array.isArray(customerIdentitySource.reference_ordinals) ? { reference_ordinals: customerIdentitySource.reference_ordinals.map(Number) } : {}),
        ...(customerIdentitySource.primary_reference_ordinal != null ? { primary_reference_ordinal: Number(customerIdentitySource.primary_reference_ordinal) } : {}),
      },
    } : {}),
    identity_references: identity,
    template_references: templates,
    ...(hasCatalogReferences ? { template_selection: resolvedCatalog.selectionSnapshot } : {}),
    artifacts: [],
    artifact_reviews: {},
    artifact_annotations: {},
    artifact_style_suggestions: {},
    aesthetic_comparisons: [],
    preference: null,
    results: [],
    capture: { state: 'not_started', real_provider_verified: false },
    submission_attempt_count: 0,
    executor: { name: imageApi ? 'openai-compatible-images' : 'playwright-mcp-extension', agent_required: false },
    ...(imageApi ? { image_api: imageApi, generation_regime_version: 'image-api-v1' } : {}),
  };
  if (normalizedCandidateSlateRequest) Object.assign(manifest, updateCandidateSlateProjection(manifest));
  const preparedEvent = {
    schema_version: 'ai-img-gen.run-event.v1',
    event_id: randomUUID(),
    run_id: runId,
    type: 'RunPrepared',
    recorded_at: now,
    data: {
      prompt_sha256: manifest.prompt_sha256,
      ...(imageApi ? { image_api: imageApi, generation_regime_version: 'image-api-v1' } : {}),
      identity_count: identity.length,
      template_count: templates.length,
      reference_plan: manifest.reference_plan,
      reference_preflight: {
        policy_version: referencePreflight.policy_version,
        state: referencePreflight.state,
        blocking_issue_codes: referencePreflight.blocking_issues.map((issue) => issue.code),
        warning_codes: referencePreflight.warnings.map((issue) => issue.code),
      },
      learning_guidance_status: manifest.learning_guidance_snapshot.status,
      customer_identity_source: manifest.customer_identity_source || null,
      template_selection_id: resolvedCatalog.selectionSnapshot?.selection_id || null,
      catalog_template_count: resolvedCatalog.catalogReferences.length,
      task_intent_version: taskIntent?.schema_version || null,
      prompt_compiler_id: promptCompilation?.compiler_id || null,
      prompt_recipe_id: promptCompilation?.recipe_id || null,
      prompt_input_mode: promptCompilation?.prompt_input_mode || null,
      applied_correction_ids: promptCompilation?.applied_correction_ids || [],
      shadow_correction_ids: promptCompilation?.shadow_correction_ids || [],
      angle_alignment: promptCompilation?.angle_alignment || null,
      candidate_slate_request_id: normalizedCandidateSlateRequest?.slate_request_id || null,
      run_creation_idempotency_key: runCreation?.idempotency_key || null,
      run_creation_request_sha256: runCreation?.request_sha256 || null,
    },
  };
  await atomicWriteJson(manifestPath, manifest);
  const candidateRequestedEvent = normalizedCandidateSlateRequest
    ? { ...buildCandidateSlateRequestedEvent(normalizedCandidateSlateRequest, { occurredAt: now }), run_id: runId }
    : null;
  await writeFile(eventsPath, `${JSON.stringify(preparedEvent)}\n${candidateRequestedEvent ? `${JSON.stringify(candidateRequestedEvent)}\n` : ''}`, 'utf8');

  if (!hasCatalogReferences) return { runId, runDir, manifestPath, manifest };

  try {
    const linkedSelection = await linkCatalogSelectionToRun({
      root,
      runId,
      selection: resolvedCatalog.selection,
      templateDecisionIdempotencyKey,
      ...(selectionDecisionRecorder ? { selectionDecisionRecorder } : {}),
    });
    const linkedTemplateSelection = {
      ...resolvedCatalog.selectionSnapshot,
      decision_id: linkedSelection.selection.decision.decision_id,
      link_state: 'linked',
    };
    const linkedRun = await recordRunEvent({
      root,
      runId,
      type: 'TemplateSelectionLinked',
      data: {
        template_selection: linkedTemplateSelection,
        catalog_template_uids: catalogTemplateUids,
      },
    });
    return linkedRun;
  } catch (error) {
    const failedRun = await recordRunEvent({
      root,
      runId,
      type: 'TemplateSelectionLinkFailed',
      data: {
        error: {
          code: error?.code || 'template_selection_link_failed',
          message: String(error?.message || error),
          details: Array.isArray(error?.details) ? error.details : [],
        },
      },
    });
    if (error instanceof CatalogRunIntegrationError) {
      error.runId = runId;
      error.failedRun = failedRun;
      throw error;
    }
    throw new CatalogRunIntegrationError('template_selection_link_failed', 'Template selection could not be linked safely', {
      status: error?.status || 409,
      details: [{ source_code: error?.code || 'selection_link_failed' }],
      runId,
      cause: error,
    });
  }
}

export async function createRunSnapshot(input = {}) {
  const idempotencyKey = normalizeRunCreationIdempotencyKey(input.runCreationIdempotencyKey);
  if (!idempotencyKey) return createRunSnapshotInternal(input);

  const normalizedCandidateSlateRequest = input.candidateSlateRequest
    ? buildCandidateSlateRequest(input.candidateSlateRequest)
    : null;
  const normalizedInput = { ...input, candidateSlateRequest: normalizedCandidateSlateRequest };
  const requestSha256 = runCreationRequestSha256(normalizedInput);
  const flightKey = `${join(String(input.root || ''), 'data', 'runs')}\u0000${idempotencyKey}`;
  const active = runCreationFlights.get(flightKey);
  if (active) {
    const created = await active.promise;
    if (active.requestSha256 !== requestSha256) {
      throw runCreationError(
        'run_creation_idempotency_conflict',
        'Run creation idempotency key is already bound to different request evidence',
        { status: 409, runId: created.runId },
      );
    }
    return { ...created, idempotent_replay: true };
  }

  const promise = (async () => {
    const replay = await findRunCreationReplay({ root: input.root, idempotencyKey, requestSha256 });
    if (replay) return { ...replay, idempotent_replay: true };
    const created = await createRunSnapshotInternal({
      ...normalizedInput,
      runCreation: { idempotency_key: idempotencyKey, request_sha256: requestSha256 },
    });
    return { ...created, idempotent_replay: false };
  })();
  runCreationFlights.set(flightKey, { requestSha256, promise });
  try {
    return await promise;
  } finally {
    if (runCreationFlights.get(flightKey)?.promise === promise) runCreationFlights.delete(flightKey);
  }
}

export async function loadRun({ root, runId }) {
  const paths = pathsFor(root, runId);
  const [manifestText, prompt, events] = await Promise.all([
    readFile(paths.manifestPath, 'utf8'),
    readFile(paths.promptPath, 'utf8'),
    readEvents(paths.eventsPath),
  ]);
  const latestPromptUpdate = [...events].reverse().find((event) => ['RunRecordUpdated','RunPreparationRevised'].includes(event.type) && (event.data?.prompt_text?.trim() || event.data?.preparation?.prompt_compilation?.compiled_prompt));
  return {
    runId,
    runDir: paths.runDir,
    manifestPath: paths.manifestPath,
    manifest: projectManifest(JSON.parse(manifestText.replace(/^\uFEFF/, ''))),
    prompt: latestPromptUpdate?.data.prompt_text?.trim() || latestPromptUpdate?.data.preparation?.prompt_compilation?.compiled_prompt || prompt.trim(),
    originalPrompt: prompt.trim(),
    events,
  };
}

export async function reviseRunPreparation({root,runId,resolution,promptCompilation,identityFiles,templateFiles,resolvedCatalog=null,identitySource=null,apiParameters=null}){
  const release=await acquireRunEventMutation(root,runId);
  try{
    const run=await loadRun({root,runId});
    if(Number(run.manifest.submission_attempt_count||0)>0||run.events.some(isSubmissionAttemptEvidenceEvent)||run.manifest.artifacts?.length)throw Object.assign(new Error('任务已经尝试发送，不能修改准备内容或重新发送。'),{status:409});
    const owner=run.manifest.customer_id||run.manifest.customer_identity_source?.customer_id;
    if(owner&&resolution.customer_id!==owner)throw Object.assign(new Error('不能切换原任务的客户身份。'),{status:422});
    if(!resolution.ready)throw Object.assign(new Error(resolution.blocking_issues[0]?.message||resolution.conflicts[0]?.message||'请检查输入'),{status:422});
    const revisionId=createHash('sha256').update(JSON.stringify({resolution:resolution.resolution_hash,prompt:promptCompilation.compiled_prompt,apiParameters})).digest('hex');
    if(run.manifest.preparation_revision_id===revisionId)return run;
    const dir=join(run.runDir,'preparations',revisionId);
    const identities=identityFiles?await storeGroup(join(dir,'identity'),identityFiles):run.manifest.identity_references;
    const templates=templateFiles?await storeGroup(join(dir,'templates'),templateFiles,resolvedCatalog?.catalogReferences||[]):run.manifest.template_references;
    const preparation={identity_references:identities,template_references:templates,task_resolution:structuredClone(resolution),reference_plan:resolution.reference_plan,reference_preflight:resolution.reference_preflight,task_intent:resolution.task_intent,prompt_compilation:promptCompilation,prompt_sha256:createHash('sha256').update(promptCompilation.compiled_prompt).digest('hex'),customer_context:resolution.reference_preflight.normalized_customer_context,...(resolvedCatalog?.selectionSnapshot?{template_selection:resolvedCatalog.selectionSnapshot}:{})};
    preparation.customer_identity_source=identitySource;
    if(run.manifest.image_api&&apiParameters)preparation.image_api={...run.manifest.image_api,...apiParameters};
    if(resolvedCatalog?.catalogReferences?.length){const linked=await linkCatalogSelectionToRun({root,runId,selection:resolvedCatalog.selection,templateDecisionIdempotencyKey:`prepare-${resolution.resolution_hash.slice(0,32)}`});preparation.template_selection={...resolvedCatalog.selectionSnapshot,decision_id:linked.selection.decision.decision_id,link_state:'linked'};}
    else if(templateFiles)preparation.template_selection=null;
    const event={schema_version:'ai-img-gen.run-event.v1',event_id:randomUUID(),run_id:runId,type:'RunPreparationRevised',recorded_at:new Date().toISOString(),data:{revision_id:revisionId,preparation}};
    await appendFile(pathsFor(root,runId).eventsPath,`${JSON.stringify(event)}\n`,'utf8');
    await atomicWriteJson(run.manifestPath,applyEvent(run.manifest,event));
    return loadRun({root,runId});
  }finally{release();}
}

async function templateLearningSummary({ root, runId, manifest }) {
  const catalogReferences = (manifest.template_references || [])
    .filter((reference) => reference?.source_type === 'catalog_template');
  if (!catalogReferences.length) {
    return { state: 'not_applicable', reason: 'manual_template', selection_id: null, template_uid: null, active_outcome_count: 0 };
  }
  if (catalogReferences.length !== 1) {
    return { state: 'deferred', reason: 'multiple_templates', selection_id: null, template_uid: null, active_outcome_count: 0 };
  }
  const reference = catalogReferences[0];
  const selectionId = reference.selection_id || manifest.template_selection?.selection_id || null;
  if (!selectionId) {
    return { state: 'deferred', reason: 'selection_missing', selection_id: null, template_uid: reference.template_uid || null, active_outcome_count: 0 };
  }
  let activeOutcomeCount = 0;
  let selectionProjection;
  try {
    selectionProjection = await loadTemplateSelection({ root, selectionId });
  } catch (error) {
    return {
      state: 'degraded',
      reason: ['selection_not_found', 'ENOENT'].includes(error?.code) ? 'selection_not_found' : 'selection_projection_invalid',
      selection_id: selectionId,
      template_uid: reference.template_uid || null,
      active_outcome_count: null,
    };
  }
  if (!selectionProjection || selectionProjection.selection_id !== selectionId || !Array.isArray(selectionProjection.active_outcomes)) {
    return {
      state: 'degraded',
      reason: 'selection_projection_invalid',
      selection_id: selectionId,
      template_uid: reference.template_uid || null,
      active_outcome_count: null,
    };
  }
  activeOutcomeCount = selectionProjection.active_outcomes.filter((outcome) => (
      outcome.run_id === runId && outcome.template_uid === reference.template_uid
  )).length;
  const artifactCount = (manifest.artifacts || []).length;
  const reviewedCount = Object.keys(manifest.artifact_reviews || {}).length;
  const preferenceDecision = manifest.preference?.decision || 'pending';
  const reason = activeOutcomeCount
    ? 'single_catalog_template'
    : reviewedCount < artifactCount
      ? 'incomplete_review'
      : !['winner', 'none'].includes(preferenceDecision)
        ? 'missing_preference'
        : 'outcome_not_active';
  return {
    state: activeOutcomeCount ? 'active' : 'deferred',
    reason,
    selection_id: selectionId,
    template_uid: reference.template_uid || null,
    active_outcome_count: activeOutcomeCount,
  };
}

export async function listRuns({ root, includeExcluded = false, artifactsOnly = true, limit = 100 } = {}) {
  const runsRoot = join(root, 'data', 'runs');
  let entries = [];
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^run-[a-zA-Z0-9-]+$/.test(entry.name)) continue;
    try {
      const run = await loadRun({ root, runId: entry.name });
      const manifest = run.manifest;
      const artifacts = manifest.artifacts || [];
      const preference = manifest.preference || null;
      const customerId = manifest.customer_identity_source?.customer_id || manifest.customer_id || null;
      const revisionSource = manifest.revision_source || {};
      const runKind = manifest.run_kind || (revisionSource.parent_run_id ? 'artifact_revision' : 'generation');
      const comparisonArtifacts = new Set((manifest.aesthetic_comparisons || []).flatMap((comparison) => [
        comparison.artifact_a_id,
        comparison.artifact_b_id,
        comparison.artifactAId,
        comparison.artifactBId,
      ]).filter(Boolean));
      const templateLearning = await templateLearningSummary({ root, runId: run.runId, manifest });
      if (!includeExcluded && manifest.excluded_from_learning) continue;
      if (artifactsOnly && !artifacts.length) continue;
      runs.push({
        run_id: run.runId,
        image_api: manifest.image_api || null,
        created_at: manifest.created_at,
        updated_at: manifest.updated_at,
        customer_name: manifest.customer_name,
        customer_id: customerId,
        run_kind: runKind,
        parent_run_id: revisionSource.parent_run_id || manifest.parent_run_id || null,
        parent_artifact_id: revisionSource.parent_artifact_id || manifest.parent_artifact_id || null,
        status: manifest.status,
        review_status: manifest.review_status,
        schema_version: manifest.schema_version,
        template_selection: manifest.template_selection || null,
        customer_identity_source: manifest.customer_identity_source || null,
        template_references: (manifest.template_references || []).map((reference) => ({
          filename: reference.filename,
          mime_type: reference.mime_type,
          extension: reference.extension || null,
          sha256: reference.sha256,
          source_type: reference.source_type || null,
          decision_type: reference.decision_type || null,
          substituted_for_template_uid: reference.substituted_for_template_uid || null,
          selection_source_kind: reference.selection_source_kind || null,
          selection_source_slate_id: reference.selection_source_slate_id || null,
          template_uid: reference.template_uid || null,
          template_name: reference.template_name || null,
          source_ordinal: reference.source_ordinal ?? null,
          selected_rank: reference.selected_rank ?? null,
          relevance_score: reference.relevance_score ?? null,
          selection_id: reference.selection_id || null,
          reference_image_sha256: reference.reference_image_sha256 || null,
          generation_blueprint_sha256: reference.generation_blueprint_sha256 || null,
          catalog_projection_version: reference.catalog_projection_version || null,
          ranking_policy_version: reference.ranking_policy_version || null,
        })),
        artifact_count: artifacts.length,
        identity_count: manifest.identity_references?.length || 0,
        template_count: manifest.template_references?.length || 0,
        reviewed_count: Object.keys(manifest.artifact_reviews || {}).length,
        prompt: run.prompt,
        history_import: manifest.history_import || null,
        intended_use: manifest.customer_context?.intended_use || '',
        record_revision: Number(manifest.record_revision || 0),
        preference: preference ? structuredClone(preference) : null,
        template_learning: templateLearning,
        artifacts: artifacts.map((artifact) => ({
          artifact_id: artifact.artifact_id,
          ordinal: artifact.ordinal,
          width: artifact.width,
          height: artifact.height,
          mime_type: artifact.mime_type,
          reviewed: Boolean(manifest.artifact_reviews?.[artifact.artifact_id]),
          preference_eligible: manifest.artifact_reviews?.[artifact.artifact_id]?.preference_eligible === true,
          is_winner: preference?.decision === 'winner' && preference.winner_artifact_id === artifact.artifact_id,
          comparison_state: manifest.artifact_reviews?.[artifact.artifact_id]?.preference_eligible !== true
            ? 'not_eligible'
            : comparisonArtifacts.has(artifact.artifact_id) ? 'compared' : 'eligible',
          annotation_count: Number(manifest.artifact_annotations?.[artifact.artifact_id]?.annotation_count || 0),
        })),
      });
    } catch {
      // Ignore incomplete directories; canonical Runs must have a readable manifest and prompt.
    }
  }
  return runs
    .sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')))
    .slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)));
}

export async function recordRunEvent({ root, runId, type, data = {}, recordedAt = new Date().toISOString() }) {
  const release = await acquireRunEventMutation(root, runId);
  try {
    const run = await loadRun({ root, runId });
    const event = {
      schema_version: 'ai-img-gen.run-event.v1',
      event_id: randomUUID(),
      run_id: runId,
      type,
      recorded_at: recordedAt,
      data,
    };
    await appendFile(pathsFor(root, runId).eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
    const manifest = applyEvent(run.manifest, event);
    await atomicWriteJson(run.manifestPath, manifest);
    return { ...run, manifest, events: [...run.events, event] };
  } finally {
    release();
  }
}

function strictRunSubmissionAttemptCount(manifest = {}) {
  if (!Object.prototype.hasOwnProperty.call(manifest, 'submission_attempt_count')) return 0;
  const value = manifest.submission_attempt_count;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Run submission attempt evidence is invalid');
  }
  return value;
}

function isSubmissionAttemptEvidenceEvent(event) {
  if (['RunSubmissionAttemptStarted', 'RunSubmitted', 'RunSubmissionUncertain'].includes(event?.type)) return true;
  return event?.type === 'RunSubmissionFailed' && Number(event.data?.submission_attempt || 0) > 0;
}

export async function beginRunSubmissionAttempt({ root, runId, recordedAt = new Date().toISOString(), requestSnapshot = null,apiSubmission=null,expectedPreparationRevision=undefined }) {
  const release = await acquireRunEventMutation(root, runId);
  try {
    const run = await loadRun({ root, runId });
    const attempts = strictRunSubmissionAttemptCount(run.manifest);
    const status = String(run.manifest.status || '');
    const attemptEvents = run.events.filter(isSubmissionAttemptEvidenceEvent);
    if (attemptEvents.length) {
      let repairedManifest = run.manifest;
      if (attempts === 0 || ['prepared', 'staged', 'provider_error', 'provider_rate_limited'].includes(status)) {
        for (const event of attemptEvents) repairedManifest = applyEvent(repairedManifest, event);
        if (Number(repairedManifest.submission_attempt_count || 0) > 0
          && ['provider_error', 'provider_rate_limited'].includes(repairedManifest.status)) {
          repairedManifest = { ...repairedManifest, status: 'submission_uncertain' };
        }
        await atomicWriteJson(run.manifestPath, repairedManifest);
      }
      return {
        started: false,
        state: repairedManifest.status === 'submitted' ? 'already_submitted' : 'already_attempted',
        previousState: repairedManifest.status || status || 'submission_attempt_recorded',
        retryAutomatically: false,
        run: { ...run, manifest: repairedManifest },
      };
    }
    if (attempts > 0 || ['submitted', 'submission_uncertain'].includes(status)) {
      return {
        started: false,
        state: status === 'submitted' ? 'already_submitted' : 'already_attempted',
        previousState: status || 'submission_attempt_recorded',
        retryAutomatically: false,
        run,
      };
    }
    if (status !== 'staged') throw new Error(`Run must be staged before submission attempt registration: ${status || 'missing'}`);
    if(expectedPreparationRevision!==undefined&&(run.manifest.preparation_revision_id||null)!==expectedPreparationRevision)throw Object.assign(new Error('任务准备信息已更新，请重新检查后再发送；本次尚未发送'),{status:409});
    const attemptId = `attempt_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const event = {
      schema_version: 'ai-img-gen.run-event.v1',
      event_id: randomUUID(),
      run_id: runId,
      type: 'RunSubmissionAttemptStarted',
      recorded_at: recordedAt,
      data: { attempt_id: attemptId, submission_attempt: 1, request_snapshot: requestSnapshot || buildSubmissionSnapshot(run,{prompt:run.prompt}),...(apiSubmission?{api_submission:apiSubmission}:{}) },
    };
    await appendFile(pathsFor(root, runId).eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
    const manifest = applyEvent(run.manifest, event);
    await atomicWriteJson(run.manifestPath, manifest);
    return {
      started: true,
      state: 'submission_attempt_started',
      attemptId,
      runBefore: run,
      run: { ...run, manifest, events: [...run.events, event] },
    };
  } finally {
    release();
  }
}

export async function updateRunRecord({ root, runId, customerName = '', prompt, batchLabel = '', intendedUse = '' }) {
  const current = await loadRun({ root, runId });
  const normalizedPrompt = String(prompt || '').trim();
  if (!normalizedPrompt) throw new Error('Prompt is required');
  const normalizedCustomerName = String(customerName || '').trim();
  const normalizedBatchLabel = String(batchLabel || '').trim();
  const normalizedIntendedUse = String(intendedUse || '').trim();
  return recordRunEvent({
    root,
    runId,
    type: 'RunRecordUpdated',
    data: {
      customer_name: normalizedCustomerName,
      prompt_text: normalizedPrompt,
      prompt_sha256: createHash('sha256').update(normalizedPrompt).digest('hex'),
      batch_label: normalizedBatchLabel,
      intended_use: normalizedIntendedUse,
      previous: {
        customer_name: current.manifest.customer_name || '',
        prompt_sha256: current.manifest.prompt_sha256 || '',
        batch_label: current.manifest.history_import?.batch_label || '',
        intended_use: current.manifest.customer_context?.intended_use || '',
      },
      editor: 'primary-user',
    },
  });
}

export async function importArtifacts({ root, runId, files = [], captureMethod = 'manual_import', source = {} }) {
  if (!files.length) throw new Error('At least one result image is required');
  if (files.length > 4) throw new Error('At most four result images can be imported at once');
  let run = await loadRun({ root, runId });
  const existingHashes = new Set(run.manifest.artifacts.map((item) => item.sha256));
  const uniqueFiles = [];
  for (const file of files) {
    const bytes = Buffer.from(file.bytes || []);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (existingHashes.has(sha256) || uniqueFiles.some((item) => item.sha256 === sha256)) continue;
    const metadata = inspectImage(bytes);
    uniqueFiles.push({ ...file, bytes, sha256, metadata });
  }
  if (run.manifest.artifacts.length + uniqueFiles.length > 4) throw new Error('A run can contain at most four artifacts');

  for (const file of uniqueFiles) {
    const artifactId = `artifact-${randomUUID()}`;
    const artifactDir = join(run.runDir, 'outputs', 'artifacts', artifactId);
    const filename = `original${file.metadata.extension}`;
    const path = join(artifactDir, filename);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path, file.bytes);
    const artifact = {
      artifact_id: artifactId,
      ordinal: run.manifest.artifacts.length + 1,
      path,
      filename,
      original_name: safeName(file.name, 'candidate'),
      sha256: file.sha256,
      bytes: file.bytes.length,
      width: file.metadata.width,
      height: file.metadata.height,
      mime_type: file.metadata.mimeType,
      capture_method: captureMethod,
      capture_source: file.source || source,
      captured_at: new Date().toISOString(),
    };
    run = await recordRunEvent({
      root,
      runId,
      type: captureMethod === 'manual_import' ? 'ArtifactImported' : 'ArtifactCaptured',
      data: { artifact },
    });
    existingHashes.add(file.sha256);
  }
  return run;
}

export async function createHistoricalRun({
  root,
  customerName = '',
  prompt,
  identityFiles = [],
  templateFiles = [],
  resultFiles = [],
  referencePlan = {},
  customerContext = {},
  source = {},
}) {
  const prepared = await createRunSnapshot({
    root,
    customerName,
    prompt,
    identityFiles,
    templateFiles,
    referencePlan,
    customerContext,
  });
  const imported = await importArtifacts({
    root,
    runId: prepared.runId,
    files: resultFiles,
    captureMethod: 'manual_import',
    source: { source_type: 'manual_history_import', batch_label: String(source.batch_label || '') },
  });
  return recordRunEvent({
    root,
    runId: imported.runId,
    type: 'HistoricalRunImported',
    data: {
      source_type: 'manual_history_import',
      batch_label: String(source.batch_label || ''),
      result_count: imported.manifest.artifacts.length,
      prompt_sha256: imported.manifest.prompt_sha256,
    },
  });
}

export async function saveResultFiles({ root, runId, files = [] }) {
  return importArtifacts({ root, runId, files, captureMethod: 'manual_import' });
}

export async function saveArtifactReview({ root, runId, artifactId, review, compatibilityRunReview = false }) {
  const run = await loadRun({ root, runId });
  if (!run.manifest.artifacts?.length) throw new Error('Save at least one generated result before reviewing');
  if (!run.manifest.artifacts.some((artifact) => artifact.artifact_id === artifactId)) throw new Error('Artifact not found');
  const previousPasses = run.events.filter((event) => event.type === 'ArtifactReviewRecorded' && event.data?.artifact_id === artifactId).length;
  const previousArtifactReview = run.manifest.artifact_reviews?.[artifactId] || null;
  const evaluated = evaluateReview(review);
  const structured = {
    ...evaluated,
    artifact_id: artifactId,
    notes: String(review?.notes || '').trim(),
    reviewer_id: 'primary-user',
    review_session_id: randomUUID(),
    review_pass: previousPasses ? `revision-${previousPasses}` : 'initial',
    recorded_at: new Date().toISOString(),
  };
  let recorded = await recordRunEvent({
    root,
    runId,
    type: 'ArtifactReviewRecorded',
    data: { artifact_id: artifactId, review: structured, compatibility_run_review: compatibilityRunReview },
  });
  const previousPreference = run.manifest.preference;
  const coreReviewChanged = ['face_identity_fidelity', 'realism_naturalness', 'style_consistency']
    .some((key) => Number(previousArtifactReview?.[key]) !== Number(evaluated[key]));
  const winnerReviewChanged = previousPreference?.decision === 'winner'
    && previousPreference.winner_artifact_id === artifactId
    && coreReviewChanged;
  const winnerNoLongerQualified = previousPreference?.decision === 'winner'
    && recorded.manifest.artifact_reviews?.[previousPreference.winner_artifact_id]?.preference_eligible !== true;
  if (previousPasses > 0 && previousPreference && previousPreference.decision !== 'pending'
    && (winnerReviewChanged || winnerNoLongerQualified)) {
    const eligibleArtifactIds = recorded.manifest.artifacts
      .filter((artifact) => recorded.manifest.artifact_reviews?.[artifact.artifact_id]?.preference_eligible === true)
      .map((artifact) => artifact.artifact_id);
    const excludedArtifactIds = recorded.manifest.artifacts
      .filter((artifact) => !eligibleArtifactIds.includes(artifact.artifact_id))
      .map((artifact) => artifact.artifact_id);
    recorded = await recordRunEvent({
      root,
      runId,
      type: 'PreferenceRecorded',
      data: {
        preference: {
          decision: 'pending',
          winner_artifact_id: null,
          eligible_artifact_ids: eligibleArtifactIds,
          excluded_artifact_ids: excludedArtifactIds,
          pairwise: [],
          notes: '',
          reviewer_id: 'system',
          preference_session_id: randomUUID(),
          supersedes_preference_session_id: previousPreference.preference_session_id || null,
          invalidation_reason: winnerNoLongerQualified ? 'winner_no_longer_qualified' : 'review_revised_after_final_preference',
          recorded_at: new Date().toISOString(),
        },
      },
    });
  }
  const reviewProjection = await rebuildReviewGuidance({ root });
  return { ...recorded, reviewProjection };
}

export async function saveArtifactAnnotation({ root, runId, artifactId, payload, previewBytes }) {
  const run = await loadRun({ root, runId });
  const artifact = run.manifest.artifacts?.find((item) => item.artifact_id === artifactId);
  if (!artifact) throw new Error('Artifact not found');
  const recordedAt = new Date().toISOString();
  const annotation = await writeAnnotationSession({
    artifact,
    payload,
    previewBytes,
    previousAnnotation: run.manifest.artifact_annotations?.[artifactId] || null,
    recordedAt,
  });
  return recordRunEvent({
    root,
    runId,
    type: 'ArtifactAnnotationRecorded',
    data: { artifact_id: artifactId, annotation },
    recordedAt,
  });
}

export async function loadArtifactAnnotation({ root, runId, artifactId }) {
  const run = await loadRun({ root, runId });
  const artifact = run.manifest.artifacts?.find((item) => item.artifact_id === artifactId);
  if (!artifact) throw new Error('Artifact not found');
  return readAnnotationSession({
    artifact,
    annotation: run.manifest.artifact_annotations?.[artifactId] || null,
  });
}


export async function saveAestheticComparison({
  root,
  runId,
  artifactAId,
  artifactBId,
  outcome,
  notes = '',
}) {
  const normalizedOutcome = String(outcome || '').trim().toLowerCase();
  if (!['a', 'b', 'tie', 'skip'].includes(normalizedOutcome)) {
    throw new Error('Aesthetic comparison outcome must be a, b, tie, or skip');
  }
  if (!artifactAId || !artifactBId || artifactAId === artifactBId) {
    throw new Error('Aesthetic comparison requires two distinct artifacts');
  }
  const run = await loadRun({ root, runId });
  const artifactIds = new Set((run.manifest.artifacts || []).map((artifact) => artifact.artifact_id));
  if (!artifactIds.has(artifactAId) || !artifactIds.has(artifactBId)) throw new Error('Comparison artifact not found');
  for (const artifactId of [artifactAId, artifactBId]) {
    if (run.manifest.artifact_reviews?.[artifactId]?.preference_eligible !== true) {
      throw new Error('Both artifacts must be aesthetic-eligible before comparison');
    }
  }
  const winnerArtifactId = normalizedOutcome === 'a'
    ? artifactAId
    : (normalizedOutcome === 'b' ? artifactBId : null);
  const loserArtifactId = normalizedOutcome === 'a'
    ? artifactBId
    : (normalizedOutcome === 'b' ? artifactAId : null);
  const comparison = {
    schema_version: 'ai-img-gen.aesthetic-comparison.v1',
    comparison_id: randomUUID(),
    review_rubric_version: REVIEW_RUBRIC.rubric_version,
    artifact_a_id: artifactAId,
    artifact_b_id: artifactBId,
    presentation_order: [artifactAId, artifactBId],
    outcome: normalizedOutcome,
    winner_artifact_id: winnerArtifactId,
    loser_artifact_id: loserArtifactId,
    notes: String(notes || '').trim(),
    reviewer_id: 'primary-user',
    recorded_at: new Date().toISOString(),
  };
  return recordRunEvent({ root, runId, type: 'AestheticComparisonRecorded', data: { comparison } });
}

export async function savePreference({ root, runId, decision, winnerArtifactId = null, notes = '' }) {
  if (!['winner', 'none', 'pending'].includes(decision)) throw new Error('Preference decision must be winner, none, or pending');
  const run = await loadRun({ root, runId });
  if (!run.manifest.artifacts?.length) throw new Error('Save at least one artifact before recording preference');
  const reviewedIds = new Set(Object.keys(run.manifest.artifact_reviews || {}));
  if (decision !== 'pending' && reviewedIds.size !== run.manifest.artifacts.length) {
    throw new Error('Review every artifact before final preference');
  }
  const eligibleArtifactIds = run.manifest.artifacts
    .filter((artifact) => run.manifest.artifact_reviews?.[artifact.artifact_id]?.preference_eligible === true)
    .map((artifact) => artifact.artifact_id);
  const excludedArtifactIds = run.manifest.artifacts
    .filter((artifact) => !eligibleArtifactIds.includes(artifact.artifact_id))
    .map((artifact) => artifact.artifact_id);
  if (decision === 'winner' && !eligibleArtifactIds.includes(winnerArtifactId)) {
    throw new Error('Winner must be a qualified artifact');
  }
  if (decision !== 'winner') winnerArtifactId = null;
  const preference = {
    decision,
    winner_artifact_id: winnerArtifactId,
    eligible_artifact_ids: eligibleArtifactIds,
    excluded_artifact_ids: excludedArtifactIds,
    pairwise: [],
    source_type: 'final_delivery_preference',
    notes: String(notes || '').trim(),
    reviewer_id: 'primary-user',
    preference_session_id: randomUUID(),
    recorded_at: new Date().toISOString(),
  };
  return recordRunEvent({ root, runId, type: 'PreferenceRecorded', data: { preference } });
}

export async function saveReview({ root, runId, review }) {
  const run = await loadRun({ root, runId });
  if (!run.manifest.artifacts?.length) throw new Error('Save at least one generated result before reviewing');
  if (run.manifest.artifacts.length !== 1) throw new Error('Use artifact-specific review when a run has multiple results');
  return saveArtifactReview({
    root,
    runId,
    artifactId: run.manifest.artifacts[0].artifact_id,
    review,
    compatibilityRunReview: true,
  });
}
