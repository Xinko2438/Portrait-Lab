import { createHash, randomUUID } from 'node:crypto';
import { loadTemplateExclusions } from './face-tag-store.mjs';
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

const SOURCE_NAMESPACE = 'temp_AIimg';
const PROJECTION_VERSION = 'ai-img-gen.template-catalog.v1';
const EVENT_VERSION = 'ai-img-gen.template-catalog-event.v1';
const DEFAULT_EXPECTED_COUNT = 124;
const SOURCE_JSON_RELATIVE = ['输出结果', 'run_20260604-191910917'];
const SOURCE_IMAGE_RELATIVE = ['例图'];
const SOURCE_INDEX_RELATIVE = ['模板索引', 'current_template_index.json'];
const CATEGORY_FILTERS = [
  'style_category',
  'portrait_scale',
  'face_angle',
  'identity_preservation_risk',
  'generation_difficulty',
];
const IMAGE_MIME = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

function withoutBom(text) {
  return text.replace(/^\uFEFF/, '');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceIdSlug(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function templateUid(sourceTemplateId) {
  const slug = sourceIdSlug(sourceTemplateId);
  if (!slug) throw new Error('template_info.template_id must contain a stable identifier');
  return `tpl_temp_aiimg_${slug}`;
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertTemplateUid(value) {
  if (!/^tpl_temp_aiimg_[a-z0-9_-]+$/.test(String(value || ''))) throw new Error('Invalid template uid');
}

function assertInside(path, root, label) {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${label} escaped its allowed root`);
  return resolvedPath;
}

function publicEntry(entry, { detail = false } = {}) {
  const base = {
    template_uid: entry.template_uid,
    source_namespace: entry.source_namespace,
    source_template_id: entry.source_template_id,
    source_ordinal: entry.source_ordinal,
    template_info: entry.template_info,
    selection_tags: entry.selection_tags,
    retrieval_text: entry.retrieval_text,
    reference_image: {
      url: `/api/templates/${entry.template_uid}/reference`,
      sha256: entry.reference_image.sha256,
      bytes: entry.reference_image.bytes,
      mime_type: entry.reference_image.mime_type,
      extension: entry.reference_image.extension,
      duplicate_hash_group_size: entry.reference_image.duplicate_hash_group_size,
    },
    source_hashes: entry.source_hashes,
    observational_prior: entry.observational_prior,
    decision_uses: entry.decision_uses,
  };
  if (detail) {
    base.generation_blueprint = entry.generation_blueprint;
    base.negative_prompt_rules = entry.negative_prompt_rules;
  }
  return base;
}

async function readJsonFile(path, label = basename(path)) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw error;
  }
  try {
    return JSON.parse(withoutBom(text));
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${error.message}`);
  }
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

async function readEvents(path) {
  try {
    const text = await readFile(path, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`template catalog event line ${index + 1} is invalid: ${error.message}`);
      }
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function histogram(entries, tag) {
  const result = {};
  for (const entry of entries) {
    const value = String(entry.selection_tags?.[tag] || 'unlabeled');
    result[value] = (result[value] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function duplicateImageGroups(entries) {
  const byHash = new Map();
  for (const entry of entries) {
    const hash = entry.reference_image.sha256;
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(entry.template_uid);
  }
  return [...byHash.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([image_sha256, ids]) => ({ image_sha256, template_uids: ids.sort() }))
    .sort((a, b) => a.image_sha256.localeCompare(b.image_sha256));
}

function catalogSummary(entries) {
  return {
    template_count: entries.length,
    unique_source_template_ids: new Set(entries.map((entry) => entry.source_template_id)).size,
    unique_reference_images: new Set(entries.map((entry) => entry.reference_image.sha256)).size,
    identity_preservation_risk: histogram(entries, 'identity_preservation_risk'),
    generation_difficulty: histogram(entries, 'generation_difficulty'),
    duplicate_image_groups: duplicateImageGroups(entries),
  };
}

function normalizeSource({ source, ordinal, sourceJsonBytes, imageBytes, imagePath }) {
  assertObject(source, `${ordinal}.txt`);
  assertObject(source.template_info, `${ordinal}.txt template_info`);
  assertObject(source.selection_tags, `${ordinal}.txt selection_tags`);
  assertObject(source.generation_blueprint, `${ordinal}.txt generation_blueprint`);
  const sourceTemplateId = String(source.template_info.template_id || '').trim();
  const sourceTemplateName = String(source.template_info.template_name || source.template_info.name || '').trim();
  if (!sourceTemplateId) throw new Error(`${ordinal}.txt template_info.template_id is required`);
  if (!sourceTemplateName) throw new Error(`${ordinal}.txt template_info.template_name is required`);
  if (!String(source.retrieval_text || '').trim()) throw new Error(`${ordinal}.txt retrieval_text is required`);
  const extension = extname(imagePath).toLowerCase();
  if (!IMAGE_MIME.has(extension)) throw new Error(`Unsupported reference image extension for ordinal ${ordinal}`);
  const uid = templateUid(sourceTemplateId);
  const jsonHash = sha256(sourceJsonBytes);
  const imageHash = sha256(imageBytes);
  const scoring = source.scoring_notes && typeof source.scoring_notes === 'object' ? source.scoring_notes : {};
  return {
    template_uid: uid,
    source_namespace: SOURCE_NAMESPACE,
    source_template_id: sourceTemplateId,
    source_ordinal: ordinal,
    template_info: source.template_info,
    selection_tags: source.selection_tags,
    retrieval_text: String(source.retrieval_text),
    generation_blueprint: source.generation_blueprint,
    negative_prompt_rules: Array.isArray(source.generation_blueprint.negative_prompt_rules)
      ? source.generation_blueprint.negative_prompt_rules
      : [],
    observational_prior: {
      evidence_space: 'course_observational_prior',
      source_rubric: scoring.score_scale || null,
      aesthetic_score: scoring.aesthetic_score ?? null,
      commercial_score: scoring.commercial_score ?? null,
      identity_preservation_score: scoring.identity_preservation_score ?? null,
      generation_stability_score: scoring.generation_stability_score ?? null,
      personal_preference_score: scoring.personal_preference_score ?? null,
      total_manual_score: scoring.total_manual_score ?? null,
      human_reason: scoring.human_reason || '',
      human_correction_rules: Array.isArray(scoring.human_correction_rules) ? scoring.human_correction_rules : [],
    },
    source_hashes: {
      json_sha256: jsonHash,
      reference_image_sha256: imageHash,
    },
    source_json_path: `data/templates/${uid}/source.json`,
    reference_image_path: `data/templates/${uid}/reference${extension}`,
    reference_image: {
      sha256: imageHash,
      bytes: imageBytes.length,
      mime_type: IMAGE_MIME.get(extension),
      extension,
      duplicate_hash_group_size: 1,
    },
    decision_uses: {
      template_info: 'display_and_provenance',
      selection_tags: 'filtering_and_risk_gating',
      retrieval_text: 'future_retrieval',
      generation_blueprint: 'future_prompt_assembly',
      negative_prompt_rules: 'future_quality_gating',
      observational_prior: 'cold_start_ranking_prior_only',
      source_hashes: 'rebuild_and_debugging',
    },
    _source: { sourceJsonBytes, imageBytes },
  };
}

export async function inspectTemplateSource({ sourceRoot, expectedCount = DEFAULT_EXPECTED_COUNT }) {
  if (!sourceRoot || !isAbsolute(String(sourceRoot))) throw new Error('sourceRoot must be an absolute path');
  const root = resolve(String(sourceRoot));
  const jsonDir = assertInside(join(root, ...SOURCE_JSON_RELATIVE), root, 'template JSON directory');
  const imageDir = assertInside(join(root, ...SOURCE_IMAGE_RELATIVE), root, 'template image directory');
  const indexPath = assertInside(join(root, ...SOURCE_INDEX_RELATIVE), root, 'template index');
  const [jsonEntries, imageEntries, index] = await Promise.all([
    readdir(jsonDir, { withFileTypes: true }),
    readdir(imageDir, { withFileTypes: true }),
    readJsonFile(indexPath, 'current_template_index.json'),
  ]);
  const jsonFiles = jsonEntries
    .filter((entry) => entry.isFile() && /^\d+\.txt$/i.test(entry.name))
    .map((entry) => ({ entry, ordinal: Number.parseInt(entry.name, 10) }))
    .sort((a, b) => a.ordinal - b.ordinal);
  const imageByOrdinal = new Map();
  for (const entry of imageEntries.filter((item) => item.isFile() && /^\d+\.(?:jpe?g|png|webp)$/i.test(item.name))) {
    const ordinal = Number.parseInt(entry.name, 10);
    if (imageByOrdinal.has(ordinal)) throw new Error(`Multiple reference images found for ordinal ${ordinal}`);
    imageByOrdinal.set(ordinal, join(imageDir, entry.name));
  }
  if (jsonFiles.length !== expectedCount) throw new Error(`Expected ${expectedCount} template JSON files, found ${jsonFiles.length}`);
  const missingImageOrdinals = jsonFiles.map(({ ordinal }) => ordinal).filter((ordinal) => !imageByOrdinal.has(ordinal));
  if (missingImageOrdinals.length) throw new Error(`Reference image for ordinal ${missingImageOrdinals.join(', ')} is missing`);
  if (imageByOrdinal.size !== expectedCount) throw new Error(`Expected ${expectedCount} reference images, found ${imageByOrdinal.size}`);
  assertObject(index, 'current_template_index.json');
  if (!Array.isArray(index.templates) || index.templates.length !== expectedCount || Number(index.template_count) !== expectedCount) {
    throw new Error(`Template index must contain exactly ${expectedCount} templates`);
  }
  const indexIds = new Map(index.templates.map((item) => [Number.parseInt(item.txt_filename, 10), String(item.template_id || '')]));
  const normalized = [];
  const sourceIds = new Set();
  const uids = new Set();
  for (const { entry, ordinal } of jsonFiles) {
    const imagePath = imageByOrdinal.get(ordinal);
    if (!imagePath) throw new Error(`Reference image for ordinal ${ordinal} is missing`);
    const sourceJsonPath = join(jsonDir, entry.name);
    const [sourceJsonBytes, imageBytes] = await Promise.all([readFile(sourceJsonPath), readFile(imagePath)]);
    let source;
    try {
      source = JSON.parse(withoutBom(sourceJsonBytes.toString('utf8')));
    } catch (error) {
      throw new Error(`${entry.name} must contain valid JSON: ${error.message}`);
    }
    const item = normalizeSource({ source, ordinal, sourceJsonBytes, imageBytes, imagePath });
    if (sourceIds.has(item.source_template_id)) throw new Error(`Duplicate source template id: ${item.source_template_id}`);
    if (uids.has(item.template_uid)) throw new Error(`Template ids collide after normalization: ${item.template_uid}`);
    if (indexIds.get(ordinal) !== item.source_template_id) {
      throw new Error(`Template index mismatch for ordinal ${ordinal}`);
    }
    sourceIds.add(item.source_template_id);
    uids.add(item.template_uid);
    normalized.push(item);
  }
  const duplicates = duplicateImageGroups(normalized);
  const duplicateSizes = new Map();
  for (const group of duplicates) for (const uid of group.template_uids) duplicateSizes.set(uid, group.template_uids.length);
  for (const entry of normalized) entry.reference_image.duplicate_hash_group_size = duplicateSizes.get(entry.template_uid) || 1;
  return {
    source_namespace: SOURCE_NAMESPACE,
    expected_count: expectedCount,
    template_count: normalized.length,
    image_count: imageByOrdinal.size,
    index_count: index.templates.length,
    unique_template_ids: sourceIds.size,
    unique_image_hashes: new Set(normalized.map((entry) => entry.reference_image.sha256)).size,
    duplicate_image_groups: duplicates,
    templates: normalized,
  };
}

function projectionFromEvents(events) {
  const byUid = new Map();
  for (const event of events) {
    if (event.event_type !== 'TemplateImported') continue;
    const entry = event.data?.template;
    if (!entry?.template_uid) continue;
    if (byUid.has(entry.template_uid)) {
      const existing = byUid.get(entry.template_uid);
      if (existing.source_hashes?.json_sha256 !== entry.source_hashes?.json_sha256
        || existing.source_hashes?.reference_image_sha256 !== entry.source_hashes?.reference_image_sha256) {
        throw new Error(`Conflicting import events for ${entry.template_uid}`);
      }
      continue;
    }
    byUid.set(entry.template_uid, entry);
  }
  const templates = [...byUid.values()].sort((a, b) => a.source_ordinal - b.source_ordinal || a.template_uid.localeCompare(b.template_uid));
  return {
    schema_version: PROJECTION_VERSION,
    source_namespace: SOURCE_NAMESPACE,
    projection_version: PROJECTION_VERSION,
    rebuilt_at: new Date().toISOString(),
    summary: catalogSummary(templates),
    templates,
  };
}

export async function rebuildTemplateCatalog({ root }) {
  const eventsPath = join(root, 'data', 'events', 'template-catalog.jsonl');
  const projection = projectionFromEvents(await readEvents(eventsPath));
  for (const entry of projection.templates) {
    const jsonPath = assertInside(join(root, ...entry.source_json_path.split('/')), join(root, 'data', 'templates'), 'source JSON');
    const imagePath = assertInside(join(root, ...entry.reference_image_path.split('/')), join(root, 'data', 'templates'), 'reference image');
    const [jsonBytes, imageBytes] = await Promise.all([readFile(jsonPath), readFile(imagePath)]);
    if (sha256(jsonBytes) !== entry.source_hashes.json_sha256) throw new Error(`Imported source JSON hash mismatch for ${entry.template_uid}`);
    if (sha256(imageBytes) !== entry.source_hashes.reference_image_sha256) throw new Error(`Imported reference image hash mismatch for ${entry.template_uid}`);
  }
  await atomicWriteJson(join(root, 'data', 'projections', 'template-catalog.json'), projection);
  return projection;
}

async function storeImmutableTemplate({ root, entry, renameDirectory = rename }) {
  const templatesRoot = join(root, 'data', 'templates');
  const targetDir = assertInside(join(templatesRoot, entry.template_uid), templatesRoot, 'template asset');
  let targetFiles;
  try {
    targetFiles = await readdir(targetDir);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (targetFiles) {
    const referenceFiles = targetFiles.filter((name) => /^reference\.(?:jpe?g|png|webp)$/i.test(name));
    if (!targetFiles.includes('source.json') || referenceFiles.length !== 1) {
      throw new Error(`Changed source detected for ${entry.template_uid}: imported asset set is incomplete`);
    }
    const existingJson = await readFile(join(targetDir, 'source.json'));
    const existingImage = await readFile(join(targetDir, referenceFiles[0]));
    if (sha256(existingJson) !== entry.source_hashes.json_sha256 || sha256(existingImage) !== entry.source_hashes.reference_image_sha256) {
      throw new Error(`Changed source detected for ${entry.template_uid}; explicit revision workflow is required`);
    }
    return 'unchanged';
  }
  await mkdir(templatesRoot, { recursive: true });
  const temporaryDir = join(templatesRoot, `.${entry.template_uid}.${randomUUID()}.tmp`);
  await mkdir(temporaryDir, { recursive: false });
  try {
    await Promise.all([
      writeFile(join(temporaryDir, 'source.json'), entry._source.sourceJsonBytes),
      writeFile(join(temporaryDir, `reference${entry.reference_image.extension}`), entry._source.imageBytes),
    ]);
    let lastRenameError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await renameDirectory(temporaryDir, targetDir);
        return 'added';
      } catch (error) {
        if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') {
          await rm(temporaryDir, { recursive: true, force: true });
          return storeImmutableTemplate({ root, entry });
        }
        if (error?.code !== 'EPERM') throw error;
        lastRenameError = error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 * (attempt + 1)));
      }
    }
    throw lastRenameError;
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true });
    throw error;
  }
}

