import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as runStore from '../src/run-store.mjs';
import { rebuildReviewGuidance } from '../src/learning-projection.mjs';
import { MAX_IMAGE_BYTES } from '../src/image-metadata.mjs';

const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const whitePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlAT8sAAAAASUVORK5CYII=', 'base64');

async function preparedRun(root, name = 'Artifact Customer') {
  return runStore.createRunSnapshot({
    root,
    customerName: name,
    prompt: 'portrait',
    identityFiles: [{ name: 'identity.png', bytes: transparentPng }],
    templateFiles: [{ name: 'template.png', bytes: whitePng }],
    referencePlan: {
      identityAngles: ['frontal'],
      targetAngle: 'frontal',
      templateAngle: 'frontal',
      targetFraming: 'half_body',
      templateFraming: 'half_body',
    },
    customerContext: { businessDomain: 'consulting', intendedUse: 'profile' },
  });
}

test('v4 runs import distinct validated images as independent artifacts and deduplicate by hash', async () => {
  assert.equal(typeof runStore.importArtifacts, 'function');
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-artifacts-'));
  const run = await preparedRun(root);
  assert.equal(run.manifest.schema_version, 'ai-img-gen.web-run.v4');
  assert.deepEqual(run.manifest.artifacts, []);

  const imported = await runStore.importArtifacts({
    root,
    runId: run.runId,
    files: [
      { name: 'candidate-a.png', bytes: transparentPng },
      { name: 'candidate-b.png', bytes: whitePng },
    ],
    captureMethod: 'manual_import',
  });
  assert.equal(imported.manifest.artifacts.length, 2);
  assert.equal(new Set(imported.manifest.artifacts.map((item) => item.artifact_id)).size, 2);
  assert.equal(new Set(imported.manifest.artifacts.map((item) => item.sha256)).size, 2);
  for (const artifact of imported.manifest.artifacts) {
    assert.equal(artifact.width, 1);
    assert.equal(artifact.height, 1);
    assert.equal(artifact.mime_type, 'image/png');
    assert.equal(artifact.capture_method, 'manual_import');
    assert.match(artifact.path, new RegExp(`outputs[\\\\/]artifacts[\\\\/]${artifact.artifact_id}[\\\\/]original\\.png$`));
  }

  const duplicate = await runStore.importArtifacts({
    root,
    runId: run.runId,
    files: [{ name: 'again.png', bytes: transparentPng }],
    captureMethod: 'manual_import',
  });
  assert.equal(duplicate.manifest.artifacts.length, 2);
  assert.equal(duplicate.events.filter((event) => event.type === 'ArtifactImported').length, 2);
});
function review(overrides = {}) {
  return {
    faceFidelity: 9,
    naturalness: 9,
    style: 9,
    diagnosticCodes: [],
    notes: '',
    ...overrides,
  };
}

test('artifact reviews are independent and preference only accepts gate-qualified winners', async () => {
  assert.equal(typeof runStore.saveArtifactReview, 'function');
  assert.equal(typeof runStore.savePreference, 'function');
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-preference-'));
  const run = await preparedRun(root);
  const imported = await runStore.importArtifacts({
    root,
    runId: run.runId,
    files: [
      { name: 'identity-fail.png', bytes: transparentPng },
      { name: 'qualified.png', bytes: whitePng },
    ],
  });
  const [failedArtifact, qualifiedArtifact] = imported.manifest.artifacts;

  const failedReview = await runStore.saveArtifactReview({
    root,
    runId: run.runId,
    artifactId: failedArtifact.artifact_id,
    review: review({ faceFidelity: 7.9 }),
  });
  assert.equal(failedReview.manifest.artifact_reviews[failedArtifact.artifact_id].verdict, 'identity_rejected');
  assert.equal(failedReview.manifest.artifact_reviews[failedArtifact.artifact_id].preference_eligible, false);

  const qualifiedReview = await runStore.saveArtifactReview({
    root,
    runId: run.runId,
    artifactId: qualifiedArtifact.artifact_id,
    review: review(),
  });
  assert.equal(qualifiedReview.manifest.artifact_reviews[qualifiedArtifact.artifact_id].verdict, 'qualified');
  assert.equal(qualifiedReview.manifest.artifact_reviews[qualifiedArtifact.artifact_id].preference_eligible, true);

  await assert.rejects(() => runStore.savePreference({
    root,
    runId: run.runId,
    decision: 'winner',
    winnerArtifactId: failedArtifact.artifact_id,
  }), /qualified/i);

  const preferred = await runStore.savePreference({
    root,
    runId: run.runId,
    decision: 'winner',
    winnerArtifactId: qualifiedArtifact.artifact_id,
    notes: 'Best overall',
  });
  assert.equal(preferred.manifest.preference.decision, 'winner');
  assert.equal(preferred.manifest.preference.winner_artifact_id, qualifiedArtifact.artifact_id);
  assert.deepEqual(preferred.manifest.preference.eligible_artifact_ids, [qualifiedArtifact.artifact_id]);
  assert.deepEqual(preferred.manifest.preference.excluded_artifact_ids, [failedArtifact.artifact_id]);
  assert.equal(preferred.manifest.status, 'completed');
  assert.equal(preferred.events.filter((event) => event.type === 'ArtifactReviewRecorded').length, 2);
  assert.equal(preferred.events.filter((event) => event.type === 'PreferenceRecorded').length, 1);
});

