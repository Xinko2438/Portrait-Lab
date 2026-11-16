import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as templateSelection from '../src/template-selection.mjs';
import { listTemplates } from '../src/template-catalog.mjs';
import { assertTemplatesNotRejected } from '../src/face-tag-store.mjs';
import { resolveCatalogSelectionForRun } from '../src/catalog-run-integration.mjs';
import { createTemplateLibraryController } from '../public/template-library.js';
import { createTemplateSelectionOutcomeInvalidated } from '../src/template-outcome-lifecycle.mjs';

const { normalizeTaskBrief, rankTemplateCatalog } = templateSelection;

test('confirmed rejection excludes exact assets from new recommendations and full library remains visible', async () => {
  const root = await makeSelectionRoot();
  try {
    const catalog = fixtureCatalog();
    const entry = catalog.templates[0];
    const args = {root,idempotencyKey:'rejection-before',taskBrief:{customer_scope_id:'customer-fixture',use_case:'personal_brand'}};
    const before = await templateSelection.createTemplateSelection(args);
    await templateSelection.recordTemplateSelectionDecision({root,selectionId:before.selection.selection_id,decisionIdempotencyKey:'before-reject-choice',decision:{accepted_template_uids:[entry.template_uid]}});
    const eventPath = join(root,'data','events','template-face-tags.jsonl');
    await mkdir(join(root,'data','events'),{recursive:true});
    const rejection = {event_type:'FaceTagConfirmed',event_id:'reject-fixture',actor:'primary-user',subject_kind:'template',subject_id:entry.template_uid,image_sha256:entry.reference_image.sha256,tag:{template_state:'rejected'}};
    await writeFile(eventPath,JSON.stringify(rejection)+'\n');
    const after = await templateSelection.createTemplateSelection({...args,idempotencyKey:'rejection-after'});
    const duplicates = catalog.templates.filter(t=>t.reference_image.sha256===entry.reference_image.sha256).map(t=>t.template_uid);
    assert.ok(duplicates.length===2);
    assert.ok(after.selection.ranked_candidates.every(t=>!duplicates.includes(t.template_uid)));
    const full = await listTemplates({root});
    assert.equal(full.total,catalog.templates.length);
    assert.ok(full.templates.filter(t=>duplicates.includes(t.template_uid)).every(t=>t.operator_rejected===true));
    const controller=createTemplateLibraryController({fetch:async()=>Response.json(full)});
    await controller.loadTemplates();
    assert.equal(controller.getTemplateEligibility(entry.template_uid).state,'ineligible');
    await assert.rejects(()=>assertTemplatesNotRejected({root,imageHashes:[entry.reference_image.sha256]}),e=>e.status===422);
    await assert.rejects(()=>resolveCatalogSelectionForRun({root,templateSelectionId:before.selection.selection_id,catalogTemplateUids:[entry.template_uid]}),e=>e.status===422);
    await assert.rejects(()=>templateSelection.recordTemplateSelectionDecision({root,selectionId:before.selection.selection_id,decisionIdempotencyKey:'after-reject-choice',decision:{accepted_template_uids:[entry.template_uid]}}),e=>e.status===422);
    const freshSlate=await templateSelection.recordTemplateExploration({root,selectionId:after.selection.selection_id,explorationIdempotencyKey:'fresh-explore'});
    assert.ok(freshSlate.slate.candidate_uids.every(uid=>!duplicates.includes(uid)));
    await assert.rejects(()=>templateSelection.createTemplateSelection(args),/idempotency|changed|conflict/i);
    await assert.rejects(()=>templateSelection.recordTemplateExploration({root,selectionId:before.selection.selection_id,explorationIdempotencyKey:'stale-explore'}),e=>e.status===409);
    await appendFile(eventPath,JSON.stringify({...rejection,event_id:'restore-fixture',tag:{template_state:'active'}})+'\n');
    const restored = await templateSelection.createTemplateSelection({...args,idempotencyKey:'rejection-restored'});
    assert.deepEqual(restored.selection.top4,before.selection.top4);
    await appendFile(eventPath,JSON.stringify({...rejection,event_type:'FaceTagSuggested',event_id:'suggestion-is-not-rejection'})+'\n');
    assert.ok((await listTemplates({root})).templates.every(t=>!t.operator_rejected));
    await appendFile(eventPath,'invalid-json\n');
    await assert.rejects(()=>listTemplates({root}),/Invalid face tag event/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

function templateEntry({
  uid,
  ordinal,
  name,
  style,
  imageHash,
  risk = 'medium',
  difficulty = 'medium',
  visibility = 'high',
  textOnFace = false,
  scale = 'bust',
  angle = 'front_15_degree',
  cameraAngle = 'eye_level',
  visualIntensity = 'medium',
  typography = 'low',
  bestTemperament = ['专业', '克制'],
  avoidTemperament = ['甜美'],
  bestFace = ['五官清晰', '眼神稳定'],
  avoidFace = ['照片模糊', '脸部过小'],
  retrieval = '',
  suitableUse = ['个人品牌封面'],
  prior = 80,
}) {
  return {
    template_uid: uid,
    source_namespace: 'fixture',
    source_template_id: uid.replace(/^tpl_fixture_/, ''),
    source_ordinal: ordinal,
    template_info: {
      template_id: uid.replace(/^tpl_fixture_/, ''),
      template_name: name,
      image_type: 'portrait',
      suitable_use: suitableUse,
      overall_style_summary: `${style} ${retrieval}`,
    },
    selection_tags: {
      style_category: style,
      visual_intensity: visualIntensity,
      portrait_scale: scale,
      face_angle: angle,
      camera_angle: cameraAngle,
      face_visibility: visibility,
      face_size: 'large',
      hair_occlusion: 'low',
      text_on_face: textOnFace,
      typography_complexity: typography,
      background_complexity: 'low',
      color_complexity: 'low',
      lighting_difficulty: 'medium',
      identity_preservation_risk: risk,
      generation_difficulty: difficulty,
      commercial_safety: risk === 'high' ? 'medium' : 'high',
      best_client_temperament: bestTemperament,
      avoid_client_temperament: avoidTemperament,
      best_client_face_features: bestFace,
      avoid_client_face_features: avoidFace,
    },
    retrieval_text: retrieval || `${style} ${name} portrait`,
    generation_blueprint: {
      core_visual_goal: `${style} portrait`,
      composition: { portrait_scale: scale },
      subject_design: { temperament: bestTemperament },
      camera_and_angle: { face_angle: angle, camera_angle: cameraAngle },
      lighting: { difficulty: 'medium' },
      color_palette: { complexity: 'low' },
      background: { complexity: 'low' },
      typography_and_graphics: { complexity: typography, text_on_face: textOnFace },
      texture_and_finish: { finish: 'natural' },
      negative_prompt_rules: ['preserve identity'],
    },
    negative_prompt_rules: ['preserve identity'],
    observational_prior: {
      evidence_space: 'course_observational_prior',
      source_rubric: 'fixture',
      aesthetic_score: prior,
      commercial_score: prior,
      identity_preservation_score: prior,
      generation_stability_score: prior,
      personal_preference_score: prior,
      total_manual_score: prior,
      human_reason: 'fixture prior',
      human_correction_rules: [],
    },
    source_hashes: {
      json_sha256: `${uid}-json-hash`,
      reference_image_sha256: imageHash,
    },
    source_json_path: `data/templates/${uid}/source.json`,
    reference_image_path: `data/templates/${uid}/reference.png`,
    reference_image: {
      sha256: imageHash,
      bytes: 128,
      mime_type: 'image/png',
      extension: '.png',
      duplicate_hash_group_size: 1,
    },
    decision_uses: {
      selection_tags: 'filtering_and_risk_gating',
      retrieval_text: 'retrieval',
      generation_blueprint: 'prompt_assembly',
      observational_prior: 'cold_start_weak_prior',
    },
  };
}

function fixtureCatalog() {
  const templates = [
    templateEntry({ uid: 'tpl_fixture_clean_a', ordinal: 1, name: 'Clean A', style: 'clean_magazine', imageHash: fixtureHash('hash-clean-duplicate'), retrieval: 'clean professional restrained personal brand', prior: 92 }),
    templateEntry({ uid: 'tpl_fixture_clean_b', ordinal: 2, name: 'Clean B', style: 'clean_magazine', imageHash: fixtureHash('hash-clean-duplicate'), retrieval: 'clean professional restrained personal brand', prior: 88 }),
    templateEntry({ uid: 'tpl_fixture_clean_c', ordinal: 3, name: 'Clean C', style: 'clean_magazine', imageHash: fixtureHash('hash-clean-c'), retrieval: 'clean professional calm editorial', prior: 84 }),
    templateEntry({ uid: 'tpl_fixture_clean_d', ordinal: 4, name: 'Clean D', style: 'clean_magazine', imageHash: fixtureHash('hash-clean-d'), retrieval: 'clean mature personal brand', prior: 82 }),
    templateEntry({ uid: 'tpl_fixture_clean_e', ordinal: 5, name: 'Clean E', style: 'clean_magazine', imageHash: fixtureHash('hash-clean-e'), retrieval: 'clean restrained magazine portrait', prior: 80 }),
    templateEntry({ uid: 'tpl_fixture_dark_high', ordinal: 6, name: 'Dark High', style: 'dark_grunge', imageHash: fixtureHash('hash-dark'), risk: 'high', difficulty: 'high', retrieval: 'dark grunge music poster', bestTemperament: ['酷感'] }),
    templateEntry({ uid: 'tpl_fixture_text_face', ordinal: 7, name: 'Text Face', style: 'bold_color_graphic', imageHash: fixtureHash('hash-text-face'), textOnFace: true, retrieval: 'bold graphic text face', bestTemperament: ['时尚'] }),
    templateEntry({ uid: 'tpl_fixture_streetwear', ordinal: 8, name: 'Streetwear', style: 'streetwear_editorial', imageHash: fixtureHash('hash-streetwear'), retrieval: 'streetwear fashion editorial', bestTemperament: ['时尚', '酷感'] }),
    templateEntry({ uid: 'tpl_fixture_low_risk', ordinal: 9, name: 'Low Risk', style: 'minimal_personal_brand', imageHash: fixtureHash('hash-low-risk'), risk: 'low', retrieval: 'minimal professional identity first', prior: 78 }),
  ];
  return {
    schema_version: 'ai-img-gen.template-catalog.v1',
    source_namespace: 'fixture',
    projection_version: 'ai-img-gen.template-catalog.v1',
    rebuilt_at: '2026-08-15T00:00:00.000Z',
    summary: { template_count: templates.length },
    templates,
  };
}

function baseBrief(overrides = {}) {
  return {
    schema_version: 'ai-img-gen.customer-task-brief.v1',
    customer_scope_id: 'fixture_customer',
    use_case: 'personal_brand_cover',
    style_keywords: ['clean_magazine'],
    avoid_keywords: ['dark_grunge'],
    target_portrait_scales: ['bust'],
    target_face_angles: ['front_15_degree'],
    temperament_keywords: ['专业', '克制'],
    face_feature_observations: ['五官清晰', '眼神稳定'],
    required_face_visibility: ['high'],
    allow_text_on_face: false,
    max_identity_preservation_risk: 'medium',
    max_generation_difficulty: 'high',
    diversity_preference: 'balanced',
    free_text_intent: 'clean professional restrained personal brand',
    ...overrides,
  };
}

async function makeSelectionRoot() {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-template-selection-'));
  const projectionDir = join(root, 'data', 'projections');
  await mkdir(projectionDir, { recursive: true });
  await writeFile(join(projectionDir, 'template-catalog.json'), `${JSON.stringify(fixtureCatalog(), null, 2)}\n`, 'utf8');
  return root;
}

function selectionBusinessContent(selection) {
  const copy = structuredClone(selection);
  delete copy.rebuilt_at;
  delete copy.projection_sha256;
  return copy;
}

function stableFixtureValue(value) {
  if (Array.isArray(value)) return value.map(stableFixtureValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableFixtureValue(value[key])]));
  }
  return value;
}

function fixtureHash(value) {
  return createHash('sha256').update(JSON.stringify(stableFixtureValue(value))).digest('hex');
}

test('normalization applies conservative defaults, stable lists, and rejects contradictory or unknown constraints', () => {
  const normalized = normalizeTaskBrief({
    customer_scope_id: 'fixture_customer',
    style_keywords: [' clean_magazine ', 'clean_magazine'],
    target_face_angles: ['front_15_degree', 'front_15_degree'],
    free_text_intent: '  clean   portrait  ',
  });
  assert.deepEqual(normalized.style_keywords, ['clean_magazine']);
  assert.deepEqual(normalized.target_face_angles, ['front_15_degree']);
  assert.deepEqual(normalized.required_face_visibility, ['high', 'medium']);
  assert.equal(normalized.allow_text_on_face, false);
  assert.equal(normalized.max_identity_preservation_risk, 'medium');
  assert.equal(normalized.max_generation_difficulty, 'high');
  assert.equal(normalized.diversity_preference, 'balanced');
  assert.equal(normalized.free_text_intent, 'clean portrait');

  assert.throws(
    () => normalizeTaskBrief(baseBrief({ style_keywords: ['clean_magazine'], avoid_keywords: ['clean_magazine'] })),
    /contradictory.*clean_magazine/i,
  );
  assert.throws(
    () => normalizeTaskBrief(baseBrief({ max_identity_preservation_risk: 'impossible' })),
    /unknown max_identity_preservation_risk/i,
  );
});

test('hard filters exclude identity-risk and text-on-face violations before ranking', () => {
  const ranked = rankTemplateCatalog({ catalog: fixtureCatalog(), taskBrief: baseBrief() });
  assert.equal(ranked.top10.some((item) => item.template_uid === 'tpl_fixture_dark_high'), false);
  assert.equal(ranked.top10.some((item) => item.template_uid === 'tpl_fixture_text_face'), false);
  assert.equal(ranked.filter_summary.rejection_counts.identity_risk_too_high, 1);
  assert.equal(ranked.filter_summary.rejection_counts.text_on_face_forbidden, 1);
  assert.equal(ranked.filter_summary.catalog_total, 9);
  assert.equal(ranked.filter_summary.eligible_count, 7);
});

test('Top10 ordering and explanations are deterministic and complete', () => {
  const catalog = fixtureCatalog();
  const first = rankTemplateCatalog({ catalog, taskBrief: baseBrief() });
  const second = rankTemplateCatalog({ catalog, taskBrief: baseBrief() });
  assert.deepEqual(first, second);
  assert.equal(first.top10[0].template_uid, 'tpl_fixture_clean_a');
  for (const candidate of first.top10) {
    assert.deepEqual(Object.keys(candidate.component_scores).sort(), [
      'composition_angle',
      'customer_compatibility',
      'observational_prior',
      'safety_stability',
      'style_use_case',
      'text_relevance',
    ]);
    assert.equal(Number.isFinite(candidate.relevance_score), true);
    assert.equal(Array.isArray(candidate.matched_evidence), true);
    assert.equal(typeof candidate.reason, 'string');
    assert.equal(JSON.stringify(candidate).includes('data/templates/'), false);
  }
});

test('complete eligible ranking is retained beyond Top10 without changing Top4 selection', () => {
  const catalog = fixtureCatalog();
  for (let index = 10; index <= 20; index += 1) {
    catalog.templates.push(templateEntry({
      uid: `tpl_fixture_more_${index}`,
      ordinal: index,
      name: `More ${index}`,
      style: 'clean_magazine',
      imageHash: `hash-more-${index}`,
      retrieval: 'clean professional restrained personal brand',
      prior: 80 - index,
    }));
  }
  catalog.summary.template_count = catalog.templates.length;
  const ranked = rankTemplateCatalog({ catalog, taskBrief: baseBrief() });
  assert.equal(ranked.ranked_candidates.length, ranked.filter_summary.eligible_count);
  assert.ok(ranked.ranked_candidates.length > 10);
  assert.deepEqual(ranked.ranked_candidates.slice(0, 10), ranked.top10);
  assert.equal(ranked.top4.length, 4);
});

test('Top4 avoids duplicate reference images when four unique eligible images exist', () => {
  const ranked = rankTemplateCatalog({ catalog: fixtureCatalog(), taskBrief: baseBrief() });
  assert.equal(ranked.top4.length, 4);
  assert.equal(new Set(ranked.top4.map((item) => item.reference_image.sha256)).size, 4);
  assert.equal(ranked.top4.some((item) => item.template_uid === 'tpl_fixture_clean_a'), true);
  assert.equal(ranked.top4.some((item) => item.template_uid === 'tpl_fixture_clean_b'), false);
});

test('narrow style keeps the Top4 inside the requested style and never relaxes a strict low-risk ceiling', () => {
  const narrow = rankTemplateCatalog({
    catalog: fixtureCatalog(),
    taskBrief: baseBrief({ diversity_preference: 'narrow' }),
  });
  assert.equal(narrow.top4.length, 4);
  assert.equal(narrow.top4.every((item) => item.selection_tags.style_category === 'clean_magazine'), true);

  const strict = rankTemplateCatalog({
    catalog: fixtureCatalog(),
    taskBrief: baseBrief({
      style_keywords: ['minimal_personal_brand'],
      max_identity_preservation_risk: 'low',
      max_generation_difficulty: 'medium',
    }),
  });
  assert.equal(strict.status, 'insufficient_candidates');
  assert.deepEqual(strict.top10.map((item) => item.template_uid), ['tpl_fixture_low_risk']);
  assert.deepEqual(strict.top4.map((item) => item.template_uid), ['tpl_fixture_low_risk']);
  assert.equal(strict.warnings.includes('insufficient_candidates'), true);
});

test('selection persistence writes an immutable request, two source events, and a path-safe projection', async () => {
  const root = await makeSelectionRoot();
  const result = await templateSelection.createTemplateSelection({
    root,
    idempotencyKey: 'fixture-operation-001',
    taskBrief: baseBrief(),
    recordedAt: '2026-08-15T12:00:00.000Z',
  });

  assert.equal(result.idempotent_replay, false);
  assert.match(result.selection.selection_id, /^sel_[a-f0-9]{24}$/);
  const directory = join(root, 'data', 'template-selections', result.selection.selection_id);
  const request = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'));
  const events = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  const projection = JSON.parse(await readFile(join(directory, 'selection.json'), 'utf8'));
  assert.equal(request.selection_identity.selection_id, result.selection.selection_id);
  assert.deepEqual(events.map((event) => event.type), ['TemplateSelectionRequested', 'TemplateSelectionCreated']);
  assert.deepEqual(projection.top10.map((item) => item.template_uid), result.selection.top10.map((item) => item.template_uid));
  assert.equal(JSON.stringify({ request, events, projection }).includes(root), false);
  assert.equal(JSON.stringify({ request, events, projection }).includes('customer_name'), false);
  assert.equal(JSON.stringify({ request, events, projection }).includes('identity_vector'), false);
});

test('selection create is idempotent for identical evidence and rejects same-key content changes', async () => {
  const root = await makeSelectionRoot();
  const first = await templateSelection.createTemplateSelection({
    root,
    idempotencyKey: 'fixture-operation-002',
    taskBrief: baseBrief(),
    recordedAt: '2026-08-15T12:01:00.000Z',
  });
  const replay = await templateSelection.createTemplateSelection({
    root,
    idempotencyKey: 'fixture-operation-002',
    taskBrief: baseBrief(),
    recordedAt: '2026-08-15T12:02:00.000Z',
  });
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.selection.selection_id, first.selection.selection_id);
  const directory = join(root, 'data', 'template-selections', first.selection.selection_id);
  assert.equal((await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split(/\r?\n/).length, 2);

  await assert.rejects(
    () => templateSelection.createTemplateSelection({
      root,
      idempotencyKey: 'fixture-operation-002',
      taskBrief: baseBrief({ free_text_intent: 'changed content' }),
      recordedAt: '2026-08-15T12:03:00.000Z',
    }),
    (error) => error?.code === 'idempotency_conflict' && error?.status === 409,
  );
});

test('selection projection rebuild reproduces business content from request and events', async () => {
  const root = await makeSelectionRoot();
  const created = await templateSelection.createTemplateSelection({
    root,
    idempotencyKey: 'fixture-operation-003',
    taskBrief: baseBrief(),
    recordedAt: '2026-08-15T12:04:00.000Z',
  });
  const directory = join(root, 'data', 'template-selections', created.selection.selection_id);
  await rm(join(directory, 'selection.json'));
  const rebuilt = await templateSelection.rebuildTemplateSelection({
    root,
    selectionId: created.selection.selection_id,
    recordedAt: '2026-08-15T12:05:00.000Z',
  });
  assert.deepEqual(selectionBusinessContent(rebuilt), selectionBusinessContent(created.selection));
  assert.equal((await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split(/\r?\n/).length, 2);
});

test('selection rebuild rejects a conflicting duplicate event idempotency key', async () => {
  const root = await makeSelectionRoot();
  const created = await templateSelection.createTemplateSelection({
    root,
    idempotencyKey: 'fixture-operation-004',
    taskBrief: baseBrief(),
    recordedAt: '2026-08-15T12:06:00.000Z',
  });
  const directory = join(root, 'data', 'template-selections', created.selection.selection_id);
  const firstEvent = JSON.parse((await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split(/\r?\n/)[0]);
  const conflicting = {
    ...firstEvent,
    event_id: 'conflicting-event-id',
    data: { ...firstEvent.data, request_hash: 'changed-request-hash' },
  };
  await appendFile(join(directory, 'events.jsonl'), `${JSON.stringify(conflicting)}\n`, 'utf8');
  await assert.rejects(
    () => templateSelection.rebuildTemplateSelection({ root, selectionId: created.selection.selection_id }),
    (error) => error?.code === 'selection_event_conflict' && error?.status === 409,
  );
});

test('selection creation fails before publication when the catalog is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-template-selection-missing-catalog-'));
  await assert.rejects(
    () => templateSelection.createTemplateSelection({
      root,
      idempotencyKey: 'fixture-operation-005',
      taskBrief: baseBrief(),
    }),
    (error) => error?.code === 'catalog_unavailable' && error?.status === 503,
  );
  await assert.rejects(() => readFile(join(root, 'data', 'template-selections'), 'utf8'), /ENOENT|EISDIR/);
});

