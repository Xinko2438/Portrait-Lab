import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildCandidateSlateRequest } from '../src/intelligent-workbench/candidate-slate.mjs';
import { normalizeTaskIntent } from '../src/intelligent-workbench/intent-schema.mjs';
import { compileDeterministicPrompt } from '../src/intelligent-workbench/prompt-compilation.mjs';
import { createRunSnapshot, loadRun } from '../src/run-store.mjs';
import { rebuildReviewGuidance } from '../src/learning-projection.mjs';
import { REVIEW_RUBRIC } from '../src/rubric.mjs';

const recipeModule = await import('../src/intelligent-workbench/prompt-recipe.mjs').catch(() => ({}));
const runtimeModule = await import('../src/intelligent-workbench/prompt-recipe-runtime.mjs').catch(() => ({}));
const serverConfigModule = await import('../src/server-config.mjs').catch(() => ({}));
const identityAsset = JSON.parse(await readFile(new URL('../../prompts/validated-identity-transfer.json', import.meta.url), 'utf8'));

const EXPECTED_PROMPT_SHA256 = '86784b995cec1b3c9b8751d33de4d016341b8642e3b11c0be40abfc5f14bbc46';
const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAF/gL+4R9SAAAAAElFTkSuQmCC', 'base64');

function recipeInput(overrides = {}) {
  return {
    promptInputMode: 'reference_image',
    identityTransferBlock: identityAsset,
    taskIntent: normalizeTaskIntent({
      useCase: 'professional_portrait',
      targetFraming: 'bust',
      targetFaceAngle: 'front',
      temperamentKeywords: ['professional', 'trustworthy'],
      layoutIntent: 'no_text',
    }),
    identityReferences: [
      { ordinal: 1, sha256: 'a'.repeat(64), role: 'primary_front' },
      { ordinal: 2, sha256: 'b'.repeat(64), role: 'identity_support' },
    ],
    templateReferences: [
      {
        ordinal: 3,
        sha256: 'c'.repeat(64),
        template_uid: 'tpl_test_001',
        template_name: '职业杂志模板',
        style_category: 'editorial',
        portrait_scale: 'bust',
        face_angle: 'front',
      },
    ],
    candidateSlateRequest: buildCandidateSlateRequest(),
    activeCorrections: [],
    shadowCorrections: [],
    aiPromptDraft: null,
    ...overrides,
  };
}