test('preference supports none and pending without inventing a winner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-preference-state-'));
  const run = await preparedRun(root);
  const imported = await runStore.importArtifacts({ root, runId: run.runId, files: [{ name: 'a.png', bytes: transparentPng }] });
  const artifactId = imported.manifest.artifacts[0].artifact_id;
  await runStore.saveArtifactReview({ root, runId: run.runId, artifactId, review: review() });

  const pending = await runStore.savePreference({ root, runId: run.runId, decision: 'pending' });
  assert.equal(pending.manifest.preference.decision, 'pending');
  assert.equal(pending.manifest.status, 'preference_pending');

  const none = await runStore.savePreference({ root, runId: run.runId, decision: 'none', notes: 'Do not keep' });
  assert.equal(none.manifest.preference.decision, 'none');
  assert.equal(none.manifest.preference.winner_artifact_id, null);
  assert.equal(none.manifest.status, 'completed');
});
test('guidance counts one best non-identity-failed score per run instead of every artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-guidance-units-'));
  for (let index = 0; index < 3; index += 1) {
    const run = await preparedRun(root, `Failing ${index}`);
    const imported = await runStore.importArtifacts({
      root,
      runId: run.runId,
      files: [{ name: 'a.png', bytes: transparentPng }, { name: 'b.png', bytes: whitePng }],
    });
    for (const artifact of imported.manifest.artifacts) {
      await runStore.saveArtifactReview({
        root,
        runId: run.runId,
        artifactId: artifact.artifact_id,
        review: review({ naturalness: 6 }),
      });
    }
  }

  const passingRun = await preparedRun(root, 'Mixed Run');
  const passingArtifacts = await runStore.importArtifacts({
    root,
    runId: passingRun.runId,
    files: [{ name: 'a.png', bytes: transparentPng }, { name: 'b.png', bytes: whitePng }],
  });
  await runStore.saveArtifactReview({
    root,
    runId: passingRun.runId,
    artifactId: passingArtifacts.manifest.artifacts[0].artifact_id,
    review: review({ naturalness: 6 }),
  });
  await runStore.saveArtifactReview({
    root,
    runId: passingRun.runId,
    artifactId: passingArtifacts.manifest.artifacts[1].artifact_id,
    review: review({ naturalness: 9 }),
  });

  const projection = await rebuildReviewGuidance({ root });
  assert.equal(projection.sample_count, 4);
  assert.equal(projection.dimensions.realism_naturalness.review_count, 4);
  assert.equal(projection.dimensions.realism_naturalness.failure_count, 3);
  assert.equal(projection.dimensions.realism_naturalness.failure_rate, 0.75);
  assert.equal(projection.shadow_corrections.some((item) => item.quality_dimension === 'realism_naturalness'), true);
  assert.deepEqual(projection.active_guidance, []);
});


