import { createHash } from 'node:crypto';

import { buildCandidateSlateRequest, candidateSlatePromptDirectives } from './candidate-slate.mjs';
import { normalizeTaskIntent } from './intent-schema.mjs';
import { REVIEW_RUBRIC } from '../rubric.mjs';

export const IDENTITY_TRANSFER_BLOCK_VERSION = 'ai-img-gen.identity-transfer-block.v1';
export const PROMPT_RECIPE_VERSION = 'ai-img-gen.prompt-recipe.v1';
export const PROMPT_RECIPE_COMPILER_ID = 'portrait-prompt-recipe-v1';
export const PROMPT_RECIPE_V2_VERSION = 'ai-img-gen.prompt-recipe.v2';
export const PROMPT_RECIPE_V2_COMPILER_ID = 'portrait-prompt-recipe-v2';
export const PROMPT_INPUT_MODE_REFERENCE_IMAGE = 'reference_image';
export const PROMPT_INPUT_MODE_BLUEPRINT_ONLY = 'blueprint_only';

const VALIDATED_SOURCE_SCHEMA = 'ai-img-gen.validated-identity-transfer-prompt.v1';
const VALIDATED_PROMPT_ID = 'validated-identity-transfer';
const VALIDATED_PROMPT_SHA256 = '86784b995cec1b3c9b8751d33de4d016341b8642e3b11c0be40abfc5f14bbc46';
const ACCEPTED_SOURCE_STATUSES = new Set(['user_validated_not_active', 'active']);

const useCaseLabels = {
  livestream_cover: '直播封面',
  social_avatar: '社交媒体头像',
  personal_ip_poster: '个人 IP 海报',
  course_promotion: '课程宣传海报',
  company_profile: '企业形象照',
  event_poster: '活动海报',
  professional_portrait: '职业形象写真',
  lifestyle_portrait: '生活写真',
  custom: '自定义用途',
};
const framingLabels = {
  follow_template: '沿用模板的主要景别',
  close_up: '头像近景',
  bust: '胸像',
  half_body: '半身',
  three_quarter: '七分身',
  full_body: '全身',
  environmental_portrait: '环境人像',
};
const angleLabels = {
  follow_identity: '以主身份图的自然朝向为准',
  follow_template: '沿用模板的人脸朝向',
  front: '正脸',
  slight_turn: '轻微侧转',
  left_45: '左 45 度',
  right_45: '右 45 度',
  profile: '完整侧脸',
};
const temperamentLabels = {
  professional: '专业',
  trustworthy: '可信',
  approachable: '亲和',
  premium: '高级',
  cool: '冷峻',
  energetic: '有活力',
  calm: '沉稳',
  technological: '科技感',
  editorial: '杂志感',
  cinematic: '电影感',
};
const layoutSentences = {
  no_text: '画面不需要可见文字，构图保持完整简洁。',
  follow_template: '沿用模板的主要版式关系，但文字不得遮挡人物面部。',
  copy_left: '在画面左侧预留清晰的标题和文案空间。',
  copy_right: '在画面右侧预留清晰的标题和文案空间。',
  copy_top: '在画面顶部预留清晰的标题空间。',
  copy_bottom: '在画面底部预留信息区。',
};

export class PromptRecipeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PromptRecipeError';
    this.code = code;
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stable(value));
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requiredText(value, field, code = 'identity_transfer_block_invalid') {
  if (typeof value !== 'string' || !value.trim()) throw new PromptRecipeError(code, `${field} is required`);
  return value.trim();
}

