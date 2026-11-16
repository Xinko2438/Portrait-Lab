import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyPose,
  classifyExpression,
  compareFacePoses,
  poseFromTransformationMatrix,
  recommendIdentityPose,
  reorderPrimaryIdentity,
  matchConfidenceLabel,
} from '../public/face-angle-core.js';
import { createFaceAngleAnalyzer } from '../public/face-angle-analyzer.js';
import { createFaceAngleWorkflow } from '../public/face-angle-workflow.js';

function usablePose({ yaw = 0, pitch = 0, roll = 0, index = 0 } = {}) {
  return {
    schema_version: 'ai-img-gen.face-pose-observation.v1',
    source_kind: 'identity',
    source_index: index,
    state: 'usable',
    reliability: 'reliable',
    yaw_deg: yaw,
    pitch_deg: pitch,
    roll_deg: roll,
    face_count: 1,
    face_coverage_ratio: 0.18,
  };
}

test('pose conversion returns continuous yaw from a column-major facial rotation matrix', () => {
  const angle = Math.PI / 6;
  const matrix = {
    rows: 4,
    columns: 4,
    data: [
      Math.cos(angle), 0, -Math.sin(angle), 0,
      0, 1, 0, 0,
      Math.sin(angle), 0, Math.cos(angle), 0,
      0, 0, 0, 1,
    ],
  };

  const pose = poseFromTransformationMatrix(matrix);

  assert.equal(pose.valid, true);
  assert.ok(Math.abs(pose.yaw_deg - 30) < 0.01, `expected yaw 30, received ${pose.yaw_deg}`);
  assert.ok(Math.abs(pose.pitch_deg) < 0.01);
  assert.ok(Math.abs(pose.roll_deg) < 0.01);
});

test('pose conversion rejects missing, malformed, and non-finite matrices', () => {
  assert.deepEqual(poseFromTransformationMatrix(null), { valid: false, reason: 'invalid_matrix' });
  assert.deepEqual(poseFromTransformationMatrix({ data: [1, 2, 3] }), { valid: false, reason: 'invalid_matrix' });
  const malformed = Array(16).fill(0);
  malformed[5] = Number.NaN;
  assert.deepEqual(poseFromTransformationMatrix({ rows: 4, columns: 4, data: malformed }), { valid: false, reason: 'invalid_matrix' });
});

test('pose classification keeps continuous nuance while projecting readable and legacy angles', () => {
  assert.deepEqual(classifyPose({ yaw_deg: 8, pitch_deg: -4, roll_deg: 6 }), {
    angle_family: 'frontal',
    legacy_angle: 'frontal',
    display_label: '正面',
    pose_label: '正面',
    pose_detail: '右转 8° · 低头 4° · 右歪 6°',
  });
  assert.deepEqual(classifyPose({ yaw_deg: -34, pitch_deg: 3, roll_deg: -7 }), {
    angle_family: 'three_quarter',
    legacy_angle: 'left_45',
    display_label: '左侧 3/4 脸',
    pose_label: '左侧 3/4 脸',
    pose_detail: '左转 34° · 仰头 3° · 左歪 7°',
  });
  assert.deepEqual(classifyPose({ yaw_deg: 72, pitch_deg: 0, roll_deg: 2 }), {
    angle_family: 'profile',
    legacy_angle: 'full_profile',
    display_label: '完整右侧脸',
    pose_label: '完整右侧脸',
    pose_detail: '右转 72° · 平视 · 右歪 2°',
  });
  assert.deepEqual(classifyPose({ yaw_deg: 54, pitch_deg: -2, roll_deg: 4 }), {
    angle_family: 'three_quarter',
    legacy_angle: 'right_45',
    display_label: '右侧 3/4 脸',
    pose_label: '右侧 3/4 脸',
    pose_detail: '右转 54° · 低头 2° · 右歪 4°',
  });
  assert.deepEqual(classifyPose({ yaw_deg: -78, pitch_deg: 28, roll_deg: -14 }), {
    angle_family: 'profile',
    legacy_angle: 'full_profile',
    display_label: '完整左侧脸 · 明显仰头',
    pose_label: '完整左侧脸 · 明显仰头',
    pose_detail: '左转 78° · 仰头 28° · 左歪 14°',
  });
  assert.deepEqual(classifyPose({ yaw_deg: 72, pitch_deg: 5, roll_deg: -25 }), {
    angle_family: 'profile',
    legacy_angle: 'full_profile',
    display_label: '完整右侧脸 · 轻微低头',
    pose_label: '完整右侧脸 · 轻微低头',
    pose_detail: '右转 72° · 仰头 5° · 左歪 25°',
  });
});

