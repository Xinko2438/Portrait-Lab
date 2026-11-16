import { createHash } from 'node:crypto';

export const TEMPLATE_EXPLORATION_POLICY_VERSION = 'template-exploration-v1';
export const TEMPLATE_EXPLORATION_SLATE_VERSION = 'ai-img-gen.template-exploration-slate.v1';
export const TEMPLATE_EXPLORATION_EVENT_VERSION = 'ai-img-gen.template-selection-event.v1';

const MAX_SLATE_SIZE = 4;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const SELECTION_ID_PATTERN = /^sel_[a-f0-9]{24}$/;
const TEMPLATE_UID_PATTERN = /^tpl_[a-z0-9_-]+$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const FORBIDDEN_CALLER_CANDIDATE_FIELDS = Object.freeze([
  'candidate_uids',
  'candidateUids',
  'candidates',
  'template_uids',
  'templateUids',
  'template_uid',
  'templateUid',
]);

export class TemplateExplorationError extends Error {
  constructor(code, message, { status = 422 } = {}) {
    super(message);
    this.name = 'TemplateExplorationError';
    this.code = code;
    this.status = status;
  }
}

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
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requireObject(value, label, {
  code = 'invalid_exploration_evidence',
  status = 422,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TemplateExplorationError(code, `${label} must be an object`, { status });
  }
  return value;
}

function normalizeSelectionIdentity(selection) {
  const selectionId = String(selection.selection_id ?? '').trim();
  const catalogBusinessSha256 = String(selection.catalog_business_sha256 ?? '').trim().toLowerCase();
  if (!SELECTION_ID_PATTERN.test(selectionId)) {
    throw new TemplateExplorationError('invalid_selection_id', 'Selection evidence has an invalid selection_id', { status: 400 });
  }
  if (!SHA256_PATTERN.test(catalogBusinessSha256)) {
    throw new TemplateExplorationError('invalid_exploration_evidence', 'Selection evidence has an invalid catalog_business_sha256');
  }
  return { selectionId, catalogBusinessSha256 };
}

function normalizeTemplateUid(value, label) {
  const templateUid = String(value ?? '').trim();
  if (!TEMPLATE_UID_PATTERN.test(templateUid)) {
    throw new TemplateExplorationError('invalid_exploration_evidence', `${label} has an invalid template_uid`);
  }
  return templateUid;
}

function candidateImageHash(candidate, label) {
  const hash = String(candidate.reference_image?.sha256 ?? candidate.reference_image_sha256 ?? '')
    .trim()
    .toLowerCase();
  if (!SHA256_PATTERN.test(hash)) {
    throw new TemplateExplorationError('invalid_exploration_evidence', `${label} has an invalid reference-image hash`);
  }
  return hash;
}

function normalizeCandidate(candidate, index, sourceKind) {
  requireObject(candidate, `${sourceKind}[${index}]`);
  const templateUid = normalizeTemplateUid(candidate.template_uid, `${sourceKind}[${index}]`);
  const rank = candidate.rank;
  const relevanceScore = candidate.relevance_score;
  if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 1) {
    throw new TemplateExplorationError('invalid_exploration_evidence', `${sourceKind}[${index}] has an invalid original rank`);
  }
  if (typeof relevanceScore !== 'number' || !Number.isFinite(relevanceScore)) {
    throw new TemplateExplorationError('invalid_exploration_evidence', `${sourceKind}[${index}] has an invalid relevance_score`);
  }
  return {
    template_uid: templateUid,
    rank,
    relevance_score: relevanceScore,
    reference_image_sha256: candidateImageHash(candidate, `${sourceKind}[${index}]`),
  };
}

