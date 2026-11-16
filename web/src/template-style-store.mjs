import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const VERSION = 'ai-img-gen.template-style.v1';
const EVENT_VERSION = 'ai-img-gen.template-style-event.v1';
const PROJECTION_VERSION = 'ai-img-gen.template-style-tags.v1';
const TEMPLATE_UID = /^tpl_temp_aiimg_[a-z0-9_-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const writeChains = new Map();

function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.values(value).forEach(deepFreeze); return Object.freeze(value); }
const option = (key, label, englishLabel, description) => ({ key, label, english_label: englishLabel, description });

export const TEMPLATE_STYLE_VOCABULARY_VERSION = VERSION;
export const TEMPLATE_STYLE_VOCABULARY = deepFreeze({
  schema_version: VERSION,
  styles: [
    option('black_white_magazine', '黑白编辑', 'Monochrome Editorial', '黑白或单色、杂志排版与编辑感'),
    option('bold_color_graphic', '图形海报', 'Graphic Poster', '高饱和撞色、强图形与视觉冲击'),
    option('cinematic_mood', '电影叙事', 'Cinematic Portrait', '电影光影、叙事场景与情绪氛围'),
    option('dark_grunge', '粗粝实验', 'Grunge Editorial', '暗调、做旧、故障、粗粝或地下感'),
    option('retro_poster', '复古编辑', 'Retro Editorial', '复古年代、胶片、旧印刷或怀旧色彩'),
    option('luxury_fashion', '高级时装', 'High-Fashion Editorial', '奢华、时装大片、精致高级感'),
    option('streetwear_editorial', '街头时装', 'Streetwear Editorial', '街头服饰、都市潮流与青年编辑感'),
    option('clean_magazine', '清透编辑', 'Clean Editorial', '干净留白、清晰排版与明亮杂志感'),
    option('documentary_poster', '纪实人像', 'Documentary Portrait', '真实环境、纪实摄影与人物故事感'),
    option('minimal_personal_brand', '商业形象', 'Personal Branding Portrait', '克制专业、个人IP与品牌表达'),
  ],
});
const STYLE_KEYS = new Set(TEMPLATE_STYLE_VOCABULARY.styles.map((item) => item.key));

export function normalizeTemplateStyleTag(input = {}) {
  const primary = String(input.primary_style || '').trim();
  if (!STYLE_KEYS.has(primary)) throw new Error('Invalid template primary style');
  return deepFreeze({ schema_version: VERSION, primary_style: primary });
}

