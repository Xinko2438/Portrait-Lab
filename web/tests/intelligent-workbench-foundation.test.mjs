import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRunSnapshot, importArtifacts, loadRun, recordRunEvent } from '../src/run-store.mjs';
import { buildGenerationPrompt } from '../src/chatgpt-executor.mjs';

const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const whitePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlAT8sAAAAASUVORK5CYII=', 'base64');
const twoByOnePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP8z8Dwn4GBgQEADQUCAOAHawIAAAAASUVORK5CYII=', 'base64');
const intentModule = await import('../src/intelligent-workbench/intent-schema.mjs').catch(() => ({}));
const compilerModule = await import('../src/intelligent-workbench/prompt-compilation.mjs').catch(() => ({}));
const providerModule = await import('../src/intelligent-workbench/ai-provider.mjs').catch(() => ({}));
const customerModule = await import('../src/customer-identity-store.mjs').catch(() => ({}));
const navigationModule = await import('../public/navigation-state.js').catch(() => ({}));
const clipboardModule = await import('../public/clipboard-image.js').catch(() => ({}));
const candidateSlateModule = await import('../src/intelligent-workbench/candidate-slate.mjs').catch(() => ({}));

test('TaskIntent uses controlled vocabulary while keeping optional user supplement separate', () => {
  assert.equal(typeof intentModule.normalizeTaskIntent, 'function');
  const intent = intentModule.normalizeTaskIntent({ useCase: 'livestream_cover', targetFraming: 'half_body', targetFaceAngle: 'front', temperamentKeywords: ['professional', 'premium', 'professional'], layoutIntent: 'copy_right', userSupplement: '服装不要过于商务。' });
  assert.equal(intent.schema_version, 'ai-img-gen.task-intent.v1');
  assert.equal(intent.use_case, 'livestream_cover');
  assert.deepEqual(intent.temperament_keywords, ['professional', 'premium']);
  assert.equal(intent.user_supplement, '服装不要过于商务。');
  assert.equal('compiled_prompt' in intent, false);
  assert.throws(() => intentModule.normalizeTaskIntent({ useCase: 'unknown-scene' }), /use case/i);
});

test('deterministic Prompt Compiler produces natural reproducible provider text instead of form serialization', () => {
  assert.equal(typeof compilerModule.compileDeterministicPrompt, 'function');
  const input = { taskIntent: intentModule.normalizeTaskIntent({ useCase: 'livestream_cover', targetFraming: 'half_body', targetFaceAngle: 'front', temperamentKeywords: ['professional', 'premium'], layoutIntent: 'copy_right', userSupplement: '服装不要过于商务。' }), identityReferences: [{ ordinal: 1, sha256: 'a'.repeat(64), role: 'primary_front' }], templateReferences: [{ ordinal: 2, sha256: 'b'.repeat(64), template_uid: 'tpl_editorial_001', template_name: '黑白杂志海报', style_category: 'editorial', portrait_scale: 'three_quarter', face_angle: 'side_45_degree' }], activeGuidance: [{ prompt_guidance: '让表情与画面氛围保持一致。' }] };
  const first = compilerModule.compileDeterministicPrompt(input);
  const second = compilerModule.compileDeterministicPrompt(input);
  assert.equal(first.schema_version, 'ai-img-gen.prompt-compilation.v1');
  assert.equal(first.compiler_id, 'portrait-prompt-compiler-v1');
  assert.equal(first.compiled_prompt, second.compiled_prompt);
  assert.equal(first.input_sha256, second.input_sha256);
  assert.equal(first.prompt_sha256, second.prompt_sha256);
  assert.match(first.compiled_prompt, /唯一身份原型/);
  assert.match(first.compiled_prompt, /直播封面/);
  assert.match(first.compiled_prompt, /右侧.*标题|右侧.*文案/);
  assert.match(first.compiled_prompt, /服装不要过于商务/);
  assert.doesNotMatch(first.compiled_prompt, /身份参考：|客户语境：|本次要求：/);
  assert.equal(first.conflict_resolutions.some((item) => item.code === 'target_angle_overrides_template'), true);
});

