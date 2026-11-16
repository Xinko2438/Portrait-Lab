import { createHash, randomUUID } from 'node:crypto';
import { loadTemplateExclusions } from './face-tag-store.mjs';
import { access, appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  TemplateExplorationError,
  resolveTemplateExplorationPresentation,
} from './template-exploration.mjs';
import {
  createTemplateSelectionOutcomeInvalidated,
  createTemplateSelectionOutcomeRecorded,
  projectActiveTemplateOutcomes,
  validateTemplateSelectionOutcomeRecorded,
} from './template-outcome-lifecycle.mjs';
import { buildTemplatePerformanceProjectionV2 } from './template-performance-projection.mjs';

export const CUSTOMER_TASK_BRIEF_VERSION = 'ai-img-gen.customer-task-brief.v1';
export const TEMPLATE_RANKING_POLICY_VERSION = 'template-ranking-v1';
export const TEMPLATE_SELECTION_REQUEST_VERSION = 'ai-img-gen.template-selection-request.v1';
export const TEMPLATE_SELECTION_EVENT_VERSION = 'ai-img-gen.template-selection-event.v1';
export const TEMPLATE_SELECTION_VERSION = 'ai-img-gen.template-selection.v1';

const RISK_ORDER = new Map([['low', 1], ['medium', 2], ['high', 3]]);
const DIFFICULTY_ORDER = new Map([['medium', 1], ['medium_high', 2], ['high', 3]]);
const FACE_VISIBILITY = new Set(['low', 'medium', 'high']);
const DIVERSITY_PREFERENCES = new Set(['balanced', 'narrow']);
const SAFE_SCOPE = /^[A-Za-z0-9_-]{1,80}$/;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_SELECTION_ID = /^sel_[a-f0-9]{24}$/;
const selectionMutationTails = new Map();

async function acquireSelectionMutation(root, selectionId) {
  const key = `${join(String(root || ''), 'data', 'template-selections')}\u0000${String(selectionId || '')}`;
  const previous = selectionMutationTails.get(key) || Promise.resolve();
  let releaseSlot;
  const slot = new Promise((resolve) => { releaseSlot = resolve; });
  const tail = previous.catch(() => {}).then(() => slot);
  selectionMutationTails.set(key, tail);
  await previous.catch(() => {});
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseSlot();
    if (selectionMutationTails.get(key) === tail) selectionMutationTails.delete(key);
  };
}

