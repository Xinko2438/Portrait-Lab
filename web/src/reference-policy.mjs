import { REVIEW_RUBRIC } from './rubric.mjs';

const supportedAngles = new Set(REVIEW_RUBRIC.reference_preflight.supported_angles);
const recommendedAngles = REVIEW_RUBRIC.reference_preflight.recommended_identity_coverage;
export const REFERENCE_POLICY_VERSION = REVIEW_RUBRIC.reference_preflight.policy_version;

function normalizeAngle(value) {
  const angle = String(value || '').trim();
  return supportedAngles.has(angle) ? angle : '';
}

function normalizeAngles(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map(normalizeAngle)
    .filter(Boolean))];
}

export function evaluateReferencePlan({ referencePlan = {}, customerContext = {} } = {}) {
  const identityAngles = normalizeAngles(referencePlan.identityAngles || referencePlan.identity_angles || []);
  const targetAngle = normalizeAngle(referencePlan.targetAngle || referencePlan.target_angle);
  const templateAngle = normalizeAngle(referencePlan.templateAngle || referencePlan.template_angle);
  const targetFraming = String(referencePlan.targetFraming || referencePlan.target_framing || '').trim();
  const templateFraming = String(referencePlan.templateFraming || referencePlan.template_framing || '').trim();
  const businessDomain = String(customerContext.businessDomain || customerContext.business_domain || '').trim();
  const intendedUse = String(customerContext.intendedUse || customerContext.intended_use || '').trim();
  const blocking = [];
  const warnings = [];

  if (!identityAngles.length) blocking.push({ code: 'missing_identity_angle_coverage', message: '请标记客户身份参考图包含的角度。' });
  if (!targetAngle) blocking.push({ code: 'missing_target_angle', message: '请选择本次目标人脸角度。' });
  if (!targetFraming) blocking.push({ code: 'missing_target_framing', message: '请选择本次目标景别。' });
  if (!businessDomain && !intendedUse) blocking.push({ code: 'missing_client_context', message: '请填写客户领域或实际使用场景。' });
  if (targetAngle && !identityAngles.includes(targetAngle)) {
    blocking.push({ code: 'missing_identity_angle', message: '客户身份参考图没有覆盖本次目标角度。' });
  }
  if (targetAngle && templateAngle && targetAngle !== templateAngle) {
    warnings.push({ code: 'template_angle_mismatch', message: '历史记录的模板人物角度与本次目标角度不同；本次以目标角度和模板图片为准。' });
  }
  if (targetAngle === 'full_profile' || templateAngle === 'full_profile') {
    warnings.push({ code: 'full_profile_high_risk', message: '完整侧脸会隐藏面部特征，属于高风险角度。' });
  }
  const missingRecommended = recommendedAngles.filter((angle) => !identityAngles.includes(angle));
  if (missingRecommended.length) {
    warnings.push({ code: 'incomplete_golden_angle_coverage', message: '建议补齐正脸、左 45 度、右 45 度身份参考图。', missing_angles: missingRecommended });
  }
  if (targetFraming && templateFraming && targetFraming !== templateFraming) {
    warnings.push({ code: 'framing_mismatch', message: '目标景别与模板景别不同，可能增加头发和构图漂移。' });
  }

  return {
    policy_version: REFERENCE_POLICY_VERSION,
    state: blocking.length ? 'blocked' : (warnings.length ? 'passed_with_warnings' : 'passed'),
    blocking_issues: blocking,
    warnings,
    normalized_reference_plan: {
      identity_angles: identityAngles,
      target_angle: targetAngle,
      template_angle: templateAngle,
      target_framing: targetFraming,
      template_framing: templateFraming,
    },
    normalized_customer_context: {
      business_domain: businessDomain,
      intended_use: intendedUse,
    },
  };
}

export function assertReferenceReady(manifest) {
  const preflight = manifest?.reference_preflight;
  if (!preflight || preflight.state === 'blocked') {
    const codes = preflight?.blocking_issues?.map((issue) => issue.code).join(', ') || 'unassessed';
    throw new Error(`Reference preflight failed: ${codes}`);
  }
  return preflight;
}