test('candidate slate upgrades only the new compilation regime to compiler v2 with deterministic two-image instructions', () => {
  const taskIntent = intentModule.normalizeTaskIntent({ useCase: 'professional_portrait', targetFraming: 'bust', targetFaceAngle: 'front', layoutIntent: 'no_text' });
  const base = {
    taskIntent,
    identityReferences: [{ ordinal: 1, sha256: 'a'.repeat(64), role: 'primary_front' }],
    templateReferences: [{ ordinal: 2, sha256: 'b'.repeat(64), template_name: '自然职业照' }],
    activeGuidance: [],
  };
  const legacy = compilerModule.compileDeterministicPrompt(base);
  const request = candidateSlateModule.buildCandidateSlateRequest();
  const slate = compilerModule.compileDeterministicPrompt({ ...base, candidateSlateRequest: request });

  assert.equal(legacy.schema_version, 'ai-img-gen.prompt-compilation.v1');
  assert.equal(legacy.compiler_id, 'portrait-prompt-compiler-v1');
  assert.equal(slate.schema_version, 'ai-img-gen.prompt-compilation.v2');
  assert.equal(slate.compiler_id, 'portrait-prompt-compiler-v2');
  assert.equal(slate.candidate_slate_request.slate_request_id, request.slate_request_id);
  assert.notEqual(slate.input_sha256, legacy.input_sha256);
  assert.match(slate.compiled_prompt, /一次输出两张候选图/);
  assert.match(slate.compiled_prompt, /候选 A/);
  assert.match(slate.compiled_prompt, /候选 B/);
});

test('provider registry keeps deterministic active and AI routes disabled until exact capability evidence exists', () => {
  assert.equal(typeof providerModule.createFoundationProviderRegistry, 'function');
  const registry = providerModule.createFoundationProviderRegistry();
  const statuses = registry.statuses();
  assert.equal(statuses.find((item) => item.id === 'deterministic').state, 'active');
  assert.equal(statuses.find((item) => item.id === 'opencodex').state, 'disabled_pending_contract');
  assert.equal(statuses.find((item) => item.id === 'codex-cli').state, 'reserved_offline');
  assert.equal(registry.resolve('prompt_compilation').id, 'deterministic');
  assert.throws(() => registry.resolve('review_suggestion'), /no active provider/i);
});

test('customer identity store is customer-scoped, versioned, and materializes exact Run inputs', async () => {
  assert.equal(typeof customerModule.createIdentitySet, 'function');
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-customer-identity-'));
  const customerId = 'cust_0123456789abcdef';
  const created = await customerModule.createIdentitySet({ root, customerId, displayName: '测试客户', files: [{ name: 'front.png', bytes: transparentPng, role: 'primary_front' }, { name: 'left.png', bytes: whitePng, role: 'left_45' }] });
  assert.equal(created.schema_version, 'ai-img-gen.customer-identity-set.v1');
  assert.equal(created.customer_id, customerId);
  assert.equal(created.version, 1);
  assert.deepEqual(created.coverage, ['primary_front', 'left_45']);
  const listed = await customerModule.listCustomers({ root });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].display_name, '测试客户');
  const materialized = await customerModule.materializeIdentitySet({ root, customerId, identitySetId: created.identity_set_id });
  assert.equal(materialized.files.length, 2);
  assert.deepEqual(materialized.files.map((item) => item.bytes), [transparentPng, whitePng]);
  await assert.rejects(() => customerModule.materializeIdentitySet({ root, customerId: 'cust_ffffffffffffffff', identitySetId: created.identity_set_id }), /not found/i);
});

