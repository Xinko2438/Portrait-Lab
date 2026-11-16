import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

import * as runStore from '../src/run-store.mjs';
import { importTemplateCatalog, listTemplates } from '../src/template-catalog.mjs';
import {
  createTemplateSelection,
  loadTemplateSelection,
  recordTemplateSelectionDecision,
} from '../src/template-selection.mjs';

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function sourceTemplate({ id, name, style = 'studio', risk = 'low', difficulty = 'medium', retrieval = 'clean portrait' }) {
  return {
    template_info: { template_id: id, template_name: name, source_image: `${id}.png` },
    selection_tags: {
      style_category: style,
      portrait_scale: 'bust',
      face_angle: 'front',
      face_visibility: 'high',
      text_on_face: false,
      identity_preservation_risk: risk,
      generation_difficulty: difficulty,
    },
    retrieval_text: retrieval,
    generation_blueprint: {
      composition: { framing: 'bust' },
      subject_design: { pose: 'natural' },
      camera_and_angle: { face_angle: 'front' },
      lighting: { style: 'soft' },
      color_palette: { dominant: 'neutral' },
      background: { complexity: 'low' },
      typography_and_graphics: { enabled: false },
      texture_and_finish: { finish: 'natural' },
      negative_prompt_rules: ['do not change identity'],
    },
    scoring_notes: {
      total_manual_score: 82,
      human_reason: 'course prior only',
      human_correction_rules: ['keep face visible'],
    },
  };
}

async function makeSourceRoot() {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-template-source-'));
  const jsonDir = join(root, '输出结果', 'run_20260604-191910917');
  const imageDir = join(root, '例图');
  const indexDir = join(root, '模板索引');
  await Promise.all([mkdir(jsonDir, { recursive: true }), mkdir(imageDir, { recursive: true }), mkdir(indexDir, { recursive: true })]);
  const templates = [
    sourceTemplate({ id: 'soft_studio_001', name: 'Soft Studio', retrieval: 'soft clean studio portrait' }),
    sourceTemplate({ id: 'clean_portrait_002', name: 'Clean Portrait', style: 'classic', retrieval: 'clean portrait' }),
  ];
  for (const [index, source] of templates.entries()) {
    const ordinal = index + 1;
    await writeFile(join(jsonDir, `${ordinal}.txt`), JSON.stringify(source, null, 2), 'utf8');
    await writeFile(join(imageDir, `${ordinal}.png`), onePixelPng);
  }
  await writeFile(join(indexDir, 'current_template_index.json'), JSON.stringify({
    index_type: 'current_template_index',
    template_count: templates.length,
    templates: templates.map((entry, index) => ({
      txt_filename: `${index + 1}.txt`,
      template_id: entry.template_info.template_id,
      template_name: entry.template_info.template_name,
      selection_tags: entry.selection_tags,
      retrieval_text: entry.retrieval_text,
    })),
  }, null, 2), 'utf8');
  return root;
}

