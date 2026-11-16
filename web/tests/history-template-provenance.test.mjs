import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as runStore from '../src/run-store.mjs';

async function writeRun(root, manifest) {
  const runDir = join(root, 'data', 'runs', manifest.run_id);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await writeFile(join(runDir, 'prompt.txt'), 'test prompt\n', 'utf8');
  await writeFile(join(runDir, 'events.jsonl'), '', 'utf8');
}

function baseManifest(runId, schemaVersion) {
  return {
    schema_version: schemaVersion,
    run_id: runId,
    status: 'completed',
    review_status: 'reviewed',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    customer_name: 'Alpha Customer',
    customer_context: { intended_use: 'live' },
    reference_plan: { target_framing: 'bust', target_angle: 'front' },
    reference_preflight: { state: 'passed' },
    prompt_sha256: 'abc123hash',
    identity_references: [{ filename: '01.png', sha256: 'idhash01', width: 512, height: 512 }],
    artifacts: [{ artifact_id: 'art-01', filename: 'artifact-01.png', sha256: 'arthash01', width: 1024, height: 1024 }],
    artifact_reviews: {},
    artifact_annotations: {},
  };
}

test('history projection exposes exact v5 template provenance without local paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'v5-history-detail-test-'));
  const manifest = {
    ...baseManifest('run-20260816000000-test0001', 'ai-img-gen.web-run.v5'),
    template_references: [
      {
        filename: '01-catalog.jpg',
        path: 'D:/must-not-leak/catalog.jpg',
        sha256: 'a'.repeat(64),
        mime_type: 'image/jpeg',
        source_type: 'catalog_template',
        decision_type: 'accepted',
        template_uid: 'tpl_studio_001',
        template_name: 'Classic Studio 1',
        selected_rank: 1,
        relevance_score: 95,
        selection_id: 'selection_test_123',
        reference_image_sha256: 'a'.repeat(64),
        generation_blueprint_sha256: 'b'.repeat(64),
        catalog_projection_version: 'ai-img-gen.template-catalog.v2',
        ranking_policy_version: 'ai-img-gen.template-selection.v1',
      },
      { filename: '02-user.png', sha256: 'c'.repeat(64), mime_type: 'image/png', source_type: 'uploaded_reference' },
    ],
    template_selection: {
      selection_id: 'selection_test_123',
      decision_id: 'decision_test_456',
      ranking_policy_version: 'ai-img-gen.template-selection.v1',
      catalog_projection_version: 'ai-img-gen.template-catalog.v2',
      accepted_template_uids: ['tpl_studio_001'],
      link_state: 'linked',
    },
  };
  await writeRun(root, manifest);

  const [history] = await runStore.listRuns({ root, artifactsOnly: true });
  assert.equal(history.schema_version, 'ai-img-gen.web-run.v5');
  assert.equal(history.template_selection.link_state, 'linked');
  assert.equal(history.template_references[0].source_type, 'catalog_template');
  assert.equal(history.template_references[0].template_name, 'Classic Studio 1');
  assert.equal(history.template_references[0].selected_rank, 1);
  assert.equal(history.template_references[0].relevance_score, 95);
  assert.equal(history.template_references[0].reference_image_sha256, 'a'.repeat(64));
  assert.equal(history.template_references[0].generation_blueprint_sha256, 'b'.repeat(64));
  assert.equal('path' in history.template_references[0], false);
  assert.equal(history.template_references[1].source_type, 'uploaded_reference');
});

test('legacy v1-v4 history does not fabricate catalog attribution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'v4-history-compat-test-'));
  const manifest = {
    ...baseManifest('run-20260816000000-test0002', 'ai-img-gen.web-run.v4'),
    template_references: [{ filename: '01.png', sha256: 'tmplhash01', width: 512, height: 512 }],
  };
  await writeRun(root, manifest);
  const [history] = await runStore.listRuns({ root, artifactsOnly: true });
  assert.equal(history.schema_version, 'ai-img-gen.web-run.v4');
  assert.equal(history.template_selection, null);
  assert.equal(history.template_references[0].source_type, null);
  assert.equal(history.template_references[0].template_uid, null);
});
