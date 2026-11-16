export const TASK_INTENT_OPTIONS = {
  useCases: [
    ['livestream_cover', '直播封面'], ['social_avatar', '社交媒体头像'], ['personal_ip_poster', '个人 IP 海报'], ['course_promotion', '课程宣传'], ['company_profile', '企业宣传'], ['event_poster', '活动海报'], ['professional_portrait', '职业形象'], ['lifestyle_portrait', '生活写真'], ['custom', '自定义'],
  ],
  temperaments: [
    ['professional', '专业'], ['trustworthy', '可信'], ['approachable', '亲和'], ['premium', '高级'], ['cool', '冷峻'], ['energetic', '活力'], ['calm', '沉稳'], ['technological', '科技感'], ['editorial', '杂志感'], ['cinematic', '电影感'],
  ],
};
function clean(value) { return String(value ?? '').trim().replace(/\s+/g, ' '); }
function fnv1a64(value) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(clean(value).normalize('NFKC').toLowerCase() || 'anonymous-customer')) {
    hash ^= BigInt(byte); hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}
export function customerIdFromName(name) { return `cust_${fnv1a64(name)}`; }
export function taskIntentFromForm(form) {
  return {
    useCase: clean(form.get('intendedUse')),
    targetFraming: clean(form.get('targetFraming')) || 'follow_template',
    targetFaceAngle: clean(form.get('targetIntentAngle')) || 'follow_identity',
    temperamentKeywords: form.getAll('temperamentKeywords').map(clean).filter(Boolean),
    layoutIntent: clean(form.get('layoutIntent')) || 'follow_template',
    userSupplement: clean(form.get('userSupplement')),
  };
}