async function startIsolatedServer(t, { recipeEnabled }) {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-prompt-server-'));
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, 'prompts', 'validated-identity-transfer.json'), `${JSON.stringify(identityAsset, null, 2)}\n`, 'utf8');
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      AI_IMG_GEN_PORT: '0',
      AI_IMG_GEN_PROJECT_ROOT: root,
      AI_IMG_GEN_PROMPT_RECIPE_V1_ENABLED: recipeEnabled ? 'true' : 'false',
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
    const timer = setTimeout(() => reject(new Error(`Isolated server did not report an assigned port: ${stdout}${stderr}`)), 2_000);
    const inspect = () => {
      const match = stdout.match(/AI IMG GEN web: http:\/\/127\.0\.0\.1:(\d+)/);
      const assigned = Number(match?.[1]);
      if (!Number.isInteger(assigned) || assigned <= 0) return;
      clearTimeout(timer);
      resolve(assigned);
    };
    child.stdout.on('data', inspect);
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`Isolated server exited before reporting a port: ${stderr}`));
    });
    inspect();
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Isolated server exited early: ${stderr}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { baseUrl, root };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Isolated server did not become ready: ${stderr}`);
}

async function writeReviewManifest(root, directoryName, {
  runId = directoryName,
  face = 9,
  naturalness = 8,
  style = 8,
  diagnosticCodes = [],
  promptInputMode = 'reference_image',
} = {}) {
  const runDirectory = join(root, 'data', 'runs', directoryName);
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, 'manifest.json'), `${JSON.stringify({
    schema_version: 'ai-img-gen.web-run.v7',
    run_id: runId,
    excluded_from_learning: false,
    prompt_compilation: { prompt_input_mode: promptInputMode },
    artifact_reviews: {
      [`artifact-${runId}`]: {
        face_identity_fidelity: face,
        realism_naturalness: naturalness,
        style_consistency: style,
        diagnostic_codes: diagnosticCodes,
        review_rubric_version: REVIEW_RUBRIC.rubric_version,
      },
    },
  }, null, 2)}\n`, 'utf8');
}

test('validated identity-transfer asset becomes an immutable block with the user-approved exact hash', () => {
  assert.equal(typeof recipeModule.normalizeIdentityTransferBlock, 'function');
  const block = recipeModule.normalizeIdentityTransferBlock(identityAsset);

  assert.equal(block.schema_version, 'ai-img-gen.identity-transfer-block.v1');
  assert.equal(block.block_id, 'validated-identity-transfer');
  assert.equal(block.prompt_sha256, EXPECTED_PROMPT_SHA256);
  assert.equal(block.exact_prompt, identityAsset.exact_prompt);
  assert.equal(block.image_roles.image_1, identityAsset.image_roles.image_1);
  assert.equal(block.image_roles.image_2, identityAsset.image_roles.image_2);

  const tampered = { ...identityAsset, exact_prompt: `${identityAsset.exact_prompt}新增内容` };
  assert.throws(
    () => recipeModule.normalizeIdentityTransferBlock(tampered),
    (error) => error?.code === 'identity_transfer_block_hash_mismatch',
  );
});

test('reference-image recipe requires a real template and rejects the reserved blueprint-only mode', () => {
  assert.equal(typeof recipeModule.compilePromptRecipe, 'function');

  assert.throws(
    () => recipeModule.compilePromptRecipe(recipeInput({ templateReferences: [] })),
    (error) => error?.code === 'real_template_reference_missing',
  );
  assert.throws(
    () => recipeModule.compilePromptRecipe(recipeInput({ promptInputMode: 'blueprint_only' })),
    (error) => error?.code === 'prompt_input_mode_not_implemented',
  );
});

test('Prompt Recipe v1 preserves the exact block, binds semantic image roles, and is deterministic', () => {
  assert.equal(typeof recipeModule.compilePromptRecipe, 'function');
  const first = recipeModule.compilePromptRecipe(recipeInput());
  const second = recipeModule.compilePromptRecipe(recipeInput());

  assert.deepEqual(first, second);
  assert.equal(first.schema_version, 'ai-img-gen.prompt-recipe.v1');
  assert.equal(first.compiler_id, 'portrait-prompt-recipe-v1');
  assert.equal(first.prompt_input_mode, 'reference_image');
  assert.match(first.recipe_id, /^prompt-recipe_[a-f0-9]{24}$/);
  assert.deepEqual(first.blocks.map((block) => block.block_id), [
    'reference-role-binding',
    'validated-identity-transfer',
    'task-intent',
    'active-corrections',
    'candidate-slate',
    'quality-safety',
  ]);
  assert.equal(first.blocks.find((block) => block.block_id === 'validated-identity-transfer').content, identityAsset.exact_prompt);
  assert.match(first.blocks[0].content, /图片1.*第 1 张主身份图/);
  assert.match(first.blocks[0].content, /图片2.*第 3 张主模板图/);
  assert.match(first.compiled_prompt, new RegExp(identityAsset.exact_prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(first.prompt_sha256.length, 64);
  assert.equal(first.input_sha256.length, 64);
  assert.equal(first.blocks.every((block) => /^[a-f0-9]{64}$/.test(block.sha256)), true);
});

test('AI draft remains shadow evidence and cannot change the effective recipe or final prompt', () => {
  assert.equal(typeof recipeModule.compilePromptRecipe, 'function');
  const base = recipeModule.compilePromptRecipe(recipeInput());
  const withDraft = recipeModule.compilePromptRecipe(recipeInput({
    aiPromptDraft: {
      schema_version: 'ai-img-gen.ai-prompt-draft.v1',
      draft_id: 'ai-prompt-draft_test',
      prompt: '把人物改成完全不同的脸。',
      reason: 'unverified',
      warnings: [],
      input_sha256: 'd'.repeat(64),
      output_sha256: 'e'.repeat(64),
      provider_id: 'test',
      model_id: 'test',
      status: 'suggested',
    },
  }));

  assert.equal(withDraft.compiled_prompt, base.compiled_prompt);
  assert.equal(withDraft.prompt_sha256, base.prompt_sha256);
  assert.equal(withDraft.recipe_id, base.recipe_id);
  assert.equal(withDraft.input_sha256, base.input_sha256);
  assert.equal(withDraft.shadow_ai_prompt_draft.prompt, '把人物改成完全不同的脸。');
  assert.doesNotMatch(withDraft.compiled_prompt, /完全不同的脸/);
});

test('existing compiler exposes Recipe v1 only through an explicit recipe request and keeps legacy behavior otherwise', () => {
  const input = recipeInput({
    aiPromptDraft: {
      schema_version: 'ai-img-gen.ai-prompt-draft.v1',
      draft_id: 'ai-prompt-draft_test',
      prompt: '未经验证的自由文本。',
      reason: 'shadow only',
      warnings: [],
      input_sha256: 'd'.repeat(64),
      output_sha256: 'e'.repeat(64),
      provider_id: 'test',
      model_id: 'test',
      status: 'suggested',
    },
  });
  const shared = {
    taskIntent: input.taskIntent,
    identityReferences: input.identityReferences,
    templateReferences: input.templateReferences,
    candidateSlateRequest: input.candidateSlateRequest,
    aiPromptDraft: input.aiPromptDraft,
  };

  const legacy = compileDeterministicPrompt(shared);
  const recipe = compileDeterministicPrompt({
    ...shared,
    promptRecipe: {
      promptInputMode: input.promptInputMode,
      identityTransferBlock: input.identityTransferBlock,
      activeCorrections: [],
      shadowCorrections: [],
    },
  });

  assert.equal(legacy.schema_version, 'ai-img-gen.prompt-compilation.v3');
  assert.match(legacy.compiled_prompt, /未经验证的自由文本/);
  assert.equal(recipe.schema_version, 'ai-img-gen.prompt-recipe.v1');
  assert.doesNotMatch(recipe.compiled_prompt, /未经验证的自由文本/);
  assert.equal(recipe.shadow_ai_prompt_draft.draft_id, 'ai-prompt-draft_test');
});

test('runtime keeps Recipe v1 disabled by default and makes AI output shadow-only when explicitly enabled', async (t) => {
  assert.equal(typeof runtimeModule.preparePromptCompilation, 'function');
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-prompt-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(join(root, 'prompts', 'validated-identity-transfer.json'), `${JSON.stringify(identityAsset, null, 2)}\n`, 'utf8');

  const input = recipeInput();
  const writer = {
    async write() {
      return {
        schema_version: 'ai-img-gen.ai-prompt-draft.v1',
        draft_id: 'ai-prompt-draft_shadow',
        prompt: '这段 AI 文本不能进入正式提示词。',
        reason: 'shadow',
        warnings: [],
        input_sha256: 'd'.repeat(64),
        output_sha256: 'e'.repeat(64),
        provider_id: 'test',
        model_id: 'test',
        status: 'suggested',
      };
    },
  };
  const shared = {
    root,
    taskIntent: input.taskIntent,
    identityReferences: input.identityReferences,
    templateReferences: input.templateReferences,
    candidateSlateRequest: input.candidateSlateRequest,
    guidance: { active_guidance: [], active_corrections: [], shadow_corrections: [] },
    aiPromptWriter: writer,
  };

  const disabled = await runtimeModule.preparePromptCompilation(shared);
  const enabled = await runtimeModule.preparePromptCompilation({ ...shared, recipeEnabled: true });

  assert.equal(disabled.compilation.schema_version, 'ai-img-gen.prompt-compilation.v3');
  assert.match(disabled.compilation.compiled_prompt, /这段 AI 文本不能进入正式提示词/);
  assert.equal(enabled.compilation.schema_version, 'ai-img-gen.prompt-recipe.v2');
  assert.equal(enabled.compilation.compiler_id, 'portrait-prompt-recipe-v2');
  assert.equal(enabled.compilation.angle_alignment.state, 'unknown');
  assert.doesNotMatch(enabled.compilation.compiled_prompt, /这段 AI 文本不能进入正式提示词/);
  assert.equal(enabled.compilation.shadow_ai_prompt_draft.draft_id, 'ai-prompt-draft_shadow');
  assert.equal(enabled.aiPromptDraft.draft_id, 'ai-prompt-draft_shadow');
});

test('Run preparation retains Recipe v1 identity and exact correction lineage without changing submission state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-prompt-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const compilation = recipeModule.compilePromptRecipe(recipeInput());

  const created = await createRunSnapshot({
    root,
    customerName: 'Recipe Fixture',
    identityFiles: [{ name: 'identity.png', bytes: transparentPng }],
    templateFiles: [{ name: 'template.png', bytes: transparentPng }],
    promptCompilation: compilation,
    taskIntent: recipeInput().taskIntent,
    candidateSlateRequest: recipeInput().candidateSlateRequest,
  });
  const loaded = await loadRun({ root, runId: created.runId });
  const prepared = loaded.events.find((event) => event.type === 'RunPrepared');

  assert.equal(loaded.manifest.prompt_compilation.recipe_id, compilation.recipe_id);
  assert.equal(loaded.manifest.prompt_compilation.prompt_input_mode, 'reference_image');
  assert.equal(loaded.manifest.submission_attempt_count, 0);
  assert.equal(loaded.prompt, compilation.compiled_prompt);
  assert.equal(prepared.data.prompt_recipe_id, compilation.recipe_id);
  assert.equal(prepared.data.prompt_input_mode, 'reference_image');
  assert.deepEqual(prepared.data.applied_correction_ids, []);
  assert.deepEqual(prepared.data.shadow_correction_ids, []);
});

test('Run preparation retains Recipe v2 angle-alignment evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-angle-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const compilation = recipeModule.compileAngleAlignedPromptRecipe(recipeInput({
    identityReferences: [{ ordinal: 1, sha256: 'a'.repeat(64), role: 'primary_front', face_angle: 'front_15_degree' }],
    templateReferences: [{ ordinal: 2, sha256: 'c'.repeat(64), template_name: '对齐模板', face_angle: 'front_30_degree' }],
  }));
  const created = await createRunSnapshot({
    root,
    customerName: 'Angle Fixture',
    identityFiles: [{ name: 'identity.png', bytes: transparentPng }],
    templateFiles: [{ name: 'template.png', bytes: transparentPng }],
    promptCompilation: compilation,
    taskIntent: recipeInput().taskIntent,
    candidateSlateRequest: recipeInput().candidateSlateRequest,
  });
  const loaded = await loadRun({ root, runId: created.runId });
  const prepared = loaded.events.find((event) => event.type === 'RunPrepared');

  assert.equal(loaded.manifest.prompt_compilation.schema_version, 'ai-img-gen.prompt-recipe.v2');
  assert.deepEqual(prepared.data.angle_alignment, compilation.angle_alignment);
});

test('server configuration defaults Recipe v1 off and permits an explicit isolated project root', () => {
  assert.equal(typeof serverConfigModule.resolveServerConfiguration, 'function');
  const sourceRoot = 'D:\\workspace\\ai-img-gen';
  const defaults = serverConfigModule.resolveServerConfiguration({ sourceRoot, env: {} });
  const isolated = serverConfigModule.resolveServerConfiguration({
    sourceRoot,
    env: {
      AI_IMG_GEN_PROJECT_ROOT: 'D:\\temp\\ai-img-gen-isolated',
      AI_IMG_GEN_PROMPT_RECIPE_V1_ENABLED: 'true',
    },
  });

  assert.equal(defaults.projectRoot, sourceRoot);
  assert.equal(defaults.promptRecipeEnabled, false);
  assert.equal(isolated.projectRoot, 'D:\\temp\\ai-img-gen-isolated');
  assert.equal(isolated.promptRecipeEnabled, true);
});

test('isolated preview route uses Recipe v1 only when its explicit feature flag is enabled', async (t) => {
  const { baseUrl } = await startIsolatedServer(t, { recipeEnabled: true });
  const health = await (await fetch(`${baseUrl}/api/health`)).json();
  const response = await fetch(`${baseUrl}/api/prompt-compilations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      taskIntent: {
        useCase: 'professional_portrait',
        targetFraming: 'bust',
        targetFaceAngle: 'front',
        layoutIntent: 'no_text',
      },
      identityReferenceTotal: 1,
      identityFaceAngles: ['front_15_degree'],
      templates: [{ ordinal: 2, sha256: 'c'.repeat(64), template_name: '隔离模板', face_angle: 'front_30_degree' }],
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(health.prompt_recipe, 'candidate_enabled');
  assert.equal(body.compilation.schema_version, 'ai-img-gen.prompt-recipe.v2');
  assert.equal(body.compilation.compiler_id, 'portrait-prompt-recipe-v2');
  assert.equal(body.compilation.prompt_input_mode, 'reference_image');
  assert.equal(body.compilation.angle_alignment.state, 'aligned');
  assert.equal(body.compilation.angle_alignment.identity_face_angle, 'front_15_degree');
  assert.equal(body.compilation.angle_alignment.template_face_angle, 'front_30_degree');
  assert.match(body.compilation.compiled_prompt, new RegExp(identityAsset.exact_prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(body.preview, {
    prompt_input_mode: 'reference_image',
    real_template_required: true,
    block_ids: [
      'reference-role-binding',
      'validated-identity-transfer',
      'angle-alignment',
      'task-intent',
      'active-corrections',
      'candidate-slate',
      'quality-safety',
    ],
    applied_correction_count: 0,
    shadow_correction_count: 0,
    exact_prompt: body.compilation.compiled_prompt,
  });
});