test('legacy v3 runs are projected for reading without rewriting their manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-legacy-'));
  const runId = 'run-legacy-v3';
  const runDir = join(root, 'data', 'runs', runId);
  await mkdir(runDir, { recursive: true });
  const legacyManifest = {
    schema_version: 'ai-img-gen.web-run.v3',
    run_id: runId,
    status: 'result_saved',
    results: [{ path: join(runDir, 'result.png'), filename: 'result.png', sha256: 'a'.repeat(64), bytes: transparentPng.length }],
    latest_review: { verdict: 'qualified', preference_eligible: true, face_identity_fidelity: 9 },
  };
  const manifestPath = join(runDir, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`, 'utf8');
  await writeFile(join(runDir, 'prompt.txt'), 'legacy prompt', 'utf8');
  const before = await readFile(manifestPath, 'utf8');

  const loaded = await runStore.loadRun({ root, runId });
  const after = await readFile(manifestPath, 'utf8');

  assert.equal(loaded.manifest.schema_version, 'ai-img-gen.web-run.v3');
  assert.equal(loaded.manifest.artifacts.length, 1);
  assert.equal(loaded.manifest.artifacts[0].legacy, true);
  assert.equal(loaded.manifest.artifact_reviews[loaded.manifest.artifacts[0].artifact_id].legacy, true);
  assert.equal(after, before);
});

test('artifact import rejects unsupported, oversized, and more than four images', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-validation-'));
  const run = await preparedRun(root);
  await assert.rejects(() => runStore.importArtifacts({
    root, runId: run.runId, files: [{ name: 'not-image.png', bytes: Buffer.from('not-an-image') }],
  }), /PNG, JPEG, and WebP/);
  await assert.rejects(() => runStore.importArtifacts({
    root, runId: run.runId, files: [{ name: 'too-large.png', bytes: Buffer.alloc(MAX_IMAGE_BYTES + 1) }],
  }), /exceeds/);
  const fiveDistinct = Array.from({ length: 5 }, (_, index) => ({
    name: `candidate-${index}.png`, bytes: Buffer.concat([transparentPng, Buffer.from([index])]),
  }));
  await assert.rejects(() => runStore.importArtifacts({ root, runId: run.runId, files: fiveDistinct }), /at most four/i);
  const loaded = await runStore.loadRun({ root, runId: run.runId });
  assert.equal(loaded.manifest.artifacts.length, 0);
});



test('review revisions invalidate a final winner that is no longer qualified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-preference-invalidation-'));
  const run = await preparedRun(root);
  const imported = await runStore.importArtifacts({ root, runId: run.runId, files: [{ name: 'candidate.png', bytes: transparentPng }] });
  const artifactId = imported.manifest.artifacts[0].artifact_id;
  await runStore.saveArtifactReview({ root, runId: run.runId, artifactId, review: review() });
  await runStore.savePreference({ root, runId: run.runId, decision: 'winner', winnerArtifactId: artifactId });

  const revised = await runStore.saveArtifactReview({
    root, runId: run.runId, artifactId, review: review({ faceFidelity: 7.9 }),
  });
  assert.equal(revised.manifest.artifact_reviews[artifactId].verdict, 'identity_rejected');
  assert.equal(revised.manifest.preference.decision, 'pending');
  assert.equal(revised.manifest.preference.invalidation_reason, 'winner_no_longer_qualified');
  assert.equal(revised.manifest.status, 'preference_pending');
  assert.equal(revised.events.filter((event) => event.type === 'PreferenceRecorded').length, 2);
});

test('diagnostic-only review revisions keep an existing final winner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-diagnostic-revision-'));
  const run = await preparedRun(root);
  const imported = await runStore.importArtifacts({ root, runId: run.runId, files: [{ name: 'candidate.png', bytes: transparentPng }] });
  const artifactId = imported.manifest.artifacts[0].artifact_id;
  await runStore.saveArtifactReview({ root, runId: run.runId, artifactId, review: review() });
  await runStore.savePreference({ root, runId: run.runId, decision: 'winner', winnerArtifactId: artifactId });

  const revised = await runStore.saveArtifactReview({
    root,
    runId: run.runId,
    artifactId,
    review: review({ diagnosticCodes: ['subject_not_primary'] }),
  });
  assert.equal(revised.manifest.artifact_reviews[artifactId].preference_eligible, true);
  assert.equal(revised.manifest.preference.decision, 'winner');
  assert.equal(revised.manifest.preference.winner_artifact_id, artifactId);
  assert.equal(revised.events.filter((event) => event.type === 'PreferenceRecorded').length, 1);
});

