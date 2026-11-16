import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import * as runStore from '../src/run-store.mjs';
import { ChatGptExecutor } from '../src/chatgpt-executor.mjs';
import * as resultCapture from '../src/result-capture.mjs';

const revisionStore = await import('../src/artifact-revision-store.mjs').catch(() => ({}));

const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const whitePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlAT8sAAAAASUVORK5CYII=', 'base64');
const parentChatUrl = 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function treeHash(root) {
  async function filesBelow(path) {
    const entries = await readdir(path, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const candidate = join(path, entry.name);
      return entry.isDirectory() ? filesBelow(candidate) : [candidate];
    }));
    return nested.flat();
  }
  const files = (await filesBelow(root)).sort((a, b) => a.localeCompare(b));
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(relative(root, file).replaceAll('\\', '/'));
    digest.update(await readFile(file));
  }
  return digest.digest('hex');
}

function annotationPayload() {
  return {
    editor_version: 'artifact-annotation-editor-v1',
    fabric_version: '7.4.0',
    canvas: { width: 1, height: 1 },
    overall_note: 'Keep the person and all unmarked areas unchanged.',
    state: { version: '7.4.0', objects: [{ type: 'rect', left: 0, top: 0, width: 1, height: 1 }] },
    annotations: [{
      annotation_id: 'mark-background-1',
      type: 'rectangle',
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      reason_code: 'background',
      note: 'Make the marked background a little brighter and cleaner.',
    }],
  };
}

async function preparedParent(root, { withAnnotation = true, chatUrl = parentChatUrl } = {}) {
  let run = await runStore.createRunSnapshot({
    root,
    customerName: 'Non-customer acceptance fixture',
    prompt: 'Create a dark studio portrait.',
    identityFiles: [{ name: 'identity.png', bytes: transparentPng }],
    templateFiles: [{ name: 'template.png', bytes: whitePng }],
    referencePlan: { identityAngles: ['frontal'], targetAngle: 'frontal', targetFraming: 'half_body' },
    customerContext: { intendedUse: 'isolated acceptance' },
  });
  if (chatUrl) {
    run = await runStore.recordRunEvent({
      root,
      runId: run.runId,
      type: 'RunSubmitted',
      data: {
        submission_attempt: 1,
        capture_context: {
          chat_url: chatUrl,
          browser_tab_index: 0,
          network_request_count: 10,
          reference_asset_ids: ['parent-reference'],
          recorded_at: '2026-08-30T00:00:00.000Z',
        },
      },
    });
  }
  run = await runStore.importArtifacts({
    root,
    runId: run.runId,
    files: [{ name: 'parent-generated.png', bytes: transparentPng }],
    captureMethod: 'mcp_network_response',
  });
  const artifact = run.manifest.artifacts[0];
  if (withAnnotation) {
    run = await runStore.saveArtifactAnnotation({
      root,
      runId: run.runId,
      artifactId: artifact.artifact_id,
      payload: annotationPayload(),
      previewBytes: whitePng,
    });
  }
  return { run, artifact: run.manifest.artifacts[0] };
}

function requireRevisionFunction(name) {
  assert.equal(typeof revisionStore[name], 'function', `${name} must be implemented`);
  return revisionStore[name];
}

test('a saved annotation creates an immutable child Run with copied and hashed revision inputs', async () => {
  const createArtifactRevisionRun = requireRevisionFunction('createArtifactRevisionRun');
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-artifact-revision-'));
  const { run: parent, artifact } = await preparedParent(root);
  const parentHashBefore = await treeHash(parent.runDir);

  const child = await createArtifactRevisionRun({ root, parentRunId: parent.runId, parentArtifactId: artifact.artifact_id });

  assert.notEqual(child.runId, parent.runId);
  assert.equal(child.manifest.schema_version, 'ai-img-gen.artifact-revision-run.v1');
  assert.equal(child.manifest.run_kind, 'artifact_revision');
  assert.equal(child.manifest.parent_run_id, parent.runId);
  assert.equal(child.manifest.parent_artifact_id, artifact.artifact_id);
  assert.equal(child.manifest.revision_source.parent_chat_url, parentChatUrl);
  assert.equal(child.manifest.revision_source.parent_artifact_sha256, artifact.sha256);
  assert.equal(child.manifest.revision_source.annotation_count, 1);
  assert.equal(child.manifest.revision_request.requested_count, 1);
  assert.equal(child.manifest.revision_request.auto_retry, false);
  assert.equal(child.manifest.reference_preflight.policy_version, 'artifact-revision-preflight-v1');
  assert.equal(child.manifest.reference_preflight.state, 'passed');
  assert.deepEqual(child.events.map((event) => event.type), ['RunPrepared', 'ArtifactRevisionPrepared']);

  for (const key of ['original_path', 'annotation_state_path', 'annotated_preview_path']) {
    const path = child.manifest.revision_source[key];
    assert.equal(relative(resolve(child.runDir), resolve(path)).startsWith('..'), false);
  }
  assert.equal(sha256(await readFile(child.manifest.revision_source.original_path)), artifact.sha256);
  assert.equal(sha256(await readFile(child.manifest.revision_source.annotation_state_path)), child.manifest.revision_source.annotation_state_sha256);
  assert.equal(sha256(await readFile(child.manifest.revision_source.annotated_preview_path)), child.manifest.revision_source.annotated_preview_sha256);
  assert.equal(await treeHash(parent.runDir), parentHashBefore);
  assert.match(child.prompt, /第 1 张.*干净原图/s);
  assert.match(child.prompt, /第 2 张.*标记位置/s);
  assert.match(child.prompt, /不要.*标记/s);
  assert.match(child.prompt, /Make the marked background a little brighter and cleaner/);
});