test('createRunSnapshot materializes exact linked v5 catalog provenance and history evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'v5-run-test-'));
  await importTemplateCatalog({ root, sourceRoot: await makeSourceRoot(), expectedCount: 2 });
  const catalogList = await listTemplates({ root });
  assert.equal(catalogList.total, 2);

  const selectionResult = await createTemplateSelection({
    root,
    idempotencyKey: 'sel-test-key-01',
    taskBrief: {
      customer_scope_id: 'cust_0123456789abcdef',
      free_text_intent: 'studio portrait',
      target_portrait_scales: ['bust'],
      target_face_angles: ['front'],
      required_face_visibility: ['high'],
      max_identity_preservation_risk: 'medium',
      max_generation_difficulty: 'medium',
      allow_text_on_face: false,
    },
  });
  const selectedCandidate = selectionResult.selection.top4[0];
  assert.ok(selectedCandidate?.template_uid);
  const initialDecision = await recordTemplateSelectionDecision({
    root,
    selectionId: selectionResult.selection.selection_id,
    decisionIdempotencyKey: 'decision-test-key-01',
    decision: {
      actor: 'primary-user',
      accepted_template_uids: [selectedCandidate.template_uid],
      removed_template_uids: selectionResult.selection.top4.slice(1).map((candidate) => candidate.template_uid),
      substitutions: [],
      linked_run_ids: [],
      notes: '',
    },
  });

  const run = await runStore.createRunSnapshot({
    root,
    customerName: '中文客户',
    prompt: 'make it sharp',
    identityFiles: [{ originalname: 'id1.png', buffer: onePixelPng }],
    templateFiles: [],
    referencePlan: { identity_angles: ['front'], target_framing: 'bust', target_angle: 'front' },
    templateSelectionId: selectionResult.selection.selection_id,
    catalogTemplateUids: [selectedCandidate.template_uid],
    templateDecisionIdempotencyKey: 'decision-test-key-01',
  });

  assert.equal(run.manifest.schema_version, 'ai-img-gen.web-run.v5');
  assert.deepEqual(run.manifest.template_selection.accepted_template_uids, [selectedCandidate.template_uid]);
  assert.equal(run.manifest.template_selection.link_state, 'linked');
  assert.equal(run.manifest.template_selection.ranking_policy_version, selectionResult.selection.ranking_policy_version);
  assert.equal(run.manifest.template_selection.catalog_projection_version, selectionResult.selection.catalog_projection_version);
  assert.notEqual(run.manifest.template_selection.decision_id, initialDecision.selection.decision.decision_id);

  const reference = run.manifest.template_references[0];
  assert.equal(reference.source_type, 'catalog_template');
  assert.equal(reference.decision_type, 'accepted');
  assert.equal(reference.template_uid, selectedCandidate.template_uid);
  assert.equal(reference.selected_rank, selectedCandidate.rank);
  assert.equal(reference.relevance_score, selectedCandidate.relevance_score);
  assert.equal(reference.selection_id, selectionResult.selection.selection_id);
  assert.equal(reference.ranking_policy_version, selectionResult.selection.ranking_policy_version);
  assert.equal(reference.catalog_projection_version, selectionResult.selection.catalog_projection_version);
  assert.match(reference.reference_image_sha256, /^[a-f0-9]{64}$/);
  assert.match(reference.generation_blueprint_sha256, /^[a-f0-9]{64}$/);
  assert.equal(extname(reference.filename), '.png');
  assert.equal(reference.mime_type, 'image/png');
  const copiedBytes = await readFile(reference.path);
  assert.equal(sha256(copiedBytes), reference.reference_image_sha256);
  assert.equal(reference.sha256, reference.reference_image_sha256);

  const linkedSelection = await loadTemplateSelection({ root, selectionId: selectionResult.selection.selection_id });
  assert.ok(linkedSelection.linked_run_ids.includes(run.runId));
  assert.equal(linkedSelection.decision.decision_id, run.manifest.template_selection.decision_id);
  const runEvents = await readFile(join(root, 'data', 'runs', run.runId, 'events.jsonl'), 'utf8');
  assert.match(runEvents, /"type":"TemplateSelectionLinked"/);

  const history = await runStore.listRuns({ root, artifactsOnly: false });
  const historyRun = history.find((item) => item.run_id === run.runId);
  assert.equal(historyRun.schema_version, 'ai-img-gen.web-run.v5');
  assert.equal(historyRun.template_selection.link_state, 'linked');
  assert.equal(historyRun.template_references[0].template_uid, selectedCandidate.template_uid);
  assert.equal(historyRun.template_references[0].generation_blueprint_sha256, reference.generation_blueprint_sha256);
});

test('createRunSnapshot enforces maximum 4 combined manual and catalog references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'v5-limit-test-'));
  await assert.rejects(
    () => runStore.createRunSnapshot({
      root,
      customerName: 'cust_01',
      prompt: 'test',
      identityFiles: [{ originalname: 'id1.png', buffer: onePixelPng }],
      templateFiles: [
        { originalname: 't1.png', buffer: onePixelPng },
        { originalname: 't2.png', buffer: onePixelPng },
        { originalname: 't3.png', buffer: onePixelPng },
      ],
      catalogTemplateUids: ['tpl_a', 'tpl_b'],
      templateSelectionId: 'selection_1',
    }),
    (error) => error?.code === 'template_reference_limit_exceeded',
  );
});