export class TemplateSelectionError extends Error {
  constructor(code, message, { status = 400, details = [] } = {}) {
    super(message);
    this.name = 'TemplateSelectionError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function cleanString(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function canonicalToken(value) {
  return cleanString(value).toLowerCase();
}

function normalizeList(value) {
  const source = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  return [...new Set(source.map(canonicalToken).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function ensureEnum(name, value, allowed) {
  if (!allowed.has(value)) {
    throw new TemplateSelectionError('invalid_task_brief', `Unknown ${name} value: ${value}`);
  }
}

function intersects(left, right) {
  const values = new Set(normalizeList(right));
  return normalizeList(left).filter((value) => values.has(value));
}

function includesToken(text, token) {
  return canonicalToken(text).includes(canonicalToken(token));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, precision = 3) {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function atomicWrite(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, 'utf8');
  await renameWithRetry(temporary, path);
}

async function atomicWriteJson(path, value) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path, errorCode = 'selection_not_found', status = 404) {
  try {
    return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new TemplateSelectionError(errorCode, `Required file not found: ${path.split(/[\\/]/).pop()}`, { status });
    if (error instanceof SyntaxError) throw new TemplateSelectionError(errorCode, `Invalid JSON in ${path.split(/[\\/]/).pop()}`, { status });
    throw error;
  }
}

function textFeatures(value) {
  const text = canonicalToken(value);
  const features = new Set(text.match(/[a-z0-9_]+/g) || []);
  const han = [...text].filter((character) => /\p{Script=Han}/u.test(character));
  for (const character of han) features.add(character);
  for (let index = 0; index < han.length - 1; index += 1) features.add(`${han[index]}${han[index + 1]}`);
  return features;
}

function coverageScore(query, document) {
  const queryFeatures = textFeatures(query);
  if (!queryFeatures.size) return 0;
  const documentFeatures = textFeatures(document);
  let matched = 0;
  for (const feature of queryFeatures) if (documentFeatures.has(feature)) matched += 1;
  return matched / queryFeatures.size;
}

function templateText(template) {
  const suitableUse = Array.isArray(template?.template_info?.suitable_use)
    ? template.template_info.suitable_use.join(' ')
    : String(template?.template_info?.suitable_use || '');
  return [
    template?.selection_tags?.style_category,
    template?.template_info?.template_name,
    template?.template_info?.overall_style_summary,
    suitableUse,
    template?.retrieval_text,
  ].filter(Boolean).join(' ');
}

function queryText(brief) {
  return [
    brief.use_case,
    ...brief.style_keywords,
    ...brief.target_portrait_scales,
    ...brief.target_face_angles,
    ...brief.temperament_keywords,
    ...brief.face_feature_observations,
    brief.free_text_intent,
  ].filter(Boolean).join(' ');
}

export function normalizeTaskBrief(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TemplateSelectionError('invalid_task_brief', 'Task brief must be an object');
  }
  const customerScopeId = cleanString(input.customer_scope_id);
  if (!SAFE_SCOPE.test(customerScopeId)) {
    throw new TemplateSelectionError('invalid_task_brief', 'customer_scope_id must be an opaque safe identifier');
  }
  const normalized = {
    schema_version: CUSTOMER_TASK_BRIEF_VERSION,
    customer_scope_id: customerScopeId,
    parent_selection_id: input.parent_selection_id ? cleanString(input.parent_selection_id) : null,
    use_case: canonicalToken(input.use_case),
    style_keywords: normalizeList(input.style_keywords),
    avoid_keywords: normalizeList(input.avoid_keywords),
    target_portrait_scales: normalizeList(input.target_portrait_scales),
    target_face_angles: normalizeList(input.target_face_angles),
    temperament_keywords: normalizeList(input.temperament_keywords),
    face_feature_observations: normalizeList(input.face_feature_observations),
    required_face_visibility: normalizeList(input.required_face_visibility?.length ? input.required_face_visibility : ['high', 'medium']),
    allow_text_on_face: input.allow_text_on_face === true,
    max_identity_preservation_risk: canonicalToken(input.max_identity_preservation_risk || 'medium'),
    max_generation_difficulty: canonicalToken(input.max_generation_difficulty || 'high'),
    diversity_preference: canonicalToken(input.diversity_preference || 'balanced'),
    free_text_intent: cleanString(input.free_text_intent),
    ...(input.hard_style_categories?.length?{hard_style_categories:normalizeList(input.hard_style_categories)}:{}),
    ...(input.hard_portrait_scales?.length?{hard_portrait_scales:normalizeList(input.hard_portrait_scales)}:{}),
  };
  ensureEnum('max_identity_preservation_risk', normalized.max_identity_preservation_risk, new Set(RISK_ORDER.keys()));
  ensureEnum('max_generation_difficulty', normalized.max_generation_difficulty, new Set(DIFFICULTY_ORDER.keys()));
  ensureEnum('diversity_preference', normalized.diversity_preference, DIVERSITY_PREFERENCES);
  for (const value of normalized.required_face_visibility) ensureEnum('required_face_visibility', value, FACE_VISIBILITY);
  const contradictions = intersects(normalized.style_keywords, normalized.avoid_keywords);
  if (contradictions.length) {
    throw new TemplateSelectionError('invalid_task_brief', `Contradictory requested and avoided style: ${contradictions.join(', ')}`);
  }
  const hasIntent = Boolean(
    normalized.use_case
    || normalized.style_keywords.length
    || normalized.target_portrait_scales.length
    || normalized.target_face_angles.length
    || normalized.temperament_keywords.length
    || normalized.free_text_intent,
  );
  if (!hasIntent) throw new TemplateSelectionError('invalid_task_brief', 'Task brief must include at least one selection intent');
  return normalized;
}

function requiredTemplateFields(template) {
  return Boolean(
    template?.template_uid
    && template?.template_info?.template_name
    && template?.selection_tags?.style_category
    && template?.selection_tags?.identity_preservation_risk
    && template?.selection_tags?.generation_difficulty
    && template?.selection_tags?.face_visibility
    && template?.retrieval_text
    && template?.generation_blueprint
    && template?.reference_image?.sha256,
  );
}

function evaluateHardFilter(template, brief) {
  const tags = template?.selection_tags || {};
  const rejectionCodes = [];
  const warningCodes = [];
  if(brief.hard_portrait_scales?.length&&!brief.hard_portrait_scales.includes(canonicalToken(tags.portrait_scale)))rejectionCodes.push('manual_framing_mismatch');
  if(brief.hard_style_categories?.length&&!brief.hard_style_categories.includes(canonicalToken(tags.style_category)))rejectionCodes.push('manual_style_mismatch');
  if (!requiredTemplateFields(template)) rejectionCodes.push('missing_required_template_field');
  const risk = canonicalToken(tags.identity_preservation_risk);
  const riskRank = RISK_ORDER.get(risk);
  if (!riskRank || riskRank > RISK_ORDER.get(brief.max_identity_preservation_risk)) {
    rejectionCodes.push('identity_risk_too_high');
  }
  const difficulty = canonicalToken(tags.generation_difficulty);
  const difficultyRank = DIFFICULTY_ORDER.get(difficulty);
  if (!difficultyRank || difficultyRank > DIFFICULTY_ORDER.get(brief.max_generation_difficulty)) {
    rejectionCodes.push('generation_difficulty_too_high');
  }
  if (!brief.required_face_visibility.includes(canonicalToken(tags.face_visibility))) {
    rejectionCodes.push('face_visibility_not_allowed');
  }
  if (!brief.allow_text_on_face && tags.text_on_face === true) rejectionCodes.push('text_on_face_forbidden');
  const style = canonicalToken(tags.style_category);
  if (brief.avoid_keywords.includes(style)) rejectionCodes.push('style_forbidden');
  const text = templateText(template);
  for (const avoid of brief.avoid_keywords) {
    if (avoid !== style && includesToken(text, avoid)) warningCodes.push(`avoid_keyword_match:${avoid}`);
  }
  const temperamentConflicts = intersects(brief.temperament_keywords, tags.avoid_client_temperament);
  if (temperamentConflicts.length) rejectionCodes.push('avoid_temperament_conflict');
  const faceConflicts = intersects(brief.face_feature_observations, tags.avoid_client_face_features);
  if (faceConflicts.length) rejectionCodes.push('avoid_face_feature_conflict');
  return {
    eligible: rejectionCodes.length === 0,
    rejection_codes: [...new Set(rejectionCodes)].sort(),
    warning_codes: [...new Set(warningCodes)].sort(),
  };
}

function evidence(field, matched, score) {
  return { field, matched: normalizeList(matched), score: round(score) };
}

function scoreCandidate(template, brief, filterResult) {
  const tags = template.selection_tags;
  const text = templateText(template);
  const matchedEvidence = [];

  let styleUseCase = brief.style_keywords.length ? 0 : 8;
  const exactStyle = brief.style_keywords.includes(canonicalToken(tags.style_category));
  if (exactStyle) styleUseCase += 18;
  const textStyleMatches = brief.style_keywords.filter((keyword) => includesToken(text, keyword));
  styleUseCase += Math.min(4, textStyleMatches.length * 2);
  if (brief.use_case && includesToken(text, brief.use_case)) styleUseCase += 3;
  styleUseCase = clamp(styleUseCase, 0, 25);
  matchedEvidence.push(evidence('style_use_case', [exactStyle ? tags.style_category : '', ...textStyleMatches], styleUseCase));

  let compositionAngle = 0;
  const scaleMatch = !brief.target_portrait_scales.length || brief.target_portrait_scales.includes(canonicalToken(tags.portrait_scale));
  const angleMatch = !brief.target_face_angles.length || brief.target_face_angles.includes(canonicalToken(tags.face_angle));
  compositionAngle += scaleMatch ? 10 : 0;
  compositionAngle += angleMatch ? 10 : 0;
  matchedEvidence.push(evidence('composition_angle', [scaleMatch ? tags.portrait_scale : '', angleMatch ? tags.face_angle : ''], compositionAngle));

  const temperamentMatches = intersects(brief.temperament_keywords, tags.best_client_temperament);
  const faceMatches = intersects(brief.face_feature_observations, tags.best_client_face_features);
  const temperamentScore = brief.temperament_keywords.length
    ? 10 * temperamentMatches.length / brief.temperament_keywords.length
    : 5;
  const faceScore = brief.face_feature_observations.length
    ? 10 * faceMatches.length / brief.face_feature_observations.length
    : 5;
  const customerCompatibility = clamp(temperamentScore + faceScore, 0, 20);
  matchedEvidence.push(evidence('customer_compatibility', [...temperamentMatches, ...faceMatches], customerCompatibility));

  const textRelevance = clamp(coverageScore(queryText(brief), text) * 15, 0, 15);
  matchedEvidence.push(evidence('text_relevance', [], textRelevance));

  const riskScore = { low: 7, medium: 5, high: 2 }[canonicalToken(tags.identity_preservation_risk)] || 0;
  const difficultyScore = { medium: 5, medium_high: 4, high: 2 }[canonicalToken(tags.generation_difficulty)] || 0;
  const visibilityScore = { high: 3, medium: 2, low: 1 }[canonicalToken(tags.face_visibility)] || 0;
  const safetyStability = clamp(riskScore + difficultyScore + visibilityScore, 0, 15);
  matchedEvidence.push(evidence('safety_stability', [tags.identity_preservation_risk, tags.generation_difficulty, tags.face_visibility], safetyStability));

  const priorValue = Number(template.observational_prior?.total_manual_score);
  const observationalPrior = Number.isFinite(priorValue) ? clamp(priorValue / 20, 0, 5) : 0;
  matchedEvidence.push(evidence('observational_prior', [], observationalPrior));

  const penalties = filterResult.warning_codes.map((code) => ({ code, amount: 2 }));
  const penaltyTotal = penalties.reduce((sum, item) => sum + item.amount, 0);
  const componentScores = {
    style_use_case: round(styleUseCase),
    composition_angle: round(compositionAngle),
    customer_compatibility: round(customerCompatibility),
    text_relevance: round(textRelevance),
    safety_stability: round(safetyStability),
    observational_prior: round(observationalPrior),
  };
  const relevanceScore = clamp(Object.values(componentScores).reduce((sum, value) => sum + value, 0) - penaltyTotal, 0, 100);
  return {
    template_uid: template.template_uid,
    source_template_id: template.source_template_id,
    template_name: template.template_info.template_name,
    reference_image: {
      url: `/api/templates/${template.template_uid}/reference`,
      sha256: template.reference_image.sha256,
      bytes: template.reference_image.bytes,
      mime_type: template.reference_image.mime_type,
      extension: template.reference_image.extension,
      duplicate_hash_group_size: template.reference_image.duplicate_hash_group_size,
    },
    selection_tags: structuredClone(tags),
    component_scores: componentScores,
    penalties,
    relevance_score: round(relevanceScore),
    matched_evidence: matchedEvidence,
    warning_codes: filterResult.warning_codes,
    reason: `Matched ${matchedEvidence.filter((item) => item.score > 0).map((item) => item.field).join(', ')} under ${TEMPLATE_RANKING_POLICY_VERSION}.`,
  };
}

function candidateSort(left, right) {
  if (right.relevance_score !== left.relevance_score) return right.relevance_score - left.relevance_score;
  const leftRisk = RISK_ORDER.get(canonicalToken(left.selection_tags.identity_preservation_risk)) || 99;
  const rightRisk = RISK_ORDER.get(canonicalToken(right.selection_tags.identity_preservation_risk)) || 99;
  if (leftRisk !== rightRisk) return leftRisk - rightRisk;
  const leftDifficulty = DIFFICULTY_ORDER.get(canonicalToken(left.selection_tags.generation_difficulty)) || 99;
  const rightDifficulty = DIFFICULTY_ORDER.get(canonicalToken(right.selection_tags.generation_difficulty)) || 99;
  if (leftDifficulty !== rightDifficulty) return leftDifficulty - rightDifficulty;
  return left.template_uid.localeCompare(right.template_uid);
}

function candidateSimilarity(left, right) {
  if (left.reference_image.sha256 === right.reference_image.sha256) return 1;
  const fields = [
    ['style_category', 0.3],
    ['portrait_scale', 0.15],
    ['face_angle', 0.15],
    ['camera_angle', 0.1],
    ['visual_intensity', 0.1],
    ['typography_complexity', 0.1],
    ['background_complexity', 0.05],
    ['color_complexity', 0.05],
  ];
  return round(fields.reduce((sum, [field, weight]) => (
    canonicalToken(left.selection_tags[field]) === canonicalToken(right.selection_tags[field]) ? sum + weight : sum
  ), 0));
}

function selectTop4(top10, brief) {
  if (!top10.length) return [];
  const exactStylePool = top10.filter((candidate) => brief.style_keywords.includes(canonicalToken(candidate.selection_tags.style_category)));
  const pool = brief.diversity_preference === 'narrow' && exactStylePool.length >= Math.min(4, top10.length)
    ? exactStylePool
    : top10;
  const uniqueAvailable = new Set(pool.map((candidate) => candidate.reference_image.sha256)).size >= 4;
  const selected = [];
  const remaining = [...pool];
  while (selected.length < Math.min(4, pool.length) && remaining.length) {
    const scored = remaining.map((candidate) => {
      const similarities = selected.map((chosen) => candidateSimilarity(candidate, chosen));
      const similarity = similarities.length ? Math.max(...similarities) : 0;
      const novelty = 1 - similarity;
      const noveltyWeight = brief.diversity_preference === 'narrow' ? 0.08 : 0.18;
      const relevanceWeight = 1 - noveltyWeight;
      const rerankValue = relevanceWeight * (candidate.relevance_score / 100) + noveltyWeight * novelty;
      return { candidate, similarity, novelty, rerankValue };
    }).filter(({ candidate }) => (
      !uniqueAvailable || !selected.some((chosen) => chosen.reference_image.sha256 === candidate.reference_image.sha256)
    ));
    if (!scored.length) break;
    scored.sort((left, right) => (
      right.rerankValue - left.rerankValue
      || candidateSort(left.candidate, right.candidate)
    ));
    const winner = scored[0];
    selected.push({
      ...winner.candidate,
      diversity: {
        similarity_to_selected: round(winner.similarity),
        novelty_score: round(winner.novelty),
        rerank_value: round(winner.rerankValue, 6),
        selected_for_top4: true,
        reason: winner.similarity === 1 ? 'selected despite duplicate similarity' : 'balanced relevance and novelty',
      },
    });
    remaining.splice(remaining.findIndex((candidate) => candidate.template_uid === winner.candidate.template_uid), 1);
  }
  return selected.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

export function rankTemplateCatalog({ catalog, taskBrief, excludedTemplateUids = [] }) {
  if (!catalog || catalog.schema_version !== 'ai-img-gen.template-catalog.v1' || !Array.isArray(catalog.templates)) {
    throw new TemplateSelectionError('catalog_unavailable', 'Unsupported or missing template catalog', { status: 503 });
  }
  const brief = normalizeTaskBrief(taskBrief);
  const filterResults = [];
  const eligible = [];
  const rejectionCounts = {};
  for (const template of catalog.templates) {
    const filter = evaluateHardFilter(template, brief);
    if (excludedTemplateUids.includes(template.template_uid)) {
      filter.eligible = false;
      filter.rejection_codes = [...filter.rejection_codes, 'operator_template_rejected'];
    }
    filterResults.push({ template_uid: template?.template_uid || null, ...filter });
    if (!filter.eligible) {
      for (const code of filter.rejection_codes) rejectionCounts[code] = (rejectionCounts[code] || 0) + 1;
      continue;
    }
    eligible.push(scoreCandidate(template, brief, filter));
  }
  eligible.sort(candidateSort);
  const rankedCandidates = eligible.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const top10 = rankedCandidates.slice(0, 10);
  const top4 = selectTop4(top10, brief);
  const warnings = [];
  const status = eligible.length === 0 ? 'blocked' : eligible.length < 10 ? 'insufficient_candidates' : 'created';
  if (eligible.length < 10) warnings.push('insufficient_candidates');
  return {
    status,
    ranking_policy_version: TEMPLATE_RANKING_POLICY_VERSION,
    catalog_schema_version: catalog.schema_version,
    catalog_projection_version: catalog.projection_version,
    task_brief: brief,
    filter_summary: {
      catalog_total: catalog.templates.length,
      eligible_count: eligible.length,
      rejected_count: catalog.templates.length - eligible.length,
      rejection_counts: Object.fromEntries(Object.entries(rejectionCounts).sort(([left], [right]) => left.localeCompare(right))),
    },
    top10,
    top4,
    ranked_candidates: rankedCandidates,
    warnings,
    filter_results: filterResults,
  };
}

function validateIdempotencyKey(value, name = 'idempotency_key', errorCode = 'invalid_task_brief') {
  const normalized = cleanString(value);
  if (!SAFE_IDEMPOTENCY_KEY.test(normalized)) {
    throw new TemplateSelectionError(errorCode, `${name} must contain 1-128 safe characters`);
  }
  return normalized;
}

function validateSelectionId(selectionId) {
  if (!SAFE_SELECTION_ID.test(String(selectionId || ''))) {
    throw new TemplateSelectionError('invalid_selection_id', 'Invalid template selection id');
  }
  return selectionId;
}

function selectionPaths(root, selectionId) {
  validateSelectionId(selectionId);
  const directory = join(root, 'data', 'template-selections', selectionId);
  return {
    directory,
    request: join(directory, 'request.json'),
    events: join(directory, 'events.jsonl'),
    projection: join(directory, 'selection.json'),
  };
}

async function loadCatalogEvidence(root) {
  const path = join(root, 'data', 'projections', 'template-catalog.json');
  let text;
  try {
    text = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new TemplateSelectionError('catalog_unavailable', 'Template catalog projection is unavailable', { status: 503 });
    }
    throw error;
  }
  let catalog;
  try {
    catalog = JSON.parse(text);
  } catch {
    throw new TemplateSelectionError('catalog_unavailable', 'Template catalog projection is invalid JSON', { status: 503 });
  }
  if (catalog?.schema_version !== 'ai-img-gen.template-catalog.v1' || !Array.isArray(catalog.templates)) {
    throw new TemplateSelectionError('catalog_unavailable', 'Template catalog projection uses an unsupported schema', { status: 503 });
  }
  const businessCatalog = structuredClone(catalog);
  delete businessCatalog.rebuilt_at;
  const exclusions = await loadTemplateExclusions({root});
  return {
    catalog,
    exclusions,
    content_sha256: sha256(text),
    business_sha256: sha256(stableJson(businessCatalog)),
  };
}

function selectionIdentity({ brief, idempotencyKey, catalogEvidence }) {
  const identityHash = sha256(stableJson({
    schema_version: TEMPLATE_SELECTION_VERSION,
    customer_scope_id: brief.customer_scope_id,
    idempotency_key: idempotencyKey,
  }));
  const selectionId = `sel_${identityHash.slice(0, 24)}`;
  const requestHash = sha256(stableJson({
    task_brief: brief,
    catalog_schema_version: catalogEvidence.catalog.schema_version,
    catalog_projection_version: catalogEvidence.catalog.projection_version,
    catalog_business_sha256: catalogEvidence.business_sha256,
    operator_exclusions_sha256: catalogEvidence.exclusions.fingerprint,
    ranking_policy_version: TEMPLATE_RANKING_POLICY_VERSION,
  }));
  return {
    selection_id: selectionId,
    identity_hash: identityHash,
    request_hash: requestHash,
    catalog_schema_version: catalogEvidence.catalog.schema_version,
    catalog_projection_version: catalogEvidence.catalog.projection_version,
    catalog_content_sha256: catalogEvidence.content_sha256,
    catalog_business_sha256: catalogEvidence.business_sha256,
    operator_exclusions_sha256: catalogEvidence.exclusions.fingerprint,
    eligibility_policy_version: catalogEvidence.exclusions.policy_version,
    ranking_policy_version: TEMPLATE_RANKING_POLICY_VERSION,
  };
}

function selectionEvent({ selectionId, type, idempotencyKey, data, recordedAt }) {
  return {
    schema_version: TEMPLATE_SELECTION_EVENT_VERSION,
    event_id: randomUUID(),
    selection_id: selectionId,
    type,
    recorded_at: recordedAt,
    idempotency_key: idempotencyKey,
    data,
  };
}

async function readSelectionEvents(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new TemplateSelectionError('selection_not_found', 'Selection events not found', { status: 404 });
    throw error;
  }
  const events = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new TemplateSelectionError('selection_event_conflict', `Invalid selection event JSON at line ${index + 1}`, { status: 409 });
    }
  });
  const byIdempotency = new Map();
  const unique = [];
  for (const event of events) {
    if (event?.schema_version !== TEMPLATE_SELECTION_EVENT_VERSION || !event?.idempotency_key || !event?.type) {
      throw new TemplateSelectionError('selection_event_conflict', 'Selection event is missing required evidence', { status: 409 });
    }
    const logicalHash = sha256(stableJson({ type: event.type, data: event.data }));
    if (byIdempotency.has(event.idempotency_key)) {
      if (byIdempotency.get(event.idempotency_key) !== logicalHash) {
        throw new TemplateSelectionError('selection_event_conflict', `Conflicting selection event idempotency key: ${event.idempotency_key}`, { status: 409 });
      }
      continue;
    }
    byIdempotency.set(event.idempotency_key, logicalHash);
    unique.push(event);
  }
  return unique;
}