export function normalizeIdentityTransferBlock(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PromptRecipeError('identity_transfer_block_missing', 'Validated identity-transfer block is required');
  }
  if (input.schema_version !== VALIDATED_SOURCE_SCHEMA || input.prompt_id !== VALIDATED_PROMPT_ID) {
    throw new PromptRecipeError('identity_transfer_block_invalid', 'Validated identity-transfer block contract does not match');
  }
  if (!ACCEPTED_SOURCE_STATUSES.has(input.status)) {
    throw new PromptRecipeError('identity_transfer_block_invalid', 'Validated identity-transfer block status is not accepted');
  }
  const exactPrompt = requiredText(input.exact_prompt, 'exact_prompt');
  const promptSha256 = sha256(exactPrompt);
  if (promptSha256 !== VALIDATED_PROMPT_SHA256) {
    throw new PromptRecipeError('identity_transfer_block_hash_mismatch', 'Validated identity-transfer prompt hash does not match');
  }
  const image1 = requiredText(input.image_roles?.image_1, 'image_roles.image_1');
  const image2 = requiredText(input.image_roles?.image_2, 'image_roles.image_2');
  if (!/客户|身份/.test(image1) || !/模板|风格/.test(image2) || /客户身份/.test(image2)) {
    throw new PromptRecipeError('identity_transfer_block_invalid', 'Validated identity-transfer image roles do not match the protected contract');
  }
  return deepFreeze({
    schema_version: IDENTITY_TRANSFER_BLOCK_VERSION,
    block_id: VALIDATED_PROMPT_ID,
    source_prompt_id: input.prompt_id,
    source_schema_version: input.schema_version,
    source_status: input.status,
    approval_state: input.validated_by === 'user' ? 'user_validated' : 'invalid',
    exact_prompt: exactPrompt,
    prompt_sha256: promptSha256,
    image_roles: { image_1: image1, image_2: image2 },
    protected_meaning: Array.isArray(input.protected_meaning)
      ? input.protected_meaning.map((item) => requiredText(item, 'protected_meaning item'))
      : [],
  });
}

function normalizeIdentityReferences(items) {
  if (!Array.isArray(items) || !items.length) {
    throw new PromptRecipeError('identity_reference_missing', 'At least one identity reference is required');
  }
  return items.map((item, index) => ({
    ordinal: Number(item.ordinal || index + 1),
    sha256: String(item.sha256 || '').toLowerCase(),
    role: String(item.role || (index === 0 ? 'primary_front' : 'identity_support')),
  })).sort((left, right) => left.ordinal - right.ordinal);
}

function normalizeIdentityReferencesV2(items) {
  if (!Array.isArray(items) || !items.length) {
    throw new PromptRecipeError('identity_reference_missing', 'At least one identity reference is required');
  }
  return items.map((item, index) => ({
    ordinal: Number(item.ordinal || index + 1),
    sha256: String(item.sha256 || '').toLowerCase(),
    role: String(item.role || (index === 0 ? 'primary_front' : 'identity_support')),
    face_angle: String(item.face_angle || item.faceAngle || ''),
  })).sort((left, right) => left.ordinal - right.ordinal);
}

function normalizeTemplateReferences(items) {
  if (!Array.isArray(items) || !items.length) {
    throw new PromptRecipeError('real_template_reference_missing', 'At least one real template reference is required');
  }
  return items.map((item, index) => ({
    ordinal: Number(item.ordinal || index + 2),
    sha256: String(item.sha256 || '').toLowerCase(),
    template_uid: String(item.template_uid || ''),
    template_name: String(item.template_name || item.filename || ''),
    style_category: String(item.style_category || ''),
    portrait_scale: String(item.portrait_scale || ''),
    face_angle: String(item.face_angle || ''),
  })).sort((left, right) => left.ordinal - right.ordinal);
}

function referenceRoleBinding(identityReferences, templateReferences) {
  const primaryIdentity = identityReferences.find((item) => item.role === 'primary_front') || identityReferences[0];
  const primaryTemplate = templateReferences[0];
  const identitySupport = identityReferences.filter((item) => item !== primaryIdentity);
  const supportSentence = identitySupport.length
    ? `第 ${identitySupport.map((item) => item.ordinal).join('、')} 张仅作为同一人物的身份辅助参考，不改变图片1和图片2的语义角色。`
    : '';
  return `本次附件角色绑定：下方固定指令中的“图片1”指本次第 ${primaryIdentity.ordinal} 张主身份图；“图片2”指本次第 ${primaryTemplate.ordinal} 张主模板图。${supportSentence}`;
}

