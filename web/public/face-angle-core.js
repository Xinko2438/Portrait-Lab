export const FACE_POSE_SCHEMA_VERSION = 'ai-img-gen.face-pose-observation.v1';
export const FACE_ANGLE_MATCH_SCHEMA_VERSION = 'ai-img-gen.face-angle-match.v1';

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function degrees(radians) {
  return radians * (180 / Math.PI);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function poseFromTransformationMatrix(matrix) {
  const data = Array.from(matrix?.data || []);
  if (data.length !== 16 || data.some((value) => !Number.isFinite(Number(value)))) {
    return { valid: false, reason: 'invalid_matrix' };
  }
  if ((matrix?.rows != null && Number(matrix.rows) !== 4) || (matrix?.columns != null && Number(matrix.columns) !== 4)) {
    return { valid: false, reason: 'invalid_matrix' };
  }

  // MediaPipe exposes a column-major 4x4 transform. These are the same
  // rotation terms used by a conventional XYZ Euler decomposition.
  const m11 = Number(data[0]);
  const m12 = Number(data[4]);
  const m13 = Number(data[8]);
  const m22 = Number(data[5]);
  const m23 = Number(data[9]);
  const m32 = Number(data[6]);
  const m33 = Number(data[10]);
  const yaw = Math.asin(clamp(m13, -1, 1));
  let pitch;
  let roll;
  if (Math.abs(m13) < 0.9999999) {
    pitch = Math.atan2(-m23, m33);
    roll = Math.atan2(-m12, m11);
  } else {
    pitch = Math.atan2(m32, m22);
    roll = 0;
  }

  const result = {
    valid: true,
    yaw_deg: round(degrees(yaw)),
    pitch_deg: round(degrees(pitch)),
    roll_deg: round(degrees(roll)),
  };
  if (Object.values(result).slice(1).some((value) => !Number.isFinite(value))) {
    return { valid: false, reason: 'invalid_matrix' };
  }
  return result;
}

export function classifyPose(pose = {}) {
  const yaw = finiteNumber(pose.yaw_deg);
  if (yaw === null) {
    return { angle_family: 'unknown', legacy_angle: 'other', display_label: '角度未知', pose_label: '角度未知', pose_detail: '角度未知' };
  }
  const pitch = finiteNumber(pose.pitch_deg) ?? 0;
  const roll = finiteNumber(pose.roll_deg) ?? 0;
  const magnitude = Math.abs(yaw);
  const direction = yaw < 0 ? '左' : '右';
  let angleFamily;
  let legacyAngle;
  let horizontalLabel;
  if (magnitude < 15) {
    angleFamily = 'frontal';
    legacyAngle = 'frontal';
    horizontalLabel = '正面';
  } else if (magnitude < 30) {
    angleFamily = 'slight_turn';
    legacyAngle = yaw < 0 ? 'left_45' : 'right_45';
    horizontalLabel = `轻微向${direction}侧转`;
  } else if (magnitude < 60) {
    angleFamily = 'three_quarter';
    legacyAngle = yaw < 0 ? 'left_45' : 'right_45';
    horizontalLabel = `${direction}侧 3/4 脸`;
  } else {
    angleFamily = 'profile';
    legacyAngle = 'full_profile';
    horizontalLabel = `完整${direction}侧脸`;
  }
  const labels = [horizontalLabel];
  const displayPitch = angleFamily === 'profile' ? pitch + (Math.sign(yaw) * roll) : pitch;
  if (Math.abs(displayPitch) >= 12) labels.push(`${Math.abs(displayPitch) >= 25 ? '明显' : '轻微'}${displayPitch > 0 ? '仰头' : '低头'}`);
  if (angleFamily !== 'profile' && Math.abs(roll) >= 10) labels.push(`头部向${roll < 0 ? '左' : '右'}歪`);
  const poseLabel = labels.join(' · ');
  const yawDetail = `${yaw < 0 ? '左' : '右'}转 ${Math.round(Math.abs(yaw))}°`;
  const pitchDetail = Math.abs(pitch) < 0.5 ? '平视' : `${pitch > 0 ? '仰头' : '低头'} ${Math.round(Math.abs(pitch))}°`;
  const rollDetail = Math.abs(roll) < 0.5 ? '头正' : `${roll < 0 ? '左' : '右'}歪 ${Math.round(Math.abs(roll))}°`;
  return {
    angle_family: angleFamily,
    legacy_angle: legacyAngle,
    display_label: poseLabel,
    pose_label: poseLabel,
    pose_detail: `${yawDetail} · ${pitchDetail} · ${rollDetail}`,
  };
}

function blendshapeScores(categories = []) {
  return new Map((Array.isArray(categories) ? categories : []).map((item) => [String(item?.categoryName || item?.category_name || ''), Number(item?.score || 0)]));
}

export function classifyExpression(categories = [], pose = {}) {
  const scores = blendshapeScores(categories);
  const smile = round(((scores.get('mouthSmileLeft') || 0) + (scores.get('mouthSmileRight') || 0)) / 2, 3);
  const eyeClosedLeft = round(scores.get('eyeBlinkLeft') || 0, 3);
  const eyeClosedRight = round(scores.get('eyeBlinkRight') || 0, 3);
  const mouthOpen = round(scores.get('jawOpen') || 0, 3);
  const base = {
    smile_score: smile,
    eye_closed_left: eyeClosedLeft,
    eye_closed_right: eyeClosedRight,
    mouth_open_score: mouthOpen,
    source: 'mediapipe_blendshapes',
    semantic_temperament: 'not_inferred',
  };
  if (Math.abs(Number(pose?.yaw_deg || 0)) >= 60) {
    return { ...base, state: 'unavailable_profile', label: '侧脸表情信息不足', reliability: 'unavailable' };
  }
  if (!scores.size) return { ...base, state: 'unavailable', label: '表情信息不足', reliability: 'unavailable' };
  const state = smile >= 0.45 ? 'smile' : smile >= 0.04 ? 'slight_smile' : 'neutral';
  const eyesClosed = eyeClosedLeft >= 0.55 || eyeClosedRight >= 0.55;
  const labels = [];
  if (state === 'smile') labels.push('微笑');
  else if (state === 'slight_smile') labels.push('轻微笑意');
  if (eyesClosed) labels.push('闭眼');
  if (mouthOpen >= 0.45) labels.push('张嘴');
  if (!labels.length) labels.push('中性表情');
  return { ...base, state, label: labels.join(' · '), reliability: state === 'slight_smile' ? 'low' : 'reliable' };
}

export function isUsableFacePose(observation) {
  return observation?.state === 'usable'
    && observation?.reliability === 'reliable'
    && ['yaw_deg', 'pitch_deg', 'roll_deg'].every((key) => finiteNumber(observation[key]) !== null);
}

export function compareFacePoses(identity, template) {
  if (!isUsableFacePose(identity) || !isUsableFacePose(template)) {
    return { comparable: false, reason: 'pose_unavailable', match_score: null, weighted_total: null, distance: null };
  }
  const distance = {
    yaw: round(Math.abs(Number(identity.yaw_deg) - Number(template.yaw_deg))),
    pitch: round(Math.abs(Number(identity.pitch_deg) - Number(template.pitch_deg))),
    roll: round(Math.abs(Number(identity.roll_deg) - Number(template.roll_deg))),
  };
  const weightedTotal = round(distance.yaw + (distance.pitch * 0.6) + (distance.roll * 0.35));
  return {
    comparable: true,
    distance,
    weighted_total: weightedTotal,
    match_score: round(clamp(100 - (weightedTotal * 1.5), 0, 100), 1),
  };
}

export function matchConfidenceLabel(score) {
  if (score == null || score === '') return '姿态待确认';
  const numeric = finiteNumber(score);
  if (numeric === null) return '姿态待确认';
  if (numeric >= 90) return '姿态高度接近';
  if (numeric >= 75) return '姿态较接近';
  return '姿态差异较大';
}

export function recommendIdentityPose(identityObservations = [], templateObservation = null) {
  const base = {
    schema_version: FACE_ANGLE_MATCH_SCHEMA_VERSION,
    template_source_kind: templateObservation?.source_kind || null,
    template_source_index: Number.isInteger(templateObservation?.source_index) ? templateObservation.source_index : null,
    recommended_identity_source_index: null,
    final_identity_source_index: null,
    selection_mode: 'manual_fallback',
    match_score: null,
    distance: null,
  };
  if (!isUsableFacePose(templateObservation)) {
    return { ...base, state: 'manual_required', reason: 'template_pose_unavailable' };
  }
  const candidates = identityObservations
    .filter(isUsableFacePose)
    .map((observation) => ({ observation, comparison: compareFacePoses(observation, templateObservation) }))
    .sort((left, right) => (
      left.comparison.weighted_total - right.comparison.weighted_total
      || Number(left.observation.source_index) - Number(right.observation.source_index)
    ));
  if (!candidates.length) {
    return { ...base, state: 'manual_required', reason: 'identity_pose_unavailable' };
  }
  const best = candidates[0];
  const sourceIndex = Number(best.observation.source_index);
  const strong = best.comparison.match_score >= 70;
  return {
    ...base,
    state: strong ? 'recommended' : 'low_similarity',
    recommended_identity_source_index: sourceIndex,
    final_identity_source_index: sourceIndex,
    selection_mode: 'automatic',
    match_score: best.comparison.match_score,
    distance: {
      ...best.comparison.distance,
      weighted_total: best.comparison.weighted_total,
    },
    reason: strong ? 'closest_reliable_pose' : 'closest_pose_low_similarity',
  };
}

export function reorderPrimaryIdentity(files = [], observations = [], finalSourceIndex = 0) {
  const selectedPosition = observations.findIndex((item) => Number(item?.source_index) === Number(finalSourceIndex));
  const fallbackPosition = files.length === observations.length && selectedPosition >= 0
    ? selectedPosition
    : Number(finalSourceIndex);
  if (!Number.isInteger(fallbackPosition) || fallbackPosition < 0 || fallbackPosition >= files.length) {
    throw new RangeError('Primary identity index does not resolve to an uploaded identity file');
  }
  const remainingPositions = files.map((_, index) => index).filter((index) => index !== fallbackPosition);
  const order = [fallbackPosition, ...remainingPositions];
  return {
    files: order.map((index) => files[index]),
    observations: order.map((index) => observations[index]),
    original_positions: order,
  };
}
