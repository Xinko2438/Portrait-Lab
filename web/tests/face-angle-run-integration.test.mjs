import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseFaceAngleSubmission } from '../src/face-angle-evidence.mjs';
import { createRunSnapshot } from '../src/run-store.mjs';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc000000301010018dd8db10000000049454e44ae426082', 'hex');

async function startIsolatedServer(t) {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-face-angle-server-'));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      AI_IMG_GEN_PORT: '0',
      AI_IMG_GEN_PROJECT_ROOT: root,
      AI_IMG_GEN_PROMPT_RECIPE_V1_ENABLED: 'false',
      AI_IMG_GEN_AI_PROMPT_WRITER_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await new Promise((resolve) => child.exitCode === null ? child.once('exit', resolve) : resolve());
    await rm(root, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${stdout}${stderr}`)), 8_000);
    const inspect = () => {
      const match = stdout.match(/AI IMG GEN web: http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    };
    child.stdout.on('data', inspect);
    child.once('exit', () => reject(new Error(`server exited early: ${stderr}`)));
    inspect();
  });
  return { baseUrl: `http://127.0.0.1:${port}`, root };
}

function pose(sourceKind, sourceIndex, yaw, overrides = {}) {
  return {
    schema_version: 'ai-img-gen.face-pose-observation.v1',
    source_kind: sourceKind,
    source_index: sourceIndex,
    source_sha256: 'a'.repeat(64),
    analyzer: {
      name: 'mediapipe-face-landmarker',
      version: '1.0.1',
      model_sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
    },
    state: 'usable',
    yaw_deg: yaw,
    pitch_deg: 2,
    roll_deg: -3,
    angle_family: Math.abs(yaw) < 18 ? 'frontal' : 'three_quarter',
    legacy_angle: yaw < -18 ? 'left_45' : yaw > 18 ? 'right_45' : 'frontal',
    face_count: 1,
    face_coverage_ratio: 0.2,
    reliability: 'reliable',
    expression: {
      state: 'neutral',
      label: '中性表情',
      reliability: 'reliable',
      smile_score: 0.02,
      eye_closed_left: 0.01,
      eye_closed_right: 0.01,
      mouth_open_score: 0.03,
      source: 'mediapipe_blendshapes',
      semantic_temperament: 'not_inferred',
    },
    semantic_temperament: 'not_inferred',
    ...overrides,
  };
}

function match(overrides = {}) {
  return {
    schema_version: 'ai-img-gen.face-angle-match.v1',
    state: 'recommended',
    template_source_kind: 'uploaded_template',
    template_source_index: 0,
    recommended_identity_source_index: 1,
    final_identity_source_index: 1,
    selection_mode: 'automatic',
    match_score: 96.4,
    distance: { yaw: 2, pitch: 1, roll: 1, weighted_total: 2.95 },
    reason: 'closest_reliable_pose',
    ...overrides,
  };
}

test('submission parser accepts aligned local pose evidence and preserves original source identity after primary reordering', () => {
  const parsed = parseFaceAngleSubmission({
    identityRaw: JSON.stringify([pose('identity', 1, 34), pose('identity', 0, 2)]),
    uploadedTemplateRaw: JSON.stringify([pose('uploaded_template', 0, 36)]),
    catalogTemplateRaw: JSON.stringify({}),
    matchRaw: JSON.stringify(match()),
    pipelineVersionRaw: 'hybrid-profile-v2',
    identityFileCount: 2,
    uploadedTemplateCount: 1,
    catalogTemplateUids: [],
  });

  assert.equal(parsed.schema_version, 'ai-img-gen.face-angle-analysis.v1');
  assert.equal(parsed.pipeline_version, 'hybrid-profile-v2');
  assert.deepEqual(parsed.identity_observations.map((item) => item.source_index), [1, 0]);
  assert.equal(parsed.match.final_identity_source_index, 1);
  assert.equal(parsed.legacy_coverage_source, 'automatic');
});

test('submission parser rejects false certainty, impossible angles, and misaligned arrays', () => {
  assert.throws(() => parseFaceAngleSubmission({
    identityRaw: JSON.stringify([pose('identity', 0, 181)]),
    uploadedTemplateRaw: JSON.stringify([]),
    catalogTemplateRaw: JSON.stringify({}),
    matchRaw: JSON.stringify(match({ state: 'manual_required', final_identity_source_index: 0, recommended_identity_source_index: null, selection_mode: 'manual_fallback', match_score: null, distance: null, reason: 'operator_manual_fallback' })),
    identityFileCount: 1,
    uploadedTemplateCount: 0,
    catalogTemplateUids: [],
  }), /yaw_deg/i);

  assert.throws(() => parseFaceAngleSubmission({
    identityRaw: JSON.stringify([pose('identity', 0, 0)]),
    uploadedTemplateRaw: JSON.stringify([]),
    catalogTemplateRaw: JSON.stringify({}),
    matchRaw: JSON.stringify(match({ final_identity_source_index: 0, recommended_identity_source_index: 0 })),
    identityFileCount: 2,
    uploadedTemplateCount: 0,
    catalogTemplateUids: [],
  }), /identity observation count/i);

  assert.throws(() => parseFaceAngleSubmission({
    identityRaw: JSON.stringify([pose('identity', 0, 0, { state: 'no_face', reliability: 'unavailable', yaw_deg: null, pitch_deg: null, roll_deg: null })]),
    uploadedTemplateRaw: JSON.stringify([]),
    catalogTemplateRaw: JSON.stringify({}),
    matchRaw: JSON.stringify(match({ final_identity_source_index: 0, recommended_identity_source_index: 0 })),
    identityFileCount: 1,
    uploadedTemplateCount: 0,
    catalogTemplateUids: [],
  }), /automatic recommendation requires reliable/i);

  assert.throws(() => parseFaceAngleSubmission({
    identityRaw: JSON.stringify([pose('identity', 0, 0, { semantic_temperament: 'solemn' })]),
    uploadedTemplateRaw: JSON.stringify([]),
    catalogTemplateRaw: JSON.stringify({}),
    matchRaw: JSON.stringify(match({ state: 'manual_required', final_identity_source_index: 0, recommended_identity_source_index: null, selection_mode: 'manual_fallback', match_score: null, distance: null, reason: 'operator_manual_fallback' })),
    identityFileCount: 1,
    uploadedTemplateCount: 0,
    catalogTemplateUids: [],
  }), /semantic temperament/i);
});

test('legacy requests without face-angle evidence remain valid', () => {
  assert.equal(parseFaceAngleSubmission({
    identityRaw: '',
    uploadedTemplateRaw: '',
    catalogTemplateRaw: '',
    matchRaw: '',
    identityFileCount: 1,
    uploadedTemplateCount: 1,
    catalogTemplateUids: [],
  }), null);
});

test('Run persistence retains customer-scoped angle evidence and exact manual override', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-face-angle-'));
  const faceAngleAnalysis = parseFaceAngleSubmission({
    identityRaw: JSON.stringify([pose('identity', 1, 34), pose('identity', 0, 2)]),
    uploadedTemplateRaw: JSON.stringify([pose('uploaded_template', 0, 36)]),
    catalogTemplateRaw: JSON.stringify({}),
    matchRaw: JSON.stringify(match({
      selection_mode: 'manual_override',
      final_identity_source_index: 1,
      recommended_identity_source_index: 0,
      reason: 'operator_override',
    })),
    pipelineVersionRaw: 'hybrid-profile-v2',
    identityFileCount: 2,
    uploadedTemplateCount: 1,
    catalogTemplateUids: [],
  });

  const run = await createRunSnapshot({
    root,
    customerName: 'Customer Scoped Fixture',
    prompt: 'pose evidence fixture',
    identityFiles: [{ name: 'chosen.png', bytes: png }, { name: 'other.png', bytes: png }],
    templateFiles: [{ name: 'template.png', bytes: png }],
    referencePlan: { identityAngles: ['right_45', 'frontal'], targetAngle: 'right_45', targetFraming: 'bust' },
    customerContext: { intendedUse: 'professional_portrait' },
    faceAngleAnalysis,
  });

  assert.equal(run.manifest.face_angle_analysis.match.selection_mode, 'manual_override');
  assert.equal(run.manifest.face_angle_analysis.identity_observations[0].expression.label, '中性表情');
  assert.equal(run.manifest.face_angle_analysis.identity_observations[0].semantic_temperament, 'not_inferred');
  assert.equal(run.manifest.face_angle_analysis.match.recommended_identity_source_index, 0);
  assert.equal(run.manifest.face_angle_analysis.match.final_identity_source_index, 1);
  const onDisk = JSON.parse(await readFile(join(root, 'data', 'runs', run.runId, 'manifest.json'), 'utf8'));
  assert.deepEqual(onDisk.face_angle_analysis, run.manifest.face_angle_analysis);
  assert.equal(onDisk.identity_references[0].filename, '01-chosen.png');
});

