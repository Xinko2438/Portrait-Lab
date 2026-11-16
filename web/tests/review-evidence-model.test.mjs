import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluateReview } from '../src/review-policy.mjs';
import { rebuildReviewGuidance } from '../src/learning-projection.mjs';
import * as runStore from '../src/run-store.mjs';

const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const whitePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mP8/x8AAusB9WlAT8sAAAAASUVORK5CYII=', 'base64');
const rubricVersion = 'portrait-review-v3-three-score-diagnostics-20260816';

function currentReview(overrides = {}) {
  return {
    faceFidelity: 9.1,
    naturalness: 8.4,
    style: 8.6,
    diagnosticCodes: [],
    notes: '',
    ...overrides,
  };
}

async function preparedRun(root, name = 'Review Evidence Customer') {
  return runStore.createRunSnapshot({
    root,
    customerName: name,
    prompt: 'portrait',
    identityFiles: [{ name: 'identity.png', bytes: transparentPng }],
    templateFiles: [{ name: 'template.png', bytes: whitePng }],
    referencePlan: {
      identityAngles: ['frontal'],
      targetAngle: 'frontal',
      targetFraming: 'half_body',
    },
    customerContext: { businessDomain: 'consulting', intendedUse: 'profile' },
  });
}

async function runWithArtifacts(root, count = 2) {
  const run = await preparedRun(root);
  const files = [
    { name: 'candidate-a.png', bytes: transparentPng },
    { name: 'candidate-b.png', bytes: whitePng },
  ].slice(0, count);
  return runStore.importArtifacts({ root, runId: run.runId, files, captureMethod: 'manual_import' });
}

test('current review source truth is exactly three numeric scores plus structured diagnostics', () => {
  const evaluated = evaluateReview(currentReview({
    diagnosticCodes: ['emotion_unclear', 'subject_not_primary', 'emotion_unclear'],
  }));

  assert.equal(evaluated.review_rubric_version, rubricVersion);
  assert.equal(evaluated.face_identity_fidelity, 9.1);
  assert.equal(evaluated.realism_naturalness, 8.4);
  assert.equal(evaluated.style_consistency, 8.6);
  assert.equal(evaluated.emotional_clarity, undefined);
  assert.equal(evaluated.element_coherence, undefined);
  assert.equal(evaluated.visual_hierarchy, undefined);
  assert.equal(evaluated.client_suitability, undefined);
  assert.deepEqual(evaluated.diagnostic_codes, ['emotion_unclear', 'subject_not_primary']);
  assert.deepEqual(evaluated.diagnostic_findings.map((finding) => finding.group), ['emotional_clarity', 'visual_hierarchy']);
  assert.equal(evaluated.preference_eligible, true);
  assert.equal(evaluated.gate_state, 'qualified');
});

test('diagnostics remain structured evidence and never become hidden hard gates', () => {
  const evaluated = evaluateReview(currentReview({ diagnosticCodes: ['client_use_case_mismatch'] }));
  assert.equal(evaluated.failed_dimensions.length, 0);
  assert.equal(evaluated.preference_eligible, true);
  assert.equal(evaluated.gate_state, 'qualified');
  assert.equal(evaluated.verdict, 'qualified');
});

test('current review rejects retired score fields, unknown diagnostics, and invalid precision', () => {
  assert.throws(
    () => evaluateReview(currentReview({ emotionalClarity: 8.2 })),
    /retired.*diagnostic/i,
  );
  assert.throws(
    () => evaluateReview(currentReview({ diagnosticCodes: ['invented_issue'] })),
    /unknown diagnostic/i,
  );
  assert.throws(
    () => evaluateReview(currentReview({ style: 8.25 })),
    /at most one decimal place/i,
  );
});

