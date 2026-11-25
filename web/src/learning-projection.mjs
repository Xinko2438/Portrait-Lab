import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { REVIEW_RUBRIC, REVIEW_DIMENSIONS, REVIEW_DIAGNOSTICS } from './rubric.mjs';

const projectionVersion = 'ai-img-gen.review-guidance.v4';
const promptInputMode = 'reference_image';
const legacyDiagnosticMap = {
  emotional_clarity: 'emotion_unclear',
  element_coherence: 'elements_incoherent',
  visual_hierarchy: 'subject_not_primary',
  client_suitability: 'client_use_case_mismatch',
};

function emptyProjection() {
  return {
    schema_version: projectionVersion,
    rubric_version: REVIEW_RUBRIC.rubric_version,
    source_rubric_versions: [],
    status: 'insufficient',
    sample_count: 0,
    sampling_unit: 'best_identity_passed_artifact_per_run',
    minimum_reviews_before_guidance: REVIEW_RUBRIC.learning_policy.minimum_reviews_before_guidance,
    minimum_failure_rate: REVIEW_RUBRIC.learning_policy.minimum_failure_rate,
    prompt_input_mode: promptInputMode,
    dimensions: {},
    diagnostics: {},
    corrections: [],
    observational_corrections: [],
    shadow_corrections: [],
    active_corrections: [],
    active_guidance: [],
    rebuilt_at: null,
  };
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}
`, 'utf8');
  await rename(temporary, path);
}

async function listManifests(root) {
  const runsRoot = join(root, 'data', 'runs');
  let entries = [];
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const manifests = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.discard-')) continue;
    try {
      const manifest = JSON.parse((await readFile(join(runsRoot, entry.name, 'manifest.json'), 'utf8')).replace(/^\uFEFF/, ''));
      manifests.push(manifest);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return manifests;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function promptModeForManifest(manifest) {
  return String(manifest?.prompt_compilation?.prompt_input_mode || 'reference_image');
}

function uniqueManifestsByRunId(manifests) {
  const byRunId = new Map();
  for (const manifest of manifests) {
    const runId = String(manifest?.run_id || '').trim();
    if (!runId || byRunId.has(runId)) continue;
    byRunId.set(runId, manifest);
  }
  return [...byRunId.values()].sort((left, right) => String(left.run_id).localeCompare(String(right.run_id)));
}

function correctionState(supportCount, failureRate) {
  return supportCount >= REVIEW_RUBRIC.learning_policy.minimum_reviews_before_guidance
    && failureRate >= REVIEW_RUBRIC.learning_policy.minimum_failure_rate
    ? 'shadow'
    : 'observational';
}

function correctionRecord({ signalType, qualityDimension = null, diagnosticCode = null, targetBlock, promptGuidance, sourceRunIds, failureCount }) {
  const supportCount = sourceRunIds.length;
  const failureRate = supportCount ? failureCount / supportCount : 0;
  const identity = {
    signal_type: signalType,
    quality_dimension: qualityDimension,
    diagnostic_code: diagnosticCode,
    target_block: targetBlock,
    prompt_guidance: promptGuidance,
    context: {
      prompt_input_mode: promptInputMode,
      rubric_version: REVIEW_RUBRIC.rubric_version,
      customer_scope: 'global_identity_neutral',
    },
  };
  const evidence = {
    ...identity,
    source_run_ids: [...sourceRunIds].sort(),
    support_count: supportCount,
    failure_count: failureCount,
    failure_rate: Math.round(failureRate * 1000) / 1000,
    state: correctionState(supportCount, failureRate),
  };
  return {
    schema_version: 'ai-img-gen.prompt-correction.v1',
    correction_id: `prompt-correction_${hash(identity).slice(0, 24)}`,
    ...evidence,
    correction_sha256: hash(evidence),
  };
}

function targetBlockForDiagnostic(group) {
  if (group === 'style') return 'template-emphasis';
  return 'quality-safety';
}

function coreScore(review, dimensionId) {
  const aliases = {
    face_identity_fidelity: ['face_identity_fidelity', 'face_fidelity'],
    realism_naturalness: ['realism_naturalness', 'naturalness'],
    style_consistency: ['style_consistency', 'style'],
  }[dimensionId] || [dimensionId];
  for (const key of aliases) {
    const value = Number(review?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function identityPassed(review) {
  const threshold = REVIEW_DIMENSIONS.get('face_identity_fidelity').threshold;
  return coreScore(review, 'face_identity_fidelity') >= threshold;
}

function reviewsForManifest(manifest) {
  const artifactReviews = Object.values(manifest.artifact_reviews || {}).filter((review) => review && typeof review === 'object');
  if (artifactReviews.length) return artifactReviews;
  return manifest.latest_review ? [manifest.latest_review] : [];
}

function runValue(manifest, dimensionId) {
  const values = reviewsForManifest(manifest)
    .filter(identityPassed)
    .map((review) => coreScore(review, dimensionId))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function diagnosticCodesForReview(review) {
  const direct = Array.isArray(review?.diagnostic_codes)
    ? review.diagnostic_codes
    : (Array.isArray(review?.diagnostic_findings) ? review.diagnostic_findings.map((finding) => finding?.code) : []);
  if (direct.length) return [...new Set(direct.map(String).filter((code) => REVIEW_DIAGNOSTICS.has(code)))];

  const legacy = new Set();
  for (const failure of review?.failed_dimensions || []) {
    const code = legacyDiagnosticMap[failure?.dimension];
    if (code) legacy.add(code);
  }
  for (const [dimensionId, code] of Object.entries(legacyDiagnosticMap)) {
    const value = Number(review?.[dimensionId]);
    if (Number.isFinite(value) && value < 7) legacy.add(code);
  }
  return [...legacy];
}

function runHasDiagnostic(manifest, code) {
  return reviewsForManifest(manifest)
    .filter(identityPassed)
    .some((review) => diagnosticCodesForReview(review).includes(code));
}

export async function rebuildReviewGuidance({ root }) {
  const manifests = uniqueManifestsByRunId(await listManifests(root))
    .filter((manifest) => !manifest.excluded_from_learning)
    .filter((manifest) => !manifest.image_api)
    .filter((manifest) => promptModeForManifest(manifest) === promptInputMode);
  const projection = emptyProjection();
  projection.rebuilt_at = new Date().toISOString();

  const eligibleRuns = manifests.filter((manifest) => reviewsForManifest(manifest).some(identityPassed));
  projection.sample_count = eligibleRuns.length;
  projection.source_rubric_versions = [...new Set(eligibleRuns.flatMap((manifest) => (
    reviewsForManifest(manifest).map((review) => String(review?.review_rubric_version || 'portrait-review-v1'))
  )))].sort();

  for (const dimension of REVIEW_RUBRIC.dimensions) {
    if (dimension.id === 'face_identity_fidelity') continue;
    const samples = eligibleRuns
      .map((manifest) => ({ run_id: manifest.run_id, value: runValue(manifest, dimension.id) }))
      .filter((sample) => Number.isFinite(sample.value));
    const values = samples.map((sample) => sample.value);
    const failures = values.filter((value) => value < dimension.threshold).length;
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const failureRate = values.length ? failures / values.length : 0;
    projection.dimensions[dimension.id] = {
      review_count: values.length,
      failure_count: failures,
      failure_rate: Math.round(failureRate * 1000) / 1000,
      average_score: average === null ? null : Math.round(average * 100) / 100,
      threshold: dimension.threshold,
      sampling_unit: 'run_best_score',
    };
    projection.corrections.push(correctionRecord({
      signalType: 'numeric_dimension',
      qualityDimension: dimension.id,
      targetBlock: dimension.id === 'style_consistency' ? 'template-emphasis' : 'quality-safety',
      promptGuidance: REVIEW_RUBRIC.prompt_guidance_templates[dimension.id],
      sourceRunIds: samples.map((sample) => sample.run_id),
      failureCount: failures,
    }));
  }

  for (const [code, diagnostic] of REVIEW_DIAGNOSTICS) {
    if (diagnostic.customer_scoped) continue;
    const failureCount = eligibleRuns.filter((manifest) => runHasDiagnostic(manifest, code)).length;
    const failureRate = eligibleRuns.length ? failureCount / eligibleRuns.length : 0;
    projection.diagnostics[code] = {
      group: diagnostic.group,
      label: diagnostic.label,
      review_count: eligibleRuns.length,
      failure_count: failureCount,
      failure_rate: Math.round(failureRate * 1000) / 1000,
      sampling_unit: 'run_has_diagnostic',
    };
    projection.corrections.push(correctionRecord({
      signalType: 'diagnostic',
      diagnosticCode: code,
      targetBlock: targetBlockForDiagnostic(diagnostic.group),
      promptGuidance: diagnostic.prompt_guidance,
      sourceRunIds: eligibleRuns.map((manifest) => manifest.run_id),
      failureCount,
    }));
  }

  projection.corrections.sort((left, right) => left.correction_id.localeCompare(right.correction_id));
  projection.observational_corrections = projection.corrections.filter((item) => item.state === 'observational');
  projection.shadow_corrections = projection.corrections.filter((item) => item.state === 'shadow');
  projection.active_corrections = [];
  projection.active_guidance = [];
  projection.status = projection.shadow_corrections.length ? 'shadow_ready' : 'insufficient';
  const path = join(root, 'data', 'projections', 'review-guidance.json');
  await atomicWriteJson(path, projection);
  return projection;
}

export async function loadReviewGuidance({ root }) {
  const path = join(root, 'data', 'projections', 'review-guidance.json');
  try {
    const projection = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
    return projection.schema_version === projectionVersion && projection.rubric_version === REVIEW_RUBRIC.rubric_version
      ? projection
      : emptyProjection();
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyProjection();
    throw error;
  }
}
