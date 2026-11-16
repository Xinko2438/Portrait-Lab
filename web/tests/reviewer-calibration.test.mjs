import test from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  appendFile,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CALIBRATION_ANCHOR_SET_VERSION,
  REVIEWER_CALIBRATION_PROJECTION_VERSION,
  REVIEWER_CALIBRATION_SESSION_VERSION,
  buildCalibrationAnchorSetEvent,
  buildReviewerCalibrationSessionEvent,
  normalizeCalibrationAnchorSet,
  normalizeReviewerCalibrationSession,
  projectReviewerCalibration,
} from '../src/intelligent-workbench/reviewer-calibration.mjs';
import {
  appendReviewerCalibrationEvent,
  loadReviewerCalibrationProjection,
  rebuildReviewerCalibrationProjection,
} from '../src/intelligent-workbench/reviewer-calibration-store.mjs';

const RUBRIC_V1 = 'portrait-review-v3-three-score-diagnostics-20260816';
const DAY_MS = 24 * 60 * 60 * 1000;
const SCORE_FIELDS = [
  'face_identity_fidelity',
  'realism_naturalness',
  'style_consistency',
];

function scores(face, realism, style) {
  return {
    face_identity_fidelity: face,
    realism_naturalness: realism,
    style_consistency: style,
  };
}