function referenceRoleBindingFor(identityReferences, templateReferences, primaryIdentity) {
  const primaryTemplate = templateReferences[0];
  const identitySupport = identityReferences.filter((item) => item.ordinal !== primaryIdentity.ordinal);
  const supportSentence = identitySupport.length
    ? `第 ${identitySupport.map((item) => item.ordinal).join('、')} 张仅作为同一人物的身份辅助参考，不改变图片1和图片2的语义角色。`
    : '';
  return `本次附件角色绑定：下方固定指令中的“图片1”指本次第 ${primaryIdentity.ordinal} 张主身份图；“图片2”指本次第 ${primaryTemplate.ordinal} 张主模板图。${supportSentence}`;
}

function normalizedAngleFamily(value) {
  const angle = String(value || '').trim().toLowerCase();
  if (!angle) return null;
  if (/profile|90|完整侧脸/.test(angle)) return 'profile';
  if (/45|side|three.?quarter|slight.?turn|侧转/.test(angle)) return 'three_quarter';
  if (/front|frontal|正脸|15|30/.test(angle)) return 'frontal';
  return null;
}

function normalizedAngleDirection(value) {
  const angle = String(value || '').trim().toLowerCase();
  if (/left|左/.test(angle)) return 'left';
  if (/right|右/.test(angle)) return 'right';
  return 'neutral';
}

function angleDistance(identity, template) {
  const identityFamily = normalizedAngleFamily(identity.face_angle);
  const templateFamily = normalizedAngleFamily(template.face_angle);
  if (!identityFamily || !templateFamily) return 100;
  if (identityFamily !== templateFamily) return 20;
  const identityDirection = normalizedAngleDirection(identity.face_angle);
  const templateDirection = normalizedAngleDirection(template.face_angle);
  if (identityDirection === templateDirection) return 0;
  if (identityDirection === 'neutral' || templateDirection === 'neutral') return 1;
  return 5;
}

function buildAngleAlignment(identityReferences, templateReferences) {
  const template = templateReferences[0];
  const primaryFallback = identityReferences.find((item) => item.role === 'primary_front') || identityReferences[0];
  const templateFamily = normalizedAngleFamily(template.face_angle);
  const knownIdentities = identityReferences.filter((item) => normalizedAngleFamily(item.face_angle));
  if (!templateFamily || !knownIdentities.length) {
    return {
      primaryIdentity: primaryFallback,
      evidence: {
        state: 'unknown',
        selected_identity_ordinal: primaryFallback.ordinal,
        template_ordinal: template.ordinal,
        identity_face_angle: primaryFallback.face_angle || '',
        template_face_angle: template.face_angle || '',
        identity_angle_family: normalizedAngleFamily(primaryFallback.face_angle),
        template_angle_family: templateFamily,
        selection_reason: 'angle_metadata_missing',
      },
    };
  }
  const ranked = [...knownIdentities].sort((left, right) => (
    angleDistance(left, template) - angleDistance(right, template)
    || Number(left.ordinal) - Number(right.ordinal)
  ));
  const selected = ranked[0];
  const distance = angleDistance(selected, template);
  return {
    primaryIdentity: selected,
    evidence: {
      state: distance <= 1 ? 'aligned' : 'mismatch',
      selected_identity_ordinal: selected.ordinal,
      template_ordinal: template.ordinal,
      identity_face_angle: selected.face_angle,
      template_face_angle: template.face_angle,
      identity_angle_family: normalizedAngleFamily(selected.face_angle),
      template_angle_family: templateFamily,
      selection_reason: 'closest_known_angle',
    },
  };
}

function angleAlignmentBlock(evidence) {
  if (evidence.state === 'aligned') {
    return `为获得最自然的人脸迁移，已选择与图片2模板人脸方向最接近的客户身份图作为图片1。保持图片1与图片2共同的人脸朝向、俯仰角和头部姿势，不要改成相反方向。`;
  }
  if (evidence.state === 'mismatch') {
    return '图片1与图片2当前人脸角度存在差异。只允许让图片2模板人物的动作、朝向、俯仰角和头部姿势轻微向图片1身份图靠拢；不要扭曲、拉伸或重塑图片1的客户五官。';
  }
  return '为获得最自然的人脸迁移，图片1与图片2的人脸朝向、俯仰角和头部姿势应尽量一致。若存在差异，只允许模板动作和头部姿态轻微向图片1靠拢；不要扭曲、拉伸或重塑客户五官。';
}

