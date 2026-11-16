import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  beginRunSubmissionAttempt,
  createRunSnapshot,
  listRuns,
  loadRun,
  recordRunEvent,
  saveResultFiles,
  saveReview,
} from '../src/run-store.mjs';
import { ChatGptExecutor, buildGenerationPrompt, findComputerUploadRef } from '../src/chatgpt-executor.mjs';
import { extractCurrentChatTab } from '../src/result-capture.mjs';
import { evaluateReview } from '../src/review-policy.mjs';
import { evaluateReferencePlan } from '../src/reference-policy.mjs';
import { loadReviewGuidance } from '../src/learning-projection.mjs';
import { ensureMcpServer } from '../src/mcp-process.mjs';

const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const captureChatUrl = 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';

test('current ChatGPT add-photos-and-files menu item is accepted as the computer upload action', () => {
  const snapshot = '- menu:\n  - menuitem "添加照片和文件" [active] [ref=e777] [cursor=pointer]';
  assert.equal(findComputerUploadRef(snapshot), 'e777');
});

test('isolated server without a Playwright token degrades to token-required instead of exiting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-mcp-token-missing-'));
  const result = await ensureMcpServer({
    tokenFile: join(root, '.runtime', 'playwright-extension-token'),
    outputDir: join(root, '.runtime', 'playwright-mcp'),
    logFile: join(root, '.runtime', 'playwright-mcp.log'),
    workingDirectory: root,
    port: 0,
  });
  assert.deepEqual(result, { ready: false, owned: false, state: 'token_required', process: null });
});

function fakeClient({ snapshotTexts, fileUploadError, postSubmitSnapshotTexts, screenshotError, networkRequestsText, postSubmitNetworkRequestsText, postSubmitTabTexts } = {}) {
  const calls = [];
  let snapshotCount = 0;
  let postSubmitSnapshotCount = 0;
  let submitted = false;
  let typedPrompt = '';
  let postSubmitTabCount = 0;
  const defaultSnapshots = [
    '- button "添加文件等" [active] [ref=e104]',
    '- generic [ref=e418] [cursor=pointer]:\n  - generic: 添加照片和文件\n  - generic: 从电脑上传',
    '- textbox "与 ChatGPT 聊天" [active] [ref=e49]\n- button "发送提示" [ref=e140] [cursor=pointer]',
  ];
  return {
    calls,
    async initialize() { calls.push({ name: 'initialize', args: {} }); },
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'browser_file_upload' && fileUploadError) throw fileUploadError;
      if (name === 'browser_take_screenshot' && screenshotError) throw screenshotError;
      if (name === 'browser_type' && String(args.text || '').trim()) typedPrompt = args.text;
      if (isSendButtonClick({ name, args })) submitted = true;
      if (name === 'browser_press_key' && args.key === 'Enter' && typedPrompt) submitted = true;
      if (name === 'browser_tabs') {
        if (submitted && postSubmitTabTexts?.length) {
          const text = postSubmitTabTexts[Math.min(postSubmitTabCount, postSubmitTabTexts.length - 1)];
          postSubmitTabCount += 1;
          return { text };
        }
        return { text: `- 0: (current) [Capture test](${captureChatUrl})` };
      }
      if (name === 'browser_snapshot') {
        if (submitted) {
          const snapshots = postSubmitSnapshotTexts || [`- article:\n  - paragraph: ${typedPrompt}`];
          const text = snapshots[Math.min(postSubmitSnapshotCount, snapshots.length - 1)];
          postSubmitSnapshotCount += 1;
          return { text };
        }
        snapshotCount += 1;
        const snapshots = snapshotTexts || defaultSnapshots;
        return { text: snapshots[Math.min(snapshotCount - 1, snapshots.length - 1)] };
      }
      if (name === 'browser_network_requests') {
        return { text: (submitted && postSubmitNetworkRequestsText) || networkRequestsText || '4. [GET] https://chatgpt.com/a => [200] OK\n12. [GET] https://chatgpt.com/b => [200] OK' };
      }
      return { text: 'ok' };
    },
  };
}

test('staged prompt snapshot stays exact and changed legacy text cannot be silently sent',async()=>{
 const root=await mkdtemp(join(tmpdir(),'staged-prompt-'));const run=await preparedRun(root);const client=fakeClient();const executor=new ChatGptExecutor({clientFactory:()=>client});
 await executor.stageRun({run,confirmed:true});
 const typed=client.calls.filter(c=>c.name==='browser_type'&&c.args.text).at(-1).args.text;
 assert.equal(executor.stagedRequestSnapshot(run.runId).prompt,typed);
 const count=client.calls.length;
 await assert.rejects(()=>executor.submitRun({run:{...run,prompt:'changed after staging'},confirmed:true}),/changed|重新装载/);
 assert.equal(client.calls.length,count);
});
test('staged references and preparation revision are bound even when prompt is unchanged',async()=>{
 const root=await mkdtemp(join(tmpdir(),'staged-revision-'));const run=await preparedRun(root);run.manifest.preparation_revision_id='prep_old';const client=fakeClient();const executor=new ChatGptExecutor({clientFactory:()=>client});
 await executor.stageRun({run,confirmed:true});const count=client.calls.length;
 await assert.rejects(()=>executor.submitRun({run:{...run,manifest:{...run.manifest,preparation_revision_id:'prep_new'}},confirmed:true}),/changed|重新装载/);
 const changed={...run,manifest:{...run.manifest,identity_references:run.manifest.identity_references.map(r=>({...r,sha256:'f'.repeat(64)}))}};
 await assert.rejects(()=>executor.submitRun({run:changed,confirmed:true}),/changed|重新装载/);assert.equal(client.calls.length,count);
});

function isSendButtonClick(call) {
  return call.name === 'browser_click' && call.args?.element === 'ChatGPT send button';
}

function enterKeyCount(client) {
  return client.calls.filter((call) => call.name === 'browser_press_key' && call.args.key === 'Enter').length;
}

function validReferencePlan() {
  return {
    identityAngles: ['frontal', 'left_45', 'right_45'],
    targetAngle: 'left_45',
    targetFraming: 'half_body',
  };
}

function validCustomerContext() {
  return { businessDomain: 'health and fitness', intendedUse: 'social media cover' };
}

function fullReview(overrides = {}) {
  return {
    faceFidelity: 8.8,
    naturalness: 8.1,
    style: 8.3,
    diagnosticCodes: [],
    notes: '',
    ...overrides,
  };
}

async function preparedRun(root, overrides = {}) {
  const created = await createRunSnapshot({
    root,
    customerName: 'Customer A',
    prompt: 'Keep identity consistent and use the template composition.',
    identityFiles: [{ name: 'front.png', bytes: Buffer.from('front') }, { name: 'side.png', bytes: Buffer.from('side') }],
    templateFiles: [{ name: 'style.png', bytes: Buffer.from('style') }],
    referencePlan: validReferencePlan(),
    customerContext: validCustomerContext(),
    ...overrides,
  });
  return loadRun({ root, runId: created.runId });
}