function anchorSetInput(overrides = {}) {
  return {
    version: 1,
    rubric_version: RUBRIC_V1,
    anchors: [
      {
        anchor_id: 'anchor-c',
        asset_sha256: 'c'.repeat(64),
        source_scope: 'non_customer_authorized',
        baseline_scores: scores(9, 9, 9),
      },
      {
        anchor_id: 'anchor-a',
        asset_sha256: 'a'.repeat(64),
        source_scope: 'global_identity_neutral',
        baseline_scores: scores(8, 8, 8),
      },
      {
        anchor_id: 'anchor-b',
        asset_sha256: 'b'.repeat(64),
        source_scope: 'global_identity_neutral',
        baseline_scores: scores(7, 7, 7),
      },
    ],
    approval: {
      approved_by: 'calibration-owner',
      approved_at: '2026-01-01T00:00:00.000Z',
      note: 'Approved non-customer calibration fixtures.',
    },
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function sessionInput(anchorSet, {
  reviewerId = 'reviewer-01',
  recordedAt = '2026-02-01T00:00:00.000Z',
  ratings,
  ...overrides
} = {}) {
  return {
    reviewer_id: reviewerId,
    anchor_set_id: anchorSet.anchor_set_id,
    anchor_set_version: anchorSet.version,
    rubric_version: anchorSet.rubric_version,
    ratings: ratings ?? [
      { anchor_id: 'anchor-b', scores: scores(6, 7.5, 8) },
      { anchor_id: 'anchor-c', scores: scores(9, 7.5, 10) },
      { anchor_id: 'anchor-a', scores: scores(8.5, 7, 8) },
    ],
    recorded_at: recordedAt,
    ...overrides,
  };
}

function withoutRebuildTime(projection) {
  const copy = structuredClone(projection);
  delete copy.rebuilt_at;
  return copy;
}

async function rejectsAccess(path) {
  await assert.rejects(access(path), (error) => error?.code === 'ENOENT');
}

test('anchor set normalizes deterministic identity-neutral evidence and stable content identity', () => {
  const first = normalizeCalibrationAnchorSet(anchorSetInput());
  const reordered = normalizeCalibrationAnchorSet({
    ...anchorSetInput(),
    anchors: [...anchorSetInput().anchors].reverse(),
  });

  assert.equal(CALIBRATION_ANCHOR_SET_VERSION, 'ai-img-gen.calibration-anchor-set.v1');
  assert.equal(first.schema_version, CALIBRATION_ANCHOR_SET_VERSION);
  assert.match(first.anchor_set_id, /^calibration-anchor-set_[a-f0-9]{24}$/);
  assert.equal(first.anchor_set_id, reordered.anchor_set_id);
  assert.deepEqual(first.anchors.map((anchor) => anchor.anchor_id), ['anchor-a', 'anchor-b', 'anchor-c']);
  assert.deepEqual(first.anchors[0].baseline_scores, scores(8, 8, 8));
});

test('anchor set rejects insufficient, malformed, imprecise, or duplicate evidence', () => {
  assert.throws(
    () => normalizeCalibrationAnchorSet({ ...anchorSetInput(), anchors: anchorSetInput().anchors.slice(0, 2) }),
    /at least 3/i,
  );
  assert.throws(
    () => normalizeCalibrationAnchorSet({
      ...anchorSetInput(),
      anchors: anchorSetInput().anchors.map((anchor, index) => (
        index === 0 ? { ...anchor, asset_sha256: 'not-a-hash' } : anchor
      )),
    }),
    /sha-256/i,
  );
  assert.throws(
    () => normalizeCalibrationAnchorSet({
      ...anchorSetInput(),
      anchors: anchorSetInput().anchors.map((anchor, index) => (
        index === 0
          ? { ...anchor, baseline_scores: { ...anchor.baseline_scores, realism_naturalness: 8.11 } }
          : anchor
      )),
    }),
    /one decimal/i,
  );
  assert.throws(
    () => normalizeCalibrationAnchorSet({
      ...anchorSetInput(),
      anchors: anchorSetInput().anchors.map((anchor, index) => (
        index === 2 ? { ...anchor, anchor_id: 'anchor-a' } : anchor
      )),
    }),
    /duplicate anchor_id/i,
  );
  assert.throws(() => normalizeCalibrationAnchorSet({ ...anchorSetInput(), version: 0 }), /positive integer/i);
  assert.throws(
    () => normalizeCalibrationAnchorSet({ ...anchorSetInput(), approval: { approved_by: '', approved_at: '' } }),
    /approved_by/i,
  );
});

test('anchor set rejects every customer-scoped identity path', () => {
  assert.throws(
    () => normalizeCalibrationAnchorSet({ ...anchorSetInput(), customer_id: 'customer-01' }),
    /customer-scoped/i,
  );
  assert.throws(
    () => normalizeCalibrationAnchorSet({
      ...anchorSetInput(),
      anchors: anchorSetInput().anchors.map((anchor, index) => (
        index === 0 ? { ...anchor, customer_id: 'customer-01' } : anchor
      )),
    }),
    /customer-scoped/i,
  );
  assert.throws(
    () => normalizeCalibrationAnchorSet({
      ...anchorSetInput(),
      anchors: anchorSetInput().anchors.map((anchor, index) => (
        index === 0 ? { ...anchor, source_scope: 'customer_scoped' } : anchor
      )),
    }),
    /source_scope/i,
  );
});

test('anchor event has a stable payload and idempotency identity independent of event time', () => {
  const early = buildCalibrationAnchorSetEvent(anchorSetInput(), { occurredAt: '2026-01-02T00:00:00Z' });
  const later = buildCalibrationAnchorSetEvent(anchorSetInput(), { occurredAt: '2026-01-03T00:00:00Z' });

  assert.equal(early.type, 'CalibrationAnchorSetDefined');
  assert.equal(early.idempotency_key, later.idempotency_key);
  assert.equal(early.event_id, later.event_id);
  assert.deepEqual(early.data, later.data);
  assert.notEqual(early.occurred_at, later.occurred_at);
});

test('session requires an exact complete anchor rating set and computes literal absolute deviations', () => {
  const anchorSet = normalizeCalibrationAnchorSet(anchorSetInput());
  const session = normalizeReviewerCalibrationSession(sessionInput(anchorSet), { anchorSet });

  assert.equal(REVIEWER_CALIBRATION_SESSION_VERSION, 'ai-img-gen.reviewer-calibration-session.v1');
  assert.equal(session.schema_version, REVIEWER_CALIBRATION_SESSION_VERSION);
  assert.match(session.session_id, /^reviewer-calibration_[a-f0-9]{24}$/);
  assert.deepEqual(session.ratings.map((rating) => rating.anchor_id), ['anchor-a', 'anchor-b', 'anchor-c']);
  assert.deepEqual(session.deviations, [
    { anchor_id: 'anchor-a', absolute_deviation: scores(0.5, 1, 0) },
    { anchor_id: 'anchor-b', absolute_deviation: scores(1, 0.5, 1) },
    { anchor_id: 'anchor-c', absolute_deviation: scores(0, 1.5, 1) },
  ]);
  assert.deepEqual(session.median_absolute_deviation, scores(0.5, 1, 1));
});

test('session rejects mismatched anchor metadata, missing/extra/duplicate anchors, and score precision violations', () => {
  const anchorSet = normalizeCalibrationAnchorSet(anchorSetInput());
  assert.throws(
    () => normalizeReviewerCalibrationSession(sessionInput(anchorSet, { anchor_set_id: 'wrong' }), { anchorSet }),
    /anchor_set_id/i,
  );
  assert.throws(
    () => normalizeReviewerCalibrationSession(sessionInput(anchorSet, { rubric_version: 'wrong-rubric' }), { anchorSet }),
    /rubric_version/i,
  );
  assert.throws(
    () => normalizeReviewerCalibrationSession(sessionInput(anchorSet, {
      ratings: sessionInput(anchorSet).ratings.slice(0, 2),
    }), { anchorSet }),
    /exactly one rating/i,
  );
  assert.throws(
    () => normalizeReviewerCalibrationSession(sessionInput(anchorSet, {
      ratings: [
        ...sessionInput(anchorSet).ratings,
        { anchor_id: 'anchor-extra', scores: scores(8, 8, 8) },
      ],
    }), { anchorSet }),
    /exactly one rating/i,
  );
  assert.throws(
    () => normalizeReviewerCalibrationSession(sessionInput(anchorSet, {
      ratings: sessionInput(anchorSet).ratings.map((rating, index) => (
        index === 2 ? { ...rating, anchor_id: 'anchor-b' } : rating
      )),
    }), { anchorSet }),
    /duplicate anchor_id/i,
  );
  assert.throws(
    () => normalizeReviewerCalibrationSession(sessionInput(anchorSet, {
      ratings: sessionInput(anchorSet).ratings.map((rating, index) => (
        index === 0 ? { ...rating, scores: { ...rating.scores, style_consistency: 9.99 } } : rating
      )),
    }), { anchorSet }),
    /one decimal/i,
  );
});

test('session content identity and event idempotency are stable across rating input order', () => {
  const anchorSet = normalizeCalibrationAnchorSet(anchorSetInput());
  const input = sessionInput(anchorSet);
  const first = normalizeReviewerCalibrationSession(input, { anchorSet });
  const reordered = normalizeReviewerCalibrationSession({ ...input, ratings: [...input.ratings].reverse() }, { anchorSet });
  const event = buildReviewerCalibrationSessionEvent(input, {
    anchorSet,
    occurredAt: '2026-02-01T01:00:00Z',
  });

  assert.equal(first.session_id, reordered.session_id);
  assert.equal(event.type, 'ReviewerCalibrationRecorded');
  assert.equal(event.data.session.session_id, first.session_id);
  assert.match(event.idempotency_key, /^ReviewerCalibrationRecorded:[a-f0-9]{64}$/);
});

test('projection is not configured without an approved anchor event', () => {
  const projection = projectReviewerCalibration([], {
    rubricVersion: RUBRIC_V1,
    now: '2026-02-01T00:00:00Z',
  });

  assert.equal(REVIEWER_CALIBRATION_PROJECTION_VERSION, 'ai-img-gen.reviewer-calibration-projection.v1');
  assert.deepEqual(projection, {
    schema_version: REVIEWER_CALIBRATION_PROJECTION_VERSION,
    status: 'not_configured',
    active_anchor_set: null,
    latest_session: null,
    median_absolute_deviation: null,
    valid_until: null,
    rebuilt_at: '2026-02-01T00:00:00.000Z',
  });
});

test('projection treats exactly 30 days and deviation 1.0 as calibrated, then expires one millisecond later', () => {
  const anchorSet = normalizeCalibrationAnchorSet(anchorSetInput());
  const anchorEvent = buildCalibrationAnchorSetEvent(anchorSet, { occurredAt: '2026-01-01T00:00:00Z' });
  const recordedAt = '2026-02-01T00:00:00.000Z';
  const equalThresholdRatings = anchorSet.anchors.map((anchor) => ({
    anchor_id: anchor.anchor_id,
    scores: Object.fromEntries(SCORE_FIELDS.map((field) => [field, anchor.baseline_scores[field] - 1])),
  }));
  const sessionEvent = buildReviewerCalibrationSessionEvent(
    sessionInput(anchorSet, { recordedAt, ratings: equalThresholdRatings }),
    { anchorSet, occurredAt: recordedAt },
  );
  const exactBoundary = new Date(Date.parse(recordedAt) + 30 * DAY_MS).toISOString();

  const calibrated = projectReviewerCalibration([sessionEvent, anchorEvent], {
    rubricVersion: RUBRIC_V1,
    now: exactBoundary,
  });
  const expired = projectReviewerCalibration([anchorEvent, sessionEvent], {
    rubricVersion: RUBRIC_V1,
    now: new Date(Date.parse(exactBoundary) + 1).toISOString(),
  });

  assert.equal(calibrated.status, 'calibrated');
  assert.deepEqual(calibrated.median_absolute_deviation, scores(1, 1, 1));
  assert.equal(calibrated.valid_until, exactBoundary);
  assert.equal(expired.status, 'stale');
});

test('projection marks rubric changes or missing sessions stale before considering drift', () => {
  const anchorSet = normalizeCalibrationAnchorSet(anchorSetInput());
  const anchorEvent = buildCalibrationAnchorSetEvent(anchorSet, { occurredAt: '2026-01-01T00:00:00Z' });
  const sessionEvent = buildReviewerCalibrationSessionEvent(sessionInput(anchorSet), {
    anchorSet,
    occurredAt: '2026-02-01T00:00:00Z',
  });

  assert.equal(projectReviewerCalibration([anchorEvent], {
    rubricVersion: RUBRIC_V1,
    now: '2026-02-02T00:00:00Z',
  }).status, 'stale');
  assert.equal(projectReviewerCalibration([anchorEvent, sessionEvent], {
    rubricVersion: 'portrait-review-v4',
    now: '2026-02-02T00:00:00Z',
  }).status, 'stale');
});

test('projection detects drift only when any median absolute deviation is greater than 1.0', () => {
  const anchorSet = normalizeCalibrationAnchorSet(anchorSetInput());
  const anchorEvent = buildCalibrationAnchorSetEvent(anchorSet, { occurredAt: '2026-01-01T00:00:00Z' });
  const driftRatings = anchorSet.anchors.map((anchor) => ({
    anchor_id: anchor.anchor_id,
    scores: {
      ...anchor.baseline_scores,
      style_consistency: anchor.baseline_scores.style_consistency - 1.1,
    },
  }));
  const sessionEvent = buildReviewerCalibrationSessionEvent(
    sessionInput(anchorSet, { ratings: driftRatings }),
    { anchorSet, occurredAt: '2026-02-01T00:00:00Z' },
  );
  const projection = projectReviewerCalibration([anchorEvent, sessionEvent], {
    rubricVersion: RUBRIC_V1,
    now: '2026-02-02T00:00:00Z',
  });

  assert.equal(projection.status, 'drift_detected');
  assert.deepEqual(projection.median_absolute_deviation, scores(0, 0, 1.1));
});

test('event ordering and exact duplicate input do not change projected business state', () => {
  const anchorSet = normalizeCalibrationAnchorSet(anchorSetInput());
  const anchorEvent = buildCalibrationAnchorSetEvent(anchorSet, { occurredAt: '2026-01-01T00:00:00Z' });
  const older = buildReviewerCalibrationSessionEvent(sessionInput(anchorSet, {
    recordedAt: '2026-01-15T00:00:00Z',
    ratings: anchorSet.anchors.map((anchor) => ({ anchor_id: anchor.anchor_id, scores: anchor.baseline_scores })),
  }), { anchorSet, occurredAt: '2026-01-15T00:00:00Z' });
  const latest = buildReviewerCalibrationSessionEvent(sessionInput(anchorSet), {
    anchorSet,
    occurredAt: '2026-02-01T00:00:00Z',
  });
  const now = '2026-02-02T00:00:00Z';

  const forward = projectReviewerCalibration([anchorEvent, older, latest], { rubricVersion: RUBRIC_V1, now });
  const noisy = projectReviewerCalibration([latest, anchorEvent, latest, older, anchorEvent], { rubricVersion: RUBRIC_V1, now });
  assert.deepEqual(withoutRebuildTime(noisy), withoutRebuildTime(forward));
  assert.equal(noisy.latest_session.session_id, latest.data.session.session_id);
});

test('read-only load on a missing store returns not_configured and performs zero writes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reviewer-calibration-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const projection = await loadReviewerCalibrationProjection({
    root,
    rubricVersion: RUBRIC_V1,
    now: '2026-02-02T00:00:00Z',
  });

  assert.equal(projection.status, 'not_configured');
  await rejectsAccess(join(root, 'data'));
});