function taskIntentBlock(taskIntent, templateReferences) {
  const primaryTemplate = templateReferences[0];
  const useCase = taskIntent.custom_use_case || useCaseLabels[taskIntent.use_case];
  const framing = taskIntent.custom_framing || framingLabels[taskIntent.target_framing];
  const angle = taskIntent.custom_face_angle || angleLabels[taskIntent.target_face_angle];
  const temperament = taskIntent.temperament_keywords.map((key) => temperamentLabels[key]).filter(Boolean).join('、');
  return [
    `主模板为第 ${primaryTemplate.ordinal} 张${primaryTemplate.template_name ? `“${primaryTemplate.template_name}”` : ''}；在保留真实模板图构图、动作、服装、滤镜和光影的前提下完成${useCase}。`,
    `目标景别为${framing}，目标人脸朝向为${angle}。`,
    temperament ? `整体气质为${temperament}。` : '',
    layoutSentences[taskIntent.layout_intent] || '',
    taskIntent.user_supplement ? `补充要求：${taskIntent.user_supplement}` : '',
  ].filter(Boolean).join('');
}

function block(blockId, content) {
  return Object.freeze({ block_id: blockId, version: 1, sha256: sha256(content), content });
}

function normalizeCorrections(items, { expectedState, promptInputMode }) {
  if (!Array.isArray(items)) throw new PromptRecipeError('correction_context_mismatch', 'Prompt corrections must be an array');
  return items.map((item) => {
    const correctionId = requiredText(item?.correction_id, 'correction_id', 'correction_context_mismatch');
    const state = requiredText(item?.state, 'state', 'correction_context_mismatch');
    if (state !== expectedState) {
      throw new PromptRecipeError('correction_context_mismatch', `Correction ${correctionId} must be ${expectedState}`);
    }
    const context = item?.context || {};
    if (context.customer_scope !== 'global_identity_neutral') {
      throw new PromptRecipeError('customer_scoped_correction_rejected', `Correction ${correctionId} is not identity-neutral global evidence`);
    }
    if (context.prompt_input_mode !== promptInputMode || context.rubric_version !== REVIEW_RUBRIC.rubric_version) {
      throw new PromptRecipeError('correction_context_mismatch', `Correction ${correctionId} does not match the current prompt context`);
    }
    return {
      correction_id: correctionId,
      state,
      target_block: requiredText(item.target_block, 'target_block', 'correction_context_mismatch'),
      prompt_guidance: requiredText(item.prompt_guidance, 'prompt_guidance', 'correction_context_mismatch'),
      context: {
        prompt_input_mode: context.prompt_input_mode,
        rubric_version: context.rubric_version,
        customer_scope: context.customer_scope,
      },
      source_run_ids: Array.isArray(item.source_run_ids) ? [...new Set(item.source_run_ids.map(String))].sort() : [],
      signal_type: String(item.signal_type || ''),
      quality_dimension: item.quality_dimension || null,
      diagnostic_code: item.diagnostic_code || null,
    };
  }).sort((left, right) => left.correction_id.localeCompare(right.correction_id));
}