function normalizedTop4Uids(selection, sourceCandidateUids) {
  if (!Array.isArray(selection.top4)) {
    throw new TemplateExplorationError('invalid_exploration_evidence', 'Selection evidence must contain stored Top4 candidates');
  }
  const expectedTop4Count = Math.min(4, sourceCandidateUids.size);
  if (selection.top4.length !== expectedTop4Count) {
    throw new TemplateExplorationError(
      'invalid_exploration_evidence',
      `Stored Top4 must contain exactly ${expectedTop4Count} candidates for this source pool`,
    );
  }
  const top4Uids = new Set();
  for (const [index, candidate] of selection.top4.entries()) {
    const templateUid = normalizeTemplateUid(candidate?.template_uid, `top4[${index}]`);
    if (top4Uids.has(templateUid)) {
      throw new TemplateExplorationError('invalid_exploration_evidence', `Stored Top4 UID is duplicated: ${templateUid}`);
    }
    if (!sourceCandidateUids.has(templateUid)) {
      throw new TemplateExplorationError(
        'invalid_exploration_evidence',
        `Stored Top4 UID is absent from the stored source pool: ${templateUid}`,
      );
    }
    top4Uids.add(templateUid);
  }
  return top4Uids;
}

function sourceCandidates(selection) {
  if (Array.isArray(selection.ranked_candidates)) {
    return {
      candidates: selection.ranked_candidates,
      legacyLimited: false,
      sourceKind: 'ranked_candidates',
    };
  }
  if (selection.ranked_candidates !== undefined && selection.ranked_candidates !== null) {
    throw new TemplateExplorationError('invalid_exploration_evidence', 'ranked_candidates must be an array when present');
  }
  if (!Array.isArray(selection.top10)) {
    throw new TemplateExplorationError(
      'legacy_selection_unavailable',
      'Legacy selection has no stored non-Top4 Top10 fallback',
      { status: 409 },
    );
  }
  return {
    candidates: selection.top10,
    legacyLimited: true,
    sourceKind: 'legacy_non_top4_top10',
  };
}

export function deriveEligibleTemplateExplorationPool(selectionInput) {
  const selection = requireObject(selectionInput, 'selection');
  const { selectionId, catalogBusinessSha256 } = normalizeSelectionIdentity(selection);
  const source = sourceCandidates(selection);
  const seenUids = new Set();
  const seenRanks = new Set();
  const normalized = source.candidates.map((candidate, index) => {
    const item = normalizeCandidate(candidate, index, source.sourceKind);
    if (seenUids.has(item.template_uid)) {
      throw new TemplateExplorationError(
        'invalid_exploration_evidence',
        `Stored candidate UID is duplicated: ${item.template_uid}`,
      );
    }
    if (seenRanks.has(item.rank)) {
      throw new TemplateExplorationError(
        'invalid_exploration_evidence',
        `Stored candidate rank is duplicated: ${item.rank}`,
      );
    }
    seenUids.add(item.template_uid);
    seenRanks.add(item.rank);
    return item;
  });
  const top4Uids = normalizedTop4Uids(selection, seenUids);
  const candidates = normalized
    .filter((candidate) => !top4Uids.has(candidate.template_uid))
    .sort((left, right) => left.rank - right.rank || left.template_uid.localeCompare(right.template_uid));
  const eligiblePoolSha256 = hashCanonicalValue({
    policy_version: TEMPLATE_EXPLORATION_POLICY_VERSION,
    selection_id: selectionId,
    catalog_business_sha256: catalogBusinessSha256,
    source_kind: source.sourceKind,
    candidates,
  });
  return deepFreeze({
    selection_id: selectionId,
    policy_version: TEMPLATE_EXPLORATION_POLICY_VERSION,
    catalog_business_sha256: catalogBusinessSha256,
    eligible_pool_sha256: eligiblePoolSha256,
    legacy_limited: source.legacyLimited,
    source_kind: source.sourceKind,
    candidates,
  });
}

function normalizeNonNegativeInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TemplateExplorationError('invalid_exploration_request', `${label} must be a non-negative integer`, { status: 400 });
  }
  return value;
}

function deterministicOrder(values, identity) {
  return [...values].sort((left, right) => {
    const leftKey = hashCanonicalValue({ ...identity, value: left.key });
    const rightKey = hashCanonicalValue({ ...identity, value: right.key });
    return leftKey.localeCompare(rightKey) || left.key.localeCompare(right.key);
  });
}

function groupCandidatesByImageHash(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const members = groups.get(candidate.reference_image_sha256) ?? [];
    members.push(candidate);
    groups.set(candidate.reference_image_sha256, members);
  }
  return [...groups.entries()].map(([imageHash, members]) => ({
    key: imageHash,
    imageHash,
    members,
  }));
}