test('store appends events, replays same content idempotently, rejects conflicts, and rebuilds projection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reviewer-calibration-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const anchorSet = normalizeCalibrationAnchorSet(anchorSetInput());
  const anchorEvent = buildCalibrationAnchorSetEvent(anchorSet, { occurredAt: '2026-01-01T00:00:00Z' });
  const sessionEvent = buildReviewerCalibrationSessionEvent(sessionInput(anchorSet), {
    anchorSet,
    occurredAt: '2026-02-01T00:00:00Z',
  });
  const eventsPath = join(root, 'data', 'reviewer-calibration', 'events.jsonl');
  const projectionPath = join(root, 'data', 'reviewer-calibration', 'projection.json');

  assert.equal((await appendReviewerCalibrationEvent({
    root,
    event: anchorEvent,
    rubricVersion: RUBRIC_V1,
    now: '2026-02-02T00:00:00Z',
  })).status, 'stale');
  assert.equal((await appendReviewerCalibrationEvent({
    root,
    event: sessionEvent,
    rubricVersion: RUBRIC_V1,
    now: '2026-02-02T00:00:00Z',
  })).status, 'calibrated');

  const beforeReplay = await readFile(eventsPath, 'utf8');
  await appendReviewerCalibrationEvent({
    root,
    event: sessionEvent,
    rubricVersion: RUBRIC_V1,
    now: '2026-02-02T00:00:00Z',
  });
  assert.equal(await readFile(eventsPath, 'utf8'), beforeReplay);

  const conflicting = structuredClone(sessionEvent);
  conflicting.data.session.reviewer_id = 'different-reviewer';
  await assert.rejects(
    appendReviewerCalibrationEvent({
      root,
      event: conflicting,
      rubricVersion: RUBRIC_V1,
      now: '2026-02-02T00:00:00Z',
    }),
    (error) => error?.code === 'idempotency_conflict' && error?.status === 409,
  );
  assert.equal(await readFile(eventsPath, 'utf8'), beforeReplay);

  const storedProjection = JSON.parse(await readFile(projectionPath, 'utf8'));
  assert.equal(storedProjection.status, 'calibrated');
  const rebuilt = await rebuildReviewerCalibrationProjection({
    root,
    rubricVersion: RUBRIC_V1,
    now: '2026-02-02T00:00:00Z',
  });
  assert.deepEqual(rebuilt, storedProjection);
});