test('A/B/tie/skip aesthetic comparisons are append-only and separate from final preference', async () => {
  assert.equal(typeof runStore.saveAestheticComparison, 'function');
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-aesthetic-comparison-'));
  const imported = await runWithArtifacts(root, 2);
  const [artifactA, artifactB] = imported.manifest.artifacts;
  for (const artifact of [artifactA, artifactB]) {
    await runStore.saveArtifactReview({
      root,
      runId: imported.runId,
      artifactId: artifact.artifact_id,
      review: currentReview(),
    });
  }

  const choseA = await runStore.saveAestheticComparison({
    root,
    runId: imported.runId,
    artifactAId: artifactA.artifact_id,
    artifactBId: artifactB.artifact_id,
    outcome: 'a',
    notes: 'A has cleaner visual rhythm.',
  });
  assert.equal(choseA.manifest.preference, null);
  assert.equal(choseA.manifest.aesthetic_comparisons.length, 1);
  assert.deepEqual(choseA.manifest.aesthetic_comparisons[0].presentation_order, [artifactA.artifact_id, artifactB.artifact_id]);
  assert.equal(choseA.manifest.aesthetic_comparisons[0].winner_artifact_id, artifactA.artifact_id);
  assert.equal(choseA.manifest.aesthetic_comparisons[0].loser_artifact_id, artifactB.artifact_id);
  assert.equal(choseA.manifest.aesthetic_comparisons[0].outcome, 'a');

  const choseB = await runStore.saveAestheticComparison({
    root,
    runId: imported.runId,
    artifactAId: artifactA.artifact_id,
    artifactBId: artifactB.artifact_id,
    outcome: 'b',
  });
  assert.equal(choseB.manifest.aesthetic_comparisons.length, 2);
  assert.equal(choseB.manifest.aesthetic_comparisons[1].winner_artifact_id, artifactB.artifact_id);
  assert.equal(choseB.manifest.aesthetic_comparisons[1].loser_artifact_id, artifactA.artifact_id);

  const tied = await runStore.saveAestheticComparison({
    root,
    runId: imported.runId,
    artifactAId: artifactA.artifact_id,
    artifactBId: artifactB.artifact_id,
    outcome: 'tie',
  });
  assert.equal(tied.manifest.aesthetic_comparisons.length, 3);
  assert.equal(tied.manifest.aesthetic_comparisons[2].winner_artifact_id, null);
  assert.equal(tied.manifest.aesthetic_comparisons[2].loser_artifact_id, null);

  const skipped = await runStore.saveAestheticComparison({
    root,
    runId: imported.runId,
    artifactAId: artifactA.artifact_id,
    artifactBId: artifactB.artifact_id,
    outcome: 'skip',
  });
  assert.equal(skipped.manifest.aesthetic_comparisons.length, 4);
  assert.equal(skipped.events.filter((event) => event.type === 'AestheticComparisonRecorded').length, 4);
});

test('comparison requires two distinct aesthetic-eligible artifacts', async () => {
  assert.equal(typeof runStore.saveAestheticComparison, 'function');
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-aesthetic-gate-'));
  const imported = await runWithArtifacts(root, 2);
  const [artifactA, artifactB] = imported.manifest.artifacts;
  await runStore.saveArtifactReview({ root, runId: imported.runId, artifactId: artifactA.artifact_id, review: currentReview() });
  await runStore.saveArtifactReview({
    root,
    runId: imported.runId,
    artifactId: artifactB.artifact_id,
    review: currentReview({ naturalness: 6.9, diagnosticCodes: ['subject_not_primary'] }),
  });

  await assert.rejects(() => runStore.saveAestheticComparison({
    root,
    runId: imported.runId,
    artifactAId: artifactA.artifact_id,
    artifactBId: artifactB.artifact_id,
    outcome: 'b',
  }), /aesthetic-eligible/i);
  await assert.rejects(() => runStore.saveAestheticComparison({
    root,
    runId: imported.runId,
    artifactAId: artifactA.artifact_id,
    artifactBId: artifactA.artifact_id,
    outcome: 'tie',
  }), /distinct/i);
});

test('diagnostic context does not prevent comparison or separate final selection', async () => {
  assert.equal(typeof runStore.saveAestheticComparison, 'function');
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-delivery-gate-'));
  const imported = await runWithArtifacts(root, 2);
  const [artifactA, artifactB] = imported.manifest.artifacts;
  await runStore.saveArtifactReview({
    root,
    runId: imported.runId,
    artifactId: artifactA.artifact_id,
    review: currentReview({ diagnosticCodes: ['client_use_case_mismatch'] }),
  });
  await runStore.saveArtifactReview({ root, runId: imported.runId, artifactId: artifactB.artifact_id, review: currentReview() });

  const compared = await runStore.saveAestheticComparison({
    root,
    runId: imported.runId,
    artifactAId: artifactA.artifact_id,
    artifactBId: artifactB.artifact_id,
    outcome: 'a',
  });
  assert.equal(compared.manifest.aesthetic_comparisons[0].winner_artifact_id, artifactA.artifact_id);
  const preferred = await runStore.savePreference({
    root,
    runId: imported.runId,
    decision: 'winner',
    winnerArtifactId: artifactA.artifact_id,
  });
  assert.equal(preferred.manifest.preference.winner_artifact_id, artifactA.artifact_id);
  assert.deepEqual(preferred.manifest.preference.pairwise, []);
});

