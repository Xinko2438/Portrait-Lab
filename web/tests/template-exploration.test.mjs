import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TEMPLATE_EXPLORATION_POLICY_VERSION,
  TemplateExplorationError,
  deriveEligibleTemplateExplorationPool,
  deriveTemplateExplorationCycleOrder,
  createTemplateExplorationSlate,
  buildTemplateExplorationSlatePresentedEvent,
  resolveTemplateExplorationPresentation,
} from '../src/template-exploration.mjs';

const RECORDED_AT = '2026-08-31T15:00:00.000Z';

function imageHash(index) {
  return index.toString(16).padStart(64, '0');
}

function candidate(templateUid, rank, hash = imageHash(rank), relevanceScore = 100 - rank) {
  return {
    template_uid: templateUid,
    rank,
    relevance_score: relevanceScore,
    reference_image: {
      sha256: hash,
      url: `/api/templates/${templateUid}/reference`,
    },
  };
}

function selectionWithAlternatives({
  alternativeCount = 8,
  alternativeHashes = [],
  legacy = false,
  overrides = {},
} = {}) {
  const topCandidates = [
    candidate('tpl_top_1', 1),
    candidate('tpl_top_2', 2),
    candidate('tpl_top_3', 3),
    candidate('tpl_top_4', 5),
  ];
  const alternativeRanks = alternativeCount > 0
    ? [4, ...Array.from({ length: alternativeCount - 1 }, (_, index) => index + 6)]
    : [];
  const alternatives = alternativeRanks.map((rank, index) => candidate(
    `tpl_alt_${index + 1}`,
    rank,
    alternativeHashes[index] ?? imageHash(rank + 100),
    90 - index - 0.25,
  ));
  const rankedCandidates = [...topCandidates, ...alternatives]
    .sort((left, right) => left.rank - right.rank || left.template_uid.localeCompare(right.template_uid));
  const selection = {
    selection_id: `sel_${'1'.repeat(24)}`,
    catalog_business_sha256: 'a'.repeat(64),
    top4: topCandidates.map((item, index) => ({ ...item, rank: index + 1 })),
    top10: rankedCandidates.slice(0, 10),
    ...overrides,
  };
  if (!legacy) selection.ranked_candidates = rankedCandidates;
  return selection;
}

function slateInput(selection, roundIndex = 0, cycleIndex = 0, idempotencyKey = `exploration-${cycleIndex}-${roundIndex}`) {
  return {
    selection,
    cycleIndex,
    roundIndex,
    idempotencyKey,
    recordedAt: RECORDED_AT,
  };
}

function assertExplorationError(action, code, status) {
  let error;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof TemplateExplorationError);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  return error;
}

test('same stored evidence and idempotency identity replay to one byte-stable slate and event', () => {
  assert.equal(TEMPLATE_EXPLORATION_POLICY_VERSION, 'template-exploration-v1');
  assert.equal(typeof createTemplateExplorationSlate, 'function');
  assert.equal(typeof buildTemplateExplorationSlatePresentedEvent, 'function');
  const selection = selectionWithAlternatives();

  const first = createTemplateExplorationSlate(slateInput(selection));
  const replay = createTemplateExplorationSlate(slateInput(structuredClone(selection)));
  const firstEvent = buildTemplateExplorationSlatePresentedEvent(slateInput(selection));
  const replayEvent = buildTemplateExplorationSlatePresentedEvent(slateInput(structuredClone(selection)));

  assert.deepEqual(replay, first);
  assert.equal(JSON.stringify(replay), JSON.stringify(first));
  assert.deepEqual(replayEvent, firstEvent);
  assert.equal(firstEvent.type, 'TemplateExplorationSlatePresented');
  assert.deepEqual(firstEvent.data.slate, first);
  assert.match(first.slate_id, /^slate_[a-f0-9]{24}$/);
  assert.equal(first.selection_id, selection.selection_id);
  assert.equal(first.policy_version, TEMPLATE_EXPLORATION_POLICY_VERSION);
  assert.equal(first.idempotency_key, 'exploration-0-0');
});