function projectionHash(projection) {
  const copy = structuredClone(projection);
  delete copy.rebuilt_at;
  delete copy.projection_sha256;
  return sha256(stableJson(copy));
}

function isLifecycleOutcomeEvent(event) {
  if (event?.type === 'TemplateSelectionOutcomeInvalidated') return true;
  if (event?.type !== 'TemplateSelectionOutcomeRecorded' || !event.data?.outcome) return false;
  const outcome = event.data.outcome;
  return Boolean(
    outcome.selection_id
      && outcome.artifact_sha256
      && outcome.preference_session_id
      && outcome.review_source_event_id
      && outcome.preference_source_event_id,
  );
}

function applySelectionEvents(requestSource, events, recordedAt) {
  const requested = events.find((event) => event.type === 'TemplateSelectionRequested');
  const created = events.find((event) => event.type === 'TemplateSelectionCreated');
  if (!requested || !created) {
    throw new TemplateSelectionError('selection_event_conflict', 'Selection request or created event is missing', { status: 409 });
  }
  if (requested.data?.request_hash !== requestSource.selection_identity?.request_hash) {
    throw new TemplateSelectionError('selection_event_conflict', 'Selection request hash does not match immutable request', { status: 409 });
  }
  const result = created.data?.result;
  if (!result || !Array.isArray(result.top10) || !Array.isArray(result.top4)) {
    throw new TemplateSelectionError('selection_event_conflict', 'Selection created event is incomplete', { status: 409 });
  }
  const projection = {
    schema_version: TEMPLATE_SELECTION_VERSION,
    selection_id: requestSource.selection_identity.selection_id,
    status: result.status,
    task_brief: requestSource.task_brief,
    request_hash: requestSource.selection_identity.request_hash,
    ranking_policy_version: requestSource.selection_identity.ranking_policy_version,
    catalog_schema_version: requestSource.selection_identity.catalog_schema_version,
    catalog_projection_version: requestSource.selection_identity.catalog_projection_version,
    catalog_content_sha256: requestSource.selection_identity.catalog_content_sha256,
    catalog_business_sha256: requestSource.selection_identity.catalog_business_sha256,
    operator_exclusions_sha256: requestSource.selection_identity.operator_exclusions_sha256 || null,
    eligibility_policy_version: requestSource.selection_identity.eligibility_policy_version || null,
    filter_summary: result.filter_summary,
    exclusions: result.filter_results.filter((item) => !item.eligible),
    top10: result.top10,
    top4: result.top4,
    ranked_candidates: Array.isArray(result.ranked_candidates) ? result.ranked_candidates : null,
    ranked_candidates_source: Array.isArray(result.ranked_candidates) ? 'complete' : 'legacy_top10',
    warnings: result.warnings,
    decision: null,
    decision_history_count: 0,
    linked_run_ids: [],
    outcomes: [],
    active_outcomes: [],
    outcome_history: [],
    outcome_invalidations: [],
    legacy_outcome_count: 0,
    exploration: {
      presentation_count: 0,
      next_cycle_index: 0,
      next_round_index: 0,
      last_slate: null,
    },
    projection_version: TEMPLATE_SELECTION_VERSION,
    rebuilt_at: recordedAt,
  };
  for (const event of events) {
    if (event.type === 'TemplateExplorationSlatePresented') {
      const explorationEvents = events.filter((item) => item.type === 'TemplateExplorationSlatePresented');
      const selectionEvidence = projection.ranked_candidates_source === 'complete'
        ? projection
        : { ...projection, ranked_candidates: null };
      const replay = resolveTemplateExplorationPresentation({
        selection: selectionEvidence,
        cycleIndex: event.data?.slate?.cycle_index,
        roundIndex: event.data?.slate?.round_index,
        idempotencyKey: event.idempotency_key,
        recordedAt: event.recorded_at,
        events: explorationEvents,
      });
      const slate = replay.slate;
      projection.exploration.presentation_count += 1;
      projection.exploration.last_slate = slate;
      if (slate.round_index + 1 < slate.cycle_round_count) {
        projection.exploration.next_cycle_index = slate.cycle_index;
        projection.exploration.next_round_index = slate.round_index + 1;
      } else {
        projection.exploration.next_cycle_index = slate.cycle_index + 1;
        projection.exploration.next_round_index = 0;
      }
    }
    if (event.type === 'TemplateSelectionDecisionRecorded' && event.data?.decision) {
      projection.decision = event.data.decision;
      projection.decision_history_count += 1;
      projection.linked_run_ids = [...new Set([
        ...projection.linked_run_ids,
        ...(event.data.decision.linked_run_ids || []),
      ])].sort();
      projection.status = 'decision_recorded';
    }
    if (event.type === 'TemplateSelectionOutcomeRecorded' && event.data?.outcome) {
      projection.outcomes.push(event.data.outcome);
      projection.status = 'outcome_recorded';
    }
  }
  const lifecycleEvents = events.filter(isLifecycleOutcomeEvent);
  if (lifecycleEvents.length) {
    try {
      const lifecycle = projectActiveTemplateOutcomes(lifecycleEvents);
      projection.active_outcomes = lifecycle.active_outcomes;
      projection.outcome_history = lifecycle.outcome_history;
      projection.outcome_invalidations = lifecycle.invalidations;
    } catch (error) {
      throw new TemplateSelectionError('selection_event_conflict', error.message, { status: 409 });
    }
  }
  projection.legacy_outcome_count = projection.outcomes.length
    - lifecycleEvents.filter((event) => event.type === 'TemplateSelectionOutcomeRecorded').length;
  projection.projection_sha256 = projectionHash(projection);
  return projection;
}