test('run creation idempotency replays one durable Run across concurrent and later retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-run-create-idempotency-'));
  const input = {
    root,
    runCreationIdempotencyKey: 'run-create-test-001',
    customerName: 'Customer A',
    prompt: 'Keep identity consistent and use the template composition.',
    identityFiles: [{ name: 'front.png', bytes: Buffer.from('front') }],
    templateFiles: [{ name: 'style.png', bytes: Buffer.from('style') }],
    referencePlan: validReferencePlan(),
    customerContext: validCustomerContext(),
  };

  const [first, concurrentReplay] = await Promise.all([
    createRunSnapshot(input),
    createRunSnapshot(input),
  ]);
  const laterReplay = await createRunSnapshot(input);
  const runDirs = (await readdir(join(root, 'data', 'runs'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('run-'));
  const loaded = await loadRun({ root, runId: first.runId });

  assert.equal(concurrentReplay.runId, first.runId);
  assert.equal(laterReplay.runId, first.runId);
  assert.equal([first, concurrentReplay].filter((result) => result.idempotent_replay === false).length, 1);
  assert.equal([first, concurrentReplay].filter((result) => result.idempotent_replay === true).length, 1);
  assert.equal(laterReplay.idempotent_replay, true);
  assert.equal(runDirs.length, 1);
  assert.equal(loaded.manifest.run_creation.idempotency_key, input.runCreationIdempotencyKey);
  assert.match(loaded.manifest.run_creation.request_sha256, /^[a-f0-9]{64}$/);
});

test('run creation idempotency rejects the same key with changed request evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-run-create-conflict-'));
  const input = {
    root,
    runCreationIdempotencyKey: 'run-create-test-conflict',
    customerName: 'Customer A',
    prompt: 'First request',
    identityFiles: [{ name: 'front.png', bytes: Buffer.from('front') }],
    templateFiles: [{ name: 'style.png', bytes: Buffer.from('style') }],
    referencePlan: validReferencePlan(),
    customerContext: validCustomerContext(),
  };
  const created = await createRunSnapshot(input);

  await assert.rejects(
    () => createRunSnapshot({ ...input, prompt: 'Changed request' }),
    (error) => error?.code === 'run_creation_idempotency_conflict' && error?.status === 409 && error?.runId === created.runId,
  );
  const runDirs = (await readdir(join(root, 'data', 'runs'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('run-'));
  assert.equal(runDirs.length, 1);
});

test('new-customer Runs persist the opaque customer id used by history grouping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-new-customer-id-'));
  const created = await createRunSnapshot({
    root,
    customerId: 'cust_1234567890abcdef',
    customerName: 'New Customer',
    prompt: 'Portrait',
    identityFiles: [{ name: 'front.png', bytes: Buffer.from('front') }],
    templateFiles: [{ name: 'style.png', bytes: Buffer.from('style') }],
    referencePlan: validReferencePlan(),
    customerContext: validCustomerContext(),
  });
  const loaded = await loadRun({ root, runId: created.runId });
  const history = await listRuns({ root, artifactsOnly: false });

  assert.equal(loaded.manifest.customer_id, 'cust_1234567890abcdef');
  assert.equal(history[0].customer_id, 'cust_1234567890abcdef');
});

test('history exposes degraded template learning instead of hiding a corrupt selection projection as zero support', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-template-learning-degraded-'));
  const created = await createRunSnapshot({
    root,
    customerName: 'Customer A',
    prompt: 'Portrait',
    identityFiles: [{ name: 'front.png', bytes: Buffer.from('front') }],
    templateFiles: [{ name: 'style.png', bytes: Buffer.from('style') }],
    referencePlan: validReferencePlan(),
    customerContext: validCustomerContext(),
  });
  const manifestPath = join(root, 'data', 'runs', created.runId, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const selectionId = 'sel_111111111111111111111111';
  manifest.template_references[0] = {
    ...manifest.template_references[0],
    source_type: 'catalog_template',
    template_uid: 'tpl_fixture',
    selection_id: selectionId,
  };
  manifest.template_selection = { selection_id: selectionId, link_state: 'linked' };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const selectionDir = join(root, 'data', 'template-selections', selectionId);
  await mkdir(selectionDir, { recursive: true });
  await writeFile(join(selectionDir, 'selection.json'), '{invalid-json', 'utf8');

  const history = await listRuns({ root, artifactsOnly: false });

  assert.equal(history.length, 1);
  assert.equal(history[0].template_learning.state, 'degraded');
  assert.equal(history[0].template_learning.reason, 'selection_not_found');
  assert.equal(history[0].template_learning.active_outcome_count, null);
});

test('reference preflight requires target settings without requiring duplicate template metadata', () => {
  const missingIdentity = evaluateReferencePlan({
    referencePlan: { identityAngles: ['frontal'], targetAngle: 'left_45', targetFraming: 'half_body' },
    customerContext: validCustomerContext(),
  });
  assert.equal(missingIdentity.state, 'blocked');
  assert.equal(missingIdentity.blocking_issues.some((issue) => issue.code === 'missing_identity_angle'), true);

  const withoutTemplateMetadata = evaluateReferencePlan({
    referencePlan: validReferencePlan(),
    customerContext: validCustomerContext(),
  });
  assert.equal(withoutTemplateMetadata.state, 'passed');
  assert.equal(withoutTemplateMetadata.policy_version, 'portrait-reference-preflight-v2');
  assert.equal(withoutTemplateMetadata.normalized_reference_plan.template_angle, '');
  assert.equal(withoutTemplateMetadata.normalized_reference_plan.template_framing, '');

  const historicalMismatch = evaluateReferencePlan({
    referencePlan: { ...validReferencePlan(), templateAngle: 'frontal', templateFraming: 'full_body' },
    customerContext: validCustomerContext(),
  });
  assert.equal(historicalMismatch.state, 'passed_with_warnings');
  assert.equal(historicalMismatch.warnings.some((issue) => issue.code === 'template_angle_mismatch'), true);
  assert.equal(historicalMismatch.warnings.some((issue) => issue.code === 'framing_mismatch'), true);
});

test('loading a v1 run reprojects obsolete template-angle blocking without rewriting source truth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-preflight-upgrade-'));
  const created = await createRunSnapshot({
    root,
    customerName: 'Legacy preflight customer',
    prompt: 'Keep identity consistent and use the template composition.',
    identityFiles: [{ name: 'front.png', bytes: Buffer.from('front') }],
    templateFiles: [{ name: 'style.png', bytes: Buffer.from('style') }],
    referencePlan: { identityAngles: ['frontal'], targetAngle: 'frontal', targetFraming: 'half_body' },
    customerContext: { intendedUse: 'clean background' },
  });
  const manifestPath = join(root, 'data', 'runs', created.runId, 'manifest.json');
  const stored = JSON.parse(await readFile(manifestPath, 'utf8'));
  stored.reference_preflight = {
    ...stored.reference_preflight,
    policy_version: 'portrait-reference-preflight-v1',
    state: 'blocked',
    blocking_issues: [{ code: 'missing_template_angle', message: '请选择模板人物的主要角度。' }],
  };
  await writeFile(manifestPath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');

  const loaded = await loadRun({ root, runId: created.runId });
  assert.equal(loaded.manifest.reference_preflight.policy_version, 'portrait-reference-preflight-v2');
  assert.notEqual(loaded.manifest.reference_preflight.state, 'blocked');
  assert.equal(loaded.manifest.reference_preflight.blocking_issues.some((issue) => issue.code === 'missing_template_angle'), false);

  const rawAfterLoad = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(rawAfterLoad.reference_preflight.policy_version, 'portrait-reference-preflight-v1');
  assert.equal(rawAfterLoad.reference_preflight.state, 'blocked');
});