test('revision preparation fails closed before child creation for missing annotation or conversation', async () => {
  const createArtifactRevisionRun = requireRevisionFunction('createArtifactRevisionRun');
  const missingAnnotationRoot = await mkdtemp(join(tmpdir(), 'ai-img-gen-revision-no-annotation-'));
  const missingAnnotation = await preparedParent(missingAnnotationRoot, { withAnnotation: false });
  await assert.rejects(() => createArtifactRevisionRun({
    root: missingAnnotationRoot,
    parentRunId: missingAnnotation.run.runId,
    parentArtifactId: missingAnnotation.artifact.artifact_id,
  }), /annotation/i);

  const missingChatRoot = await mkdtemp(join(tmpdir(), 'ai-img-gen-revision-no-chat-'));
  const missingChat = await preparedParent(missingChatRoot, { chatUrl: null });
  await assert.rejects(() => createArtifactRevisionRun({
    root: missingChatRoot,
    parentRunId: missingChat.run.runId,
    parentArtifactId: missingChat.artifact.artifact_id,
  }), /conversation|chat/i);
});

test('revision preparation rejects mismatched annotation projection lineage before copying inputs', async () => {
  const createArtifactRevisionRun = requireRevisionFunction('createArtifactRevisionRun');
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-revision-stale-annotation-'));
  const { run, artifact } = await preparedParent(root);
  const manifestPath = join(run.runDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.artifact_annotations[artifact.artifact_id].annotation_session_id = 'annotation-forged-projection';
  manifest.artifact_annotations[artifact.artifact_id].annotation_count = 2;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  await assert.rejects(() => createArtifactRevisionRun({
    root,
    parentRunId: run.runId,
    parentArtifactId: artifact.artifact_id,
  }), /annotation.*lineage|annotation.*metadata/i);
});

function fakeRevisionClient({ currentUrl = parentChatUrl } = {}) {
  const calls = [];
  let snapshotIndex = 0;
  let submitted = false;
  let typedPrompt = '';
  const stageSnapshots = [
    '- button "添加文件等" [active] [ref=e104]',
    '- generic [ref=e418] [cursor=pointer]:\n  - generic: 添加照片和文件\n  - generic: 从电脑上传',
  ];
  return {
    calls,
    async initialize() { calls.push({ name: 'initialize', args: {} }); },
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'browser_type' && String(args.text || '').trim()) typedPrompt = String(args.text);
      if (name === 'browser_press_key' && args.key === 'Enter' && typedPrompt) submitted = true;
      if (name === 'browser_tabs') return { text: `- 0: (current) [Original conversation](${currentUrl})` };
      if (name === 'browser_snapshot') {
        if (submitted) return { text: `- article:\n  - paragraph: ${typedPrompt}` };
        if (snapshotIndex < stageSnapshots.length) return { text: stageSnapshots[snapshotIndex++] };
        return { text: '- textbox "与 ChatGPT 聊天" [active] [ref=e49]\n- button "发送提示" [ref=e140] [cursor=pointer]' };
      }
      if (name === 'browser_network_requests') {
        return { text: submitted
          ? '20. [GET] https://chatgpt.com/backend-api/estuary/content?id=revision-source-one => [200] OK\n21. [GET] https://chatgpt.com/backend-api/estuary/content?id=revision-source-two => [200] OK'
          : '19. [GET] https://chatgpt.com/backend-api/conversation => [200] OK' };
      }
      return { text: 'ok' };
    },
  };
}