export async function rebuildTemplateSelection({ root, selectionId, recordedAt = new Date().toISOString() }) {
  const paths = selectionPaths(root, selectionId);
  const requestSource = await readJson(paths.request);
  if (requestSource?.schema_version !== TEMPLATE_SELECTION_REQUEST_VERSION
    || requestSource?.selection_identity?.selection_id !== selectionId) {
    throw new TemplateSelectionError('selection_event_conflict', 'Immutable selection request is invalid', { status: 409 });
  }
  const events = await readSelectionEvents(paths.events);
  const projection = applySelectionEvents(requestSource, events, recordedAt);
  await atomicWriteJson(paths.projection, projection);
  return projection;
}

export async function loadTemplateSelection({ root, selectionId }) {
  const paths = selectionPaths(root, selectionId);
  try {
    const [projection, requestSource, events] = await Promise.all([
      readJson(paths.projection),
      readJson(paths.request),
      readSelectionEvents(paths.events),
    ]);
    if (projection?.schema_version !== TEMPLATE_SELECTION_VERSION || projection?.selection_id !== selectionId
      || requestSource?.schema_version !== TEMPLATE_SELECTION_REQUEST_VERSION
      || requestSource?.selection_identity?.selection_id !== selectionId) {
      throw new TemplateSelectionError('selection_event_conflict', 'Selection projection is invalid', { status: 409 });
    }
    const eventProjection = applySelectionEvents(requestSource, events, projection.rebuilt_at || new Date().toISOString());
    return eventProjection.projection_sha256 === projection.projection_sha256 ? projection : eventProjection;
  } catch (error) {
    if (error?.code !== 'selection_not_found') throw error;
    return rebuildTemplateSelection({ root, selectionId });
  }
}