test('generation prompt uses the same portrait framing labels exposed by the workbench', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-framing-'));
  const headshot = await preparedRun(root, {
    referencePlan: { ...validReferencePlan(), targetFraming: 'headshot' },
  });
  const headshotPrompt = buildGenerationPrompt(headshot);
  assert.match(headshotPrompt, /\u5934\u50cf\u8fd1\u666f/);
  assert.doesNotMatch(headshotPrompt, /模板景别为未标记/);
  const threeQuarter = await preparedRun(root, {
    customerName: 'Three Quarter',
    referencePlan: { ...validReferencePlan(), targetFraming: 'three_quarter' },
  });
  assert.match(buildGenerationPrompt(threeQuarter), /\u4e03\u5206\u8eab/);
});

test('submitted conversation parser accepts only the current full ChatGPT conversation URL', () => {
  const actual = extractCurrentChatTab([
    '- 0: [Welcome](chrome-extension://playwright/connect.html?client=ai-img-gen-browser-probe)',
    '- 1: (current) [人像写真生成要求](https://chatgpt.com/c/6a7af065-6694-83e8-87b4-f8fa6d586480)',
    '- 2: [AI 人像写真复利工作台](http://127.0.0.1:4577/)',
  ].join('\n'));
  assert.deepEqual(actual, {
    index: 1,
    url: 'https://chatgpt.com/c/6a7af065-6694-83e8-87b4-f8fa6d586480',
  });
  assert.equal(extractCurrentChatTab('- 0: (current) [ChatGPT](https://chatgpt.com/c/WEB)'), null);
  assert.equal(extractCurrentChatTab('- 0: (current) [ChatGPT](https://chatgpt.com/)'), null);
});

test('staging requires explicit upload confirmation and never submits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-workflow-'));
  const run = await preparedRun(root);
  const client = fakeClient();
  const executor = new ChatGptExecutor({ clientFactory: () => client });

  await assert.rejects(() => executor.stageRun({ run, confirmed: false }), /confirm/i);
  assert.equal(client.calls.length, 0);

  const result = await executor.stageRun({ run, confirmed: true });
  assert.equal(result.state, 'awaiting_submission_confirmation');
  assert.deepEqual(client.calls.map((call) => call.name), [
    'initialize',
    'browser_tabs',
    'browser_wait_for',
    'browser_tabs',
    'browser_press_key',
    'browser_type',
    'browser_press_key',
    'browser_snapshot',
    'browser_press_key',
    'browser_snapshot',
    'browser_press_key',
    'browser_file_upload',
    'browser_type',
    'browser_take_screenshot',
  ]);
  const openedTab = client.calls.find((call) => call.name === 'browser_tabs');
  assert.deepEqual(openedTab.args, { action: 'new', url: 'https://chatgpt.com/' });
  assert.equal(client.calls.some((call) => call.name === 'browser_navigate'), false);
  assert.equal(client.calls.some(isSendButtonClick), false);
  assert.equal(client.calls.some((call) => call.name === 'browser_drop'), false);
  const keyboardCalls = client.calls.filter((call) => call.name === 'browser_press_key');
  assert.deepEqual(keyboardCalls.map((call) => call.args), [{ key: 'Escape' }, { key: 'Shift+Tab' }, { key: 'Enter' }, { key: 'Enter' }]);
  assert.equal(client.calls.some((call) => call.name === 'browser_click'), false);
  const upload = client.calls.find((call) => call.name === 'browser_file_upload');
  assert.equal(upload.args.paths.length, 3);
  assert.equal(upload.args.paths.every((path) => path.includes(run.runId)), true);
  const typedCalls = client.calls.filter((call) => call.name === 'browser_type');
  assert.equal(typedCalls[0].args.text, '');
  const typed = typedCalls[1];
  assert.match(typed.args.text, /左 45 度/);
  assert.match(typed.args.text, /health and fitness/);
});

test('staging dismisses one transient ChatGPT dialog and reopens the upload menu without sending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-workflow-'));
  const run = await preparedRun(root);
  const client = fakeClient({
    snapshotTexts: [
      '- button "添加文件等" [active] [ref=e104]',
      '- dialog [ref=e887]:\n  - button "关闭" [active] [ref=e890]',
      '- button "添加文件等" [active] [ref=e204]',
      '- generic [ref=e518] [cursor=pointer]:\n  - generic: 添加照片和文件\n  - generic: 从电脑上传',
    ],
  });
  const executor = new ChatGptExecutor({ clientFactory: () => client });

  const result = await executor.stageRun({ run, confirmed: true });

  assert.equal(result.state, 'awaiting_submission_confirmation');
  assert.deepEqual(
    client.calls.filter((call) => call.name === 'browser_press_key').map((call) => call.args.key),
    ['Escape', 'Shift+Tab', 'Enter', 'Escape', 'Shift+Tab', 'Enter', 'Enter'],
  );
  assert.equal(client.calls.some((call) => call.name === 'browser_click'), false);
  assert.equal(client.calls.some((call) => call.name === 'browser_drop'), false);
  assert.equal(client.calls.filter((call) => call.name === 'browser_file_upload').length, 1);
});

test('staging activates the current add-photos menu item by keyboard instead of clicking an off-viewport target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-workflow-active-upload-item-'));
  const run = await preparedRun(root);
  const client = fakeClient({
    snapshotTexts: [
      '- button "添加文件等" [active] [ref=e104]',
      '- menu:\n  - menuitem "添加照片和文件" [active] [ref=e88] [cursor=pointer]',
    ],
  });
  const executor = new ChatGptExecutor({ clientFactory: () => client });

  const result = await executor.stageRun({ run, confirmed: true });

  assert.equal(result.state, 'awaiting_submission_confirmation');
  assert.deepEqual(
    client.calls.filter((call) => call.name === 'browser_press_key').map((call) => call.args.key),
    ['Escape', 'Shift+Tab', 'Enter', 'Enter'],
  );
  assert.equal(client.calls.some((call) => call.name === 'browser_click' && call.args.target === 'e88'), false);
  assert.equal(client.calls.filter((call) => call.name === 'browser_file_upload').length, 1);
});

test('staging remains ready to submit when the optional evidence screenshot has a zero-width viewport failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-workflow-screenshot-warning-'));
  const run = await preparedRun(root);
  const client = fakeClient({
    screenshotError: new Error('Protocol error (Page.captureScreenshot): Cannot take screenshot with 0 width.'),
  });
  const executor = new ChatGptExecutor({ clientFactory: () => client });

  const result = await executor.stageRun({ run, confirmed: true });

  assert.equal(result.state, 'awaiting_submission_confirmation');
  assert.equal(result.alreadyStaged, false);
  assert.match(result.evidenceWarning, /screenshot.*0 width/i);
  assert.equal(client.calls.filter((call) => call.name === 'browser_file_upload').length, 1);
  assert.equal(client.calls.some(isSendButtonClick), false);
});