test('objective expression classification keeps subjective temperament uninferred', () => {
  const categories = [
    { categoryName: 'mouthSmileLeft', score: 0.72 },
    { categoryName: 'mouthSmileRight', score: 0.68 },
    { categoryName: 'eyeBlinkLeft', score: 0.12 },
    { categoryName: 'eyeBlinkRight', score: 0.08 },
    { categoryName: 'jawOpen', score: 0.58 },
  ];

  const expression = classifyExpression(categories, { yaw_deg: 20 });

  assert.equal(expression.state, 'smile');
  assert.equal(expression.label, '微笑 · 张嘴');
  assert.equal(expression.reliability, 'reliable');
  assert.equal(expression.smile_score, 0.7);
  assert.equal(expression.mouth_open_score, 0.58);
  assert.equal(expression.semantic_temperament, 'not_inferred');

  const profile = classifyExpression(categories, { yaw_deg: -72 });
  assert.equal(profile.state, 'unavailable_profile');
  assert.equal(profile.label, '侧脸表情信息不足');
  assert.equal(profile.reliability, 'unavailable');
  assert.equal(profile.semantic_temperament, 'not_inferred');

  const subtle = classifyExpression([
    { categoryName: 'mouthSmileLeft', score: 0.05 },
    { categoryName: 'mouthSmileRight', score: 0.042 },
  ], { yaw_deg: 18 });
  assert.equal(subtle.state, 'slight_smile');
  assert.equal(subtle.label, '轻微笑意');
  assert.equal(subtle.reliability, 'low');

  const closedEyes = classifyExpression([
    { categoryName: 'eyeBlinkLeft', score: 0.81 },
    { categoryName: 'eyeBlinkRight', score: 0.12 },
  ], { yaw_deg: -42 });
  assert.equal(closedEyes.state, 'neutral');
  assert.equal(closedEyes.label, '闭眼');
  assert.equal(closedEyes.reliability, 'reliable');
});

test('continuous comparison ranks the truly closer three-axis pose above a coarse-family tie', () => {
  const template = usablePose({ yaw: 38, pitch: -7, roll: 11 });
  template.source_kind = 'uploaded_template';
  const close = usablePose({ yaw: 35, pitch: -5, roll: 9, index: 1 });
  const sameBucketButFar = usablePose({ yaw: 58, pitch: 17, roll: -8, index: 2 });

  const closeResult = compareFacePoses(close, template);
  const farResult = compareFacePoses(sameBucketButFar, template);

  assert.equal(closeResult.comparable, true);
  assert.ok(closeResult.weighted_total < farResult.weighted_total);
  assert.ok(closeResult.match_score > farResult.match_score);
  assert.deepEqual(closeResult.distance, { yaw: 3, pitch: 2, roll: 2 });
});

test('user-facing match confidence avoids false percentage precision', () => {
  assert.equal(matchConfidenceLabel(96.8), '姿态高度接近');
  assert.equal(matchConfidenceLabel(82), '姿态较接近');
  assert.equal(matchConfidenceLabel(69), '姿态差异较大');
  assert.equal(matchConfidenceLabel(null), '姿态待确认');
});

test('recommendation selects the closest reliable identity and explains weak or missing evidence', () => {
  const identities = [
    usablePose({ yaw: 2, pitch: 0, roll: 1, index: 0 }),
    usablePose({ yaw: 36, pitch: -4, roll: 7, index: 1 }),
    usablePose({ yaw: 79, pitch: -2, roll: 5, index: 2 }),
  ];
  const template = usablePose({ yaw: 39, pitch: -6, roll: 9 });
  template.source_kind = 'catalog_template';

  const recommended = recommendIdentityPose(identities, template);

  assert.equal(recommended.state, 'recommended');
  assert.equal(recommended.recommended_identity_source_index, 1);
  assert.equal(recommended.final_identity_source_index, 1);
  assert.equal(recommended.selection_mode, 'automatic');
  assert.ok(recommended.match_score >= 90);

  const unavailable = recommendIdentityPose(identities, { state: 'multiple_faces', reliability: 'unavailable' });
  assert.equal(unavailable.state, 'manual_required');
  assert.equal(unavailable.reason, 'template_pose_unavailable');
  assert.equal(unavailable.recommended_identity_source_index, null);
});