test('decision recording preserves accepted, removed, substituted, and linked Run evidence idempotently', async () => {
  const root = await makeSelectionRoot();
  const created = await templateSelection.createTemplateSelection({
    root,
    idempotencyKey: 'fixture-operation-006',
    taskBrief: baseBrief(),
    recordedAt: '2026-08-15T12:07:00.000Z',
  });
  const accepted = created.selection.top4[0].template_uid;
  const removed = created.selection.top4[1].template_uid;
  const substitute = created.selection.top10.find((item) => !created.selection.top4.some((top4) => top4.template_uid === item.template_uid)).template_uid;
  const payload = {
    actor: 'primary-user',
    accepted_template_uids: [accepted],
    removed_template_uids: [removed],
    substitutions: [{ removed_template_uid: removed, added_template_uid: substitute, reason: 'fixture customer fit' }],
    linked_run_ids: ['run-fixture-001'],
    notes: 'fixture decision',
  };
  const decided = await templateSelection.recordTemplateSelectionDecision({
    root,
    selectionId: created.selection.selection_id,
    decisionIdempotencyKey: 'fixture-decision-001',
    decision: payload,
    recordedAt: '2026-08-15T12:08:00.000Z',
  });
  assert.equal(decided.idempotent_replay, false);
  assert.equal(decided.selection.status, 'decision_recorded');
  assert.deepEqual(decided.selection.decision.accepted_template_uids, [accepted]);
  assert.deepEqual(decided.selection.decision.removed_template_uids, [removed]);
  assert.deepEqual(decided.selection.decision.substitutions, payload.substitutions);
  assert.deepEqual(decided.selection.linked_run_ids, ['run-fixture-001']);

  const replay = await templateSelection.recordTemplateSelectionDecision({
    root,
    selectionId: created.selection.selection_id,
    decisionIdempotencyKey: 'fixture-decision-001',
    decision: payload,
    recordedAt: '2026-08-15T12:09:00.000Z',
  });
  assert.equal(replay.idempotent_replay, true);
  const directory = join(root, 'data', 'template-selections', created.selection.selection_id);
  assert.equal((await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split(/\r?\n/).length, 3);

  await assert.rejects(
    () => templateSelection.recordTemplateSelectionDecision({
      root,
      selectionId: created.selection.selection_id,
      decisionIdempotencyKey: 'fixture-decision-001',
      decision: { ...payload, notes: 'changed decision content' },
    }),
    (error) => error?.code === 'decision_idempotency_conflict' && error?.status === 409,
  );
});

test('decision rejects unknown accepted templates and hard-filter-ineligible substitutions', async () => {
  const root = await makeSelectionRoot();
  const created = await templateSelection.createTemplateSelection({
    root,
    idempotencyKey: 'fixture-operation-007',
    taskBrief: baseBrief(),
  });
  await assert.rejects(
    () => templateSelection.recordTemplateSelectionDecision({
      root,
      selectionId: created.selection.selection_id,
      decisionIdempotencyKey: 'fixture-decision-invalid',
      decision: { actor: 'primary-user', accepted_template_uids: ['tpl_fixture_unknown'] },
    }),
    (error) => error?.code === 'invalid_decision' && error?.status === 400,
  );
  await assert.rejects(
    () => templateSelection.recordTemplateSelectionDecision({
      root,
      selectionId: created.selection.selection_id,
      decisionIdempotencyKey: 'fixture-decision-unsafe',
      decision: {
        actor: 'primary-user',
        accepted_template_uids: [created.selection.top4[0].template_uid],
        removed_template_uids: [created.selection.top4[1].template_uid],
        substitutions: [{
          removed_template_uid: created.selection.top4[1].template_uid,
          added_template_uid: 'tpl_fixture_dark_high',
          reason: 'should be rejected by original risk ceiling',
        }],
      },
    }),
    (error) => error?.code === 'unsafe_substitution' && error?.status === 422,
  );
});

test('outcomes separate identity eligibility from aesthetic statistics and rebuild inactive template performance', async () => {
  const root = await makeSelectionRoot();
  const catalog = fixtureCatalog();
  const created = await templateSelection.createTemplateSelection({
    root,
    idempotencyKey: 'fixture-operation-008',
    taskBrief: baseBrief(),
  });
  const templateUid = created.selection.top4[0].template_uid;
  const template = catalog.templates.find((item) => item.template_uid === templateUid);
  await templateSelection.recordTemplateSelectionDecision({
    root,
    selectionId: created.selection.selection_id,
    decisionIdempotencyKey: 'fixture-decision-outcomes',
    decision: { actor: 'primary-user', accepted_template_uids: [templateUid], linked_run_ids: ['run-fixture-outcomes'] },
  });
  const common = {
    run_id: 'run-fixture-outcomes',
    template_uid: templateUid,
    reference_image_sha256: template.reference_image.sha256,
    generation_blueprint_sha256: fixtureHash(template.generation_blueprint),
    catalog_projection_version: catalog.projection_version,
    ranking_policy_version: 'template-ranking-v1',
    rubric_version: 'portrait-review-v3',
    reviewer_id: 'primary-user',
    preference_session_id: 'preference-fixture-outcomes',
    preference_source_event_id: 'preference-event-fixture-outcomes',
    excluded_from_learning: false,
  };
  const passed = await templateSelection.recordTemplateSelectionOutcome({
    root,
    selectionId: created.selection.selection_id,
    outcomeIdempotencyKey: 'fixture-outcome-pass',
    outcome: {
      ...common,
      artifact_id: 'artifact-pass',
      artifact_sha256: 'a'.repeat(64),
      review_session_id: 'review-pass',
      review_source_event_id: 'review-event-pass',
      scores: { face_consistency: 9.1, naturalness: 8.4, style_consistency: 8.8 },
      preference_result: 'winner',
    },
  });
  assert.equal(passed.selection.outcomes[0].identity_eligible, true);
  assert.equal(passed.selection.outcomes[0].aesthetic_eligible, true);

  const failed = await templateSelection.recordTemplateSelectionOutcome({
    root,
    selectionId: created.selection.selection_id,
    outcomeIdempotencyKey: 'fixture-outcome-face-fail',
    outcome: {
      ...common,
      artifact_id: 'artifact-face-fail',
      artifact_sha256: 'b'.repeat(64),
      review_session_id: 'review-face-fail',
      review_source_event_id: 'review-event-face-fail',
      scores: { face_consistency: 5.0, naturalness: 9.5, style_consistency: 9.6 },
      preference_result: 'eligible_not_selected',
    },
  });
  assert.equal(failed.selection.outcomes[1].identity_eligible, false);
  assert.equal(failed.selection.outcomes[1].aesthetic_eligible, false);
  assert.equal(failed.selection.outcomes[1].exclusion_reasons.includes('face_consistency_failed'), true);

  const qualityFailed = await templateSelection.recordTemplateSelectionOutcome({
    root,
    selectionId: created.selection.selection_id,
    outcomeIdempotencyKey: 'fixture-outcome-naturalness-fail',
    outcome: {
      ...common,
      artifact_id: 'artifact-naturalness-fail',
      artifact_sha256: 'c'.repeat(64),
      review_session_id: 'review-naturalness-fail',
      review_source_event_id: 'review-event-naturalness-fail',
      scores: { face_consistency: 9.0, naturalness: 6.9, style_consistency: 9.0 },
      preference_result: 'eligible_not_selected',
    },
  });
  assert.equal(qualityFailed.selection.outcomes[2].identity_eligible, true);
  assert.equal(qualityFailed.selection.outcomes[2].aesthetic_eligible, false);
  assert.equal(qualityFailed.selection.outcomes[2].exclusion_reasons.includes('naturalness_failed'), true);

  const performance = await templateSelection.rebuildTemplatePerformance({
    root,
    recordedAt: '2026-08-15T12:10:00.000Z',
  });
  const stats = performance.templates.find((item) => item.template_uid === templateUid);
  assert.equal(performance.schema_version, 'ai-img-gen.template-performance.v2');
  assert.equal(performance.status, 'inactive_insufficient_evidence');
  assert.equal(stats.choice_support_count, 1);
  assert.equal(stats.outcome_support_count, 0, 'missing Run projection must not become real support');
  assert.equal(performance.deferred.length, 1);
  assert.equal(performance.deferred[0].reason, 'run_projection_missing');
  assert.equal(performance.production_ranking_active, false);
  assert.equal(JSON.stringify(performance).includes('fixture_customer'), false);
});

test('outcome recording rejects template usage hashes that do not match the catalog', async () => {
  const root = await makeSelectionRoot();
  const created = await templateSelection.createTemplateSelection({
    root,
    idempotencyKey: 'fixture-operation-009',
    taskBrief: baseBrief(),
  });
  const templateUid = created.selection.top4[0].template_uid;
  await templateSelection.recordTemplateSelectionDecision({
    root,
    selectionId: created.selection.selection_id,
    decisionIdempotencyKey: 'fixture-decision-hash-mismatch',
    decision: { actor: 'primary-user', accepted_template_uids: [templateUid], linked_run_ids: ['run-hash-mismatch'] },
  });
  await assert.rejects(
    () => templateSelection.recordTemplateSelectionOutcome({
      root,
      selectionId: created.selection.selection_id,
      outcomeIdempotencyKey: 'fixture-outcome-hash-mismatch',
      outcome: {
        run_id: 'run-hash-mismatch',
        artifact_id: 'artifact-hash-mismatch',
        artifact_sha256: 'd'.repeat(64),
        template_uid: templateUid,
        reference_image_sha256: 'wrong-reference-hash',
        generation_blueprint_sha256: 'wrong-blueprint-hash',
        catalog_projection_version: 'ai-img-gen.template-catalog.v1',
        ranking_policy_version: 'template-ranking-v1',
        rubric_version: 'portrait-review-v3',
        review_session_id: 'review-hash-mismatch',
        reviewer_id: 'primary-user',
        preference_session_id: 'preference-hash-mismatch',
        review_source_event_id: 'review-event-hash-mismatch',
        preference_source_event_id: 'preference-event-hash-mismatch',
        scores: { face_consistency: 9, naturalness: 8, style_consistency: 8 },
        preference_result: 'winner',
        excluded_from_learning: false,
      },
    }),
    (error) => error?.code === 'template_usage_mismatch' && error?.status === 422,
  );
});

test('outcome writer resumes an invalidated unsuperseded Outcome after an interrupted replacement append', async () => {
  const root = await makeSelectionRoot();
  const catalog = fixtureCatalog();
  const created = await templateSelection.createTemplateSelection({
    root,
    idempotencyKey: 'fixture-operation-interrupted-replacement',
    taskBrief: baseBrief(),
  });
  const templateUid = created.selection.top4[0].template_uid;
  const template = catalog.templates.find((item) => item.template_uid === templateUid);
  await templateSelection.recordTemplateSelectionDecision({
    root,
    selectionId: created.selection.selection_id,
    decisionIdempotencyKey: 'fixture-decision-interrupted-replacement',
    decision: { actor: 'primary-user', accepted_template_uids: [templateUid], linked_run_ids: ['run-interrupted-replacement'] },
  });
  const baseOutcome = {
    run_id: 'run-interrupted-replacement',
    artifact_id: 'artifact-interrupted-replacement',
    artifact_sha256: 'e'.repeat(64),
    template_uid: templateUid,
    reference_image_sha256: template.reference_image.sha256,
    generation_blueprint_sha256: fixtureHash(template.generation_blueprint),
    catalog_projection_version: catalog.projection_version,
    ranking_policy_version: 'template-ranking-v1',
    rubric_version: 'portrait-review-v3',
    review_session_id: 'review-session-original',
    reviewer_id: 'primary-user',
    preference_session_id: 'preference-session-original',
    review_source_event_id: 'review-event-original',
    preference_source_event_id: 'preference-event-original',
    scores: { face_consistency: 9, naturalness: 8, style_consistency: 8 },
    preference_result: 'winner',
    excluded_from_learning: false,
  };
  const first = await templateSelection.recordTemplateSelectionOutcome({
    root,
    selectionId: created.selection.selection_id,
    outcomeIdempotencyKey: 'fixture-outcome-interrupted-original',
    outcome: baseOutcome,
    recordedAt: '2026-08-31T15:00:00.000Z',
  });
  const originalOutcome = first.selection.active_outcomes[0];
  const interruptedInvalidation = createTemplateSelectionOutcomeInvalidated({
    selection_id: created.selection.selection_id,
    outcome_id: originalOutcome.outcome_id,
    artifact_id: originalOutcome.artifact_id,
    reason: 'review_revised',
    review_source_event_id: 'review-event-revised',
    preference_source_event_id: 'preference-event-pending',
    recorded_at: '2026-08-31T15:01:00.000Z',
  });
  const eventsPath = join(root, 'data', 'template-selections', created.selection.selection_id, 'events.jsonl');
  await appendFile(eventsPath, `${JSON.stringify(interruptedInvalidation)}\n`, 'utf8');

  const resumed = await templateSelection.recordTemplateSelectionOutcome({
    root,
    selectionId: created.selection.selection_id,
    outcomeIdempotencyKey: 'fixture-outcome-interrupted-revised',
    outcome: {
      ...baseOutcome,
      review_session_id: 'review-session-revised',
      review_source_event_id: 'review-event-revised',
      preference_session_id: 'preference-session-final',
      preference_source_event_id: 'preference-event-final',
      scores: { face_consistency: 9.2, naturalness: 8.5, style_consistency: 8.6 },
    },
    recordedAt: '2026-08-31T15:02:00.000Z',
  });
  assert.equal(resumed.selection.active_outcomes.length, 1);
  assert.equal(resumed.selection.active_outcomes[0].supersedes_outcome_id, originalOutcome.outcome_id);
  assert.equal(resumed.selection.outcome_history.find((item) => item.outcome_id === originalOutcome.outcome_id).lifecycle_state, 'superseded');
});

test('concurrent Outcome revisions serialize into one linear supersession chain', async () => {
  const root = await makeSelectionRoot();
  const catalog = fixtureCatalog();
  const created = await templateSelection.createTemplateSelection({
    root,
    idempotencyKey: 'fixture-operation-concurrent-outcome-revisions',
    taskBrief: baseBrief(),
  });
  const templateUid = created.selection.top4[0].template_uid;
  const template = catalog.templates.find((item) => item.template_uid === templateUid);
  await templateSelection.recordTemplateSelectionDecision({
    root,
    selectionId: created.selection.selection_id,
    decisionIdempotencyKey: 'fixture-decision-concurrent-outcome-revisions',
    decision: { actor: 'primary-user', accepted_template_uids: [templateUid], linked_run_ids: ['run-concurrent-outcome-revisions'] },
  });
  const baseOutcome = {
    run_id: 'run-concurrent-outcome-revisions',
    artifact_id: 'artifact-concurrent-outcome-revisions',
    artifact_sha256: 'f'.repeat(64),
    template_uid: templateUid,
    reference_image_sha256: template.reference_image.sha256,
    generation_blueprint_sha256: fixtureHash(template.generation_blueprint),
    catalog_projection_version: catalog.projection_version,
    ranking_policy_version: 'template-ranking-v1',
    rubric_version: 'portrait-review-v3',
    reviewer_id: 'primary-user',
    preference_result: 'winner',
    excluded_from_learning: false,
  };
  await templateSelection.recordTemplateSelectionOutcome({
    root,
    selectionId: created.selection.selection_id,
    outcomeIdempotencyKey: 'fixture-outcome-concurrent-original',
    outcome: {
      ...baseOutcome,
      review_session_id: 'review-session-concurrent-original',
      preference_session_id: 'preference-session-concurrent-original',
      review_source_event_id: 'review-event-concurrent-original',
      preference_source_event_id: 'preference-event-concurrent-original',
      scores: { face_consistency: 9, naturalness: 8, style_consistency: 8 },
    },
  });

  const revisions = await Promise.all([
    templateSelection.recordTemplateSelectionOutcome({
      root,
      selectionId: created.selection.selection_id,
      outcomeIdempotencyKey: 'fixture-outcome-concurrent-revision-a',
      outcome: {
        ...baseOutcome,
        review_session_id: 'review-session-concurrent-a',
        preference_session_id: 'preference-session-concurrent-a',
        review_source_event_id: 'review-event-concurrent-a',
        preference_source_event_id: 'preference-event-concurrent-a',
        scores: { face_consistency: 9.1, naturalness: 8.1, style_consistency: 8.1 },
      },
    }),
    templateSelection.recordTemplateSelectionOutcome({
      root,
      selectionId: created.selection.selection_id,
      outcomeIdempotencyKey: 'fixture-outcome-concurrent-revision-b',
      outcome: {
        ...baseOutcome,
        review_session_id: 'review-session-concurrent-b',
        preference_session_id: 'preference-session-concurrent-b',
        review_source_event_id: 'review-event-concurrent-b',
        preference_source_event_id: 'preference-event-concurrent-b',
        scores: { face_consistency: 9.2, naturalness: 8.2, style_consistency: 8.2 },
      },
    }),
  ]);

  assert.equal(revisions.every((result) => result.idempotent_replay === false), true);
  const rebuilt = await templateSelection.rebuildTemplateSelection({ root, selectionId: created.selection.selection_id });
  assert.equal(rebuilt.active_outcomes.length, 1);
  assert.equal(rebuilt.outcome_history.length, 3);
  assert.equal(rebuilt.outcome_history.filter((outcome) => outcome.lifecycle_state === 'superseded').length, 2);
  assert.equal(new Set(rebuilt.outcome_history.map((outcome) => outcome.outcome_id)).size, 3);
});