test('mixed-version guidance uses two non-identity scores and non-customer diagnostic frequencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-guidance-v3-'));
  for (let index = 0; index < 3; index += 1) {
    const imported = await runWithArtifacts(root, 1);
    await runStore.saveArtifactReview({
      root,
      runId: imported.runId,
      artifactId: imported.manifest.artifacts[0].artifact_id,
      review: currentReview({ diagnosticCodes: ['subject_not_primary', 'client_use_case_mismatch'] }),
    });
  }

  const legacyRunId = 'run-legacy-seven-dimension';
  const legacyDir = join(root, 'data', 'runs', legacyRunId);
  await mkdir(legacyDir, { recursive: true });
  const legacyReview = {
    review_rubric_version: 'portrait-review-v2-tutorial-20260810',
    face_identity_fidelity: 9,
    realism_naturalness: 8,
    style_consistency: 8,
    emotional_clarity: 6,
    element_coherence: 8,
    visual_hierarchy: 8,
    client_suitability: 6,
    failed_dimensions: [
      { dimension: 'client_suitability' },
      { dimension: 'emotional_clarity' },
    ],
    preference_eligible: false,
  };
  await writeFile(join(legacyDir, 'manifest.json'), `${JSON.stringify({
    schema_version: 'ai-img-gen.web-run.v4',
    run_id: legacyRunId,
    excluded_from_learning: false,
    artifacts: [{ artifact_id: 'artifact-legacy', path: 'legacy.png', sha256: 'a'.repeat(64) }],
    artifact_reviews: { 'artifact-legacy': legacyReview },
  }, null, 2)}\n`, 'utf8');

  const projection = await rebuildReviewGuidance({ root });
  assert.equal(projection.schema_version, 'ai-img-gen.review-guidance.v4');
  assert.deepEqual(Object.keys(projection.dimensions).sort(), ['realism_naturalness', 'style_consistency']);
  assert.equal(projection.diagnostics.subject_not_primary.review_count, 4);
  assert.equal(projection.diagnostics.subject_not_primary.failure_count, 3);
  assert.equal(projection.diagnostics.emotion_unclear.failure_count, 1);
  assert.equal(projection.diagnostics.client_use_case_mismatch, undefined);
  assert.equal(projection.shadow_corrections.some((item) => item.diagnostic_code === 'subject_not_primary'), true);
  assert.deepEqual(projection.active_corrections, []);
  assert.deepEqual(projection.active_guidance, []);
  assert.deepEqual(projection.source_rubric_versions.sort(), [
    'portrait-review-v2-tutorial-20260810',
    rubricVersion,
  ].sort());
});

test('workbench exposes three scores, diagnostic chips, and A/B/tie/skip comparison', async () => {
  const [html, app, server] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'),
  ]);

  for (const field of ['faceFidelity', 'naturalness', 'style']) {
    assert.match(html, new RegExp(`name="${field}"[^>]*type="number"`));
  }
  for (const retired of ['emotionalClarity', 'elementCoherence', 'visualHierarchy', 'clientSuitability', 'styleLevel', 'clientSuitabilityLevel']) {
    assert.doesNotMatch(html, new RegExp(`name="${retired}"`));
  }
  for (const code of ['emotion_unclear', 'elements_incoherent', 'subject_not_primary', 'client_use_case_mismatch']) {
    assert.match(html, new RegExp(`name="diagnosticCodes"[^>]*value="${code}"`));
  }
  assert.match(html, /id="aestheticComparisonForm"/);
  for (const outcome of ['a', 'b', 'tie', 'skip']) {
    assert.match(html, new RegExp(`data-comparison-outcome="${outcome}"`));
  }
  assert.match(app, /saveAestheticComparison/);
  assert.match(app, /\/comparison/);
  assert.match(server, /action === 'comparison'/);
  assert.match(server, /saveAestheticComparison/);
});