test('staging falls back to official file drop when the current ChatGPT UI does not expose a file chooser modal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-workflow-'));
  const run = await preparedRun(root);
  const client = fakeClient({
    fileUploadError: new Error('The tool "browser_file_upload" can only be used when there is related modal state present.'),
  });
  const executor = new ChatGptExecutor({ clientFactory: () => client });

  const result = await executor.stageRun({ run, confirmed: true });

  assert.equal(result.state, 'awaiting_submission_confirmation');
  const uploadIndex = client.calls.findIndex((call) => call.name === 'browser_file_upload');
  const dropIndex = client.calls.findIndex((call) => call.name === 'browser_drop');
  const promptIndex = client.calls.findIndex((call, index) => index > dropIndex && call.name === 'browser_type');
  assert.equal(uploadIndex > 0, true);
  assert.equal(dropIndex > uploadIndex, true);
  assert.equal(promptIndex > dropIndex, true);
  assert.deepEqual(client.calls[dropIndex].args, {
    element: 'ChatGPT message composer',
    target: '#prompt-textarea',
    paths: [
      ...run.manifest.identity_references.map((item) => item.path),
      ...run.manifest.template_references.map((item) => item.path),
    ],
  });
  assert.equal(
    client.calls.some((call, index) => index > dropIndex && call.name === 'browser_press_key' && call.args.key === 'Escape'),
    true,
  );
  assert.equal(client.calls.some(isSendButtonClick), false);
});

test('file-drop fallback waits for a late overlay and dismisses it before typing the prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-workflow-overlay-'));
  const run = await preparedRun(root);
  const client = fakeClient({
    fileUploadError: new Error('The tool "browser_file_upload" can only be used when there is related modal state present.'),
    snapshotTexts: [
      '- button "添加文件等" [active] [ref=e104]',
      '- generic [ref=e418] [cursor=pointer]:\n  - generic: 从电脑上传',
      '- dialog:\n  - heading "添加任意内容"\n  - text: 将任意文件拖放到此处',
      '- textbox "与 ChatGPT 聊天"',
    ],
  });
  const executor = new ChatGptExecutor({ clientFactory: () => client });

  const result = await executor.stageRun({ run, confirmed: true });

  assert.equal(result.state, 'awaiting_submission_confirmation');
  const dropIndex = client.calls.findIndex((call) => call.name === 'browser_drop');
  const promptIndex = client.calls.findIndex((call, index) => index > dropIndex && call.name === 'browser_type' && String(call.args.text || '').trim());
  const postDropSnapshots = client.calls.filter((call, index) => index > dropIndex && index < promptIndex && call.name === 'browser_snapshot');
  const postDropEscapes = client.calls.filter((call, index) => index > dropIndex && index < promptIndex && call.name === 'browser_press_key' && call.args.key === 'Escape');
  assert.equal(postDropSnapshots.length >= 2, true);
  assert.equal(postDropEscapes.length >= 1, true);
});

test('file-drop fallback refuses to type or stage while the drop overlay remains visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-workflow-overlay-stuck-'));
  const run = await preparedRun(root);
  const overlay = '- dialog:\n  - heading "添加任意内容"\n  - text: 将任意文件拖放到此处';
  const client = fakeClient({
    fileUploadError: new Error('The tool "browser_file_upload" can only be used when there is related modal state present.'),
    snapshotTexts: [
      '- button "添加文件等" [active] [ref=e104]',
      '- generic [ref=e418] [cursor=pointer]:\n  - generic: 从电脑上传',
      overlay,
      overlay,
      overlay,
      overlay,
    ],
  });
  const executor = new ChatGptExecutor({ clientFactory: () => client });

  const result = await executor.stageRun({ run, confirmed: true });

  assert.equal(result.state, 'provider_error');
  assert.match(result.message, /overlay|遮罩|拖放/i);
  const dropIndex = client.calls.findIndex((call) => call.name === 'browser_drop');
  assert.equal(client.calls.some((call, index) => index > dropIndex && call.name === 'browser_type' && String(call.args.text || '').trim()), false);
  assert.equal(client.calls.some(isSendButtonClick), false);
});

test('staging does not hide unrelated file-upload failures behind the drop fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-workflow-'));
  const run = await preparedRun(root);
  const client = fakeClient({ fileUploadError: new Error('Upload permission denied') });
  const executor = new ChatGptExecutor({ clientFactory: () => client });

  const result = await executor.stageRun({ run, confirmed: true });

  assert.equal(result.state, 'provider_error');
  assert.match(result.message, /permission denied/i);
  assert.equal(client.calls.some((call) => call.name === 'browser_drop'), false);
  assert.equal(client.calls.some(isSendButtonClick), false);
});

test('blocked reference preflight stops before any browser action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-workflow-'));
  const run = await preparedRun(root, {
    referencePlan: { identityAngles: ['frontal'], targetAngle: 'left_45', templateAngle: 'frontal' },
  });
  const client = fakeClient();
  const executor = new ChatGptExecutor({ clientFactory: () => client });
  await assert.rejects(() => executor.stageRun({ run, confirmed: true }), /reference preflight/i);
  assert.equal(client.calls.length, 0);
});

test('submission uses one Enter keypress from the active composer instead of geometry-dependent clicking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-visible-send-ref-'));
  const run = await preparedRun(root);
  const client = fakeClient();
  const executor = new ChatGptExecutor({ clientFactory: () => client });
  await executor.stageRun({ run, confirmed: true });

  const result = await executor.submitRun({ run, confirmed: true });
  const baselineIndex = client.calls.findIndex((call) => call.name === 'browser_network_requests');
  const sendKeyIndex = client.calls.findIndex((call, index) => (
    index > baselineIndex && call.name === 'browser_press_key' && call.args.key === 'Enter'
  ));

  assert.equal(result.state, 'submitted');
  assert.equal(client.calls.some(isSendButtonClick), false);
  assert.equal(sendKeyIndex > baselineIndex, true);
});

test('submission remains idempotent and records the exact ChatGPT tab for capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-workflow-'));
  const run = await preparedRun(root);
  const client = fakeClient({
    networkRequestsText: '4. [GET] https://chatgpt.com/a => [200] OK\n12. [GET] https://chatgpt.com/b => [200] OK',
    postSubmitNetworkRequestsText: [
      '12. [GET] https://chatgpt.com/b => [200] OK',
      '13. [GET] https://chatgpt.com/backend-api/estuary/content?id=file_uploaded_identity&sig=secret-one => [200] OK',
      '14. [GET] https://chatgpt.com/backend-api/estuary/content?id=file_uploaded_template&sig=secret-two => [200] OK',
    ].join('\n'),
  });
  const executor = new ChatGptExecutor({ clientFactory: () => client });
  await executor.stageRun({ run, confirmed: true });
  const enterCountAfterStage = enterKeyCount(client);

  await assert.rejects(() => executor.submitRun({ run, confirmed: false }), /confirm/i);
  assert.equal(client.calls.filter(isSendButtonClick).length, 0);

  const first = await executor.submitRun({ run, confirmed: true });
  const second = await executor.submitRun({ run, confirmed: true });
  assert.equal(first.state, 'submitted');
  assert.equal(first.captureContext.chat_url, captureChatUrl);
  assert.equal(first.captureContext.browser_tab_index, 0);
  assert.equal(first.captureContext.network_request_count, 12);
  assert.deepEqual(first.captureContext.reference_asset_ids, ['file_uploaded_identity', 'file_uploaded_template']);
  assert.equal(JSON.stringify(first.captureContext).includes('secret-one'), false);
  assert.equal(second.state, 'already_submitted');
  assert.equal(client.calls.filter(isSendButtonClick).length, 0);
  assert.equal(enterKeyCount(client), enterCountAfterStage + 1);
  assert.equal(client.calls.filter((call) => call.name === 'browser_tabs' && call.args.action === 'list').length, 2);
  assert.equal(client.calls.filter((call) => call.name === 'browser_network_requests').length, 2);
  const baselineCallIndex = client.calls.findIndex((call) => call.name === 'browser_network_requests');
  const sendCallIndex = client.calls.findIndex((call, index) => (
    index > baselineCallIndex && call.name === 'browser_press_key' && call.args.key === 'Enter'
  ));
  assert.equal(baselineCallIndex < sendCallIndex, true);
  assert.equal(executor.clientForRun(run.runId), client);
});