test('rejected face-angle pipeline is disabled on next server start while legacy evidence remains readable', async (t) => {
  const { baseUrl, root } = await startIsolatedServer(t);
  const pageResponse = await fetch(baseUrl);
  assert.match(pageResponse.headers.get('content-security-policy') || '', /connect-src 'self' blob:/);
  const health = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(health.face_angle_matching, 'disabled');
  assert.equal(health.face_angle_profile_fallback, undefined);
  const rejectedRoute = await fetch(`${baseUrl}/api/face-angle/profile-fallback`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-image-width': '1',
      'x-image-height': '1',
      'x-source-kind': 'identity',
      'x-source-index': '0',
    },
    body: Buffer.alloc(3),
  });
  assert.equal(rejectedRoute.status, 404);
  const [moduleResponse, wasmResponse, modelResponse] = await Promise.all([
    fetch(`${baseUrl}/vendor/mediapipe/vision_bundle.mjs`),
    fetch(`${baseUrl}/vendor/mediapipe/wasm/vision_wasm_internal.wasm`),
    fetch(`${baseUrl}/vendor/mediapipe/face_landmarker.task`),
  ]);
  assert.deepEqual([moduleResponse.status, wasmResponse.status, modelResponse.status], [404, 404, 404]);

  const identityObservations = [pose('identity', 1, 34), pose('identity', 0, 2)];
  const templateObservations = [pose('uploaded_template', 0, 36)];
  const form = new FormData();
  form.append('customerName', 'HTTP Fixture');
  form.append('identity', new File([png], 'chosen.png', { type: 'image/png' }));
  form.append('identity', new File([png], 'other.png', { type: 'image/png' }));
  form.append('templates', new File([png], 'template.png', { type: 'image/png' }));
  form.append('intendedUse', 'professional_portrait');
  form.append('targetFraming', 'bust');
  form.append('targetIntentAngle', 'right_45');
  form.append('layoutIntent', 'follow_template');
  form.append('targetAngle', 'right_45');
  form.append('templateAngle', 'right_45');
  form.append('identityAngles', 'right_45');
  form.append('identityAngles', 'frontal');
  form.append('identityFaceAngles', 'right_45');
  form.append('identityFaceAngles', 'frontal');
  form.append('templateFaceAngles', 'right_45');
  form.append('identityFacePoseObservations', JSON.stringify(identityObservations));
  form.append('templateFacePoseObservations', JSON.stringify(templateObservations));
  form.append('catalogTemplateFacePoseObservations', JSON.stringify({}));
  form.append('faceAngleMatch', JSON.stringify(match()));
  form.append('faceAnglePipelineVersion', 'hybrid-profile-v2');

  const response = await fetch(`${baseUrl}/api/runs`, { method: 'POST', body: form });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  const manifest = JSON.parse(await readFile(join(root, 'data', 'runs', body.runId, 'manifest.json'), 'utf8'));
  assert.equal(manifest.face_angle_analysis.match.final_identity_source_index, 1);
  assert.equal(manifest.face_angle_analysis.pipeline_version, 'hybrid-profile-v2');
  assert.deepEqual(manifest.face_angle_analysis.identity_observations.map((item) => item.source_index), [1, 0]);
  assert.equal(manifest.identity_references[0].filename, '01-chosen.png');
});