test('foundation Run stores TaskIntent and PromptCompilation as v6 lineage without changing legacy input support', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-foundation-run-'));
  const taskIntent = intentModule.normalizeTaskIntent({ useCase: 'professional_portrait', targetFraming: 'bust', targetFaceAngle: 'front', temperamentKeywords: ['trustworthy'], layoutIntent: 'no_text' });
  const promptCompilation = compilerModule.compileDeterministicPrompt({ taskIntent, identityReferences: [{ ordinal: 1, sha256: 'a'.repeat(64), role: 'primary_front' }], templateReferences: [{ ordinal: 2, sha256: 'b'.repeat(64), template_name: '自然职业照' }], activeGuidance: [] });
  const created = await createRunSnapshot({ root, customerName: 'Customer A', prompt: promptCompilation.compiled_prompt, identityFiles: [{ name: 'front.png', bytes: transparentPng }], templateFiles: [{ name: 'template.png', bytes: whitePng }], referencePlan: { identityAngles: ['frontal'], targetAngle: 'frontal', targetFraming: 'bust' }, customerContext: { intendedUse: 'professional portrait' }, taskIntent, promptCompilation });
  const loaded = await loadRun({ root, runId: created.runId });
  assert.equal(loaded.manifest.schema_version, 'ai-img-gen.web-run.v6');
  assert.equal(loaded.manifest.task_intent.schema_version, 'ai-img-gen.task-intent.v1');
  assert.equal(loaded.manifest.prompt_compilation.prompt_sha256, promptCompilation.prompt_sha256);
  assert.equal(loaded.prompt, promptCompilation.compiled_prompt);
});

test('candidate slate Run v7 rebuilds pending, partial, complete, and ambiguous from source events without resubmission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-slate-run-'));
  const taskIntent = intentModule.normalizeTaskIntent({ useCase: 'professional_portrait', targetFraming: 'bust', targetFaceAngle: 'front', layoutIntent: 'no_text' });
  const candidateSlateRequest = candidateSlateModule.buildCandidateSlateRequest();
  const promptCompilation = compilerModule.compileDeterministicPrompt({
    taskIntent,
    identityReferences: [{ ordinal: 1, sha256: 'a'.repeat(64), role: 'primary_front' }],
    templateReferences: [{ ordinal: 2, sha256: 'b'.repeat(64), template_name: '自然职业照' }],
    activeGuidance: [],
    candidateSlateRequest,
  });
  const created = await createRunSnapshot({
    root,
    customerName: 'Slate Customer',
    prompt: promptCompilation.compiled_prompt,
    identityFiles: [{ name: 'front.png', bytes: transparentPng }],
    templateFiles: [{ name: 'template.png', bytes: whitePng }],
    referencePlan: { identityAngles: ['frontal'], targetAngle: 'frontal', targetFraming: 'bust' },
    customerContext: { intendedUse: 'professional portrait' },
    taskIntent,
    promptCompilation,
    candidateSlateRequest,
  });

  let loaded = await loadRun({ root, runId: created.runId });
  assert.equal(loaded.manifest.schema_version, 'ai-img-gen.web-run.v7');
  assert.equal(loaded.manifest.generation_regime_version, 'portrait-generation-v7-two-candidate');
  assert.equal(loaded.manifest.candidate_slate.status, 'pending');
  assert.equal(loaded.events.filter((event) => event.type === 'CandidateSlateRequested').length, 1);

  await importArtifacts({ root, runId: created.runId, files: [{ name: 'candidate-a.png', bytes: transparentPng }], captureMethod: 'manual_import' });
  loaded = await loadRun({ root, runId: created.runId });
  assert.equal(loaded.manifest.candidate_slate.status, 'partial');
  await importArtifacts({ root, runId: created.runId, files: [{ name: 'candidate-b.png', bytes: whitePng }], captureMethod: 'manual_import' });
  loaded = await loadRun({ root, runId: created.runId });
  assert.equal(loaded.manifest.candidate_slate.status, 'complete');
  assert.equal(loaded.manifest.candidate_slate.received_count, 2);

  await importArtifacts({ root, runId: created.runId, files: [{ name: 'candidate-c.png', bytes: twoByOnePng }], captureMethod: 'manual_import' });
  loaded = await loadRun({ root, runId: created.runId });
  assert.equal(loaded.manifest.candidate_slate.status, 'overcomplete');
  assert.equal(loaded.manifest.candidate_slate.received_count, 3);

  await recordRunEvent({ root, runId: created.runId, type: 'CaptureChecked', data: { capture: { state: 'capture_ambiguous' } } });
  loaded = await loadRun({ root, runId: created.runId });
  assert.equal(loaded.manifest.candidate_slate.status, 'ambiguous');
  assert.equal(loaded.manifest.submission_attempt_count, 0);
});