test('revision executor stages two files in the exact parent conversation and submits with one new Enter only', async () => {
  const createArtifactRevisionRun = requireRevisionFunction('createArtifactRevisionRun');
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-revision-executor-'));
  const { run: parent, artifact } = await preparedParent(root);
  const child = await createArtifactRevisionRun({ root, parentRunId: parent.runId, parentArtifactId: artifact.artifact_id });
  const client = fakeRevisionClient();
  const executor = new ChatGptExecutor({ clientFactory: () => client });

  const staged = await executor.stageRun({ run: child, confirmed: true });
  assert.equal(staged.state, 'awaiting_submission_confirmation');
  const upload = client.calls.find((call) => call.name === 'browser_file_upload');
  assert.deepEqual(upload?.args.paths, [
    child.manifest.revision_source.original_path,
    child.manifest.revision_source.annotated_preview_path,
  ]);
  const newTab = client.calls.find((call) => call.name === 'browser_tabs' && call.args.action === 'new');
  assert.equal(newTab?.args.url, parentChatUrl);
  const entersAfterStage = client.calls.filter((call) => call.name === 'browser_press_key' && call.args.key === 'Enter').length;

  const submitted = await executor.submitRun({ run: child, confirmed: true });
  const repeated = await executor.submitRun({ run: child, confirmed: true });
  assert.equal(submitted.state, 'submitted');
  assert.equal(submitted.submissionAttempt, 1);
  assert.equal(submitted.captureContext.chat_url, parentChatUrl);
  assert.equal(repeated.state, 'already_submitted');
  assert.equal(client.calls.filter((call) => call.name === 'browser_press_key' && call.args.key === 'Enter').length, entersAfterStage + 1);
});

test('revision staging refuses a redirected or different conversation before uploading', async () => {
  const createArtifactRevisionRun = requireRevisionFunction('createArtifactRevisionRun');
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-revision-wrong-chat-'));
  const { run: parent, artifact } = await preparedParent(root);
  const child = await createArtifactRevisionRun({ root, parentRunId: parent.runId, parentArtifactId: artifact.artifact_id });
  const client = fakeRevisionClient({ currentUrl: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  const executor = new ChatGptExecutor({ clientFactory: () => client });

  const result = await executor.stageRun({ run: child, confirmed: true });

  assert.notEqual(result.state, 'awaiting_submission_confirmation');
  assert.equal(client.calls.some((call) => call.name === 'browser_file_upload'), false);
  assert.equal(client.calls.some((call) => call.name === 'browser_type' && String(call.args.text || '').trim()), false);
});

test('capture exclusions include both revision source hashes', async () => {
  assert.equal(typeof resultCapture.excludedSourceHashes, 'function');
  const run = {
    manifest: {
      identity_references: [{ sha256: 'identity' }],
      template_references: [{ sha256: 'template' }],
      revision_source: { original_sha256: 'original', annotated_preview_sha256: 'preview' },
    },
  };
  assert.deepEqual([...resultCapture.excludedSourceHashes(run)].sort(), ['identity', 'original', 'preview', 'template']);
});

test('server and UI expose continuation while annotation save remains local-only', async () => {
  const [server, html, app, editor] = await Promise.all([
    readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/annotation-editor.js', import.meta.url), 'utf8'),
  ]);
  assert.match(server, /createArtifactRevisionRun/);
  assert.match(server, /artifacts.*revisions/);
  assert.match(server, /artifact_revision:\s*'ready'/);
  assert.match(html, /id="submitArtifactRevision"/);
  assert.match(html, />在原对话继续修改</);
  assert.match(editor, /onSubmitRevision/);
  assert.match(app, /artifacts.*revisions/);
  assert.match(app, /stageAndSubmitRunOnce\(child/);
  assert.match(app, /monitorAutomaticCapture\(child/);
  assert.match(app, /artifactRevisionCapability/);
  assert.match(app, /artifactRevisionCapability\s*===\s*'ready'\s*\?\s*createAndSubmitArtifactRevision\s*:\s*null/);
  const saveStart = editor.indexOf('async function saveAnnotation');
  const saveEnd = editor.indexOf('function requestClose', saveStart);
  const saveFunction = editor.slice(saveStart, saveEnd);
  assert.doesNotMatch(saveFunction, /\/revisions|\/stage|\/submit/);
});