test('eligible pool excludes Top4 by UID while preserving each remaining original rank, score, UID, and image hash', () => {
  assert.equal(typeof deriveEligibleTemplateExplorationPool, 'function');
  const selection = selectionWithAlternatives({ alternativeCount: 5 });
  const pool = deriveEligibleTemplateExplorationPool(selection);
  const top4Uids = new Set(selection.top4.map((item) => item.template_uid));

  assert.equal(pool.legacy_limited, false);
  assert.equal(pool.source_kind, 'ranked_candidates');
  assert.equal(pool.candidates.length, 5);
  assert.equal(pool.candidates.some((item) => top4Uids.has(item.template_uid)), false);
  assert.deepEqual(pool.candidates[0], {
    template_uid: 'tpl_alt_1',
    rank: 4,
    relevance_score: 89.75,
    reference_image_sha256: imageHash(104),
  });
  assert.match(pool.eligible_pool_sha256, /^[a-f0-9]{64}$/);
});

test('all rounds in one cycle expose every eligible UID once before exhaustion', () => {
  const selection = selectionWithAlternatives({ alternativeCount: 9 });
  const pool = deriveEligibleTemplateExplorationPool(selection);
  const slates = [0, 1, 2].map((roundIndex) => (
    createTemplateExplorationSlate(slateInput(selection, roundIndex))
  ));
  const presented = slates.flatMap((slate) => slate.candidate_uids);

  assert.deepEqual(slates.map((slate) => slate.candidates.length), [4, 4, 1]);
  assert.equal(new Set(presented).size, presented.length);
  assert.deepEqual([...presented].sort(), pool.candidates.map((item) => item.template_uid).sort());
  assert.throws(
    () => createTemplateExplorationSlate(slateInput(selection, 3)),
    /cycle.*exhaust|round.*range/i,
  );
});

test('cycle index deterministically changes order without changing eligible membership', () => {
  assert.equal(typeof deriveTemplateExplorationCycleOrder, 'function');
  const selection = selectionWithAlternatives({ alternativeCount: 8 });
  const first = deriveTemplateExplorationCycleOrder({ selection, cycleIndex: 0 });
  const repeated = deriveTemplateExplorationCycleOrder({ selection: structuredClone(selection), cycleIndex: 0 });
  const next = deriveTemplateExplorationCycleOrder({ selection, cycleIndex: 1 });

  assert.deepEqual(repeated, first);
  assert.notDeepEqual(
    next.candidates.map((item) => item.template_uid),
    first.candidates.map((item) => item.template_uid),
  );
  assert.deepEqual(
    next.candidates.map((item) => item.template_uid).sort(),
    first.candidates.map((item) => item.template_uid).sort(),
  );
});

test('insufficient pools return only what exists and an empty non-Top4 pool is explicit', () => {
  const oneAlternative = selectionWithAlternatives({ alternativeCount: 1 });
  const slate = createTemplateExplorationSlate(slateInput(oneAlternative));

  assert.deepEqual(slate.candidate_uids, ['tpl_alt_1']);
  assert.equal(slate.candidates[0].inclusion_probability, 1);
  assert.throws(
    () => createTemplateExplorationSlate(slateInput(selectionWithAlternatives({ alternativeCount: 0 }))),
    /no safe non-Top4|no eligible|empty/i,
  );
});

test('a slate prefers four distinct image hashes when the remaining UID pool permits', () => {
  const duplicateHash = 'b'.repeat(64);
  const selection = selectionWithAlternatives({
    alternativeCount: 5,
    alternativeHashes: [duplicateHash, duplicateHash, 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)],
  });
  const slate = createTemplateExplorationSlate(slateInput(selection));

  assert.equal(slate.candidates.length, 4);
  assert.equal(new Set(slate.candidates.map((item) => item.reference_image_sha256)).size, 4);
});

test('legacy selection falls back only to stored non-Top4 Top10 and declares bounded legacy behavior', () => {
  const unsafeExtra = candidate('tpl_unsafe_from_catalog', 99, 'f'.repeat(64), 99);
  const selection = selectionWithAlternatives({
    alternativeCount: 9,
    legacy: true,
    overrides: {
      catalog_templates: [unsafeExtra],
      filter_results: [{ template_uid: unsafeExtra.template_uid, eligible: false }],
    },
  });
  const pool = deriveEligibleTemplateExplorationPool(selection);
  const slate = createTemplateExplorationSlate(slateInput(selection));

  assert.equal(pool.legacy_limited, true);
  assert.equal(pool.source_kind, 'legacy_non_top4_top10');
  assert.equal(pool.candidates.length, 6);
  assert.equal(pool.candidates.some((item) => item.template_uid === unsafeExtra.template_uid), false);
  assert.equal(slate.legacy_limited, true);
  assert.equal(slate.candidates.every((item) => selection.top10.some((candidateItem) => candidateItem.template_uid === item.template_uid)), true);
});