function paths(root) { return { events: join(root, 'data', 'events', 'template-style-tags.jsonl'), projection: join(root, 'data', 'projections', 'template-style-tags.json') }; }
async function readJson(path, message) { try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); } catch (error) { if (error.code === 'ENOENT' && message) throw new Error(message); throw error; } }
async function readEvents(path) { try { return (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
async function atomicJson(path, value) { const previous = writeChains.get(path) || Promise.resolve(); const operation = previous.catch(() => {}).then(async () => { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); await rename(temporary, path); }); writeChains.set(path, operation); try { await operation; } finally { if (writeChains.get(path) === operation) writeChains.delete(path); } }

function projectEvents(events, templateUid, imageSha256) {
  let suggestion = null; let confirmation = null;
  for (const event of events) {
    if (event.template_uid !== templateUid || event.image_sha256 !== imageSha256) continue;
    if (event.event_type === 'TemplateStyleSuggested') suggestion = event;
    if (event.event_type === 'TemplateStyleConfirmed') confirmation = event;
  }
  return deepFreeze({ state: confirmation ? 'confirmed' : suggestion ? 'suggested' : 'untagged', template_uid: templateUid, image_sha256: imageSha256, suggestion, confirmation });
}

export async function rebuildTemplateStyleProjection({ root }) {
  const catalog = await readJson(join(root, 'data', 'projections', 'template-catalog.json'), 'Template catalog not found');
  const eventPath = paths(root);
  const events = await readEvents(eventPath.events);
  const templates = {};
  for (const item of catalog.templates || []) {
    const uid = String(item.template_uid || ''); const hash = String(item.reference_image?.sha256 || '').toLowerCase();
    if (!TEMPLATE_UID.test(uid) || !SHA256.test(hash)) throw new Error('Template catalog is invalid');
    templates[uid] = projectEvents(events, uid, hash);
  }
  const projection = { schema_version: PROJECTION_VERSION, vocabulary_version: VERSION, event_count: events.length, templates };
  await atomicJson(eventPath.projection, projection);
  return deepFreeze(projection);
}

export async function loadTemplateStyleProjection({ root, templateUid }) {
  if (!TEMPLATE_UID.test(String(templateUid || ''))) throw new Error('Invalid template uid');
  const projection = await rebuildTemplateStyleProjection({ root });
  if (!projection.templates[templateUid]) throw new Error('Template not found');
  return projection.templates[templateUid];
}

export async function loadTemplateStyleProgress({ root }) {
  const projection = await rebuildTemplateStyleProjection({ root });
  const result = { total: 0, untagged: 0, suggested: 0, confirmed: 0 };
  for (const item of Object.values(projection.templates)) { result.total += 1; result[item.state] += 1; }
  return result;
}

export async function recordTemplateStyleTag({ root, templateUid, imageSha256, kind, idempotencyKey, actor, tag, modelVersion = '', promptVersion = '', supersedesEventId = null }) {
  if (!TEMPLATE_UID.test(String(templateUid || ''))) throw new Error('Invalid template uid');
  const catalog = await readJson(join(root, 'data', 'projections', 'template-catalog.json'), 'Template catalog not found');
  const item = (catalog.templates || []).find((entry) => entry.template_uid === templateUid);
  if (!item) throw new Error('Template not found');
  const expectedHash = String(item.reference_image?.sha256 || '').toLowerCase();
  if (!SHA256.test(String(imageSha256 || '').toLowerCase()) || String(imageSha256).toLowerCase() !== expectedHash) throw new Error('Template image hash mismatch');
  if (!['suggestion', 'confirmation'].includes(kind)) throw new Error('Invalid style event kind');
  if (!String(idempotencyKey || '').match(/^[a-zA-Z0-9._:-]{4,128}$/)) throw new Error('Invalid style idempotency key');
  if (!String(actor || '').trim()) throw new Error('Template style actor is required');
  if (kind === 'suggestion' && (!String(modelVersion).trim() || !String(promptVersion).trim())) throw new Error('Suggestion model and prompt versions are required');
  const eventPath = paths(root); const events = await readEvents(eventPath.events);
  const replay = events.find((event) => event.idempotency_key === idempotencyKey);
  if (replay) return { event: replay, projection: projectEvents(events, templateUid, expectedHash), idempotent_replay: true };
  const current = projectEvents(events, templateUid, expectedHash);
  if (kind === 'confirmation') {
    const currentId = current.confirmation?.event_id || null;
    if (currentId && supersedesEventId !== currentId) throw new Error(`Style confirmation revision requires supersedes_event_id ${currentId}`);
    if (!currentId && supersedesEventId) throw new Error('Initial style confirmation cannot supersede an event');
  }
  const event = {
    schema_version: EVENT_VERSION,
    event_id: `template-style-${randomUUID()}`,
    event_type: kind === 'suggestion' ? 'TemplateStyleSuggested' : 'TemplateStyleConfirmed',
    idempotency_key: String(idempotencyKey), recorded_at: new Date().toISOString(), actor: String(actor).trim(),
    template_uid: templateUid, image_sha256: expectedHash, vocabulary_version: VERSION, tag: normalizeTemplateStyleTag(tag),
    ...(kind === 'suggestion' ? { model_version: String(modelVersion).trim(), prompt_version: String(promptVersion).trim() } : { supersedes_event_id: supersedesEventId || null }),
  };
  await mkdir(dirname(eventPath.events), { recursive: true });
  await appendFile(eventPath.events, `${JSON.stringify(event)}\n`, 'utf8');
  const projection = await rebuildTemplateStyleProjection({ root });
  return { event, projection: projection.templates[templateUid], idempotent_replay: false };
}
