import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  importTemplateCatalog,
  inspectTemplateSource,
  listTemplates,
  loadTemplate,
  rebuildTemplateCatalog,
  resolveTemplateReference,
} from '../src/template-catalog.mjs';

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function sourceTemplate({ id, name, style = 'studio', risk = 'low', difficulty = 'medium', retrieval = 'clean portrait' }) {
  return {
    template_info: {
      template_id: id,
      template_name: name,
      source_image: `${id}.png`,
    },
    selection_tags: {
      style_category: style,
      portrait_scale: 'headshot',
      face_angle: 'frontal',
      identity_preservation_risk: risk,
      generation_difficulty: difficulty,
    },
    retrieval_text: retrieval,
    generation_blueprint: {
      composition: { framing: 'headshot' },
      subject_design: { pose: 'natural' },
      camera_and_angle: { face_angle: 'frontal' },
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

async function makeSource({ malformedOrdinal = null, missingImageOrdinal = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-template-source-'));
  const jsonDir = join(root, '输出结果', 'run_20260604-191910917');
  const imageDir = join(root, '例图');
  const indexDir = join(root, '模板索引');
  await Promise.all([
    mkdir(jsonDir, { recursive: true }),
    mkdir(imageDir, { recursive: true }),
    mkdir(indexDir, { recursive: true }),
  ]);
  const templates = [
    sourceTemplate({ id: 'soft_studio_001', name: 'Soft Studio', retrieval: 'soft clean studio portrait' }),
    sourceTemplate({ id: 'dark_editorial_001', name: 'Dark Editorial', style: 'editorial', risk: 'high', difficulty: 'high', retrieval: 'dark editorial portrait' }),
  ];
  for (const [index, source] of templates.entries()) {
    const ordinal = index + 1;
    const text = ordinal === malformedOrdinal ? '{not json' : JSON.stringify(source, null, 2);
    await writeFile(join(jsonDir, `${ordinal}.txt`), text, 'utf8');
    if (ordinal !== missingImageOrdinal) await writeFile(join(imageDir, `${ordinal}.png`), onePixelPng);
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

test('source preflight validates every JSON-image-index mapping and preserves duplicate images as separate templates', async () => {
  const sourceRoot = await makeSource();
  const inspection = await inspectTemplateSource({ sourceRoot, expectedCount: 2 });

  assert.equal(inspection.template_count, 2);
  assert.equal(inspection.image_count, 2);
  assert.equal(inspection.unique_template_ids, 2);
  assert.equal(inspection.duplicate_image_groups.length, 1);
  assert.deepEqual(inspection.duplicate_image_groups[0].template_uids, [
    'tpl_temp_aiimg_dark_editorial_001',
    'tpl_temp_aiimg_soft_studio_001',
  ]);
  assert.equal(inspection.templates[0].decision_uses.selection_tags, 'filtering_and_risk_gating');
  assert.equal(inspection.templates[0].observational_prior.evidence_space, 'course_observational_prior');
});

test('preflight rejects a malformed or incomplete batch before persistent catalog publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-template-destination-'));
  const malformed = await makeSource({ malformedOrdinal: 2 });
  await assert.rejects(
    () => importTemplateCatalog({ root, sourceRoot: malformed, expectedCount: 2 }),
    /2\.txt.*valid JSON/i,
  );
  const missing = await makeSource({ missingImageOrdinal: 2 });
  await assert.rejects(
    () => importTemplateCatalog({ root, sourceRoot: missing, expectedCount: 2 }),
    /reference image.*2/i,
  );
  await assert.rejects(() => readFile(join(root, 'data', 'projections', 'template-catalog.json'), 'utf8'), /ENOENT/);
});

test('Windows directory publication tolerates one transient EPERM from antivirus or indexing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-template-windows-rename-'));
  let renameAttempts = 0;
  const result = await importTemplateCatalog({
    root,
    sourceRoot: await makeSource(),
    expectedCount: 2,
    renameDirectory: async (from, to) => {
      renameAttempts += 1;
      if (renameAttempts === 1) {
        const error = new Error('simulated Windows scanner lock');
        error.code = 'EPERM';
        throw error;
      }
      await rename(from, to);
    },
  });
  assert.equal(result.added_templates, 2);
  assert.equal(renameAttempts, 3);
});

test('import is immutable and idempotent, and rebuilds the same catalog from append-only events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-template-import-'));
  const sourceRoot = await makeSource();

  const first = await importTemplateCatalog({ root, sourceRoot, expectedCount: 2 });
  const second = await importTemplateCatalog({ root, sourceRoot, expectedCount: 2 });
  assert.equal(first.added_templates, 2);
  assert.equal(first.unchanged_templates, 0);
  assert.equal(second.added_templates, 0);
  assert.equal(second.unchanged_templates, 2);

  const eventText = await readFile(join(root, 'data', 'events', 'template-catalog.jsonl'), 'utf8');
  assert.equal(eventText.trim().split(/\r?\n/).length, 3);
  assert.equal((await readdir(join(root, 'data', 'templates'))).length, 2);

  const originalProjection = JSON.parse(await readFile(join(root, 'data', 'projections', 'template-catalog.json'), 'utf8'));
  const rebuilt = await rebuildTemplateCatalog({ root });
  assert.deepEqual(rebuilt.templates, originalProjection.templates);
  assert.deepEqual(rebuilt.summary, originalProjection.summary);

  const sourceFile = join(sourceRoot, '输出结果', 'run_20260604-191910917', '1.txt');
  const changed = JSON.parse(await readFile(sourceFile, 'utf8'));
  changed.retrieval_text = 'changed source must not overwrite';
  await writeFile(sourceFile, JSON.stringify(changed, null, 2), 'utf8');
  await assert.rejects(
    () => importTemplateCatalog({ root, sourceRoot, expectedCount: 2 }),
    /changed source.*tpl_temp_aiimg_soft_studio_001/i,
  );
});

test('catalog queries filter and search without exposing absolute paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-template-query-'));
  await importTemplateCatalog({ root, sourceRoot: await makeSource(), expectedCount: 2 });

  const result = await listTemplates({
    root,
    filters: { style_category: 'editorial', identity_preservation_risk: 'high', q: 'dark' },
    limit: 10,
    offset: 0,
  });
  assert.equal(result.total, 1);
  assert.equal(result.templates[0].template_uid, 'tpl_temp_aiimg_dark_editorial_001');
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.equal(JSON.stringify(result).includes('source_json_path'), false);

  await assert.rejects(
    () => listTemplates({ root, filters: { identity_preservation_risk: 'impossible' } }),
    /unknown identity_preservation_risk/i,
  );
  const detail = await loadTemplate({ root, templateUid: 'tpl_temp_aiimg_soft_studio_001' });
  assert.deepEqual(detail.generation_blueprint.negative_prompt_rules, ['do not change identity']);
  await assert.rejects(() => loadTemplate({ root, templateUid: '../escape' }), /invalid template uid/i);

  const reference = await resolveTemplateReference({ root, templateUid: detail.template_uid });
  assert.deepEqual(await readFile(reference.path), onePixelPng);
  assert.equal(reference.mime_type, 'image/png');
});

test('Node server declares path-safe list, detail and reference routes without legacy Python authority', async () => {
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /listTemplates/);
  assert.match(server, /loadTemplate/);
  assert.match(server, /resolveTemplateReference/);
  assert.match(server, /req\.method === 'GET'.*url\.pathname === '\/api\/templates'/s);
  assert.match(server, /templateRoute/);
  assert.match(server, /templateReferenceRoute/);
  assert.doesNotMatch(server, /src\/ai_img_gen|python.*template/i);
});