test('complete selections never relax hard filters by supplementing ranked candidates from Top10, filters, or catalog fields', () => {
  const selection = selectionWithAlternatives({ alternativeCount: 2 });
  const forged = candidate('tpl_forged_unsafe', 99, 'f'.repeat(64), 100);
  selection.top10 = [...selection.top10, forged];
  selection.filter_results = [{ template_uid: forged.template_uid, eligible: true }];
  selection.catalog_templates = [forged];
  selection.all_templates = [forged];

  const pool = deriveEligibleTemplateExplorationPool(selection);

  assert.deepEqual(
    pool.candidates.map((item) => item.template_uid).sort(),
    ['tpl_alt_1', 'tpl_alt_2'],
  );
});

test('caller-supplied candidate UIDs are rejected and inclusion probabilities remain bounded evidence', () => {
  const selection = selectionWithAlternatives({ alternativeCount: 7 });
  assert.throws(
    () => createTemplateExplorationSlate({
      ...slateInput(selection),
      candidate_uids: ['tpl_forged_unsafe'],
    }),
    /caller.*candidate|candidate.*forbidden|must not supply/i,
  );

  const slate = createTemplateExplorationSlate(slateInput(selection));
  assert.equal(slate.candidates.length, 4);
  for (const item of slate.candidates) {
    assert.ok(item.inclusion_probability > 0 && item.inclusion_probability <= 1);
    assert.equal(item.inclusion_probability, 4 / 7);
  }
});

test('presentation resolver replays an existing idempotency key without advancing and rejects conflicting stored evidence', () => {
  assert.equal(typeof resolveTemplateExplorationPresentation, 'function');
  const selection = selectionWithAlternatives({ alternativeCount: 8 });
  const originalInput = slateInput(selection, 0, 0, 'exploration-replay');
  const originalEvent = buildTemplateExplorationSlatePresentedEvent(originalInput);
  const replay = resolveTemplateExplorationPresentation({
    ...slateInput(selection, 1, 0, 'exploration-replay'),
    recordedAt: '2026-08-31T16:00:00.000Z',
    events: [originalEvent],
  });

  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.event, null);
  assert.deepEqual(replay.slate, originalEvent.data.slate);

  const fresh = resolveTemplateExplorationPresentation({
    ...slateInput(selection, 1, 0, 'exploration-fresh'),
    events: [originalEvent],
  });
  assert.equal(fresh.idempotent_replay, false);
  assert.equal(fresh.event.type, 'TemplateExplorationSlatePresented');
  assert.deepEqual(fresh.slate, fresh.event.data.slate);

  const conflict = buildTemplateExplorationSlatePresentedEvent(
    slateInput(selection, 1, 0, 'exploration-replay'),
  );
  assert.throws(
    () => resolveTemplateExplorationPresentation({
      ...slateInput(selection, 0, 0, 'exploration-replay'),
      events: [originalEvent, conflict],
    }),
    /idempotency.*conflict|conflicting.*evidence/i,
  );
});

test('presentation resolver deduplicates exact replays and permits only the single next cycle-round', () => {
  const selection = selectionWithAlternatives({ alternativeCount: 9 });
  const firstEvent = buildTemplateExplorationSlatePresentedEvent(
    slateInput(selection, 0, 0, 'progress-first'),
  );
  const exactReplay = structuredClone(firstEvent);
  const next = resolveTemplateExplorationPresentation({
    ...slateInput(selection, 1, 0, 'progress-next'),
    events: [firstEvent, exactReplay],
  });

  assert.equal(next.idempotent_replay, false);
  assert.equal(next.slate.cycle_index, 0);
  assert.equal(next.slate.round_index, 1);

  const sameKeyReplay = resolveTemplateExplorationPresentation({
    ...slateInput(selection, 2, 0, 'progress-first'),
    recordedAt: '2026-08-31T18:00:00.000Z',
    events: [firstEvent, exactReplay],
  });
  assert.equal(sameKeyReplay.idempotent_replay, true);
  assert.deepEqual(sameKeyReplay.slate, firstEvent.data.slate);

  const invalidFreshRequests = [
    slateInput(selection, 0, 0, 'duplicate-round-new-key'),
    slateInput(selection, 2, 0, 'skipped-round'),
    slateInput(selection, 0, 1, 'jumped-cycle'),
  ];
  for (const request of invalidFreshRequests) {
    assertExplorationError(
      () => resolveTemplateExplorationPresentation({ ...request, events: [firstEvent, exactReplay] }),
      'exploration_progression_conflict',
      409,
    );
  }
});