test('submission waits for a delayed conversation URL instead of marking a real send uncertain after eight seconds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-workflow-delayed-chat-url-'));
  const run = await preparedRun(root);
  const home = '- 0: (current) [ChatGPT](https://chatgpt.com/)';
  const conversation = `- 0: (current) [Capture test](${captureChatUrl})`;
  const client = fakeClient({ postSubmitTabTexts: [...Array(10).fill(home), conversation] });
  const executor = new ChatGptExecutor({ clientFactory: () => client });
  await executor.stageRun({ run, confirmed: true });
  const enterCountAfterStage = enterKeyCount(client);

  const result = await executor.submitRun({ run, confirmed: true });

  assert.equal(result.state, 'submitted');
  assert.equal(result.captureContext.chat_url, captureChatUrl);
  assert.equal(client.calls.filter(isSendButtonClick).length, 0);
  assert.equal(enterKeyCount(client), enterCountAfterStage + 1);
  assert.equal(client.calls.filter((call) => call.name === 'browser_tabs' && call.args.action === 'list').length >= 12, true);
});

test('submission is marked uncertain rather than submitted when only the chat URL changes but the sent prompt is not visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-workflow-unverified-submit-'));
  const run = await preparedRun(root);
  const client = fakeClient({ postSubmitSnapshotTexts: ['- textbox "与 ChatGPT 聊天"'] });
  const executor = new ChatGptExecutor({ clientFactory: () => client });
  await executor.stageRun({ run, confirmed: true });
  const enterCountAfterStage = enterKeyCount(client);

  const first = await executor.submitRun({ run, confirmed: true });
  const second = await executor.submitRun({ run, confirmed: true });

  assert.equal(first.state, 'submission_uncertain');
  assert.equal(first.submissionAttempt, 1);
  assert.equal(first.retryAutomatically, false);
  assert.equal(first.captureContext.chat_url, captureChatUrl);
  assert.equal(second.state, 'already_attempted');
  assert.equal(client.calls.filter(isSendButtonClick).length, 0);
  assert.equal(enterKeyCount(client), enterCountAfterStage + 1);
});

test('a fresh executor cannot restage a Run whose durable manifest records a submission attempt', async () => {
  for (const [eventType, state] of [
    ['RunSubmitted', 'submitted'],
    ['RunSubmissionUncertain', 'submission_uncertain'],
    ['RunSubmissionFailed', 'provider_error'],
  ]) {
    const root = await mkdtemp(join(tmpdir(), `ai-img-gen-restart-stage-guard-${state}-`));
    const prepared = await preparedRun(root);
    await recordRunEvent({
      root,
      runId: prepared.runId,
      type: eventType,
      data: { state, submission_attempt: 1, message: 'attempt recorded' },
    });
    const current = await loadRun({ root, runId: prepared.runId });
    const client = fakeClient();
    const freshExecutor = new ChatGptExecutor({ clientFactory: () => client });

    await assert.rejects(
      () => freshExecutor.stageRun({ run: current, confirmed: true }),
      /already (?:submitted|attempted)|submission attempt/i,
    );
    assert.equal(client.calls.length, 0);
  }
});

test('malformed durable submission-attempt counts fail closed for both stage and submit', async () => {
  for (const corruptCount of ['corrupt', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-corrupt-attempt-count-'));
    const run = await preparedRun(root);
    run.manifest.status = 'staged';
    run.manifest.submission_attempt_count = corruptCount;
    const stageClient = fakeClient();
    const stageExecutor = new ChatGptExecutor({ clientFactory: () => stageClient });
    await assert.rejects(
      () => stageExecutor.stageRun({ run, confirmed: true }),
      /submission attempt.*invalid|invalid.*submission attempt/i,
    );
    assert.equal(stageClient.calls.length, 0);

    const submitClient = fakeClient();
    const submitExecutor = new ChatGptExecutor({ clientFactory: () => submitClient });
    submitExecutor.sessions.set(run.runId, {
      client: submitClient,
      staged: true,
      submissionAttempted: false,
      state: 'awaiting_submission_confirmation',
    });
    await assert.rejects(
      () => submitExecutor.submitRun({ run, confirmed: true }),
      /submission attempt.*invalid|invalid.*submission attempt/i,
    );
    assert.equal(submitClient.calls.length, 0);
  }
});

test('write-ahead submission attempt survives a post-send crash and prevents a second send after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-submission-write-ahead-'));
  const prepared = await preparedRun(root);
  await recordRunEvent({ root, runId: prepared.runId, type: 'RunStaged', data: { executor: 'playwright-mcp-extension' } });
  const started = await beginRunSubmissionAttempt({ root, runId: prepared.runId });
  assert.equal(started.started, true);
  assert.match(started.attemptId, /^attempt_[a-f0-9]{24}$/);

  const firstClient = fakeClient();
  const firstExecutor = new ChatGptExecutor({ clientFactory: () => firstClient });
  await firstExecutor.stageRun({ run: started.runBefore, confirmed: true });
  const enterCountAfterStage = enterKeyCount(firstClient);
  const first = await firstExecutor.submitRun({ run: started.runBefore, confirmed: true });
  assert.equal(first.state, 'submitted');
  // Simulate a process crash here: no RunSubmitted/RunSubmissionUncertain completion event is recorded.
  const durable = await loadRun({ root, runId: prepared.runId });
  assert.equal(durable.manifest.status, 'submission_uncertain');
  assert.equal(durable.manifest.submission_attempt_count, 1);
  assert.equal(durable.manifest.submission_attempt_id, started.attemptId);

  const replay = await beginRunSubmissionAttempt({ root, runId: prepared.runId });
  assert.equal(replay.started, false);
  assert.equal(replay.state, 'already_attempted');
  const secondClient = fakeClient();
  const freshExecutor = new ChatGptExecutor({ clientFactory: () => secondClient });
  await assert.rejects(
    () => freshExecutor.stageRun({ run: durable, confirmed: true }),
    /already.*attempted|submission attempt/i,
  );
  assert.equal(secondClient.calls.length, 0);
  assert.equal(enterKeyCount(firstClient), enterCountAfterStage + 1);
});

test('concurrent write-ahead requests create exactly one durable submission attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-submission-write-ahead-concurrent-'));
  const prepared = await preparedRun(root);
  await recordRunEvent({ root, runId: prepared.runId, type: 'RunStaged', data: { executor: 'playwright-mcp-extension' } });

  const attempts = await Promise.all([
    beginRunSubmissionAttempt({ root, runId: prepared.runId }),
    beginRunSubmissionAttempt({ root, runId: prepared.runId }),
  ]);
  const durable = await loadRun({ root, runId: prepared.runId });

  assert.equal(attempts.filter((attempt) => attempt.started).length, 1);
  assert.equal(attempts.filter((attempt) => !attempt.started && attempt.state === 'already_attempted').length, 1);
  assert.equal(durable.events.filter((event) => event.type === 'RunSubmissionAttemptStarted').length, 1);
  assert.equal(durable.manifest.submission_attempt_count, 1);
});