test('workbench foundation exposes customer reuse, controlled intent, supplement and prompt preview controls', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="customerSelector"/);
  assert.doesNotMatch(html, /id="identitySetSelector"|身份参考组/);
  assert.match(app, /resolveActiveCustomerPhotoPool/);
  assert.match(html, /id="intendedUse"[\s\S]*<option/);
  assert.match(html, /id="temperamentOptions"/);
  assert.match(html, /id="layoutIntent"/);
  assert.match(html, /id="userSupplement"/);
  assert.match(html, /id="compiledPromptPreview"/);
  assert.match(app, /\/api\/customers/);
  assert.match(app, /\/api\/prompt-compilations/);
});
test('OpenCodex health inspection reports transport without activating an unverified model contract', async () => {
  assert.equal(typeof providerModule.inspectOpenCodexHealth, 'function');
  const fakeFetch = async (url) => ({ ok: true, json: async () => url.endsWith('/v1/models') ? { data: [{ id: 'model-a' }] } : { status: url.endsWith('/readyz') ? 'ready' : 'ok', version: '2.29.0' } });
  const status = await providerModule.inspectOpenCodexHealth({ fetch: fakeFetch });
  assert.equal(status.transport_ready, true);
  assert.equal(status.model_count, 1);
  assert.equal(status.activation_state, 'disabled_pending_contract');
});
test('v6 executor sends the compiled provider prompt directly instead of wrapping it in legacy labelled requirements', () => {
  const compiled = '以第 1 张身份参考图中的人物作为唯一身份原型，参照第 2 张模板图创作专业海报。';
  const prompt = buildGenerationPrompt({ manifest: { schema_version: 'ai-img-gen.web-run.v6', prompt_compilation: { compiled_prompt: compiled }, identity_references: [{}], template_references: [{}], reference_plan: {}, customer_context: {} }, prompt: compiled });
  assert.equal(prompt, compiled);
  assert.doesNotMatch(prompt, /身份参考：|客户语境：|本次要求：/);
});
test('v7 executor sends compiler v2 output directly without wrapping or a second submission instruction', () => {
  const compiled = '一次输出两张候选图。候选 A 紧贴模板；候选 B 仅做有限变化。';
  const prompt = buildGenerationPrompt({ manifest: { schema_version: 'ai-img-gen.web-run.v7', prompt_compilation: { compiled_prompt: compiled }, candidate_slate_request: candidateSlateModule.buildCandidateSlateRequest(), identity_references: [{}], template_references: [{}] }, prompt: compiled });
  assert.equal(prompt, compiled);
  assert.doesNotMatch(prompt, /身份参考：|客户语境：|本次要求：/);
});
test('compiled prompt becomes the effective Run prompt when the blank legacy prompt field is omitted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-compiled-run-prompt-'));
  const taskIntent = intentModule.normalizeTaskIntent({ useCase: 'livestream_cover', targetFraming: 'half_body', targetFaceAngle: 'front', temperamentKeywords: ['professional'], layoutIntent: 'copy_right', userSupplement: 'Keep the expression natural.' });
  const promptCompilation = compilerModule.compileDeterministicPrompt({ taskIntent, identityReferences: [{ ordinal: 1, sha256: 'a'.repeat(64), role: 'primary_front' }], templateReferences: [{ ordinal: 2, sha256: 'b'.repeat(64), template_name: 'Editorial poster' }], activeGuidance: [] });
  const created = await createRunSnapshot({ root, customerName: 'Customer B', prompt: '', identityFiles: [{ name: 'front.png', bytes: transparentPng }], templateFiles: [{ name: 'template.png', bytes: whitePng }], referencePlan: { identityAngles: ['frontal'], targetAngle: 'frontal', targetFraming: 'half_body' }, customerContext: { intendedUse: 'livestream_cover' }, taskIntent, promptCompilation });
  const loaded = await loadRun({ root, runId: created.runId });
  assert.equal(loaded.prompt, promptCompilation.compiled_prompt);
  assert.equal(loaded.manifest.prompt_sha256, promptCompilation.prompt_sha256);
  assert.equal(loaded.manifest.schema_version, 'ai-img-gen.web-run.v6');
});