test('review evidence remains observational below support and becomes shadow-only at the repeated-failure threshold', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-prompt-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeReviewManifest(root, 'run-1', { naturalness: 6 });
  await writeReviewManifest(root, 'run-2', { naturalness: 6 });

  const insufficient = await rebuildReviewGuidance({ root });
  assert.equal(Array.isArray(insufficient.corrections), true);
  const insufficientNaturalness = insufficient.corrections.find((item) => item.quality_dimension === 'realism_naturalness');
  assert.equal(insufficient.schema_version, 'ai-img-gen.review-guidance.v4');
  assert.equal(insufficientNaturalness.state, 'observational');
  assert.equal(insufficientNaturalness.support_count, 2);
  assert.deepEqual(insufficient.shadow_corrections, []);
  assert.deepEqual(insufficient.active_corrections, []);
  assert.deepEqual(insufficient.active_guidance, []);

  await writeReviewManifest(root, 'run-3', { naturalness: 8 });
  const qualified = await rebuildReviewGuidance({ root });
  const shadowNaturalness = qualified.shadow_corrections.find((item) => item.quality_dimension === 'realism_naturalness');
  assert.equal(qualified.status, 'shadow_ready');
  assert.equal(shadowNaturalness.state, 'shadow');
  assert.equal(shadowNaturalness.support_count, 3);
  assert.equal(shadowNaturalness.failure_count, 2);
  assert.equal(shadowNaturalness.failure_rate, 0.667);
  assert.deepEqual(shadowNaturalness.source_run_ids, ['run-1', 'run-2', 'run-3']);
  assert.match(shadowNaturalness.correction_id, /^prompt-correction_[a-f0-9]{24}$/);
  assert.equal(shadowNaturalness.target_block, 'quality-safety');
  assert.deepEqual(qualified.active_corrections, []);
  assert.deepEqual(qualified.active_guidance, []);
});

