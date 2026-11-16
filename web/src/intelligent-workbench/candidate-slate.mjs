import { createHash } from 'node:crypto';

export const CANDIDATE_SLATE_REQUEST_VERSION = 'ai-img-gen.candidate-slate-request.v1';
export const CANDIDATE_SLATE_PROJECTION_VERSION = 'ai-img-gen.candidate-slate-projection.v1';
export const GENERATION_REGIME_VERSION = 'portrait-generation-v7-two-candidate';
export const CANDIDATE_SLATE_PROMPT_POLICY_VERSION = 'candidate-slate-prompt-v1';

const RUN_EVENT_VERSION = 'ai-img-gen.run-event.v1';
const FIXED_VARIANTS = Object.freeze(['template_faithful', 'bounded_variation']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  if (value === undefined) return null;
  return value;
}

function hashCanonicalValue(value) {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) throw new Error('Cannot hash an undefined canonical value');
  return createHash('sha256').update(serialized).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertFixedValue(input, field, expected) {
  if (input[field] !== undefined && input[field] !== expected) {
    throw new Error(`${field} is fixed by the candidate slate contract and must be ${String(expected)}`);
  }
}

function assertFixedVariants(input) {
  if (input.variants === undefined) return;
  if (!Array.isArray(input.variants)
    || input.variants.length !== FIXED_VARIANTS.length
    || input.variants.some((value, index) => value !== FIXED_VARIANTS[index])) {
    throw new Error('variants are fixed by the candidate slate contract');
  }
}

function requestIdentity() {
  return {
    schema_version: CANDIDATE_SLATE_REQUEST_VERSION,
    generation_regime_version: GENERATION_REGIME_VERSION,
    requested_count: 2,
    minimum_acceptable_count: 1,
    maximum_capture_count: 4,
    submission_limit: 1,
    auto_resubmit: false,
    prompt_policy_version: CANDIDATE_SLATE_PROMPT_POLICY_VERSION,
    variants: [...FIXED_VARIANTS],
  };
}

export function buildCandidateSlateRequest(input = {}) {
  requireObject(input, 'CandidateSlateRequest input');
  assertFixedValue(input, 'schema_version', CANDIDATE_SLATE_REQUEST_VERSION);
  assertFixedValue(input, 'generation_regime_version', GENERATION_REGIME_VERSION);
  assertFixedValue(input, 'requested_count', 2);
  assertFixedValue(input, 'minimum_acceptable_count', 1);
  assertFixedValue(input, 'maximum_capture_count', 4);
  assertFixedValue(input, 'submission_limit', 1);
  assertFixedValue(input, 'auto_resubmit', false);
  assertFixedValue(input, 'prompt_policy_version', CANDIDATE_SLATE_PROMPT_POLICY_VERSION);
  assertFixedVariants(input);

  const identity = requestIdentity();
  const slateRequestId = `candidate-slate_${hashCanonicalValue(identity).slice(0, 24)}`;
  assertFixedValue(input, 'slate_request_id', slateRequestId);
  return deepFreeze({
    ...identity,
    slate_request_id: slateRequestId,
  });
}

function normalizeOccurredAt(value) {
  const date = value === undefined ? new Date(0) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('occurredAt must be a valid timestamp');
  return date.toISOString();
}

export function buildCandidateSlateRequestedEvent(input = {}, { occurredAt } = {}) {
  const request = buildCandidateSlateRequest(input);
  const idempotencyKey = `CandidateSlateRequested:${hashCanonicalValue(request)}`;
  return deepFreeze({
    schema_version: RUN_EVENT_VERSION,
    event_id: `candidate-slate-event_${hashCanonicalValue(idempotencyKey).slice(0, 24)}`,
    type: 'CandidateSlateRequested',
    recorded_at: normalizeOccurredAt(occurredAt),
    idempotency_key: idempotencyKey,
    data: {
      candidate_slate_request: request,
    },
  });
}

export function candidateSlatePromptDirectives(requestInput = {}) {
  buildCandidateSlateRequest(requestInput);
  return [
    '请在本次单次提交中一次输出两张候选图，不要拆成多次生成。',
    '候选 A 必须紧贴所选模板，忠实保持其构图、姿态、光线、色彩和整体视觉语言。',
    '候选 B 只允许在姿势、表情或构图上做有限变化，不得扩大变化范围。',
    '两张候选的客户身份、既定用途、目标风格和安全边界必须保持不变。',
    '模板只提供视觉参考；不得复制或带入模板人物的身份、面部特征或其他身份线索。',
  ].join('\n');
}