test('event-first crash recovery repairs a stale manifest and never registers a second submission attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-submission-event-first-crash-'));
  const prepared = await preparedRun(root);
  await recordRunEvent({ root, runId: prepared.runId, type: 'RunStaged', data: { executor: 'playwright-mcp-extension' } });
  const attemptId = `attempt_${'a'.repeat(24)}`;
  const event = {
    schema_version: 'ai-img-gen.run-event.v1',
    event_id: 'event-first-crash-attempt',
    run_id: prepared.runId,
    type: 'RunSubmissionAttemptStarted',
    recorded_at: '2026-09-01T00:00:00.000Z',
    data: { attempt_id: attemptId, submission_attempt: 1 },
  };
  await appendFile(join(root, 'data', 'runs', prepared.runId, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');

  const stale = await loadRun({ root, runId: prepared.runId });
  assert.equal(stale.manifest.status, 'staged');
  assert.equal(stale.manifest.submission_attempt_count, 0);
  const recovered = await beginRunSubmissionAttempt({ root, runId: prepared.runId });
  const durable = await loadRun({ root, runId: prepared.runId });

  assert.equal(recovered.started, false);
  assert.equal(recovered.state, 'already_attempted');
  assert.equal(durable.manifest.status, 'submission_uncertain');
  assert.equal(durable.manifest.submission_attempt_count, 1);
  assert.equal(durable.manifest.submission_attempt_id, attemptId);
  assert.equal(durable.events.filter((item) => item.type === 'RunSubmissionAttemptStarted').length, 1);
});

test('provider failure after write-ahead remains capture-only uncertain instead of becoming retryable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-write-ahead-provider-failure-'));
  const prepared = await preparedRun(root);
  await recordRunEvent({ root, runId: prepared.runId, type: 'RunStaged', data: { executor: 'playwright-mcp-extension' } });
  const started = await beginRunSubmissionAttempt({ root, runId: prepared.runId });
  await recordRunEvent({
    root,
    runId: prepared.runId,
    type: 'RunSubmissionFailed',
    data: { state: 'provider_error', message: 'connection dropped after attempt registration', submission_attempt: 1, attempt_id: started.attemptId },
  });
  const durable = await loadRun({ root, runId: prepared.runId });

  assert.equal(durable.manifest.status, 'submission_uncertain');
  assert.equal(durable.manifest.submission_attempt_count, 1);
  assert.equal(durable.manifest.last_error.state, 'provider_error');
});

test('durable submission evidence blocks a stale in-memory staged session from sending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-durable-submit-guard-'));
  const prepared = await preparedRun(root);
  const client = fakeClient();
  const executor = new ChatGptExecutor({ clientFactory: () => client });
  await executor.stageRun({ run: prepared, confirmed: true });
  const enterCountAfterStage = enterKeyCount(client);
  await recordRunEvent({
    root,
    runId: prepared.runId,
    type: 'RunSubmissionUncertain',
    data: { state: 'submission_uncertain', submission_attempt: 1, message: 'attempt recorded elsewhere' },
  });
  const current = await loadRun({ root, runId: prepared.runId });

  const result = await executor.submitRun({ run: current, confirmed: true });

  assert.equal(result.state, 'already_attempted');
  assert.equal(result.previousState, 'submission_uncertain');
  assert.equal(result.retryAutomatically, false);
  assert.equal(enterKeyCount(client), enterCountAfterStage);
});

test('a staged Run with zero durable submission attempts can be restaged after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-safe-restage-'));
  const prepared = await preparedRun(root);
  await recordRunEvent({ root, runId: prepared.runId, type: 'RunStaged', data: { executor: 'playwright-mcp-extension' } });
  const current = await loadRun({ root, runId: prepared.runId });
  const client = fakeClient();
  const freshExecutor = new ChatGptExecutor({ clientFactory: () => client });
  assert.equal(freshExecutor.hasStagedSession(current.runId), false);

  const result = await freshExecutor.stageRun({ run: current, confirmed: true });

  assert.equal(result.state, 'awaiting_submission_confirmation');
  assert.equal(freshExecutor.hasStagedSession(current.runId), true);
  assert.equal(client.calls.some((call) => call.name === 'browser_file_upload'), true);
  assert.equal(client.calls.some(isSendButtonClick), false);
});

test('stage retry repairs durable status before write-ahead and then sends exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-stage-projection-repair-'));
  const prepared = await preparedRun(root);
  const client = fakeClient();
  const executor = new ChatGptExecutor({ clientFactory: () => client });
  const firstStage = await executor.stageRun({ run: prepared, confirmed: true });
  assert.equal(firstStage.alreadyStaged, false);
  // Simulate a crash/failure before the stage route records RunStaged.
  const stillPrepared = await loadRun({ root, runId: prepared.runId });
  assert.equal(stillPrepared.manifest.status, 'prepared');
  const retriedStage = await executor.stageRun({ run: stillPrepared, confirmed: true });
  assert.equal(retriedStage.alreadyStaged, true);
  if (retriedStage.state === 'awaiting_submission_confirmation' && stillPrepared.manifest.status !== 'staged') {
    await recordRunEvent({ root, runId: prepared.runId, type: 'RunStaged', data: { executor: 'playwright-mcp-extension', recovered: true } });
  }
  const durableStaged = await loadRun({ root, runId: prepared.runId });
  assert.equal(durableStaged.manifest.status, 'staged');
  assert.equal(durableStaged.manifest.submission_attempt_count, 0);

  const started = await beginRunSubmissionAttempt({ root, runId: prepared.runId });
  const enterCountAfterStage = enterKeyCount(client);
  const submitted = await executor.submitRun({ run: started.runBefore, confirmed: true });
  assert.equal(submitted.state, 'submitted');
  assert.equal(enterKeyCount(client), enterCountAfterStage + 1);
});

test('capture can rebind to a fresh MCP client after the server lost its in-memory submission session', async () => {
  const createdClients = [];
  const executor = new ChatGptExecutor({
    clientFactory: () => {
      const client = fakeClient();
      createdClients.push(client);
      return client;
    },
  });

  assert.equal(executor.clientForRun('run-persisted-after-restart'), null);
  const recovered = executor.clientForCapture('run-persisted-after-restart');

  assert.equal(recovered, createdClients[0]);
  assert.equal(createdClients.length, 1);
  assert.equal(executor.clientForRun('run-persisted-after-restart'), null);
});

test('run events are append-only while manifest remains a rebuildable projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-workflow-'));
  const run = await preparedRun(root);
  await recordRunEvent({ root, runId: run.runId, type: 'RunStaged', data: { executor: 'playwright-mcp-extension' } });
  await recordRunEvent({ root, runId: run.runId, type: 'RunSubmitted', data: { submission_attempt: 1 } });
  const loaded = await loadRun({ root, runId: run.runId });
  assert.equal(loaded.manifest.status, 'submitted');
  assert.equal(loaded.events.length, 3);
  assert.deepEqual(loaded.events.map((event) => event.type), ['RunPrepared', 'RunStaged', 'RunSubmitted']);
  assert.equal(loaded.manifest.reference_preflight.state, 'passed');
});