test('primary identity reordering keeps files and pose evidence aligned without mutating inputs', () => {
  const files = [{ name: 'front.jpg' }, { name: 'turn.jpg' }, { name: 'profile.jpg' }];
  const observations = [
    usablePose({ yaw: 0, index: 0 }),
    usablePose({ yaw: 37, index: 1 }),
    usablePose({ yaw: 76, index: 2 }),
  ];

  const reordered = reorderPrimaryIdentity(files, observations, 1);

  assert.deepEqual(reordered.files.map((item) => item.name), ['turn.jpg', 'front.jpg', 'profile.jpg']);
  assert.deepEqual(reordered.observations.map((item) => item.yaw_deg), [37, 0, 76]);
  assert.deepEqual(reordered.observations.map((item) => item.source_index), [1, 0, 2]);
  assert.deepEqual(files.map((item) => item.name), ['front.jpg', 'turn.jpg', 'profile.jpg']);
});

test('local analyzer converts a real detector-shaped result without accepting remote asset URLs', async () => {
  const requested = {};
  const angle = Math.PI / 6;
  const detectorResult = {
    faceLandmarks: [[{ x: 0.3, y: 0.2 }, { x: 0.7, y: 0.8 }]],
    facialTransformationMatrixes: [{
      rows: 4,
      columns: 4,
      data: [
        Math.cos(angle), 0, -Math.sin(angle), 0,
        0, 1, 0, 0,
        Math.sin(angle), 0, Math.cos(angle), 0,
        0, 0, 0, 1,
      ],
    }],
  };
  const analyzer = createFaceAngleAnalyzer({
    profileFallback: null,
    wasmRoot: '/vendor/mediapipe/wasm',
    modelUrl: '/vendor/mediapipe/face_landmarker.task',
    modelSha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
    loadVision: async (assets) => {
      Object.assign(requested, assets);
      return { detector: { detect: () => detectorResult }, packageVersion: '1.0.1' };
    },
  });

  const observation = await analyzer.analyzeFacePose({ width: 1000, height: 1000 }, {
    sourceKind: 'identity',
    sourceIndex: 2,
    sourceSha256: 'b'.repeat(64),
  });

  assert.deepEqual(requested, {
    wasmRoot: '/vendor/mediapipe/wasm',
    modelUrl: '/vendor/mediapipe/face_landmarker.task',
  });
  assert.equal(observation.state, 'usable');
  assert.equal(observation.reliability, 'reliable');
  assert.equal(observation.source_index, 2);
  assert.ok(Math.abs(observation.yaw_deg - 30) < 0.01);
  assert.equal(observation.angle_family, 'three_quarter');
  assert.equal(observation.face_count, 1);
  assert.equal(observation.face_coverage_ratio, 0.24);
});

test('local analyzer refuses no-face, multi-face, and too-small-face results', async () => {
  const results = [
    { faceLandmarks: [], facialTransformationMatrixes: [] },
    { faceLandmarks: [[{ x: 0.1, y: 0.1 }], [{ x: 0.7, y: 0.7 }]], facialTransformationMatrixes: [{}, {}] },
    { faceLandmarks: [[{ x: 0.49, y: 0.49 }, { x: 0.51, y: 0.51 }]], facialTransformationMatrixes: [{ data: Array(16).fill(0) }] },
  ];
  const analyzer = createFaceAngleAnalyzer({
    profileFallback: null,
    loadVision: async () => ({ detector: { detect: () => results.shift() }, packageVersion: '1.0.1' }),
    wasmRoot: '/vendor/mediapipe/wasm',
    modelUrl: '/vendor/mediapipe/face_landmarker.task',
    modelSha256: 'c'.repeat(64),
  });

  const noFace = await analyzer.analyzeFacePose({}, { sourceKind: 'identity', sourceIndex: 0 });
  const multiple = await analyzer.analyzeFacePose({}, { sourceKind: 'identity', sourceIndex: 1 });
  const tooSmall = await analyzer.analyzeFacePose({}, { sourceKind: 'identity', sourceIndex: 2 });

  assert.deepEqual([noFace.state, multiple.state, tooSmall.state], ['no_face', 'multiple_faces', 'face_too_small']);
  assert.deepEqual([noFace.reliability, multiple.reliability, tooSmall.reliability], ['unavailable', 'unavailable', 'low']);
  assert.equal(noFace.yaw_deg, null);
  assert.equal(multiple.yaw_deg, null);
});