function probabilityEvidence({ groupSize, groupCount, slateSize, remainingCount }) {
  const selectedGroupCount = Math.min(slateSize, groupCount);
  const groupSelection = selectedGroupCount / groupCount;
  const memberSelection = 1 / groupSize;
  const fillCount = Math.max(0, slateSize - selectedGroupCount);
  const nonPrimaryCount = remainingCount - selectedGroupCount;
  const fillSelection = fillCount > 0 && groupSize > 1 ? fillCount / nonPrimaryCount : 0;
  const inclusionProbability = fillCount > 0
    ? memberSelection + (1 - memberSelection) * fillSelection
    : groupSelection * memberSelection;
  return {
    inclusion_probability: inclusionProbability,
    inclusion_probability_components: {
      group_selection: groupSelection,
      member_selection: memberSelection,
      fill_selection: fillSelection,
    },
  };
}

function sampleTemplateExplorationRound({ pool, remaining, cycleIndex, roundIndex }) {
  const slateSize = Math.min(MAX_SLATE_SIZE, remaining.length);
  const seed = {
    selection_id: pool.selection_id,
    catalog_business_sha256: pool.catalog_business_sha256,
    policy_version: pool.policy_version,
    cycle_index: cycleIndex,
    round_index: roundIndex,
  };
  const groups = deterministicOrder(groupCandidatesByImageHash(remaining), { ...seed, phase: 'group' });
  const selectedGroups = groups.slice(0, Math.min(slateSize, groups.length));
  const primary = selectedGroups.map((group) => deterministicOrder(
    group.members.map((candidate) => ({ key: candidate.template_uid, candidate })),
    { ...seed, phase: 'member', image_hash: group.imageHash },
  )[0].candidate);
  const primaryUids = new Set(primary.map((candidate) => candidate.template_uid));
  const fillCount = slateSize - primary.length;
  const fill = fillCount > 0
    ? deterministicOrder(
      remaining
        .filter((candidate) => !primaryUids.has(candidate.template_uid))
        .map((candidate) => ({ key: candidate.template_uid, candidate })),
      { ...seed, phase: 'fill' },
    ).slice(0, fillCount).map((item) => item.candidate)
    : [];
  const groupSizes = new Map(groups.map((group) => [group.imageHash, group.members.length]));
  return [...primary, ...fill].map((candidate) => ({
    ...candidate,
    ...probabilityEvidence({
      groupSize: groupSizes.get(candidate.reference_image_sha256),
      groupCount: groups.length,
      slateSize,
      remainingCount: remaining.length,
    }),
  }));
}

function deriveTemplateExplorationCycleSchedule({ selection, cycleIndex }) {
  const pool = deriveEligibleTemplateExplorationPool(selection);
  const remaining = [...pool.candidates];
  const rounds = [];
  while (remaining.length) {
    const roundIndex = rounds.length;
    const candidates = sampleTemplateExplorationRound({ pool, remaining, cycleIndex, roundIndex });
    rounds.push(candidates);
    const selectedUids = new Set(candidates.map((candidate) => candidate.template_uid));
    const next = remaining.filter((candidate) => !selectedUids.has(candidate.template_uid));
    remaining.splice(0, remaining.length, ...next);
  }
  return { pool, rounds };
}

export function deriveTemplateExplorationCycleOrder(input = {}) {
  const { selection, cycleIndex = 0 } = requireObject(input, 'Template exploration cycle-order request', {
    code: 'invalid_exploration_request',
    status: 400,
  });
  const normalizedCycleIndex = normalizeNonNegativeInteger(cycleIndex, 'cycleIndex');
  const schedule = deriveTemplateExplorationCycleSchedule({ selection, cycleIndex: normalizedCycleIndex });
  const candidates = schedule.rounds.flat();
  return deepFreeze({
    selection_id: schedule.pool.selection_id,
    policy_version: schedule.pool.policy_version,
    catalog_business_sha256: schedule.pool.catalog_business_sha256,
    eligible_pool_sha256: schedule.pool.eligible_pool_sha256,
    legacy_limited: schedule.pool.legacy_limited,
    source_kind: schedule.pool.source_kind,
    cycle_index: normalizedCycleIndex,
    candidates,
  });
}

