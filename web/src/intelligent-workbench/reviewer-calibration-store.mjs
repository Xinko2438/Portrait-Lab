import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import {
  REVIEWER_CALIBRATION_EVENT_VERSION,
  ReviewerCalibrationError,
  projectReviewerCalibration,
  reviewerCalibrationLogicalEventHash,
} from './reviewer-calibration.mjs';

function pathsFor(root = process.cwd()) {
  const projectRoot = resolve(root);
  const directory = join(projectRoot, 'data', 'reviewer-calibration');
  return {
    directory,
    events: join(directory, 'events.jsonl'),
    projection: join(directory, 'projection.json'),
  };
}

function conflict(message) {
  throw new ReviewerCalibrationError('idempotency_conflict', message, { status: 409 });
}

function invalidEvent(message) {
  throw new ReviewerCalibrationError('invalid_calibration_event', message, { status: 409 });
}

function validateEventEnvelope(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    invalidEvent('Calibration event must be an object');
  }
  if (event.schema_version !== REVIEWER_CALIBRATION_EVENT_VERSION) {
    invalidEvent(`Calibration event schema_version must be ${REVIEWER_CALIBRATION_EVENT_VERSION}`);
  }
  if (!['CalibrationAnchorSetDefined', 'ReviewerCalibrationRecorded'].includes(event.type)) {
    invalidEvent(`Unsupported calibration event type: ${event.type}`);
  }
  if (typeof event.idempotency_key !== 'string' || !event.idempotency_key.trim()) {
    invalidEvent('Calibration event idempotency_key is required');
  }
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
    invalidEvent('Calibration event data must be an object');
  }
  return event;
}

function dedupeEvents(events) {
  const byKey = new Map();
  const unique = [];
  for (const rawEvent of events) {
    const event = validateEventEnvelope(rawEvent);
    const contentHash = reviewerCalibrationLogicalEventHash(event);
    const existingHash = byKey.get(event.idempotency_key);
    if (existingHash !== undefined) {
      if (existingHash !== contentHash) {
        conflict(`Calibration event idempotency key was reused with different content: ${event.idempotency_key}`);
      }
      continue;
    }
    byKey.set(event.idempotency_key, contentHash);
    unique.push(event);
  }
  return unique;
}

async function readEvents(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, events: [] };
    throw error;
  }
  const events = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      invalidEvent(`Invalid reviewer calibration JSON at line ${index + 1}`);
    }
  });
  return { exists: true, events: dedupeEvents(events) };
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

function inferRubricVersion(events, explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const rubric = event.data?.anchor_set?.rubric_version ?? event.data?.session?.rubric_version;
    if (typeof rubric === 'string' && rubric.trim()) return rubric.trim();
  }
  throw new ReviewerCalibrationError('invalid_calibration_evidence', 'rubricVersion is required');
}

export async function loadReviewerCalibrationProjection({
  root = process.cwd(),
  rubricVersion,
  now = new Date().toISOString(),
} = {}) {
  const paths = pathsFor(root);
  const source = await readEvents(paths.events);
  if (!source.exists) {
    return projectReviewerCalibration([], { rubricVersion, now });
  }
  return projectReviewerCalibration(source.events, {
    rubricVersion: inferRubricVersion(source.events, rubricVersion),
    now,
  });
}

export async function rebuildReviewerCalibrationProjection({
  root = process.cwd(),
  rubricVersion,
  now = new Date().toISOString(),
} = {}) {
  const paths = pathsFor(root);
  const source = await readEvents(paths.events);
  const effectiveRubric = inferRubricVersion(source.events, rubricVersion);
  const projection = projectReviewerCalibration(source.events, { rubricVersion: effectiveRubric, now });
  await atomicWriteJson(paths.projection, projection);
  return projection;
}

export async function appendReviewerCalibrationEvent({
  root = process.cwd(),
  event,
  rubricVersion,
  now,
} = {}) {
  const candidate = validateEventEnvelope(event);
  const paths = pathsFor(root);
  const source = await readEvents(paths.events);
  projectReviewerCalibration([...source.events, candidate], {
    rubricVersion: inferRubricVersion([...source.events, candidate], rubricVersion),
    now: now ?? candidate.occurred_at,
  });

  const existing = source.events.find((item) => item.idempotency_key === candidate.idempotency_key);
  if (existing) {
    if (reviewerCalibrationLogicalEventHash(existing) !== reviewerCalibrationLogicalEventHash(candidate)) {
      conflict(`Calibration event idempotency key was reused with different content: ${candidate.idempotency_key}`);
    }
  } else {
    await mkdir(paths.directory, { recursive: true });
    await appendFile(paths.events, `${JSON.stringify(candidate)}\n`, 'utf8');
  }

  return rebuildReviewerCalibrationProjection({
    root,
    rubricVersion: inferRubricVersion([...source.events, candidate], rubricVersion),
    now: now ?? candidate.occurred_at,
  });
}