test('concurrent Run events serialize without losing manifest projection updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-run-event-concurrency-'));
  const run = await preparedRun(root);
  const total = 20;
  await Promise.all(Array.from({ length: total }, (_, index) => recordRunEvent({
    root,
    runId: run.runId,
    type: 'ReviewSuggestionRecorded',
    data: {
      artifact_id: `artifact-concurrent-${index}`,
      suggestion: { suggestion_id: `suggestion-concurrent-${index}`, status: 'suggested' },
    },
  })));
  const loaded = await loadRun({ root, runId: run.runId });

  assert.equal(Object.keys(loaded.manifest.review_suggestions || {}).length, total);
  assert.equal(loaded.events.filter((event) => event.type === 'ReviewSuggestionRecorded').length, total);
});

test('a verified late conversation reopens capture without creating a second submission event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-late-capture-recovery-'));
  const run = await preparedRun(root);
  await recordRunEvent({ root, runId: run.runId, type: 'RunSubmitted', data: { submission_attempt: 1 } });
  await recordRunEvent({ root, runId: run.runId, type: 'RunSubmissionFailed', data: { state: 'capture_timeout', submission_attempt: 1 } });
  await recordRunEvent({
    root,
    runId: run.runId,
    type: 'CaptureRecoveryRequested',
    data: {
      reason: 'verified_post_submit_conversation',
      capture_context: {
        chat_url: captureChatUrl,
        browser_tab_index: null,
        network_request_count: 0,
        reference_asset_ids: [],
        recorded_at: '2026-08-30T00:00:00.000Z',
        recovery_mode: 'verified_post_submit_conversation',
      },
    },
  });

  const recovered = await loadRun({ root, runId: run.runId });

  assert.equal(recovered.manifest.status, 'capture_pending');
  assert.equal(recovered.manifest.submission_attempt_count, 1);
  assert.equal(recovered.manifest.capture_context.chat_url, captureChatUrl);
  assert.equal(recovered.events.filter((event) => event.type === 'RunSubmitted').length, 1);
});

test('an uncertain submission preserves one-attempt evidence and capture context without claiming success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-submission-uncertain-'));
  const run = await preparedRun(root);
  await recordRunEvent({ root, runId: run.runId, type: 'RunStaged', data: { executor: 'playwright-mcp-extension' } });
  const uncertain = await recordRunEvent({
    root,
    runId: run.runId,
    type: 'RunSubmissionUncertain',
    data: {
      state: 'submission_uncertain',
      submission_attempt: 1,
      message: 'The click happened, but the submitted prompt was not visible yet.',
      capture_context: { chat_url: captureChatUrl, browser_tab_index: 0, network_request_count: 12 },
    },
  });

  assert.equal(uncertain.manifest.status, 'submission_uncertain');
  assert.equal(uncertain.manifest.submission_attempt_count, 1);
  assert.equal(uncertain.manifest.capture_context.chat_url, captureChatUrl);
  assert.equal(uncertain.events.filter((event) => event.type === 'RunSubmitted').length, 0);
});

test('result files are copied into the run and hashed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-workflow-'));
  const run = await preparedRun(root);
  const saved = await saveResultFiles({ root, runId: run.runId, files: [{ name: 'result.png', bytes: transparentPng }] });
  assert.equal(saved.manifest.results.length, 1);
  assert.equal(saved.manifest.status, 'artifacts_saved');
  const bytes = await readFile(saved.manifest.results[0].path);
  assert.deepEqual(bytes, transparentPng);
  assert.equal(saved.manifest.results[0].sha256.length, 64);
});

test('review policy uses exactly the three numeric gates while diagnostics remain non-gating', () => {
  assert.equal(evaluateReview(fullReview({ faceFidelity: 7.9 })).verdict, 'identity_rejected');
  assert.equal(evaluateReview(fullReview({ naturalness: 6.9 })).verdict, 'naturalness_revise');
  assert.equal(evaluateReview(fullReview({ style: 6.9 })).verdict, 'style_revise');
  const diagnosed = evaluateReview(fullReview({
    diagnosticCodes: ['emotion_unclear', 'elements_incoherent', 'subject_not_primary', 'client_use_case_mismatch'],
  }));
  assert.equal(diagnosed.verdict, 'qualified');
  assert.equal(diagnosed.preference_eligible, true);
  assert.equal(diagnosed.diagnostic_codes.length, 4);
  assert.throws(() => evaluateReview(fullReview({ visualHierarchy: 6.9 })), /retired score fields/i);
});

test('review stores three scores and structured diagnostics with a versioned rubric', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-workflow-'));
  const run = await preparedRun(root);
  await saveResultFiles({ root, runId: run.runId, files: [{ name: 'result.png', bytes: transparentPng }] });
  const reviewed = await saveReview({
    root,
    runId: run.runId,
    review: fullReview({ diagnosticCodes: ['subject_not_primary'], notes: 'Clear subject and coherent lighting.' }),
  });
  assert.equal(reviewed.manifest.latest_review.face_identity_fidelity, 8.8);
  assert.equal(reviewed.manifest.latest_review.realism_naturalness, 8.1);
  assert.equal(reviewed.manifest.latest_review.style_consistency, 8.3);
  assert.deepEqual(reviewed.manifest.latest_review.diagnostic_codes, ['subject_not_primary']);
  assert.equal(reviewed.manifest.latest_review.emotional_clarity, undefined);
  assert.equal(reviewed.manifest.latest_review.client_suitability, undefined);
  assert.equal(reviewed.manifest.latest_review.review_rubric_version, 'portrait-review-v3-three-score-diagnostics-20260816');
  assert.equal(reviewed.manifest.latest_review.verdict, 'qualified');
  await assert.rejects(() => saveReview({ root, runId: run.runId, review: fullReview({ faceFidelity: 8.88 }) }), /one decimal/i);
});

test('three repeated visual hierarchy diagnostics become shadow correction evidence without changing the next prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-workflow-'));
  for (let index = 0; index < 3; index += 1) {
    const run = await preparedRun(root, { customerName: `Customer ${index}` });
    await saveResultFiles({ root, runId: run.runId, files: [{ name: 'result.png', bytes: transparentPng }] });
    await saveReview({ root, runId: run.runId, review: fullReview({ diagnosticCodes: ['subject_not_primary'] }) });
  }
  const projection = await loadReviewGuidance({ root });
  assert.equal(projection.sample_count, 3);
  assert.equal(projection.shadow_corrections.some((item) => item.diagnostic_code === 'subject_not_primary'), true);
  assert.deepEqual(projection.active_guidance, []);

  const nextRun = await preparedRun(root, { customerName: 'Next Customer' });
  assert.equal(Array.isArray(nextRun.manifest.learning_guidance_snapshot.shadow_corrections), true);
  assert.equal(nextRun.manifest.learning_guidance_snapshot.shadow_corrections.some((item) => item.diagnostic_code === 'subject_not_primary'), true);
  assert.deepEqual(nextRun.manifest.learning_guidance_snapshot.active_guidance, []);
  assert.doesNotMatch(buildGenerationPrompt(nextRun), /人物必须是第一视觉中心/);
});