function normalizeIdempotencyKey(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new TemplateExplorationError(
      'invalid_exploration_request',
      'idempotencyKey must contain 1-128 safe characters',
      { status: 400 },
    );
  }
  return normalized;
}

function normalizeRecordedAt(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TemplateExplorationError('invalid_exploration_request', 'recordedAt must be a nonempty timestamp string', { status: 400 });
  }
  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime())) {
    throw new TemplateExplorationError('invalid_exploration_request', 'recordedAt must be a valid timestamp', { status: 400 });
  }
  return date.toISOString();
}

function rejectCallerCandidateFields(input) {
  for (const field of FORBIDDEN_CALLER_CANDIDATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw new TemplateExplorationError(
        'caller_candidates_forbidden',
        'Caller must not supply candidate UIDs; the server-owned stored selection determines the slate',
        { status: 400 },
      );
    }
  }
}

export function createTemplateExplorationSlate(input = {}) {
  requireObject(input, 'Template exploration input', {
    code: 'invalid_exploration_request',
    status: 400,
  });
  rejectCallerCandidateFields(input);
  const cycleIndex = normalizeNonNegativeInteger(input.cycleIndex, 'cycleIndex');
  const roundIndex = normalizeNonNegativeInteger(input.roundIndex, 'roundIndex');
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const recordedAt = normalizeRecordedAt(input.recordedAt);
  const schedule = deriveTemplateExplorationCycleSchedule({ selection: input.selection, cycleIndex });
  const poolSize = schedule.pool.candidates.length;
  if (!poolSize) {
    throw new TemplateExplorationError(
      'no_safe_non_top4_alternatives',
      'Selection has no safe non-Top4 alternatives for template exploration',
      { status: 409 },
    );
  }
  const cycleRoundCount = schedule.rounds.length;
  if (roundIndex >= cycleRoundCount) {
    throw new TemplateExplorationError(
      'exploration_cycle_exhausted',
      `roundIndex is outside the current cycle; cycle ${cycleIndex} is exhausted`,
      { status: 409 },
    );
  }
  const candidates = schedule.rounds[roundIndex];
  const slateIdentity = {
    selection_id: schedule.pool.selection_id,
    policy_version: schedule.pool.policy_version,
    catalog_business_sha256: schedule.pool.catalog_business_sha256,
    eligible_pool_sha256: schedule.pool.eligible_pool_sha256,
    cycle_index: cycleIndex,
    round_index: roundIndex,
    idempotency_key: idempotencyKey,
  };
  return deepFreeze({
    schema_version: TEMPLATE_EXPLORATION_SLATE_VERSION,
    slate_id: `slate_${hashCanonicalValue(slateIdentity).slice(0, 24)}`,
    ...slateIdentity,
    recorded_at: recordedAt,
    legacy_limited: schedule.pool.legacy_limited,
    source_kind: schedule.pool.source_kind,
    pool_size: poolSize,
    cycle_round_count: cycleRoundCount,
    candidate_uids: candidates.map((candidate) => candidate.template_uid),
    candidates,
  });
}

export function buildTemplateExplorationSlatePresentedEvent(input = {}) {
  const slate = createTemplateExplorationSlate(input);
  const eventId = explorationPresentationEventId(slate);
  return deepFreeze({
    schema_version: TEMPLATE_EXPLORATION_EVENT_VERSION,
    event_id: eventId,
    selection_id: slate.selection_id,
    type: 'TemplateExplorationSlatePresented',
    recorded_at: slate.recorded_at,
    idempotency_key: slate.idempotency_key,
    data: { slate },
  });
}

function explorationPresentationEventId(slate) {
  const eventIdentity = {
    selection_id: slate.selection_id,
    type: 'TemplateExplorationSlatePresented',
    idempotency_key: slate.idempotency_key,
  };
  return `template-exploration-event_${hashCanonicalValue(eventIdentity).slice(0, 24)}`;
}

