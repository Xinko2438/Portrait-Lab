export const TASK_INTENT_VERSION = 'ai-img-gen.task-intent.v1';

export const TASK_INTENT_VOCABULARY = Object.freeze({
  useCases: ['livestream_cover', 'social_avatar', 'personal_ip_poster', 'course_promotion', 'company_profile', 'event_poster', 'professional_portrait', 'lifestyle_portrait', 'custom'],
  framings: ['follow_template', 'close_up', 'bust', 'half_body', 'three_quarter', 'full_body', 'environmental_portrait'],
  faceAngles: ['follow_identity', 'follow_template', 'front', 'slight_turn', 'left_45', 'right_45', 'profile'],
  temperaments: ['professional', 'trustworthy', 'approachable', 'premium', 'cool', 'energetic', 'calm', 'technological', 'editorial', 'cinematic'],
  layouts: ['no_text', 'follow_template', 'copy_left', 'copy_right', 'copy_top', 'copy_bottom'],
});

function clean(value) { return String(value ?? '').trim().replace(/\s+/g, ' '); }
function canonical(value) { return clean(value).toLowerCase().replace(/[\s-]+/g, '_'); }
function requireToken(value, allowed, label, fallback = '') {
  const token = canonical(value || fallback);
  if (!allowed.includes(token)) throw new Error(`Invalid ${label}: ${value || ''}`);
  return token;
}
function uniqueTokens(values, allowed, label) {
  const list = Array.isArray(values) ? values : values == null || values === '' ? [] : [values];
  const normalized = [...new Set(list.map(canonical).filter(Boolean))];
  for (const token of normalized) if (!allowed.includes(token)) throw new Error(`Invalid ${label}: ${token}`);
  return normalized;
}

export function normalizeTaskIntent(input = {}) {
  return {
    schema_version: TASK_INTENT_VERSION,
    use_case: requireToken(input.useCase ?? input.use_case, TASK_INTENT_VOCABULARY.useCases, 'use case'),
    target_framing: requireToken(input.targetFraming ?? input.target_framing ?? 'follow_template', TASK_INTENT_VOCABULARY.framings, 'target framing'),
    target_face_angle: requireToken(input.targetFaceAngle ?? input.target_face_angle ?? 'follow_identity', TASK_INTENT_VOCABULARY.faceAngles, 'target face angle'),
    temperament_keywords: uniqueTokens(input.temperamentKeywords ?? input.temperament_keywords, TASK_INTENT_VOCABULARY.temperaments, 'temperament'),
    layout_intent: requireToken(input.layoutIntent ?? input.layout_intent ?? 'follow_template', TASK_INTENT_VOCABULARY.layouts, 'layout intent'),
    custom_use_case: clean(input.customUseCase ?? input.custom_use_case),
    custom_framing: clean(input.customFraming ?? input.custom_framing),
    custom_face_angle: clean(input.customFaceAngle ?? input.custom_face_angle),
    user_supplement: clean(input.userSupplement ?? input.user_supplement),
  };
}