async function publishInitialSelection({ paths, requestSource, events }) {
  await mkdir(paths.directory, { recursive: true });
  if (!(await pathExists(paths.request))) await atomicWriteJson(paths.request, requestSource);
  if (!(await pathExists(paths.events))) {
    await atomicWrite(paths.events, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  }
}

export async function createTemplateSelection({
  root,
  idempotencyKey,
  taskBrief,
  recordedAt = new Date().toISOString(),
}) {
  const normalizedIdempotencyKey = validateIdempotencyKey(idempotencyKey);
  const brief = normalizeTaskBrief(taskBrief);
  const catalogEvidence = await loadCatalogEvidence(root);
  const identity = selectionIdentity({ brief, idempotencyKey: normalizedIdempotencyKey, catalogEvidence });
  const paths = selectionPaths(root, identity.selection_id);
  if (await pathExists(paths.request)) {
    const existingRequest = await readJson(paths.request, 'selection_event_conflict', 409);
    if (existingRequest?.selection_identity?.request_hash !== identity.request_hash) {
      throw new TemplateSelectionError('idempotency_conflict', 'Selection idempotency key was reused with different content', { status: 409 });
    }
    return { selection: await loadTemplateSelection({ root, selectionId: identity.selection_id }), idempotent_replay: true };
  }

  const ranking = rankTemplateCatalog({ catalog: catalogEvidence.catalog, taskBrief: brief, excludedTemplateUids:catalogEvidence.exclusions.template_uids });
  const requestSource = {
    schema_version: TEMPLATE_SELECTION_REQUEST_VERSION,
    selection_identity: { ...identity, created_at: recordedAt },
    idempotency_key: normalizedIdempotencyKey,
    task_brief: brief,
    request_recorded_at: recordedAt,
  };
  const resultHash = sha256(stableJson(ranking));
  const events = [
    selectionEvent({
      selectionId: identity.selection_id,
      type: 'TemplateSelectionRequested',
      idempotencyKey: `${identity.selection_id}:requested`,
      data: {
        request_hash: identity.request_hash,
        catalog_business_sha256: identity.catalog_business_sha256,
        ranking_policy_version: identity.ranking_policy_version,
      },
      recordedAt,
    }),
    selectionEvent({
      selectionId: identity.selection_id,
      type: 'TemplateSelectionCreated',
      idempotencyKey: `${identity.selection_id}:created`,
      data: { result: ranking, result_sha256: resultHash },
      recordedAt,
    }),
  ];
  await publishInitialSelection({ paths, requestSource, events });
  const selection = await rebuildTemplateSelection({ root, selectionId: identity.selection_id, recordedAt });
  return { selection, idempotent_replay: false };
}

function normalizeTemplateUidList(value, field) {
  const values = normalizeList(value);
  for (const uid of values) {
    if (!/^tpl_[a-z0-9_-]+$/.test(uid)) {
      throw new TemplateSelectionError('invalid_decision', `${field} contains an invalid template uid`);
    }
  }
  return values;
}

function normalizeRunIdList(value) {
  const values = normalizeList(value);
  for (const runId of values) {
    if (!/^run-[a-z0-9_-]+$/i.test(runId)) {
      throw new TemplateSelectionError('invalid_decision', 'linked_run_ids contains an invalid Run id');
    }
  }
  return values;
}

function normalizeDecisionPayload(decision = {}) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new TemplateSelectionError('invalid_decision', 'Decision must be an object');
  }
  const actor = canonicalToken(decision.actor || 'primary-user');
  if (!['primary-user', 'system'].includes(actor)) {
    throw new TemplateSelectionError('invalid_decision', 'Decision actor must be primary-user or system');
  }
  const accepted = normalizeTemplateUidList(decision.accepted_template_uids, 'accepted_template_uids');
  const removed = normalizeTemplateUidList(decision.removed_template_uids, 'removed_template_uids');
  const overlap = accepted.filter((uid) => removed.includes(uid));
  if (overlap.length) throw new TemplateSelectionError('invalid_decision', `Templates cannot be accepted and removed: ${overlap.join(', ')}`);
  const substitutions = Array.isArray(decision.substitutions) ? decision.substitutions.map((item) => {
    const removedTemplateUid = canonicalToken(item?.removed_template_uid);
    const addedTemplateUid = canonicalToken(item?.added_template_uid);
    const reason = cleanString(item?.reason);
    const sourceKind = canonicalToken(item?.source_kind);
    const manualAddition = actor === 'primary-user' && sourceKind === 'full_library' && !removedTemplateUid;
    if ((!manualAddition && !/^tpl_[a-z0-9_-]+$/.test(removedTemplateUid)) || !/^tpl_[a-z0-9_-]+$/.test(addedTemplateUid) || !reason) {
      throw new TemplateSelectionError('invalid_decision', 'Each substitution requires valid removed/added template uids and a reason');
    }
    const sourceSlateId = cleanString(item?.source_slate_id);
    if (sourceKind && !['top4', 'all_safe', 'exploration_slate', 'full_library'].includes(sourceKind)) {
      throw new TemplateSelectionError('invalid_decision', `Unknown substitution source_kind: ${sourceKind}`);
    }
    if (sourceKind === 'exploration_slate' && !/^slate_[a-f0-9]{24}$/.test(sourceSlateId)) {
      throw new TemplateSelectionError('invalid_decision', 'Exploration substitution requires a valid source_slate_id');
    }
    if (sourceKind !== 'exploration_slate' && sourceSlateId) {
      throw new TemplateSelectionError('invalid_decision', 'source_slate_id is only valid for exploration_slate');
    }
    return {
      removed_template_uid: removedTemplateUid || null,
      added_template_uid: addedTemplateUid,
      reason,
      ...(sourceKind ? { source_kind: sourceKind } : {}),
      ...(sourceSlateId ? { source_slate_id: sourceSlateId } : {}),
    };
  }) : [];
  const substitutionKeys = substitutions.map((item) => `${item.removed_template_uid}->${item.added_template_uid}`);
  if (new Set(substitutionKeys).size !== substitutionKeys.length) {
    throw new TemplateSelectionError('invalid_decision', 'Duplicate substitutions are not allowed');
  }
  return {
    actor,
    accepted_template_uids: accepted,
    removed_template_uids: removed,
    substitutions,
    linked_run_ids: normalizeRunIdList(decision.linked_run_ids),
    notes: cleanString(decision.notes),
  };
}