test('prompt evidence rebuild deduplicates Runs and excludes identity failures, customer-scoped diagnostics, and other prompt modes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-prompt-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeReviewManifest(root, 'run-a', { runId: 'shared-run', style: 6, diagnosticCodes: ['client_use_case_mismatch'] });
  await writeReviewManifest(root, 'run-a-copy', { runId: 'shared-run', style: 6, diagnosticCodes: ['client_use_case_mismatch'] });
  await writeReviewManifest(root, 'run-b', { style: 6 });
  await writeReviewManifest(root, 'run-c', { style: 8 });
  await writeReviewManifest(root, 'run-identity-fail', { face: 6, style: 0 });
  await writeReviewManifest(root, 'run-blueprint-mode', { style: 0, promptInputMode: 'blueprint_only' });

  const projection = await rebuildReviewGuidance({ root });
  assert.equal(Array.isArray(projection.corrections), true);
  const styleCorrection = projection.corrections.find((item) => item.quality_dimension === 'style_consistency');

  assert.equal(styleCorrection.support_count, 3);
  assert.equal(styleCorrection.failure_count, 2);
  assert.deepEqual(styleCorrection.source_run_ids, ['run-b', 'run-c', 'shared-run']);
  assert.equal(projection.corrections.some((item) => item.diagnostic_code === 'client_use_case_mismatch'), false);
  assert.equal(projection.corrections.some((item) => item.quality_dimension === 'face_identity_fidelity'), false);
  assert.equal(projection.prompt_input_mode, 'reference_image');

  const rebuilt = await rebuildReviewGuidance({ root });
  assert.deepEqual(
    rebuilt.corrections.map(({ correction_id, state, support_count, failure_count }) => ({ correction_id, state, support_count, failure_count })),
    projection.corrections.map(({ correction_id, state, support_count, failure_count }) => ({ correction_id, state, support_count, failure_count })),
  );
});