test('run creation route passes compiled prompt and resolved references before saving a reusable identity set', async () => {
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const routeStart = server.indexOf("if (req.method === 'POST' && url.pathname === '/api/runs')");
  const routeEnd = server.indexOf('const referenceFileRoute', routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = server.slice(routeStart, routeEnd);
  const call = route.match(/const run = await createRunSnapshot\(\{([\s\S]*?)\n\s*\}\);/)?.[1] || '';
  assert.match(call, /prompt:\s*promptCompilation\.compiled_prompt/);
  assert.match(call, /^\s*identityFiles,\s*$/m);
  assert.match(call, /^\s*templateFiles,\s*$/m);
  assert.match(call, /^\s*taskIntent,\s*$/m);
  assert.match(call, /^\s*promptCompilation,\s*$/m);
  assert.ok(route.indexOf('const run = await createRunSnapshot') < route.indexOf('await createIdentitySet'));
});
test('one-click workstation submission probes the browser before staging and never asks an Agent to intervene', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('async function stageAndSubmitRunOnce');
  const end = app.indexOf('function currentTaskFormValues', start);
  assert.ok(start >= 0 && end > start);
  const flow = app.slice(start, end);
  assert.match(flow, /\/api\/browser\/probe/);
  assert.match(flow, /browser\.ready/);
  assert.ok(flow.indexOf('/api/browser/probe') < flow.indexOf('/stage'));
  assert.ok(flow.indexOf('/stage') < flow.indexOf('/submit'));
  assert.doesNotMatch(flow, /Agent|agent/);
});
test('completed bare Run URL returns to new task while explicit history remains reviewable', () => {
  assert.equal(typeof navigationModule.resolveRunStartup, 'function');
  const completed = { status: 'completed', artifacts: [{ artifact_id: 'artifact-1' }], preference: { decision: 'winner' } };
  assert.deepEqual(navigationModule.resolveRunStartup({ manifest: completed, fromHistory: false }), { mode: 'new', stage: 'references', notice: navigationModule.COMPLETED_RUN_NOTICE });
  assert.deepEqual(navigationModule.resolveRunStartup({ manifest: completed, fromHistory: true }), { mode: 'run', stage: 'review', notice: '' });
});

test('unfinished Run URLs resume the correct stage and final decisions clear only non-history URLs', () => {
  assert.equal(typeof navigationModule.resolveRunStartup, 'function');
  assert.equal(navigationModule.resolveRunStartup({ manifest: { status: 'prepared', artifacts: [] }, fromHistory: false }).stage, 'generation');
  assert.equal(navigationModule.resolveRunStartup({ manifest: { status: 'submitted', artifacts: [] }, fromHistory: false }).stage, 'results');
  assert.equal(navigationModule.resolveRunStartup({ manifest: { status: 'submission_uncertain', artifacts: [] }, fromHistory: false }).stage, 'results');
  assert.equal(navigationModule.resolveRunStartup({ manifest: { status: 'provider_error', artifacts: [] }, fromHistory: false }).stage, 'results');
  assert.equal(navigationModule.resolveRunStartup({ manifest: { status: 'artifacts_saved', artifacts: [{ artifact_id: 'artifact-1' }], preference: null }, fromHistory: false }).stage, 'review');
  assert.equal(navigationModule.shouldClearRunUrlAfterPreference('winner', false), true);
  assert.equal(navigationModule.shouldClearRunUrlAfterPreference('none', false), true);
  assert.equal(navigationModule.shouldClearRunUrlAfterPreference('pending', false), false);
  assert.equal(navigationModule.shouldClearRunUrlAfterPreference('winner', true), false);
});