test('local analyzer turns a bounded model timeout into an explicit manual-selection state', async () => {
  const analyzer = createFaceAngleAnalyzer({
    profileFallback: null,
    loadVision: () => new Promise(() => {}),
    initializationTimeoutMs: 5,
    wasmRoot: '/vendor/mediapipe/wasm',
    modelUrl: '/vendor/mediapipe/face_landmarker.task',
  });

  const observation = await analyzer.analyzeFacePose({}, { sourceKind: 'identity', sourceIndex: 0 });

  assert.equal(observation.state, 'timeout');
  assert.equal(observation.reliability, 'unavailable');
  assert.equal(observation.display_label, '分析超时，请手动选择');
});

test('fast-path no-face result uses the local profile fallback exactly once', async () => {
  let fallbackCalls = 0;
  const analyzer = createFaceAngleAnalyzer({
    loadVision: async () => ({
      detector: { detect: () => ({ faceLandmarks: [], facialTransformationMatrixes: [] }) },
      packageVersion: '1.0.1',
    }),
    profileFallback: async (_source, context) => {
      fallbackCalls += 1;
      return {
        ...usablePose({ yaw: -42, pitch: 11, roll: -4, index: context.sourceIndex }),
        source_kind: context.sourceKind,
        analyzer: { name: 'openseeface-profile-fallback', version: '1.20.4', model_sha256: '5'.repeat(64) },
        analysis_stage: 'profile_fallback',
        angle_family: 'three_quarter',
        legacy_angle: 'left_45',
        display_label: '左侧 3/4 脸',
        expression: {
          state: 'eyes_closed',
          label: '闭眼',
          reliability: 'low',
          source: 'openseeface_landmarks',
          semantic_temperament: 'not_inferred',
        },
      };
    },
  });

  const observation = await analyzer.analyzeFacePose({}, { sourceKind: 'identity', sourceIndex: 3 });

  assert.equal(fallbackCalls, 1);
  assert.equal(observation.state, 'usable');
  assert.equal(observation.analyzer.name, 'openseeface-profile-fallback');
  assert.equal(observation.analysis_stage, 'profile_fallback');
  assert.equal(observation.yaw_deg, -42);
  assert.equal(observation.expression.label, '闭眼');
  assert.equal(observation.expression.source, 'openseeface_landmarks');
});

test('full-range local pose overrides a materially lower fast-path profile estimate', async () => {
  const angle = 54 * Math.PI / 180;
  const analyzer = createFaceAngleAnalyzer({
    loadVision: async () => ({
      detector: {
        detect: () => ({
          faceLandmarks: [[{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }]],
          facialTransformationMatrixes: [{
            rows: 4,
            columns: 4,
            data: [Math.cos(angle), 0, -Math.sin(angle), 0, 0, 1, 0, 0, Math.sin(angle), 0, Math.cos(angle), 0, 0, 0, 0, 1],
          }],
          faceBlendshapes: [{ categories: [{ categoryName: 'mouthSmileLeft', score: 0.7 }, { categoryName: 'mouthSmileRight', score: 0.7 }] }],
        }),
      },
      packageVersion: '1.0.1',
    }),
    profileFallback: async (_source, context) => ({
      ...usablePose({ yaw: 78, pitch: 8, roll: 4, index: context.sourceIndex }),
      source_kind: context.sourceKind,
      analyzer: { name: 'openseeface-profile-fallback', version: '1.20.4', model_sha256: '5'.repeat(64) },
      analysis_stage: 'profile_fallback',
      angle_family: 'profile',
      legacy_angle: 'full_profile',
      display_label: '向右接近侧脸 78°',
    }),
  });

  const observation = await analyzer.analyzeFacePose({ width: 400, height: 500 }, { sourceKind: 'identity', sourceIndex: 3 });

  assert.equal(observation.yaw_deg, 78);
  assert.equal(observation.display_label, '完整右侧脸 · 轻微仰头');
  assert.equal(observation.expression.state, 'unavailable_profile');
  assert.equal(observation.estimator_comparison.fast_yaw_deg, 54);
  assert.equal(observation.estimator_comparison.authoritative_yaw_deg, 78);
});