test('only active matching corrections change the final prompt while shadow corrections remain lineage-only', () => {
  const activeCorrection = {
    schema_version: 'ai-img-gen.prompt-correction.v1',
    correction_id: 'prompt-correction_active-naturalness',
    signal_type: 'numeric_dimension',
    quality_dimension: 'realism_naturalness',
    diagnostic_code: null,
    target_block: 'quality-safety',
    prompt_guidance: '减少面部过度平滑，保留自然皮肤纹理。',
    context: {
      prompt_input_mode: 'reference_image',
      rubric_version: REVIEW_RUBRIC.rubric_version,
      customer_scope: 'global_identity_neutral',
    },
    source_run_ids: ['run-1', 'run-2', 'run-3'],
    support_count: 3,
    failure_count: 2,
    failure_rate: 0.667,
    state: 'active',
  };
  const shadowCorrection = {
    ...activeCorrection,
    correction_id: 'prompt-correction_shadow-style',
    quality_dimension: 'style_consistency',
    target_block: 'template-emphasis',
    prompt_guidance: '加强模板的杂志排版关系。',
    state: 'shadow',
  };
  const compiled = recipeModule.compilePromptRecipe(recipeInput({
    activeCorrections: [activeCorrection],
    shadowCorrections: [shadowCorrection],
  }));

  assert.match(compiled.compiled_prompt, /减少面部过度平滑/);
  assert.doesNotMatch(compiled.compiled_prompt, /加强模板的杂志排版关系/);
  assert.deepEqual(compiled.applied_correction_ids, ['prompt-correction_active-naturalness']);
  assert.deepEqual(compiled.shadow_correction_ids, ['prompt-correction_shadow-style']);
});