export async function recordTemplateExploration({
  root,
  selectionId,
  explorationIdempotencyKey,
  recordedAt = new Date().toISOString(),
}) {
  const release = await acquireSelectionMutation(root, selectionId);
  try {
    const paths = selectionPaths(root, selectionId);
    const selection = await rebuildTemplateSelection({ root, selectionId, recordedAt });
    const currentExclusions = await loadTemplateExclusions({root});
    const pool = selection.ranked_candidates || selection.top10 || [];
    if (pool.some(item=>currentExclusions.template_uids.includes(item.template_uid))) {
      throw new TemplateSelectionError('template_selection_stale','模板淘汰状态已更新，请重新获取推荐后再换一组。',{status:409});
    }
    const events = await readSelectionEvents(paths.events);
    const explorationEvents = events.filter((event) => event.type === 'TemplateExplorationSlatePresented');
    const evidence = selection.ranked_candidates_source === 'complete'
      ? selection
      : { ...selection, ranked_candidates: null };
    let resolved;
    try {
      resolved = resolveTemplateExplorationPresentation({
        selection: evidence,
        cycleIndex: selection.exploration?.next_cycle_index ?? 0,
        roundIndex: selection.exploration?.next_round_index ?? 0,
        idempotencyKey: explorationIdempotencyKey,
        recordedAt,
        events: explorationEvents,
      });
    } catch (error) {
      if (error instanceof TemplateExplorationError) {
        throw new TemplateSelectionError(error.code, error.message, { status: error.status });
      }
      throw error;
    }
    if (resolved.idempotent_replay) {
      return { selection, slate: resolved.slate, idempotent_replay: true };
    }
    await appendEventIdempotently({
      paths,
      event: resolved.event,
      conflictCode: 'exploration_idempotency_conflict',
    });
    return {
      selection: await rebuildTemplateSelection({ root, selectionId, recordedAt }),
      slate: resolved.slate,
      idempotent_replay: false,
    };
  } finally {
    release();
  }
}

function logicalEventHash(event) {
  return sha256(stableJson({ type: event.type, data: event.data }));
}

async function appendEventIdempotently({ paths, event, conflictCode }) {
  const events = await readSelectionEvents(paths.events);
  const existing = events.find((item) => item.idempotency_key === event.idempotency_key);
  if (existing) {
    if (logicalEventHash(existing) !== logicalEventHash(event)) {
      throw new TemplateSelectionError(conflictCode, `Event idempotency key was reused with different content: ${event.idempotency_key}`, { status: 409 });
    }
    return false;
  }
  await appendFile(paths.events, `${JSON.stringify(event)}\n`, 'utf8');
  return true;
}

function decisionChosenTemplates(decision) {
  return new Set([
    ...(decision?.accepted_template_uids || []),
    ...(decision?.substitutions || []).map((item) => item.added_template_uid),
  ]);
}

export async function recordTemplateSelectionDecision({
  root,
  selectionId,
  decisionIdempotencyKey,
  decision,
  recordedAt = new Date().toISOString(),
}) {
  const release = await acquireSelectionMutation(root, selectionId);
  try {
    const paths = selectionPaths(root, selectionId);
    const selection = await loadTemplateSelection({ root, selectionId });
    const normalizedKey = validateIdempotencyKey(decisionIdempotencyKey, 'decision_idempotency_key', 'invalid_decision');
    const normalized = normalizeDecisionPayload(decision);
    const currentEvents = await readSelectionEvents(paths.events);
    const top4 = new Set(selection.top4.map((item) => item.template_uid));
    for (const uid of [...normalized.accepted_template_uids, ...normalized.removed_template_uids]) {
      if (!top4.has(uid)) throw new TemplateSelectionError('invalid_decision', `Decision template is not in Top4: ${uid}`);
    }
    const explorationSlates = new Map(
      currentEvents
        .filter((event) => event.type === 'TemplateExplorationSlatePresented' && event.data?.slate?.selection_id === selectionId)
        .map((event) => [event.data.slate.slate_id, event.data.slate]),
    );
    const catalogEvidence = await loadCatalogEvidence(root);
    const catalogByUid = new Map(catalogEvidence.catalog.templates.map((template) => [template.template_uid, template]));
    if ([...normalized.accepted_template_uids,...normalized.substitutions.map(s=>s.added_template_uid)].some(uid=>catalogEvidence.exclusions.template_uids.includes(uid))) {
      throw new TemplateSelectionError('operator_template_rejected','你已淘汰此模板，请重新选择。',{status:422});
    }
    for (const substitution of normalized.substitutions) {
      const manualChoice = normalized.actor === 'primary-user' && substitution.source_kind === 'full_library';
      if (!top4.has(substitution.removed_template_uid) && !(manualChoice && substitution.removed_template_uid === null)) {
        throw new TemplateSelectionError('invalid_decision', `Substitution removed template is not in Top4: ${substitution.removed_template_uid}`);
      }
      const added = catalogByUid.get(substitution.added_template_uid);
      if (!added || (!manualChoice && !evaluateHardFilter(added, selection.task_brief).eligible)) {
        throw new TemplateSelectionError('unsafe_substitution', `Substitution template does not pass the original hard filter: ${substitution.added_template_uid}`, { status: 422 });
      }
      if (substitution.source_kind === 'exploration_slate') {
        const slate = explorationSlates.get(substitution.source_slate_id);
        if (!slate || !Array.isArray(slate.candidate_uids) || !slate.candidate_uids.includes(substitution.added_template_uid)) {
          throw new TemplateSelectionError(
            'invalid_exploration_source',
            'Exploration substitution must reference a presented slate containing the selected template',
            { status: 422 },
          );
        }
      }
    }
    if (!normalized.accepted_template_uids.length && !normalized.removed_template_uids.length
      && !normalized.substitutions.length && !normalized.linked_run_ids.length) {
      throw new TemplateSelectionError('invalid_decision', 'Decision must record at least one accepted, removed, substituted, or linked item');
    }
    const payloadHash = sha256(stableJson(normalized));
    const eventKey = `${selectionId}:decision:${normalizedKey}`;
    const existing = currentEvents.find((event) => event.idempotency_key === eventKey);
    if (existing) {
      if (existing.data?.decision_payload_sha256 !== payloadHash) {
        throw new TemplateSelectionError('decision_idempotency_conflict', 'Decision idempotency key was reused with different content', { status: 409 });
      }
      return { selection: await loadTemplateSelection({ root, selectionId }), idempotent_replay: true };
    }
    const storedDecision = {
      decision_id: `dec_${payloadHash.slice(0, 24)}`,
      ...normalized,
      recorded_at: recordedAt,
    };
    const event = selectionEvent({
      selectionId,
      type: 'TemplateSelectionDecisionRecorded',
      idempotencyKey: eventKey,
      data: { decision: storedDecision, decision_payload_sha256: payloadHash },
      recordedAt,
    });
    await appendEventIdempotently({ paths, event, conflictCode: 'decision_idempotency_conflict' });
    return {
      selection: await rebuildTemplateSelection({ root, selectionId, recordedAt }),
      idempotent_replay: false,
    };
  } finally {
    release();
  }
}