test('read-only load reprojects current expiry from events without rewriting durable files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reviewer-calibration-expiry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const anchorSet = normalizeCalibrationAnchorSet(anchorSetInput());
  const anchorEvent = buildCalibrationAnchorSetEvent(anchorSet, { occurredAt: '2026-01-01T00:00:00Z' });
  const sessionEvent = buildReviewerCalibrationSessionEvent(sessionInput(anchorSet), {
    anchorSet,
    occurredAt: '2026-02-01T00:00:00Z',
  });
  await appendReviewerCalibrationEvent({ root, event: anchorEvent, rubricVersion: RUBRIC_V1, now: '2026-02-02T00:00:00Z' });
  await appendReviewerCalibrationEvent({ root, event: sessionEvent, rubricVersion: RUBRIC_V1, now: '2026-02-02T00:00:00Z' });
  const eventsPath = join(root, 'data', 'reviewer-calibration', 'events.jsonl');
  const projectionPath = join(root, 'data', 'reviewer-calibration', 'projection.json');
  const eventsBefore = await readFile(eventsPath, 'utf8');
  const projectionBefore = await readFile(projectionPath, 'utf8');

  const loaded = await loadReviewerCalibrationProjection({
    root,
    rubricVersion: RUBRIC_V1,
    now: '2026-03-04T00:00:00Z',
  });

  assert.equal(loaded.status, 'stale');
  assert.equal(await readFile(eventsPath, 'utf8'), eventsBefore);
  assert.equal(await readFile(projectionPath, 'utf8'), projectionBefore);
});

test('rebuild rejects a conflicting duplicate idempotency key already present in source events', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reviewer-calibration-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const anchorSet = normalizeCalibrationAnchorSet(anchorSetInput());
  const event = buildCalibrationAnchorSetEvent(anchorSet, { occurredAt: '2026-01-01T00:00:00Z' });
  await appendReviewerCalibrationEvent({ root, event, rubricVersion: RUBRIC_V1, now: '2026-02-02T00:00:00Z' });
  const conflicting = structuredClone(event);
  conflicting.data.anchor_set.version = 2;
  await appendFile(
    join(root, 'data', 'reviewer-calibration', 'events.jsonl'),
    `${JSON.stringify(conflicting)}\n`,
    'utf8',
  );

  await assert.rejects(
    rebuildReviewerCalibrationProjection({ root, rubricVersion: RUBRIC_V1, now: '2026-02-02T00:00:00Z' }),
    (error) => error?.code === 'idempotency_conflict' && error?.status === 409,
  );
});