function persistedEntry(entry) {
  const { _source, ...persisted } = entry;
  return persisted;
}

function importEvent(entry, batchId) {
  const idempotencyKey = sha256(Buffer.from(`${entry.template_uid}|${entry.source_hashes.json_sha256}|${entry.source_hashes.reference_image_sha256}`));
  return {
    schema_version: EVENT_VERSION,
    event_id: `template-import-${idempotencyKey.slice(0, 24)}`,
    event_type: 'TemplateImported',
    recorded_at: new Date().toISOString(),
    import_batch_id: batchId,
    idempotency_key: idempotencyKey,
    data: { template: persistedEntry(entry) },
  };
}

export async function importTemplateCatalog({
  root,
  sourceRoot,
  expectedCount = DEFAULT_EXPECTED_COUNT,
  renameDirectory = rename,
}) {
  const inspection = await inspectTemplateSource({ sourceRoot, expectedCount });
  const eventsPath = join(root, 'data', 'events', 'template-catalog.jsonl');
  const existingEvents = await readEvents(eventsPath);
  const importedByUid = new Map(existingEvents
    .filter((event) => event.event_type === 'TemplateImported' && event.data?.template?.template_uid)
    .map((event) => [event.data.template.template_uid, event.data.template]));
  for (const entry of inspection.templates) {
    const existing = importedByUid.get(entry.template_uid);
    if (existing && (existing.source_hashes?.json_sha256 !== entry.source_hashes.json_sha256
      || existing.source_hashes?.reference_image_sha256 !== entry.source_hashes.reference_image_sha256)) {
      throw new Error(`Changed source detected for ${entry.template_uid}; explicit revision workflow is required`);
    }
  }
  let addedAssets = 0;
  for (const entry of inspection.templates) {
    if (await storeImmutableTemplate({ root, entry, renameDirectory }) === 'added') addedAssets += 1;
  }
  await mkdir(dirname(eventsPath), { recursive: true });
  const batchId = `template-batch-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`;
  const newEvents = [];
  for (const entry of inspection.templates) {
    if (!importedByUid.has(entry.template_uid)) newEvents.push(importEvent(entry, batchId));
  }
  if (newEvents.length) {
    const batchEvent = {
      schema_version: EVENT_VERSION,
      event_id: `template-batch-complete-${batchId}`,
      event_type: 'TemplateCatalogImportCompleted',
      recorded_at: new Date().toISOString(),
      import_batch_id: batchId,
      data: {
        template_count: inspection.template_count,
        image_count: inspection.image_count,
        unique_image_hashes: inspection.unique_image_hashes,
        duplicate_image_groups: inspection.duplicate_image_groups,
        allowlist: {
          template_json_directory: SOURCE_JSON_RELATIVE.join('/'),
          reference_image_directory: SOURCE_IMAGE_RELATIVE.join('/'),
          template_index: SOURCE_INDEX_RELATIVE.join('/'),
        },
      },
    };
    await appendFile(eventsPath, `${[...newEvents, batchEvent].map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  }
  const projection = await rebuildTemplateCatalog({ root });
  return {
    import_batch_id: newEvents.length ? batchId : null,
    added_templates: newEvents.length,
    unchanged_templates: inspection.template_count - newEvents.length,
    added_assets: addedAssets,
    catalog: projection,
    inspection: {
      template_count: inspection.template_count,
      image_count: inspection.image_count,
      index_count: inspection.index_count,
      unique_template_ids: inspection.unique_template_ids,
      unique_image_hashes: inspection.unique_image_hashes,
      duplicate_image_groups: inspection.duplicate_image_groups,
    },
  };
}

async function loadProjection(root) {
  try {
    const value = await readJsonFile(join(root, 'data', 'projections', 'template-catalog.json'), 'template-catalog.json');
    if (value.schema_version !== PROJECTION_VERSION || !Array.isArray(value.templates)) {
      throw new Error('Template catalog projection version is unsupported; rebuild it');
    }
    return value;
  } catch (error) {
    if (/is missing$/.test(error.message)) return projectionFromEvents(await readEvents(join(root, 'data', 'events', 'template-catalog.jsonl')));
    throw error;
  }
}

function filterVocabulary(projection) {
  return Object.fromEntries(CATEGORY_FILTERS.map((field) => [
    field,
    [...new Set(projection.templates.map((entry) => String(entry.selection_tags?.[field] || '')).filter(Boolean))].sort(),
  ]));
}

export async function listTemplates({ root, filters = {}, limit = 124, offset = 0 } = {}) {
  const projection = await loadProjection(root);
  const exclusions = await loadTemplateExclusions({root});
  const vocabulary = filterVocabulary(projection);
  for (const field of CATEGORY_FILTERS) {
    if (filters[field] && !vocabulary[field].includes(String(filters[field]))) throw new Error(`Unknown ${field}: ${filters[field]}`);
  }
  let items = projection.templates;
  for (const field of CATEGORY_FILTERS) {
    if (filters[field]) items = items.filter((entry) => String(entry.selection_tags?.[field] || '') === String(filters[field]));
  }
  const query = String(filters.q || '').trim().toLocaleLowerCase();
  if (query) {
    items = items.filter((entry) => [
      entry.source_template_id,
      entry.template_info?.template_name,
      entry.template_info?.name,
      entry.retrieval_text,
      entry.selection_tags?.style_category,
    ].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
  }
  const boundedLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 124, 124));
  const boundedOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
  return {
    summary: projection.summary,
    filters: vocabulary,
    total: items.length,
    limit: boundedLimit,
    offset: boundedOffset,
    templates: items.slice(boundedOffset, boundedOffset + boundedLimit).map((entry) => ({...publicEntry(entry),operator_rejected:exclusions.template_uids.includes(entry.template_uid)})),
  };
}

export async function loadTemplate({ root, templateUid: uid }) {
  assertTemplateUid(uid);
  const projection = await loadProjection(root);
  const entry = projection.templates.find((item) => item.template_uid === uid);
  if (!entry) {
    const error = new Error(`Template not found: ${uid}`);
    error.code = 'ENOENT';
    throw error;
  }
  return publicEntry(entry, { detail: true });
}

export async function resolveTemplateReference({ root, templateUid: uid }) {
  assertTemplateUid(uid);
  const projection = await loadProjection(root);
  const entry = projection.templates.find((item) => item.template_uid === uid);
  if (!entry) {
    const error = new Error(`Template not found: ${uid}`);
    error.code = 'ENOENT';
    throw error;
  }
  const templatesRoot = join(root, 'data', 'templates');
  const path = assertInside(join(root, ...entry.reference_image_path.split('/')), templatesRoot, 'reference image');
  const info = await stat(path);
  return { path, mime_type: entry.reference_image.mime_type, bytes: info.size, sha256: entry.reference_image.sha256 };
}

export const TEMPLATE_CATALOG_VERSION = PROJECTION_VERSION;