export function compilePromptRecipe(input = {}) {
  const promptInputMode = input.promptInputMode || PROMPT_INPUT_MODE_REFERENCE_IMAGE;
  if (promptInputMode === PROMPT_INPUT_MODE_BLUEPRINT_ONLY) {
    throw new PromptRecipeError('prompt_input_mode_not_implemented', 'Blueprint-only prompt input mode is reserved for a later feature');
  }
  if (promptInputMode !== PROMPT_INPUT_MODE_REFERENCE_IMAGE) {
    throw new PromptRecipeError('prompt_input_mode_not_implemented', `Prompt input mode is not implemented: ${promptInputMode}`);
  }

  const identityTransferBlock = normalizeIdentityTransferBlock(input.identityTransferBlock);
  const taskIntent = normalizeTaskIntent(input.taskIntent || {});
  const identityReferences = normalizeIdentityReferences(input.identityReferences);
  const templateReferences = normalizeTemplateReferences(input.templateReferences);
  const candidateSlateRequest = input.candidateSlateRequest
    ? buildCandidateSlateRequest(input.candidateSlateRequest)
    : null;
  const activeCorrections = normalizeCorrections(input.activeCorrections || [], {
    expectedState: 'active',
    promptInputMode,
  });
  const shadowCorrections = normalizeCorrections(input.shadowCorrections || [], {
    expectedState: 'shadow',
    promptInputMode,
  });
  const blocks = [
    block('reference-role-binding', referenceRoleBinding(identityReferences, templateReferences)),
    block('validated-identity-transfer', identityTransferBlock.exact_prompt),
    block('task-intent', taskIntentBlock(taskIntent, templateReferences)),
    block('active-corrections', activeCorrections.map((item) => item.prompt_guidance).join('\n')),
    block('candidate-slate', candidateSlateRequest ? candidateSlatePromptDirectives(candidateSlateRequest) : ''),
    block('quality-safety', '保持真实皮肤纹理、自然肢体结构、合理透视和可信摄影光线；避免五官漂移、模板人物残留、塑料质感、过度磨皮、肢体畸变、文字遮脸和无意义装饰。'),
  ];
  const compiledPrompt = blocks.map((item) => item.content).filter(Boolean).join('\n');
  const effectiveSource = {
    compiler_id: PROMPT_RECIPE_COMPILER_ID,
    compiler_version: 1,
    prompt_input_mode: promptInputMode,
    task_intent: taskIntent,
    identity_transfer_block: identityTransferBlock,
    identity_references: identityReferences,
    template_references: templateReferences,
    candidate_slate_request: candidateSlateRequest,
    active_corrections: activeCorrections,
  };
  const inputSha256 = sha256(stableJson(effectiveSource));
  const recipeIdentity = {
    prompt_input_mode: promptInputMode,
    block_hashes: blocks.map((item) => item.sha256),
    input_sha256: inputSha256,
  };

  return deepFreeze({
    schema_version: PROMPT_RECIPE_VERSION,
    compiler_id: PROMPT_RECIPE_COMPILER_ID,
    compiler_version: 1,
    recipe_id: `prompt-recipe_${sha256(stableJson(recipeIdentity)).slice(0, 24)}`,
    prompt_input_mode: promptInputMode,
    generation_regime_version: candidateSlateRequest?.generation_regime_version || null,
    task_intent_version: taskIntent.schema_version,
    blocks,
    identity_references: identityReferences,
    template_references: templateReferences,
    applied_correction_ids: activeCorrections.map((item) => item.correction_id),
    shadow_correction_ids: shadowCorrections.map((item) => item.correction_id),
    shadow_ai_prompt_draft: input.aiPromptDraft || null,
    input_sha256: inputSha256,
    prompt_sha256: sha256(compiledPrompt),
    compiled_prompt: compiledPrompt,
    warnings: [],
    conflict_resolutions: [],
    ...(candidateSlateRequest ? { candidate_slate_request: candidateSlateRequest } : {}),
    compiled_at: new Date(0).toISOString(),
  });
}