test('navigation parser and workbench expose clean new-task recovery controls', async () => {
  assert.deepEqual(navigationModule.parseRunLocation('?run=run-abc123&from=history'), { runId: 'run-abc123', fromHistory: true });
  assert.deepEqual(navigationModule.parseRunLocation('?run=unsafe/value'), { runId: null, fromHistory: false });
  const [html, app, css] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="newTaskButton"/);
  assert.match(app, /resolveRunStartup/);
  assert.match(app, /shouldClearRunUrlAfterPreference/);
  assert.match(app, /history\.replaceState\(null, '', '\/'\)/);
  assert.match(app, /window\.location\.assign\('\/'\)/);
  assert.match(app, /homeNoticeStorageKey/);
  assert.match(css, /\.new-task-button/);
});
test('clipboard image helper accepts binary image files, filters MIME, and generates stable names', async () => {
  assert.equal(typeof clipboardModule.clipboardImageFiles, 'function');
  const image = new File([transparentPng], 'image.png', { type: 'image/png', lastModified: 1 });
  const text = new File(['text'], 'note.txt', { type: 'text/plain', lastModified: 2 });
  const files = clipboardModule.clipboardImageFiles({ files: [image, text], items: [] }, { kind: 'identity', now: Date.UTC(2026, 7, 23, 3, 4, 5) });
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'clipboard-identity-20260823T030405-01.png');
  assert.equal(files[0].type, 'image/png');
  assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), transparentPng);
  assert.deepEqual(clipboardModule.clipboardImageFiles({ files: [text], items: [] }, { kind: 'templates' }), []);
});

test('clipboard file merge preserves picker files, deduplicates metadata, and enforces slot limits', () => {
  assert.equal(typeof clipboardModule.mergeFilesWithinLimit, 'function');
  const existing = [new File([transparentPng], 'front.png', { type: 'image/png', lastModified: 1 })];
  const duplicate = new File([transparentPng], 'front.png', { type: 'image/png', lastModified: 1 });
  const second = new File([whitePng], 'side.png', { type: 'image/png', lastModified: 2 });
  const third = new File([whitePng], 'extra.png', { type: 'image/png', lastModified: 3 });
  const merged = clipboardModule.mergeFilesWithinLimit(existing, [duplicate, second, third], 2);
  assert.deepEqual(merged.files.map((file) => file.name), ['front.png', 'side.png']);
  assert.equal(merged.added_count, 1);
  assert.equal(merged.rejected_count, 1);
  assert.equal(merged.duplicate_count, 1);
});

test('pasted reference bytes use the same durable Run persistence path as picker uploads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-clipboard-run-'));
  const created = await createRunSnapshot({ root, customerName: 'Clipboard Customer', prompt: 'Clipboard persistence test', identityFiles: [{ name: 'clipboard-identity-20260823T030405-01.png', bytes: transparentPng }], templateFiles: [{ name: 'clipboard-template-20260823T030405-01.png', bytes: whitePng }], referencePlan: { identityAngles: ['frontal'], targetAngle: 'frontal', targetFraming: 'bust' }, customerContext: { intendedUse: 'professional_portrait' } });
  const loaded = await loadRun({ root, runId: created.runId });
  assert.match(loaded.manifest.identity_references[0].filename, /clipboard-identity/);
  assert.match(loaded.manifest.template_references[0].filename, /clipboard-template/);
  assert.equal(loaded.manifest.identity_references[0].sha256, createHash('sha256').update(transparentPng).digest('hex'));
});

test('workbench scopes Ctrl+V to hovered reference areas and explains temporary versus durable state', async () => {
  const [html, app, css] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /data-paste-target="identity"/);
  assert.match(html, /data-paste-target="templates"/);
  assert.match(html, /Ctrl\+V/);
  assert.match(app, /document\.addEventListener\('paste'/);
  assert.match(app, /activePasteTarget/);
  assert.match(app, /isEditablePasteTarget/);
  assert.match(app, /clipboardImageFiles/);
  assert.match(app, /mergeFilesWithinLimit/);
  assert.match(app, /提交后(?:会)?保存到本地/);
  assert.doesNotMatch(app, /navigator\.clipboard\.read/);
  assert.match(css, /\.paste-target-active/);
});