test('workflow recommends automatically, preserves an override, and prepares aligned submission evidence', async () => {
  const analyze = async (source, context) => ({ ...source.observation, source_kind: context.sourceKind, source_index: context.sourceIndex });
  const workflow = createFaceAngleWorkflow({ analyze });
  const identities = [
    { observation: usablePose({ yaw: 1, index: 0 }) },
    { observation: usablePose({ yaw: 38, pitch: -4, roll: 6, index: 1 }) },
  ];
  const templates = [{ observation: { ...usablePose({ yaw: 40, pitch: -5, roll: 8 }), source_kind: 'uploaded_template' } }];

  await workflow.setInputs({ identitySources: identities, uploadedTemplateSources: templates, catalogTemplateSources: [] });
  assert.equal(workflow.getState().match.recommended_identity_source_index, 1);
  workflow.overridePrimary(0);
  assert.equal(workflow.getState().match.selection_mode, 'manual_override');
  assert.equal(workflow.getState().match.recommended_identity_source_index, 1);
  assert.equal(workflow.getState().match.final_identity_source_index, 0);

  const prepared = await workflow.prepareSubmission([{ name: 'front.jpg' }, { name: 'turn.jpg' }]);
  assert.deepEqual(prepared.files.map((file) => file.name), ['front.jpg', 'turn.jpg']);
  assert.deepEqual(prepared.identityObservations.map((item) => item.source_index), [0, 1]);
  assert.equal(prepared.match.selection_mode, 'manual_override');
});

test('workflow discards stale asynchronous analysis after inputs change', async () => {
  let releaseOld;
  const oldGate = new Promise((resolve) => { releaseOld = resolve; });
  const analyze = async (source, context) => {
    if (source.id === 'old') await oldGate;
    return { ...usablePose({ yaw: source.yaw, index: context.sourceIndex }), source_kind: context.sourceKind };
  };
  const workflow = createFaceAngleWorkflow({ analyze });
  const oldRun = workflow.setInputs({
    identitySources: [{ id: 'old', yaw: -40 }],
    uploadedTemplateSources: [{ id: 'old', yaw: -42 }],
    catalogTemplateSources: [],
  });
  const newRun = workflow.setInputs({
    identitySources: [{ id: 'new', yaw: 35 }],
    uploadedTemplateSources: [{ id: 'new', yaw: 37 }],
    catalogTemplateSources: [],
  });
  await newRun;
  releaseOld();
  await oldRun;

  assert.equal(workflow.getState().identityObservations[0].yaw_deg, 35);
  assert.equal(workflow.getState().revision, 2);
});

test('workflow exposes manual fallback instead of false certainty when template pose is unavailable', async () => {
  const analyze = async (source, context) => ({ ...source.observation, source_kind: context.sourceKind, source_index: context.sourceIndex });
  const workflow = createFaceAngleWorkflow({ analyze });
  await workflow.setInputs({
    identitySources: [{ observation: usablePose({ yaw: 0, index: 0 }) }, { observation: usablePose({ yaw: 35, index: 1 }) }],
    uploadedTemplateSources: [{ observation: { ...usablePose(), state: 'multiple_faces', reliability: 'unavailable', yaw_deg: null, pitch_deg: null, roll_deg: null } }],
    catalogTemplateSources: [],
  });

  assert.equal(workflow.getState().match.state, 'manual_required');
  workflow.overridePrimary(1);
  assert.equal(workflow.getState().match.selection_mode, 'manual_fallback');
  assert.equal(workflow.getState().match.final_identity_source_index, 1);
});