function eventRequest(event) {
  if (!event || typeof event !== 'object' || event.type !== 'CandidateSlateRequested') return null;
  return event.data?.candidate_slate_request
    ?? event.data?.request
    ?? event.payload?.candidate_slate_request
    ?? event.payload
    ?? null;
}

function validRequestEvents(events) {
  if (!Array.isArray(events)) throw new Error('events must be an array');
  const valid = [];
  for (const event of events) {
    const candidate = eventRequest(event);
    if (!candidate) continue;
    try {
      valid.push({
        request: buildCandidateSlateRequest(candidate),
        recorded_at: normalizeOccurredAt(event.recorded_at ?? event.occurred_at),
        tie_breaker: hashCanonicalValue(event),
      });
    } catch {
      // Invalid request evidence is ignored; projection uses the latest valid request only.
    }
  }
  return valid.sort((left, right) => (
    left.recorded_at.localeCompare(right.recorded_at)
      || left.tie_breaker.localeCompare(right.tie_breaker)
  ));
}

function activeArtifact(artifact) {
  if (artifact.active === false || artifact.invalidated_at) return false;
  return !['inactive', 'invalidated', 'deleted'].includes(String(artifact.status || '').toLowerCase());
}

function normalizeArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) throw new Error('artifacts must be an array');
  return artifacts
    .filter((artifact) => artifact && typeof artifact === 'object' && activeArtifact(artifact))
    .map((artifact) => {
      const artifactId = String(artifact.artifact_id || '').trim();
      const sha256 = String(artifact.sha256 || '').trim().toLowerCase();
      if (!artifactId) throw new Error('Active artifact_id is required');
      if (!SHA256_PATTERN.test(sha256)) {
        throw new Error(`Active artifact ${artifactId} must have a 64-character SHA-256 hash`);
      }
      return { artifact_id: artifactId, sha256 };
    })
    .sort((left, right) => (
      left.artifact_id.localeCompare(right.artifact_id)
        || left.sha256.localeCompare(right.sha256)
    ));
}

function uniqueArtifactIds(artifacts) {
  const parent = artifacts.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };
  const firstById = new Map();
  const firstByHash = new Map();

  artifacts.forEach((artifact, index) => {
    if (firstById.has(artifact.artifact_id)) union(index, firstById.get(artifact.artifact_id));
    else firstById.set(artifact.artifact_id, index);
    if (firstByHash.has(artifact.sha256)) union(index, firstByHash.get(artifact.sha256));
    else firstByHash.set(artifact.sha256, index);
  });

  const idsByRoot = new Map();
  artifacts.forEach((artifact, index) => {
    const root = find(index);
    const ids = idsByRoot.get(root) ?? [];
    ids.push(artifact.artifact_id);
    idsByRoot.set(root, ids);
  });
  return [...idsByRoot.values()]
    .map((ids) => ids.sort()[0])
    .sort();
}

function projectionStatus(receivedCount, ambiguous) {
  if (ambiguous) return 'ambiguous';
  if (receivedCount === 0) return 'pending';
  if (receivedCount === 1) return 'partial';
  if (receivedCount === 2) return 'complete';
  return 'overcomplete';
}

export function projectCandidateSlate({ events, artifacts = [], ambiguous = false } = {}) {
  if (typeof ambiguous !== 'boolean') throw new Error('ambiguous must be a boolean');
  const requests = validRequestEvents(events);
  if (!requests.length) throw new Error('No valid CandidateSlateRequested event was found');
  const latestRequest = requests.at(-1).request;
  const artifactIds = uniqueArtifactIds(normalizeArtifacts(artifacts));
  if (artifactIds.length > latestRequest.maximum_capture_count) {
    throw new Error('Candidate slate exceeds the maximum of 4 active unique artifacts');
  }
  return deepFreeze({
    schema_version: CANDIDATE_SLATE_PROJECTION_VERSION,
    slate_request_id: latestRequest.slate_request_id,
    generation_regime_version: GENERATION_REGIME_VERSION,
    requested_count: latestRequest.requested_count,
    received_count: artifactIds.length,
    artifact_ids: artifactIds,
    status: projectionStatus(artifactIds.length, ambiguous),
  });
}