test('corrections cannot cross prompt modes or customer isolation boundaries', () => {
  const mismatched = {
    correction_id: 'prompt-correction_other-mode',
    target_block: 'quality-safety',
    prompt_guidance: '不应进入主模式。',
    state: 'active',
    context: {
      prompt_input_mode: 'blueprint_only',
      rubric_version: REVIEW_RUBRIC.rubric_version,
      customer_scope: 'global_identity_neutral',
    },
  };
  const customerScoped = {
    ...mismatched,
    correction_id: 'prompt-correction_customer',
    context: {
      ...mismatched.context,
      prompt_input_mode: 'reference_image',
      customer_scope: 'customer-123',
    },
  };

  assert.throws(
    () => recipeModule.compilePromptRecipe(recipeInput({ activeCorrections: [mismatched] })),
    (error) => error?.code === 'correction_context_mismatch',
  );
  assert.throws(
    () => recipeModule.compilePromptRecipe(recipeInput({ activeCorrections: [customerScoped] })),
    (error) => error?.code === 'customer_scoped_correction_rejected',
  );
});

test('Recipe v2 selects the identity reference closest to the template angle and keeps the validated block immutable', () => {
  assert.equal(typeof recipeModule.compileAngleAlignedPromptRecipe, 'function');
  const compiled = recipeModule.compileAngleAlignedPromptRecipe(recipeInput({
    identityReferences: [
      { ordinal: 1, sha256: 'a'.repeat(64), role: 'primary_front', face_angle: 'front' },
      { ordinal: 2, sha256: 'b'.repeat(64), role: 'identity_support', face_angle: 'left_45' },
    ],
    templateReferences: [
      { ordinal: 3, sha256: 'c'.repeat(64), template_name: '左侧四十五度模板', face_angle: 'side_45_degree' },
    ],
  }));

  assert.equal(compiled.schema_version, 'ai-img-gen.prompt-recipe.v2');
  assert.equal(compiled.compiler_id, 'portrait-prompt-recipe-v2');
  assert.equal(compiled.compiler_version, 2);
  assert.deepEqual(compiled.angle_alignment, {
    state: 'aligned',
    selected_identity_ordinal: 2,
    template_ordinal: 3,
    identity_face_angle: 'left_45',
    template_face_angle: 'side_45_degree',
    identity_angle_family: 'three_quarter',
    template_angle_family: 'three_quarter',
    selection_reason: 'closest_known_angle',
  });
  assert.match(compiled.blocks[0].content, /图片1.*第 2 张主身份图/);
  assert.equal(compiled.blocks.find((block) => block.block_id === 'validated-identity-transfer').content, identityAsset.exact_prompt);
  assert.equal(compiled.blocks.find((block) => block.block_id === 'validated-identity-transfer').sha256, EXPECTED_PROMPT_SHA256);
  assert.match(compiled.blocks.find((block) => block.block_id === 'angle-alignment').content, /朝向.*俯仰角.*头部姿势/);
});

