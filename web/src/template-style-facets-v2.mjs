const VERSION = 'ai-img-gen.template-style-facets.v2';

const option = (key, label, englishLabel, description) => Object.freeze({ key, label, english_label: englishLabel, description });

export const STYLE_FACET_VOCABULARY = Object.freeze({
  schema_version: VERSION,
  work_types: Object.freeze([
    option('fashion_editorial', '时尚编辑', 'Fashion Editorial', '以服装、造型和编辑视觉为主体'),
    option('cinematic_narrative', '电影叙事', 'Cinematic Narrative', '以电影光影、场景和故事感为主体'),
    option('graphic_poster', '图形海报', 'Graphic Poster', '以字体、图形、拼版和海报设计为主体'),
    option('documentary_lifestyle', '纪实生活', 'Documentary / Lifestyle', '以真实环境、日常瞬间或人物故事为主体'),
    option('commercial_branding', '商业形象', 'Commercial Branding', '以专业可信、个人品牌或商业传播为主体'),
    option('other_uncertain', '其他 / 不确定', 'Other / Uncertain', '无法可靠归入前五类时使用'),
  ]),
  treatments: Object.freeze([
    option('monochrome', '黑白', 'Monochrome', '黑白或近似单色处理'),
    option('dark_low_key', '暗调', 'Dark / Low-key', '低亮度、高阴影或深色主导'),
    option('bright_high_key', '明亮清透', 'Bright / High-key', '高亮度、低压暗和清透观感'),
    option('vivid_color', '鲜艳撞色', 'Vivid Color', '高饱和或强对比颜色关系'),
    option('retro_film', '复古胶片', 'Retro Film', '年代感、胶片色或旧印刷观感'),
    option('grunge_collage', '粗粝拼贴', 'Grunge / Collage', '撕纸、颗粒、故障或多层拼贴'),
  ]),
  positioning: Object.freeze([
    option('luxury', '高级', 'Luxury', '精致、克制或奢华定位'),
    option('professional', '专业', 'Professional', '可信、正式或商业专业定位'),
    option('street', '街头', 'Street', '都市、青年、潮流或街头定位'),
    option('romantic', '浪漫', 'Romantic', '柔和、情绪化或浪漫定位'),
    option('avant_garde', '前卫', 'Avant-garde', '实验、先锋或强个性定位'),
    option('natural_friendly', '自然亲和', 'Natural / Friendly', '生活化、轻松或亲近定位'),
  ]),
});

const keys = (values) => new Set(values.map((item) => item.key));
const WORK_TYPES = keys(STYLE_FACET_VOCABULARY.work_types);
const TREATMENTS = keys(STYLE_FACET_VOCABULARY.treatments);
const POSITIONING = keys(STYLE_FACET_VOCABULARY.positioning);

function normalizeArray(value, { allowed, maximum, maximumWord, field }) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const normalized = value.map((item) => String(item || '').trim());
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field} cannot contain duplicate values`);
  if (normalized.length > maximum) throw new Error(`${field} accepts at most ${maximumWord} values`);
  if (normalized.some((item) => !allowed.has(item))) throw new Error(`Invalid ${field} value`);
  return Object.freeze(normalized);
}

export function normalizeStyleFacetTag(input = {}) {
  const workType = String(input.work_type || '').trim();
  if (!WORK_TYPES.has(workType)) throw new Error('Invalid work type');
  return Object.freeze({
    schema_version: VERSION,
    work_type: workType,
    treatments: normalizeArray(input.treatments, { allowed: TREATMENTS, maximum: 3, maximumWord: 'three', field: 'treatments' }),
    positioning: normalizeArray(input.positioning, { allowed: POSITIONING, maximum: 2, maximumWord: 'two', field: 'positioning' }),
  });
}

export function normalizeArtifactStyleSuggestion(input = {}) {
  const artifactId = String(input.artifact_id || '').trim();
  if (!artifactId) throw new Error('Artifact id is required');
  const facets = normalizeStyleFacetTag(input);
  if (!Array.isArray(input.scene_tags)) throw new Error('Scene tags must be an array');
  const sceneTags = input.scene_tags.map((value) => String(value || '').trim());
  if (sceneTags.length < 1 || sceneTags.length > 4 || sceneTags.some((value) => !value || value.length > 24) || new Set(sceneTags).size !== sceneTags.length) {
    throw new Error('Scene tags must contain one to four unique short values');
  }
  const styleNote = String(input.style_note || '').trim();
  if (!styleNote || styleNote.length > 220) throw new Error('Style note must contain 1-220 characters');
  const source = String(input.source || '').trim();
  if (!source) throw new Error('Suggestion source is required');
  return Object.freeze({
    schema_version: 'ai-img-gen.artifact-style-suggestion.v1',
    status: 'suggested',
    artifact_id: artifactId,
    work_type: facets.work_type,
    treatments: facets.treatments,
    positioning: facets.positioning,
    scene_tags: Object.freeze(sceneTags),
    style_note: styleNote,
    source,
    model_version: input.model_version ? String(input.model_version).trim() : null,
    vocabulary_version: STYLE_FACET_VOCABULARY.schema_version,
    campaign_id: input.campaign_id ? String(input.campaign_id).trim() : null,
  });
}

export function projectStyleFacetEligibility({ templateUid, templateState, suggestion = null } = {}) {
  const uid = String(templateUid || '');
  if (templateState === 'rejected') return Object.freeze({ template_uid: uid, eligible: false, reason: 'rejected_template', facets: null });
  if (templateState !== 'active') return Object.freeze({ template_uid: uid, eligible: false, reason: 'not_confirmed_active', facets: null });
  return Object.freeze({ template_uid: uid, eligible: true, reason: 'active_template', facets: suggestion ? normalizeStyleFacetTag(suggestion) : null });
}
