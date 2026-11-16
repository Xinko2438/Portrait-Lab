import { createHash } from 'node:crypto';
import { normalizeTaskIntent } from './intent-schema.mjs';
import { buildCandidateSlateRequest, candidateSlatePromptDirectives } from './candidate-slate.mjs';
import { compileAngleAlignedPromptRecipe, compilePromptRecipe } from './prompt-recipe.mjs';

export const PROMPT_COMPILATION_VERSION = 'ai-img-gen.prompt-compilation.v1';
export const PROMPT_COMPILER_ID = 'portrait-prompt-compiler-v1';
export const PROMPT_COMPILATION_V2_VERSION = 'ai-img-gen.prompt-compilation.v2';
export const PROMPT_COMPILER_V2_ID = 'portrait-prompt-compiler-v2';
export const PROMPT_COMPILATION_V3_VERSION = 'ai-img-gen.prompt-compilation.v3';
export const PROMPT_COMPILER_V3_ID = 'portrait-prompt-compiler-v3';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function stableJson(value) { return JSON.stringify(stable(value)); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function field(item, key) { return item?.[key] ?? item?.selection_tags?.[key] ?? ''; }

const useCaseLabels = { livestream_cover: '直播封面', social_avatar: '社交媒体头像', personal_ip_poster: '个人 IP 海报', course_promotion: '课程宣传海报', company_profile: '企业形象照', event_poster: '活动海报', professional_portrait: '职业形象写真', lifestyle_portrait: '生活写真', custom: '自定义用途' };
const framingLabels = { follow_template: '沿用模板的主要景别', close_up: '头像近景', bust: '胸像', half_body: '半身', three_quarter: '七分身', full_body: '全身', environmental_portrait: '环境人像' };
const angleLabels = { follow_identity: '以主身份图的自然朝向为准', follow_template: '沿用模板的人脸朝向', front: '正脸', slight_turn: '轻微侧转', left_45: '左 45 度', right_45: '右 45 度', profile: '完整侧脸' };
const temperamentLabels = { professional: '专业', trustworthy: '可信', approachable: '亲和', premium: '高级', cool: '冷峻', energetic: '有活力', calm: '沉稳', technological: '科技感', editorial: '杂志感', cinematic: '电影感' };
const layoutSentences = { no_text: '画面不需要可见文字，构图保持完整简洁。', follow_template: '沿用模板的主要版式关系，但文字不得遮挡人物面部。', copy_left: '在画面左侧预留清晰的标题和文案空间。', copy_right: '在画面右侧预留清晰的标题和文案空间。', copy_top: '在画面顶部预留清晰的标题空间。', copy_bottom: '在画面底部预留信息区。' };

export function compileDeterministicPrompt(input = {}) {
  if (input.promptRecipe) {
    const compileRecipe = Number(input.promptRecipe.version || 1) >= 2
      ? compileAngleAlignedPromptRecipe
      : compilePromptRecipe;
    return compileRecipe({
      promptInputMode: input.promptRecipe.promptInputMode,
      identityTransferBlock: input.promptRecipe.identityTransferBlock,
      taskIntent: input.taskIntent,
      identityReferences: input.identityReferences,
      templateReferences: input.templateReferences,
      candidateSlateRequest: input.candidateSlateRequest,
      activeCorrections: input.promptRecipe.activeCorrections || [],
      shadowCorrections: input.promptRecipe.shadowCorrections || [],
      aiPromptDraft: input.aiPromptDraft || null,
    });
  }
  const taskIntent = normalizeTaskIntent(input.taskIntent || {});
  const candidateSlateRequest = input.candidateSlateRequest
    ? buildCandidateSlateRequest(input.candidateSlateRequest)
    : null;
  const aiPromptDraft = input.aiPromptDraft?.prompt ? input.aiPromptDraft : null;
  const identityReferences = (input.identityReferences || []).map((item, index) => ({ ordinal: Number(item.ordinal || index + 1), sha256: item.sha256 || '', role: item.role || (index === 0 ? 'primary_front' : 'identity_support') }));
  const templateReferences = (input.templateReferences || []).map((item, index) => ({ ordinal: Number(item.ordinal || identityReferences.length + index + 1), sha256: item.sha256 || '', template_uid: item.template_uid || '', template_name: item.template_name || '', style_category: field(item, 'style_category'), portrait_scale: field(item, 'portrait_scale'), face_angle: field(item, 'face_angle') }));
  if (!identityReferences.length) throw new Error('At least one identity reference is required for prompt compilation');
  if (!templateReferences.length) throw new Error('At least one template reference is required for prompt compilation');
  const conflictResolutions = [];
  const warnings = [];
  const primaryTemplate = templateReferences[0];
  if (taskIntent.target_face_angle !== 'follow_template' && primaryTemplate.face_angle && !String(primaryTemplate.face_angle).includes(taskIntent.target_face_angle)) {
    conflictResolutions.push({ code: 'target_angle_overrides_template', resolution: '保留模板姿势与氛围，但以本次目标人脸朝向为准。' });
  }
  const identityRange = identityReferences.length === 1 ? `第 ${identityReferences[0].ordinal} 张身份参考图` : `第 ${identityReferences[0].ordinal}-${identityReferences.at(-1).ordinal} 张身份参考图`;
  const templateRange = templateReferences.length === 1 ? `第 ${primaryTemplate.ordinal} 张模板图` : `第 ${primaryTemplate.ordinal}-${templateReferences.at(-1).ordinal} 张模板图`;
  const temperament = taskIntent.temperament_keywords.map((key) => temperamentLabels[key]).filter(Boolean).join('、');
  const sentences = [
    `以${identityRange}中的人物作为唯一身份原型，准确保留五官结构、脸型比例、眼鼻嘴特征、年龄感和可辨识身份。`,
    `参照${templateRange}${primaryTemplate.template_name ? `“${primaryTemplate.template_name}”` : ''}的构图、姿势、服装层次、场景关系和光影语言，只继承视觉设计，不继承模板人物的面部或身份特征。`,
    `为该人物创作一张${taskIntent.custom_use_case || useCaseLabels[taskIntent.use_case]}，采用${taskIntent.custom_framing || framingLabels[taskIntent.target_framing]}构图，人脸朝向${taskIntent.custom_face_angle || angleLabels[taskIntent.target_face_angle]}。`,
    temperament ? `人物整体气质应呈现${temperament}，所有表情、姿势、服装和光线共同服务于这一气质。` : '',
    layoutSentences[taskIntent.layout_intent],
    ...conflictResolutions.map((item) => item.resolution),
    ...(input.activeGuidance || []).map((item) => String(item.prompt_guidance || '').trim()).filter(Boolean),
    taskIntent.user_supplement ? `同时满足补充要求：${taskIntent.user_supplement}` : '',
    candidateSlateRequest ? candidateSlatePromptDirectives(candidateSlateRequest) : '',
    '保持真实皮肤纹理、自然肢体结构、合理透视和可信摄影光线；避免五官漂移、模板人物残留、塑料质感、过度磨皮、肢体畸变、文字遮脸和无意义装饰。',
  ].filter(Boolean);
  const compiledPrompt = aiPromptDraft ? [sentences[0], sentences[1], aiPromptDraft.prompt, candidateSlateRequest ? candidateSlatePromptDirectives(candidateSlateRequest) : '', sentences.at(-1)].filter(Boolean).join('') : sentences.join('');
  const compilerId = aiPromptDraft ? PROMPT_COMPILER_V3_ID : (candidateSlateRequest ? PROMPT_COMPILER_V2_ID : PROMPT_COMPILER_ID);
  const compilerVersion = aiPromptDraft ? 3 : (candidateSlateRequest ? 2 : 1);
  const source = { compiler_id: compilerId, compiler_version: compilerVersion, task_intent: taskIntent, identity_references: identityReferences, template_references: templateReferences, active_guidance: input.activeGuidance || [], ...(candidateSlateRequest ? { candidate_slate_request: candidateSlateRequest } : {}), ...(aiPromptDraft ? { ai_prompt_draft: aiPromptDraft } : {}) };
  return { schema_version: aiPromptDraft ? PROMPT_COMPILATION_V3_VERSION : (candidateSlateRequest ? PROMPT_COMPILATION_V2_VERSION : PROMPT_COMPILATION_VERSION), compiler_id: compilerId, compiler_version: compilerVersion, task_intent_version: taskIntent.schema_version, input_sha256: sha256(stableJson(source)), prompt_sha256: sha256(compiledPrompt), compiled_prompt: compiledPrompt, warnings: warnings, conflict_resolutions: conflictResolutions, ...(candidateSlateRequest ? { candidate_slate_request: candidateSlateRequest } : {}), ...(aiPromptDraft ? { ai_prompt_draft: aiPromptDraft } : {}), compiled_at: new Date(0).toISOString() };
}