test('Recipe v2 reports mismatch or unknown without distorting the protected identity instruction', () => {
  assert.equal(typeof recipeModule.compileAngleAlignedPromptRecipe, 'function');
  const mismatch = recipeModule.compileAngleAlignedPromptRecipe(recipeInput({
    identityReferences: [{ ordinal: 1, sha256: 'a'.repeat(64), role: 'primary_front', face_angle: 'front' }],
    templateReferences: [{ ordinal: 2, sha256: 'c'.repeat(64), template_name: '侧脸模板', face_angle: 'profile' }],
  }));
  const unknown = recipeModule.compileAngleAlignedPromptRecipe(recipeInput({
    identityReferences: [{ ordinal: 1, sha256: 'a'.repeat(64), role: 'primary_front' }],
    templateReferences: [{ ordinal: 2, sha256: 'c'.repeat(64), template_name: '未知角度模板' }],
  }));

  assert.equal(mismatch.angle_alignment.state, 'mismatch');
  assert.equal(mismatch.warnings.some((warning) => warning.code === 'identity_template_angle_mismatch'), true);
  assert.match(mismatch.blocks.find((block) => block.block_id === 'angle-alignment').content, /模板.*向.*身份图.*靠拢/);
  assert.match(mismatch.blocks.find((block) => block.block_id === 'angle-alignment').content, /不要.*扭曲|禁止.*扭曲/);
  assert.equal(unknown.angle_alignment.state, 'unknown');
  assert.equal(unknown.angle_alignment.selection_reason, 'angle_metadata_missing');
  assert.equal(unknown.warnings.some((warning) => warning.code === 'identity_template_angle_unknown'), true);
  assert.equal(mismatch.blocks.find((block) => block.block_id === 'validated-identity-transfer').content, identityAsset.exact_prompt);
  assert.equal(unknown.blocks.find((block) => block.block_id === 'validated-identity-transfer').content, identityAsset.exact_prompt);
});