test('workbench maps the three scores and diagnostic evidence back into its artifact card', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /\['style', 'style_consistency'\]/);
  assert.match(app, /diagnosticCodesForDisplay/);
  assert.match(app, /data\.getAll\('diagnosticCodes'\)/);
  assert.doesNotMatch(app, /categoricalScoreFields/);
});
test('workbench exposes reference preflight, three scores, diagnostics, and pairwise comparison', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /name="identityAngles"/);
  assert.match(html, /name="targetAngle"/);
  assert.doesNotMatch(html, /name="templateAngle"/);
  assert.doesNotMatch(html, /name="templateFraming"/);
  assert.match(html, /name="businessDomain"/);
  assert.match(html, /name="intendedUse"/);
  for (const field of ['faceFidelity', 'naturalness', 'style']) {
    assert.match(html, new RegExp(`name="${field}"`));
  }
  assert.match(html, /name="diagnosticCodes"/);
  assert.match(html, /id="aestheticComparisonForm"/);
  assert.match(app, /saveAestheticComparison/);
});

test('workbench exposes prepare, stage, submit, capture, per-artifact review, and preference actions', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="stageRun"/);
  assert.match(html, /id="submitRun"/);
  assert.match(html, /id="captureRun"/);
  assert.match(html, /id="artifactImportForm"/);
  assert.match(html, /id="artifactGallery"/);
  assert.match(html, /id="preferenceForm"/);
  assert.doesNotMatch(html, /id="reviewForm"/);
  assert.match(app, /\/stage/);
  assert.match(app, /\/submit/);
  assert.match(app, /\/capture/);
  assert.match(app, /\/artifacts\/import/);
  assert.match(app, /\/artifacts\/\$\{artifactId\}\/review/);
  assert.match(app, /\/comparison/);
  assert.match(app, /\/preference/);
  assert.match(app, /window\.confirm/);
  assert.match(app, /confirmed:\s*true/);
  assert.match(app, /renderArtifacts/);
});

test('workbench exposes uncertain submissions as one-shot result-recovery state', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /submission_uncertain:\s*['"]发送状态待确认/);
  assert.match(app, /\['submitted',\s*'submission_uncertain'\]\.includes\(manifest\.status\)/);
  assert.match(app, /系统不会重复发送/);
});

test('first-page primary action is the single explicit save, upload, and send authorization', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="prepareRun"[^>]*>开始生成</);
  assert.match(html, /点击后通过 ChatGPT 网页版生成/);
  assert.match(html, /id="sendSummary"/);
  assert.match(html, /id="sendSummaryList"/);
  assert.match(html, /id="sendPromptPreviewDetails"/);
  assert.match(app, /async function stageAndSubmitRunOnce/);
  assert.match(app, /derivePrimaryAction/);
  assert.match(app, /buildSendSummary/);
  assert.match(app, /primaryActionBusy/);
  assert.match(app, /if\s*\(primaryActionBusy\)\s*return/);
  assert.match(app, /action\.createsRun/);
  assert.match(app, /runCreationIdempotencyKey/);
  assert.match(app, /pending-run-creation-idempotency-key/);
  assert.match(app, /await stageAndSubmitRunOnce\(currentRunId/);
  assert.match(app, /\/stage[\s\S]*confirmed:\s*true[\s\S]*\/submit[\s\S]*confirmed:\s*true/);
  const newRunFlow = app.slice(app.indexOf('const action = derivePrimaryAction({});'), app.indexOf("elements.stageRun.addEventListener"));
  assert.ok(newRunFlow.indexOf("api('/api/browser/probe'") < newRunFlow.indexOf("api('/api/runs'"));
  assert.match(newRunFlow, /stageAndSubmitRunOnce\(currentRunId,\s*\{\s*probeBrowserFirst:\s*false\s*\}\)/);
});

test('workbench integrates evidence-driven stage availability and blocks orphaned send recovery', async () => {
  const [html, app, css] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
  ]);
  assert.match(app, /deriveStageAvailability/);
  assert.match(app, /deriveSubmitRecoveryState/);
  assert.match(app, /orphaned_recovery_blocked/);
  assert.match(app, /formatRunIdentity/);
  for (const shortLabel of ['参考', '生成', '结果', '评审']) {
    assert.match(html, new RegExp(`data-short-label="${shortLabel}"`));
  }
  assert.match(css, /@media\s*\(max-width:\s*700px\)[\s\S]*?\.stage-navigation\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/is);
  assert.doesNotMatch(css, /@media\s*\(max-width:\s*700px\)[\s\S]*?\.stage-navigation\s*\{[^}]*overflow-x:\s*auto/is);
  assert.match(css, /@media\s*\(max-width:\s*700px\)[\s\S]*?\.stage-tab::after\{[^}]*content:attr\(data-short-label\)/is);
});

test('workbench can reopen a saved run from the URL without recreating it', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /parseRunLocation\(window\.location\.search\)/);
  assert.match(app, /history\.replaceState/);
  assert.match(app, /restoreRequestedRun\(\)/);
  assert.match(app, /refreshRun\(\)/);
});

test('short Run identity keeps an explicit accessible full-id copy action', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="copyRunId"[^>]+aria-label="复制完整 Run ID"/);
  assert.match(app, /navigator\.clipboard\.writeText\(currentRunId\)/);
  assert.match(app, /copyRunId\.hidden\s*=\s*false/);
  assert.match(app, /runId\.title\s*=\s*runIdentity\.title/);
});


test('workbench serves the distilled tutorial and screenshot examples as review guidance', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(html, /href="\/tutorial\/"/);
  assert.match(server, /tutorialRoot/);
  assert.match(server, /\/tutorial\//);
});
test('server exposes capture, manual artifact import, artifact review, and preference endpoints', async () => {
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /action === 'capture'/);
  assert.match(server, /action === 'preference'/);
  assert.match(server, /const importRoute/);
  assert.match(server, /const artifactRoute/);
  assert.match(server, /const artifactFileRoute/);
  assert.match(server, /const referenceFileRoute/);
  assert.match(server, /resolveRunReferenceFile/);
  assert.match(server, /captureRunArtifacts/);
  assert.match(server, /clientForCapture/);
  assert.match(server, /RunSubmissionUncertain/);
  assert.match(server, /beginRunSubmissionAttempt/);
  const submitRoute = server.slice(server.indexOf("action === 'submit'"), server.indexOf("action === 'capture'"));
  assert.ok(submitRoute.indexOf('hasStagedSession') < submitRoute.indexOf('beginRunSubmissionAttempt'));
  assert.ok(submitRoute.indexOf('beginRunSubmissionAttempt') < submitRoute.indexOf('executor.submitRun'));
  assert.match(submitRoute, /if \(result\.submissionAttempt\) captureAutomation\.start\(runId\)/);
  assert.match(server, /runCreationIdempotencyKey/);
  const stageRoute = server.slice(server.indexOf("action === 'stage'"), server.indexOf("action === 'submit'"));
  assert.match(stageRoute, /awaiting_submission_confirmation[\s\S]*run\.manifest\.status !== 'staged'[\s\S]*RunStaged/);
  assert.match(server, /run\.idempotent_replay \? 200 : 201/);
  assert.match(server, /templateSelectionTaskBrief/);
  assert.doesNotMatch(server, /Capture session is unavailable/);
  assert.match(server, /saveArtifactReview/);
  assert.match(server, /saveAestheticComparison/);
  assert.match(server, /savePreference/);
});