test('the first round of a new cycle is the only valid successor after the prior cycle is exhausted', () => {
  const selection = selectionWithAlternatives({ alternativeCount: 5 });
  const firstEvent = buildTemplateExplorationSlatePresentedEvent(
    slateInput(selection, 0, 0, 'cycle-finish-0'),
  );
  const lastEvent = buildTemplateExplorationSlatePresentedEvent(
    slateInput(selection, 1, 0, 'cycle-finish-1'),
  );
  const nextCycle = resolveTemplateExplorationPresentation({
    ...slateInput(selection, 0, 1, 'cycle-next-0'),
    events: [firstEvent, lastEvent],
  });

  assert.equal(nextCycle.slate.cycle_index, 1);
  assert.equal(nextCycle.slate.round_index, 0);
});

test('resolver validates progression across every stored presentation before handling a new key', () => {
  const selection = selectionWithAlternatives({ alternativeCount: 9 });
  const firstEvent = buildTemplateExplorationSlatePresentedEvent(
    slateInput(selection, 0, 0, 'stored-first'),
  );
  const skippedEvent = buildTemplateExplorationSlatePresentedEvent(
    slateInput(selection, 2, 0, 'stored-skipped'),
  );

  assertExplorationError(
    () => resolveTemplateExplorationPresentation({
      ...slateInput(selection, 1, 0, 'new-after-bad-history'),
      events: [firstEvent, skippedEvent],
    }),
    'exploration_progression_conflict',
    409,
  );
});

test('duplicate-image policy records unequal group-aware nominal inclusion probabilities', () => {
  const duplicateHash = 'b'.repeat(64);
  const uniqueHash = 'c'.repeat(64);
  const selection = selectionWithAlternatives({
    alternativeCount: 5,
    alternativeHashes: [duplicateHash, duplicateHash, duplicateHash, duplicateHash, uniqueHash],
  });
  const slate = createTemplateExplorationSlate(slateInput(selection));
  const uniqueCandidate = slate.candidates.find((item) => item.reference_image_sha256 === uniqueHash);
  const duplicateCandidates = slate.candidates.filter((item) => item.reference_image_sha256 === duplicateHash);

  assert.ok(uniqueCandidate);
  assert.equal(duplicateCandidates.length, 3);
  assert.equal(uniqueCandidate.inclusion_probability, 1);
  assert.equal(uniqueCandidate.inclusion_probability_components.group_selection, 1);
  assert.equal(uniqueCandidate.inclusion_probability_components.member_selection, 1);
  assert.equal(uniqueCandidate.inclusion_probability_components.fill_selection, 0);
  for (const item of duplicateCandidates) {
    assert.equal(item.inclusion_probability, 0.75);
    assert.equal(item.inclusion_probability_components.group_selection, 1);
    assert.equal(item.inclusion_probability_components.member_selection, 0.25);
    assert.equal(item.inclusion_probability_components.fill_selection, 2 / 3);
  }
});