function validateStoredPresentationEvent(event, selection) {
  requireObject(event, 'TemplateExplorationSlatePresented event');
  const slate = requireObject(event.data?.slate, 'TemplateExplorationSlatePresented slate');
  if (event.schema_version !== TEMPLATE_EXPLORATION_EVENT_VERSION
    || event.type !== 'TemplateExplorationSlatePresented'
    || event.event_id !== explorationPresentationEventId(slate)
    || event.selection_id !== slate.selection_id
    || event.idempotency_key !== slate.idempotency_key
    || event.recorded_at !== slate.recorded_at) {
    throw new TemplateExplorationError(
      'exploration_event_conflict',
      'Stored TemplateExplorationSlatePresented evidence is inconsistent',
      { status: 409 },
    );
  }
  const expected = createTemplateExplorationSlate({
    selection,
    cycleIndex: slate.cycle_index,
    roundIndex: slate.round_index,
    idempotencyKey: slate.idempotency_key,
    recordedAt: slate.recorded_at,
  });
  if (hashCanonicalValue(slate) !== hashCanonicalValue(expected)) {
    throw new TemplateExplorationError(
      'exploration_event_conflict',
      'Stored TemplateExplorationSlatePresented evidence does not match the server-owned eligible pool',
      { status: 409 },
    );
  }
  return expected;
}

function nextPresentationCoordinates(slate) {
  if (slate.round_index + 1 < slate.cycle_round_count) {
    return { cycleIndex: slate.cycle_index, roundIndex: slate.round_index + 1 };
  }
  return { cycleIndex: slate.cycle_index + 1, roundIndex: 0 };
}

function validatePresentationHistory(events, selection) {
  const byIdempotencyKey = new Map();
  const uniquePresentations = [];
  for (const event of events) {
    if (event?.type !== 'TemplateExplorationSlatePresented') continue;
    const slate = validateStoredPresentationEvent(event, selection);
    const eventHash = hashCanonicalValue(event);
    const existing = byIdempotencyKey.get(event.idempotency_key);
    if (existing) {
      if (existing.eventHash !== eventHash) {
        throw new TemplateExplorationError(
          'exploration_idempotency_conflict',
          `Conflicting exploration evidence uses idempotency key: ${event.idempotency_key}`,
          { status: 409 },
        );
      }
      continue;
    }
    const presentation = { eventHash, slate };
    byIdempotencyKey.set(event.idempotency_key, presentation);
    uniquePresentations.push(presentation);
  }

  let expected = { cycleIndex: 0, roundIndex: 0 };
  for (const presentation of uniquePresentations) {
    const slate = presentation.slate;
    if (slate.cycle_index !== expected.cycleIndex || slate.round_index !== expected.roundIndex) {
      throw new TemplateExplorationError(
        'exploration_progression_conflict',
        `Stored presentation expected cycle ${expected.cycleIndex} round ${expected.roundIndex}`,
        { status: 409 },
      );
    }
    expected = nextPresentationCoordinates(slate);
  }
  return { byIdempotencyKey, expected };
}

export function resolveTemplateExplorationPresentation(input = {}) {
  requireObject(input, 'Template exploration presentation input', {
    code: 'invalid_exploration_request',
    status: 400,
  });
  rejectCallerCandidateFields(input);
  if (!Array.isArray(input.events)) {
    throw new TemplateExplorationError('invalid_exploration_request', 'events must be an array', { status: 400 });
  }
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const history = validatePresentationHistory(input.events, input.selection);
  const replay = history.byIdempotencyKey.get(idempotencyKey);
  if (replay) {
    return deepFreeze({
      slate: replay.slate,
      event: null,
      idempotent_replay: true,
    });
  }
  const cycleIndex = normalizeNonNegativeInteger(input.cycleIndex, 'cycleIndex');
  const roundIndex = normalizeNonNegativeInteger(input.roundIndex, 'roundIndex');
  normalizeRecordedAt(input.recordedAt);
  if (cycleIndex !== history.expected.cycleIndex || roundIndex !== history.expected.roundIndex) {
    throw new TemplateExplorationError(
      'exploration_progression_conflict',
      `Fresh presentation must request cycle ${history.expected.cycleIndex} round ${history.expected.roundIndex}`,
      { status: 409 },
    );
  }
  const { events, ...request } = input;
  const event = buildTemplateExplorationSlatePresentedEvent(request);
  return deepFreeze({
    slate: event.data.slate,
    event,
    idempotent_replay: false,
  });
}