function normalizeOutcomeScore(value, field) {
  const number = value;
  if (typeof number !== 'number'
    || !Number.isFinite(number)
    || number < 0
    || number > 10
    || Math.abs(number * 10 - Math.round(number * 10)) > 1e-9) {
    throw new TemplateSelectionError('invalid_outcome', `${field} must be a 0.0-10.0 score with one decimal place`);
  }
  return Math.round(number * 10) / 10;
}

function normalizeOutcomePayload(outcome = {}) {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
    throw new TemplateSelectionError('invalid_outcome', 'Outcome must be an object');
  }
  const preferenceResult = canonicalToken(outcome.preference_result);
  if (!['winner', 'eligible_not_selected', 'none', 'pending'].includes(preferenceResult)) {
    throw new TemplateSelectionError('invalid_outcome', 'Unknown preference_result value');
  }
  const required = [
    'selection_id',
    'run_id',
    'artifact_id',
    'artifact_sha256',
    'template_uid',
    'reference_image_sha256',
    'generation_blueprint_sha256',
    'catalog_projection_version',
    'ranking_policy_version',
    'rubric_version',
    'review_session_id',
    'reviewer_id',
    'preference_session_id',
    'review_source_event_id',
    'preference_source_event_id',
  ];
  const normalized = Object.fromEntries(required.map((field) => [field, cleanString(outcome[field])]));
  for (const field of required) {
    if (!normalized[field]) throw new TemplateSelectionError('invalid_outcome', `${field} is required`);
  }
  if (!/^run-[a-z0-9_-]+$/i.test(normalized.run_id) || !/^tpl_[a-z0-9_-]+$/.test(normalized.template_uid)) {
    throw new TemplateSelectionError('invalid_outcome', 'Outcome Run or template identity is invalid');
  }
  const scores = outcome.scores || {};
  return {
    ...normalized,
    scores: {
      face_consistency: normalizeOutcomeScore(scores.face_consistency, 'face_consistency'),
      naturalness: normalizeOutcomeScore(scores.naturalness, 'naturalness'),
      style_consistency: normalizeOutcomeScore(scores.style_consistency, 'style_consistency'),
    },
    preference_result: preferenceResult,
    excluded_from_learning: outcome.excluded_from_learning === true,
    source_event_id: cleanString(outcome.source_event_id),
    prompt_compiler_id: cleanString(outcome.prompt_compiler_id) || null,
    prompt_compiler_version: outcome.prompt_compiler_version ?? null,
    prompt_recipe_id: cleanString(outcome.prompt_recipe_id) || null,
    prompt_input_mode: cleanString(outcome.prompt_input_mode) || null,
    applied_correction_ids: normalizeList(outcome.applied_correction_ids),
    shadow_correction_ids: normalizeList(outcome.shadow_correction_ids),
    angle_alignment: outcome.angle_alignment || null,
    face_angle_match: outcome.face_angle_match || null,
    face_angle_pipeline_version: cleanString(outcome.face_angle_pipeline_version) || null,
    prompt_sha256: cleanString(outcome.prompt_sha256) || null,
  };
}

export async function recordTemplateSelectionOutcome({
  root,
  selectionId,
  outcomeIdempotencyKey,
  outcome,
  recordedAt = new Date().toISOString(),
}) {
  const release = await acquireSelectionMutation(root, selectionId);
  try {
  const paths = selectionPaths(root, selectionId);
  const selection = await loadTemplateSelection({ root, selectionId });
  if (!selection.decision) throw new TemplateSelectionError('invalid_outcome', 'Record a template decision before an outcome');
  const normalizedKey = validateIdempotencyKey(outcomeIdempotencyKey, 'outcome_idempotency_key', 'invalid_outcome');
  const normalized = normalizeOutcomePayload({ ...outcome, selection_id: selectionId });
  if (!decisionChosenTemplates(selection.decision).has(normalized.template_uid)) {
    throw new TemplateSelectionError('template_usage_mismatch', 'Outcome template was not accepted or substituted into the decision', { status: 422 });
  }
  if (!selection.linked_run_ids.includes(normalized.run_id)) {
    throw new TemplateSelectionError('template_usage_mismatch', 'Outcome Run is not linked to the selection decision', { status: 422 });
  }
  const catalogEvidence = await loadCatalogEvidence(root);
  const template = catalogEvidence.catalog.templates.find((item) => item.template_uid === normalized.template_uid);
  const blueprintHash = template ? sha256(stableJson(template.generation_blueprint)) : '';
  if (!template
    || normalized.reference_image_sha256 !== template.reference_image.sha256
    || normalized.generation_blueprint_sha256 !== blueprintHash
    || normalized.catalog_projection_version !== selection.catalog_projection_version
    || normalized.ranking_policy_version !== selection.ranking_policy_version) {
    throw new TemplateSelectionError('template_usage_mismatch', 'Outcome template usage hashes or versions do not match selection evidence', { status: 422 });
  }
  const identityEligible = !normalized.excluded_from_learning && normalized.scores.face_consistency >= 8;
  const aestheticEligible = identityEligible
    && normalized.scores.naturalness >= 7
    && normalized.scores.style_consistency >= 7;
  const exclusionReasons = [];
  if (normalized.excluded_from_learning) exclusionReasons.push('run_excluded_from_learning');
  if (normalized.scores.face_consistency < 8) exclusionReasons.push('face_consistency_failed');
  if (normalized.scores.naturalness < 7) exclusionReasons.push('naturalness_failed');
  if (normalized.scores.style_consistency < 7) exclusionReasons.push('style_consistency_failed');
  const storedOutcome = {
    ...normalized,
    identity_eligible: identityEligible,
    aesthetic_eligible: aestheticEligible,
    exclusion_reasons: exclusionReasons,
    recorded_at: recordedAt,
  };
  const payloadHash = sha256(stableJson(normalized));
  const eventKey = `${selectionId}:outcome:${normalizedKey}`;
  const currentEvents = await readSelectionEvents(paths.events);
  const existing = currentEvents.find((event) => event.idempotency_key === eventKey);
  if (existing) {
    if (existing.data?.outcome_payload_sha256 !== payloadHash) {
      throw new TemplateSelectionError('outcome_idempotency_conflict', 'Outcome idempotency key was reused with different content', { status: 409 });
    }
    return {
      selection: await loadTemplateSelection({ root, selectionId }),
      performance: await rebuildTemplatePerformance({ root, recordedAt }),
      idempotent_replay: true,
    };
  }
  const lifecycleEvents = currentEvents.filter(isLifecycleOutcomeEvent);
  let prior = null;
  let priorInvalidationAlreadyRecorded = false;
  let lifecycle = null;
  if (lifecycleEvents.length) {
    try {
      lifecycle = projectActiveTemplateOutcomes(lifecycleEvents);
      prior = lifecycle.active_outcomes.find((item) => (
        item.selection_id === selectionId
          && item.run_id === normalized.run_id
          && item.artifact_id === normalized.artifact_id
          && item.template_uid === normalized.template_uid
      )) || null;
      if (!prior) {
        const invalidatedTails = lifecycle.outcome_history.filter((item) => (
          item.lifecycle_state === 'invalidated'
            && item.selection_id === selectionId
            && item.run_id === normalized.run_id
            && item.artifact_id === normalized.artifact_id
            && item.template_uid === normalized.template_uid
        ));
        if (invalidatedTails.length > 1) {
          throw new TemplateSelectionError(
            'selection_event_conflict',
            'Multiple invalidated Outcome chain tails require manual reconciliation',
            { status: 409 },
          );
        }
        prior = invalidatedTails[0] || null;
        priorInvalidationAlreadyRecorded = Boolean(prior);
      }
    } catch (error) {
      throw new TemplateSelectionError('selection_event_conflict', error.message, { status: 409 });
    }
  }
  if (prior) {
    const sameReviewSource = prior.review_source_event_id === normalized.review_source_event_id;
    const samePreferenceSource = prior.preference_source_event_id === normalized.preference_source_event_id;
    if (sameReviewSource && samePreferenceSource) {
      throw new TemplateSelectionError(
        'outcome_source_conflict',
        'Outcome source evidence already has a different active payload',
        { status: 409 },
      );
    }
    const reason = sameReviewSource ? 'preference_revised' : 'review_revised';
    if (!priorInvalidationAlreadyRecorded) {
      const invalidation = createTemplateSelectionOutcomeInvalidated({
        selection_id: selectionId,
        outcome_id: prior.outcome_id,
        artifact_id: prior.artifact_id,
        reason,
        review_source_event_id: normalized.review_source_event_id,
        preference_source_event_id: normalized.preference_source_event_id,
        recorded_at: recordedAt,
      });
      await appendEventIdempotently({
        paths,
        event: invalidation,
        conflictCode: 'outcome_idempotency_conflict',
      });
    }
    storedOutcome.supersedes_outcome_id = prior.outcome_id;
  }
  let event = createTemplateSelectionOutcomeRecorded({
    selection_id: selectionId,
    review_source_event_id: normalized.review_source_event_id,
    preference_source_event_id: normalized.preference_source_event_id,
    recorded_at: recordedAt,
    outcome: storedOutcome,
  });
  event = validateTemplateSelectionOutcomeRecorded({
    ...event,
    idempotency_key: eventKey,
    data: { ...event.data, outcome_payload_sha256: payloadHash },
  });
  await appendEventIdempotently({ paths, event, conflictCode: 'outcome_idempotency_conflict' });
  const rebuiltSelection = await rebuildTemplateSelection({ root, selectionId, recordedAt });
  const performance = await rebuildTemplatePerformance({ root, recordedAt });
  return { selection: rebuiltSelection, performance, idempotent_replay: false };
  } finally {
    release();
  }
}