test('pool derivation fails closed on malformed Top4 and ranked-source evidence', () => {
  const duplicateTop4 = selectionWithAlternatives();
  duplicateTop4.top4[1].template_uid = duplicateTop4.top4[0].template_uid;

  const emptyTop4 = selectionWithAlternatives();
  emptyTop4.top4 = [];

  const oversizedTop4 = selectionWithAlternatives();
  oversizedTop4.top4.push(candidate('tpl_top_5', 5));

  const truncatedTop4 = selectionWithAlternatives();
  truncatedTop4.top4 = truncatedTop4.top4.slice(0, 3);

  const truncatedSmallTop4 = selectionWithAlternatives();
  truncatedSmallTop4.ranked_candidates = truncatedSmallTop4.ranked_candidates.slice(0, 2);
  truncatedSmallTop4.top10 = truncatedSmallTop4.ranked_candidates;
  truncatedSmallTop4.top4 = truncatedSmallTop4.top4.slice(0, 1);

  const missingTop4Source = selectionWithAlternatives();
  missingTop4Source.top4[0].template_uid = 'tpl_not_in_source';

  const duplicateSourceRank = selectionWithAlternatives();
  duplicateSourceRank.ranked_candidates[5].rank = duplicateSourceRank.ranked_candidates[4].rank;

  const coercedSourceRank = selectionWithAlternatives();
  coercedSourceRank.ranked_candidates[4].rank = '50';

  const coercedRelevanceScore = selectionWithAlternatives();
  coercedRelevanceScore.ranked_candidates[4].relevance_score = '80';

  for (const malformed of [
    duplicateTop4,
    emptyTop4,
    oversizedTop4,
    truncatedTop4,
    truncatedSmallTop4,
    missingTop4Source,
    duplicateSourceRank,
    coercedSourceRank,
    coercedRelevanceScore,
  ]) {
    assertExplorationError(
      () => deriveEligibleTemplateExplorationPool(malformed),
      'invalid_exploration_evidence',
      422,
    );
  }
});

test('stored event identity must match the deterministic event identity', () => {
  const selection = selectionWithAlternatives();
  const event = structuredClone(buildTemplateExplorationSlatePresentedEvent(
    slateInput(selection, 0, 0, 'tampered-event-id'),
  ));
  event.event_id = `template-exploration-event_${'0'.repeat(24)}`;

  assertExplorationError(
    () => resolveTemplateExplorationPresentation({
      ...slateInput(selection, 0, 0, 'tampered-event-id'),
      events: [event],
    }),
    'exploration_event_conflict',
    409,
  );
});

test('persisted slate creation requires explicit typed cycle, round, idempotency key, and recordedAt', () => {
  const selection = selectionWithAlternatives();
  const valid = slateInput(selection);
  const invalidInputs = [
    { ...valid, cycleIndex: undefined },
    { ...valid, cycleIndex: true },
    { ...valid, cycleIndex: '' },
    { ...valid, cycleIndex: null },
    { ...valid, roundIndex: undefined },
    { ...valid, roundIndex: false },
    { ...valid, roundIndex: '' },
    { ...valid, roundIndex: null },
    { ...valid, idempotencyKey: undefined },
    { ...valid, idempotencyKey: '' },
    { ...valid, recordedAt: undefined },
    { ...valid, recordedAt: '' },
    { ...valid, recordedAt: null },
    { ...valid, recordedAt: new Date(RECORDED_AT) },
  ];

  for (const input of invalidInputs) {
    assertExplorationError(
      () => createTemplateExplorationSlate(input),
      'invalid_exploration_request',
      400,
    );
  }

  const pureOrder = deriveTemplateExplorationCycleOrder({ selection });
  assert.equal(pureOrder.cycle_index, 0);
});

test('root request container type errors are 400 while nested stored selection evidence stays 422', () => {
  const rootRequestFailures = [
    () => createTemplateExplorationSlate(null),
    () => createTemplateExplorationSlate([]),
    () => buildTemplateExplorationSlatePresentedEvent(null),
    () => resolveTemplateExplorationPresentation(null),
    () => resolveTemplateExplorationPresentation([]),
    () => deriveTemplateExplorationCycleOrder(null),
  ];
  for (const action of rootRequestFailures) {
    assertExplorationError(action, 'invalid_exploration_request', 400);
  }

  const valid = slateInput(selectionWithAlternatives());
  const storedEvidenceFailures = [
    () => deriveEligibleTemplateExplorationPool(null),
    () => deriveEligibleTemplateExplorationPool([]),
    () => createTemplateExplorationSlate({ ...valid, selection: null }),
    () => resolveTemplateExplorationPresentation({ ...valid, selection: null, events: [] }),
  ];
  for (const action of storedEvidenceFailures) {
    assertExplorationError(action, 'invalid_exploration_evidence', 422);
  }
});