export function compileAngleAlignedPromptRecipe(input = {}) {
  const promptInputMode = input.promptInputMode || PROMPT_INPUT_MODE_REFERENCE_IMAGE;
  if (promptInputMode === PROMPT_INPUT_MODE_BLUEPRINT_ONLY) {
    throw new PromptRecipeError('prompt_input_mode_not_implemented', 'Blueprint-only prompt input mode is reserved for a later feature');
  }
  if (promptInputMode !== PROMPT_INPUT_MODE_REFERENCE_IMAGE) {
    throw new PromptRecipeError('prompt_input_mode_not_implemented', `Prompt input mode is not implemented: ${promptInputMode}`);
  }

  const identityTransferBlock = normalizeIdentityTransferBlock(input.identityTransferBlock);
  const taskIntent = normalizeTaskIntent(input.taskIntent || {});
  const identityReferences = normalizeIdentityReferencesV2(input.identityReferences);
  const templateReferences = normalizeTemplateReferences(input.templateReferences);
  const candidateSlateRequest = input.candidateSlateRequest
    ? buildCandidateSlateRequest(input.candidateSlateRequest)
    : null;
  const activeCorrections = normalizeCorrections(input.activeCorrections || [], {
    expectedState: 'active',
    promptInputMode,
  });
  const shadowCorrections = normalizeCorrections(input.shadowCorrections || [], {
    expectedState: 'shadow',
    promptInputMode,
  });
  const angleSelection = buildAngleAlignment(identityReferences, templateReferences);
  const blocks = [
    block('reference-role-binding', referenceRoleBindingFor(identityReferences, templateReferences, angleSelection.primaryIdentity)),
    block('validated-identity-transfer', identityTransferBlock.exact_prompt),
    block('angle-alignment', angleAlignmentBlock(angleSelection.evidence)),
    block('task-intent', taskIntentBlock(taskIntent, templateReferences)),
    block('active-corrections', activeCorrections.map((item) => item.prompt_guidance).join('\n')),
    block('candidate-slate', candidateSlateRequest ? candidateSlatePromptDirectives(candidateSlateRequest) : ''),
    block('quality-safety', '保持真实皮肤纹理、自然肢体结构、合理透视和可信摄影光线；避免五官漂移、模板人物残留、塑料质感、过度磨皮、肢体畸变、文字遮脸和无意义装饰。'),
  ];
  const compiledPrompt = blocks.map((item) => item.content).filter(Boolean).join('\n');
  const warnings = [];
  if (angleSelection.evidence.state === 'mismatch') {
    warnings.push({ code: 'identity_template_angle_mismatch', message: 'Customer identity and template face directions are not aligned.' });
  }
  if (angleSelection.evidence.state === 'unknown') {
    warnings.push({ code: 'identity_template_angle_unknown', message: 'Angle metadata is incomplete; alignment was not claimed.' });
  }
  const effectiveSource = {
    compiler_id: PROMPT_RECIPE_V2_COMPILER_ID,
    compiler_version: 2,
    prompt_input_mode: promptInputMode,
    task_intent: taskIntent,
    identity_transfer_block: identityTransferBlock,
    identity_references: identityReferences,
    template_references: templateReferences,
    angle_alignment: angleSelection.evidence,
    candidate_slate_request: candidateSlateRequest,
    active_corrections: activeCorrections,
  };
  const inputSha256 = sha256(stableJson(effectiveSource));
  const recipeIdentity = {
    prompt_input_mode: promptInputMode,
    block_hashes: blocks.map((item) => item.sha256),
    input_sha256: inputSha256,
  };

  return deepFreeze({
    schema_version: PROMPT_RECIPE_V2_VERSION,
    compiler_id: PROMPT_RECIPE_V2_COMPILER_ID,
    compiler_version: 2,
    recipe_id: `prompt-recipe_${sha256(stableJson(recipeIdentity)).slice(0, 24)}`,
    prompt_input_mode: promptInputMode,
    generation_regime_version: candidateSlateRequest?.generation_regime_version || null,
    task_intent_version: taskIntent.schema_version,
    blocks,
    identity_references: identityReferences,
    template_references: templateReferences,
    angle_alignment: angleSelection.evidence,
    applied_correction_ids: activeCorrections.map((item) => item.correction_id),
    shadow_correction_ids: shadowCorrections.map((item) => item.correction_id),
    shadow_ai_prompt_draft: input.aiPromptDraft || null,
    input_sha256: inputSha256,
    prompt_sha256: sha256(compiledPrompt),
    compiled_prompt: compiledPrompt,
    warnings,
    conflict_resolutions: [],
    ...(candidateSlateRequest ? { candidate_slate_request: candidateSlateRequest } : {}),
    compiled_at: new Date(0).toISOString(),
  });
}

export function buildPromptRecipePreview(compilation) {
  if (![PROMPT_RECIPE_VERSION, PROMPT_RECIPE_V2_VERSION].includes(compilation?.schema_version)) return null;
  return Object.freeze({
    prompt_input_mode: compilation.prompt_input_mode,
    real_template_required: true,
    block_ids: compilation.blocks.map((item) => item.block_id),
    applied_correction_count: compilation.applied_correction_ids.length,
    shadow_correction_count: compilation.shadow_correction_ids.length,
    exact_prompt: compilation.compiled_prompt,
  });
}