export async function invalidateTemplateSelectionOutcome({
  root,
  selectionId,
  outcomeId,
  artifactId,
  reason,
  reviewSourceEventId,
  preferenceSourceEventId,
  recordedAt = new Date().toISOString(),
}) {
  const release = await acquireSelectionMutation(root, selectionId);
  try {
  const paths = selectionPaths(root, selectionId);
  const events = await readSelectionEvents(paths.events);
  const lifecycleEvents = events.filter(isLifecycleOutcomeEvent);
  if (!lifecycleEvents.length) {
    throw new TemplateSelectionError('outcome_not_found', 'No active Outcome evidence is available to invalidate', { status: 404 });
  }
  let lifecycle;
  try {
    lifecycle = projectActiveTemplateOutcomes(lifecycleEvents);
  } catch (error) {
    throw new TemplateSelectionError('selection_event_conflict', error.message, { status: 409 });
  }
  const active = lifecycle.active_outcomes.find((item) => (
    item.selection_id === selectionId
      && item.outcome_id === outcomeId
      && item.artifact_id === artifactId
  ));
  if (!active) {
    const replay = lifecycle.invalidations.find((event) => (
      event.data?.invalidation?.outcome_id === outcomeId
        && event.data.invalidation.artifact_id === artifactId
        && event.data.invalidation.reason === reason
        && event.data.invalidation.review_source_event_id === reviewSourceEventId
        && event.data.invalidation.preference_source_event_id === preferenceSourceEventId
    ));
    if (replay) {
      return {
        selection: await rebuildTemplateSelection({ root, selectionId, recordedAt }),
        performance: await rebuildTemplatePerformance({ root, recordedAt }),
        idempotent_replay: true,
      };
    }
    throw new TemplateSelectionError('outcome_not_active', 'Outcome is no longer active or does not match the requested Artifact', { status: 409 });
  }
  const event = createTemplateSelectionOutcomeInvalidated({
    selection_id: selectionId,
    outcome_id: outcomeId,
    artifact_id: artifactId,
    reason,
    review_source_event_id: reviewSourceEventId,
    preference_source_event_id: preferenceSourceEventId,
    recorded_at: recordedAt,
  });
  const appended = await appendEventIdempotently({
    paths,
    event,
    conflictCode: 'outcome_idempotency_conflict',
  });
  return {
    selection: await rebuildTemplateSelection({ root, selectionId, recordedAt }),
    performance: await rebuildTemplatePerformance({ root, recordedAt }),
    idempotent_replay: !appended,
  };
  } finally {
    release();
  }
}

function average(values) {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 2) : null;
}

function emptyPerformanceStats(templateUid) {
  return {
    template_uid: templateUid,
    eligible_generation_count: 0,
    identity_pass_count: 0,
    naturalness_values: [],
    style_consistency_values: [],
    aesthetic_eligible_count: 0,
    winner_count: 0,
    manual_substitution_in_count: 0,
    manual_substitution_out_count: 0,
  };
}

async function loadRunProjectionsForTemplatePerformance(root) {
  const runsRoot = join(root, 'data', 'runs');
  let directories = [];
  try {
    directories = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const runs = [];
  for (const directory of directories) {
    if (!directory.isDirectory() || !/^run-[a-zA-Z0-9-]+$/.test(directory.name)) continue;
    try {
      const manifest = await readJson(join(runsRoot, directory.name, 'manifest.json'));
      const eventText = await readFile(join(runsRoot, directory.name, 'events.jsonl'), 'utf8');
      const events = eventText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      runs.push({ manifest, events });
    } catch {
      // Incomplete Run directories are not attributable performance evidence.
    }
  }
  return runs;
}

export async function rebuildTemplatePerformance({ root, recordedAt = new Date().toISOString() }) {
  const selectionsRoot = join(root, 'data', 'template-selections');
  let directories = [];
  try {
    directories = await readdir(selectionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const selectionProjections = [];
  const selectionEvents = [];
  for (const directory of directories) {
    if (!directory.isDirectory() || !SAFE_SELECTION_ID.test(directory.name)) continue;
    const paths = selectionPaths(root, directory.name);
    const events = await readSelectionEvents(paths.events);
    const requestSource = await readJson(paths.request);
    selectionProjections.push(applySelectionEvents(requestSource, events, recordedAt));
    selectionEvents.push(...events.filter((event) => (
      event.type !== 'TemplateSelectionOutcomeRecorded' || isLifecycleOutcomeEvent(event)
    )));
  }
  const projection = buildTemplatePerformanceProjectionV2({
    selection_projections: selectionProjections,
    selection_events: selectionEvents,
    run_projections: await loadRunProjectionsForTemplatePerformance(root),
    recorded_at: recordedAt,
  });
  await atomicWriteJson(join(root, 'data', 'projections', 'template-performance.json'), projection);
  return projection;
}
