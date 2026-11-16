import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRunSnapshot, listRuns, loadRun, recordRunEvent } from '../src/run-store.mjs';
import { buildCandidateSlateRequest } from '../src/intelligent-workbench/candidate-slate.mjs';
const captureModule = await import('../src/result-capture.mjs').catch(() => ({}));

const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const whitePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlAT8sAAAAASUVORK5CYII=', 'base64');
const twoByOnePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP8z8Dwn4GBgQEADQUCAOAHawIAAAAASUVORK5CYII=', 'base64');
const oneByOneJpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD57ooor+kTxz//2Q==', 'base64');

function sizedPng(width, height, byteLength, fill = 0) {
  const bytes = Buffer.alloc(Math.max(byteLength, transparentPng.length), fill);
  transparentPng.copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[bytes.length - 1] = fill;
  return bytes;
}

async function submittedRun(root, { candidateSlateRequest = null } = {}) {
  const run = await createRunSnapshot({
    root,
    customerName: 'Capture Customer',
    prompt: 'portrait',
    identityFiles: [{ name: 'identity.png', bytes: transparentPng }],
    templateFiles: [{ name: 'template.png', bytes: whitePng }],
    referencePlan: { identityAngles: ['frontal'], targetAngle: 'frontal', templateAngle: 'frontal', targetFraming: 'half_body', templateFraming: 'half_body' },
    customerContext: { businessDomain: 'consulting', intendedUse: 'profile' },
    candidateSlateRequest,
  });
  await recordRunEvent({
    root,
    runId: run.runId,
    type: 'RunSubmitted',
    data: { submission_attempt: 1, capture_context: { chat_url: 'https://chatgpt.com/c/test-run', network_request_count: 10 } },
  });
  return loadRun({ root, runId: run.runId });
}

test('v7 capture sources link verified artifacts to the immutable slate request without another submission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-v7-capture-lineage-'));
  const candidateSlateRequest = buildCandidateSlateRequest();
  const run = await submittedRun(root, { candidateSlateRequest });
  const adapter = {
    async capture() {
      return {
        state: 'ready',
        files: [
          { name: 'generated-a.png', bytes: transparentPng, source: { request_index: 11 } },
          { name: 'generated-b.png', bytes: whitePng, source: { request_index: 12 } },
        ],
      };
    },
  };
  const captured = await captureModule.captureRunArtifacts({ root, runId: run.runId, adapter, client: {} });
  assert.equal(captured.manifest.candidate_slate.status, 'complete');
  assert.equal(captured.manifest.artifacts.length, 2);
  assert.equal(captured.manifest.artifacts.every((artifact) => artifact.capture_source.slate_request_id === candidateSlateRequest.slate_request_id), true);
  assert.equal(captured.manifest.artifacts.every((artifact) => artifact.capture_source.requested_count === 2), true);
  assert.equal(captured.events.filter((event) => event.type === 'RunSubmitted').length, 1);
  const history = await listRuns({ root, artifactsOnly: true });
  assert.equal(history.some((item) => item.run_id === run.runId && item.artifact_count === 2), true);
});

test('capture service imports adapter results and never creates another submission event', async () => {
  assert.equal(typeof captureModule.captureRunArtifacts, 'function');
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-capture-service-'));
  const run = await submittedRun(root);
  const adapter = {
    async capture() {
      return {
        state: 'ready',
        captureContext: {
          chat_url: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',
          browser_tab_index: 1,
          network_request_count: 10,
        },
        files: [
          { name: 'generated-1.png', bytes: transparentPng, source: { request_index: 11 } },
          { name: 'generated-2.png', bytes: whitePng, source: { request_index: 12 } },
        ],
      };
    },
  };
  const captured = await captureModule.captureRunArtifacts({ root, runId: run.runId, adapter, client: {} });
  assert.equal(captured.manifest.artifacts.length, 2);
  assert.equal(captured.manifest.artifacts.every((item) => item.capture_method === 'mcp_network_response'), true);
  assert.equal(captured.manifest.capture.state, 'saved');
  assert.equal(captured.manifest.capture_context.browser_tab_index, 1);
  assert.equal(captured.events.filter((event) => event.type === 'RunSubmitted').length, 1);
  assert.equal(captured.events.filter((event) => event.type === 'CaptureContextUpdated').length, 1);
  assert.equal(captured.events.filter((event) => event.type === 'CaptureChecked').length, 1);
});

test('invalid automatic captures leave immutable evidence but are removed from the active artifact projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-capture-invalidation-'));
  const run = await submittedRun(root);
  const adapter = {
    async capture() {
      return { state: 'ready', files: [{ name: 'wrong.png', bytes: transparentPng, source: { request_index: 5 } }] };
    },
  };
  const captured = await captureModule.captureRunArtifacts({ root, runId: run.runId, adapter, client: {} });
  const wrongId = captured.manifest.artifacts[0].artifact_id;
  const corrected = await recordRunEvent({
    root,
    runId: run.runId,
    type: 'ArtifactCaptureInvalidated',
    data: { artifact_ids: [wrongId], reason: 'matched uploaded references instead of generated output' },
  });
  assert.equal(corrected.manifest.artifacts.length, 0);
  assert.equal(corrected.manifest.status, 'submitted');
  assert.equal(corrected.manifest.invalidated_artifacts.some((item) => item.artifact_id === wrongId), true);
  assert.equal(corrected.events.some((event) => event.type === 'ArtifactCaptureInvalidated'), true);

  const restored = await recordRunEvent({
    root,
    runId: run.runId,
    type: 'ArtifactCaptureRestored',
    data: { artifact_id: wrongId, reason: 'matched the visible generated image during review' },
  });
  assert.equal(restored.manifest.artifacts.length, 1);
  assert.equal(restored.manifest.artifacts[0].artifact_id, wrongId);
  assert.equal(restored.manifest.status, 'artifacts_saved');
  assert.equal(restored.manifest.restored_artifacts.some((item) => item.artifact_id === wrongId), true);
});

test('capture not ready records evidence without adding artifacts or retrying submission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-capture-not-ready-'));
  const run = await submittedRun(root);
  const adapter = { async capture() { return { state: 'capture_not_ready', message: 'No new generated images' }; } };
  const checked = await captureModule.captureRunArtifacts({ root, runId: run.runId, adapter, client: {} });
  assert.equal(checked.manifest.artifacts.length, 0);
  assert.equal(checked.manifest.capture.state, 'capture_not_ready');
  assert.equal(checked.manifest.submission_attempt_count, 1);
  assert.equal(checked.events.filter((event) => event.type === 'RunSubmitted').length, 1);
});

test('capture remains available after an uncertain one-click submission without creating another attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-capture-uncertain-'));
  const run = await createRunSnapshot({
    root,
    customerName: 'Uncertain Capture',
    prompt: 'portrait',
    identityFiles: [{ name: 'identity.png', bytes: transparentPng }],
    templateFiles: [{ name: 'template.png', bytes: whitePng }],
    referencePlan: { identityAngles: ['frontal'], targetAngle: 'frontal', targetFraming: 'half_body' },
    customerContext: { intendedUse: 'profile' },
  });
  await recordRunEvent({
    root,
    runId: run.runId,
    type: 'RunSubmissionUncertain',
    data: {
      state: 'submission_uncertain',
      submission_attempt: 1,
      capture_context: { chat_url: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555', network_request_count: 10 },
    },
  });
  const adapter = {
    async capture() {
      return { state: 'ready', files: [{ name: 'generated.png', bytes: twoByOnePng, source: { request_index: 11 } }] };
    },
  };

  const captured = await captureModule.captureRunArtifacts({ root, runId: run.runId, adapter, client: {} });

  assert.equal(captured.manifest.artifacts.length, 1);
  assert.equal(captured.manifest.submission_attempt_count, 1);
  assert.equal(captured.events.filter((event) => event.type === 'RunSubmitted').length, 0);
});

test('Playwright MCP capture adapter accepts only new requests from the recorded chat and validates saved bytes', async () => {
  assert.equal(typeof captureModule.ChatGptMcpResultCapture, 'function');
  const outputDir = await mkdtemp(join(tmpdir(), 'ai-img-gen-mcp-output-'));
  const generatedA = sizedPng(640, 800, 100_000, 1);
  const generatedB = sizedPng(640, 800, 100_000, 2);
  const calls = [];
  let targetSelected = false;
  const client = {
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'browser_tabs' && args.action === 'list') {
        return { text: targetSelected
          ? '- 0: [Workbench](http://127.0.0.1:4577/)\n- 1: (current) [Target](https://chatgpt.com/c/11111111-2222-3333-4444-555555555555)'
          : '- 0: (current) [Workbench](http://127.0.0.1:4577/)\n- 1: [Target](https://chatgpt.com/c/11111111-2222-3333-4444-555555555555)' };
      }
      if (name === 'browser_tabs' && args.action === 'select') { targetSelected = true; return { text: 'selected' }; }
      if (name === 'browser_snapshot') return { text: '- button [ref=e700]\n  - img "Generated image 1" [ref=e701]\n- button [ref=e710]\n  - img "Generated image 2" [ref=e711]' };
      if (name === 'browser_network_requests') return { text: '9. [GET] https://chatgpt.com/old.png => [200] OK\n11. [GET] https://chatgpt.com/backend-api/estuary/content/a => [200] OK\n12. [GET] https://chatgpt.com/backend-api/estuary/content/b => [200] OK' };
      if (name === 'browser_network_request') {
        const bytes = args.index === 11 ? generatedA : generatedB;
        await mkdir(outputDir, { recursive: true });
        await writeFile(args.filename, bytes);
        return { text: `Saved to ${args.filename}` };
      }
      throw new Error(`Unexpected tool ${name}`);
    },
  };
  const adapter = new captureModule.ChatGptMcpResultCapture({ outputDir });
  const result = await adapter.capture({
    client,
    run: { runId: 'run-test', manifest: { capture_context: { chat_url: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555', browser_tab_index: 1, network_request_count: 10 } } },
  });
  assert.equal(result.state, 'ready');
  assert.equal(result.files.length, 2);
  assert.deepEqual(result.files.map((item) => item.source.request_index), [11, 12]);
  assert.equal(calls.some((call) => call.name === 'browser_tabs' && call.args.action === 'select' && call.args.index === 1), true);
  assert.equal(calls.some((call) => call.name === 'browser_click'), false);
  assert.equal(calls.filter((call) => call.name === 'browser_network_request').every((call) => call.args.part === 'response-body'), true);
  assert.equal(calls.filter((call) => call.name === 'browser_network_request').every((call) => call.args.filename.startsWith(outputDir)), true);
  assert.equal(calls.some((call) => call.name === 'browser_run_code_unsafe'), false);
});

test('capture adapter creates its configured output directory before exporting a network response body', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ai-img-gen-mcp-missing-output-parent-'));
  const outputDir = join(parent, 'missing', 'playwright-mcp');
  const expectedUrl = 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
  const generated = sizedPng(512, 512, 100_000, 7);
  const client = {
    async callTool(name, args) {
      if (name === 'browser_tabs') return { text: `- 0: (current) [Expected](${expectedUrl})` };
      if (name === 'browser_snapshot') return { text: '- button [ref=e750]\n  - img "Generated image" [ref=e751]' };
      if (name === 'browser_network_requests') return { text: '11. [GET] https://chatgpt.com/backend-api/estuary/content/generated => [200] OK' };
      if (name === 'browser_network_request') {
        await writeFile(args.filename, generated);
        return { text: `Saved to ${args.filename}` };
      }
      throw new Error(`Unexpected tool ${name}`);
    },
  };

  const adapter = new captureModule.ChatGptMcpResultCapture({ outputDir });
  const result = await adapter.capture({
    client,
    run: { runId: 'run-missing-output', manifest: { capture_context: { chat_url: expectedUrl, browser_tab_index: 0, network_request_count: 10 }, identity_references: [], template_references: [] } },
  });

  assert.equal(result.state, 'ready');
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].source.request_index, 11);
});

test('capture adapter refuses a tiny generated-control thumbnail when no full-size result is available yet', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'ai-img-gen-mcp-tiny-thumbnail-'));
  const expectedUrl = 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
  const thumbnail = sizedPng(128, 128, 3_266, 8);
  const client = {
    async callTool(name, args) {
      if (name === 'browser_tabs') return { text: `- 0: (current) [Expected](${expectedUrl})` };
      if (name === 'browser_snapshot') return { text: '- button [ref=e760]\n  - img "Generated image" [ref=e761]' };
      if (name === 'browser_network_requests') return { text: '12. [GET] https://chatgpt.com/generated-thumbnail.png => [200] OK' };
      if (name === 'browser_network_request') {
        await writeFile(args.filename, thumbnail);
        return { text: `Saved to ${args.filename}` };
      }
      throw new Error(`Unexpected tool ${name}`);
    },
  };

  const adapter = new captureModule.ChatGptMcpResultCapture({ outputDir });
  const result = await adapter.capture({
    client,
    run: { runId: 'run-tiny-thumbnail', manifest: { capture_context: { chat_url: expectedUrl, browser_tab_index: 0, network_request_count: 10 }, identity_references: [], template_references: [] } },
  });

  assert.equal(result.state, 'capture_not_ready');
  assert.equal(result.files.length, 0);
  assert.match(result.message, /full-size|reference|原图|缩略图/i);
});

test('capture keeps verified full-size results when a later unrelated image response is invalid', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'ai-img-gen-mcp-partial-invalid-response-'));
  const expectedUrl = 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
  const generated = sizedPng(1122, 1402, 1_700_000, 11);
  const client = {
    async callTool(name, args) {
      if (name === 'browser_tabs') return { text: `- 0: (current) [Expected](${expectedUrl})` };
      if (name === 'browser_snapshot') return { text: '- button [ref=e770]\n  - img "Generated image" [ref=e771]' };
      if (name === 'browser_network_requests') {
        return { text: [
          '11. [GET] https://chatgpt.com/backend-api/estuary/content?id=file_generated => [200] OK',
          '12. [GET] https://chatgpt.com/generated-invalid.bin => [200] OK',
        ].join('\n') };
      }
      if (name === 'browser_network_request') {
        await writeFile(args.filename, args.index === 11 ? generated : Buffer.from('not an image'));
        return { text: `Saved to ${args.filename}` };
      }
      throw new Error(`Unexpected tool ${name}`);
    },
  };

  const adapter = new captureModule.ChatGptMcpResultCapture({ outputDir });
  const result = await adapter.capture({
    client,
    run: { runId: 'run-partial-invalid', manifest: { capture_context: { chat_url: expectedUrl, browser_tab_index: 0, network_request_count: 10 }, identity_references: [], template_references: [] } },
  });

  assert.equal(result.state, 'ready');
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].source.request_index, 11);
});

test('capture stops safely when the submission session has no requests newer than its recorded baseline', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'ai-img-gen-mcp-refresh-'));
  const expectedUrl = 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
  const calls = [];
  const client = {
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'browser_tabs') return { text: `- 0: (current) [Expected](${expectedUrl})` };
      if (name === 'browser_snapshot') return { text: '- button [ref=e800]\n  - img "Generated image" [ref=e801]' };
      if (name === 'browser_network_requests') return { text: '18. [GET] https://chatgpt.com/backend-api/estuary/content/uploaded => [200] OK' };
      throw new Error(`Unexpected tool ${name}`);
    },
  };
  const adapter = new captureModule.ChatGptMcpResultCapture({ outputDir });
  const result = await adapter.capture({
    client,
    run: { runId: 'run-refresh', manifest: { capture_context: { chat_url: expectedUrl, browser_tab_index: 0, network_request_count: 18 } } },
  });
  assert.equal(result.state, 'capture_not_ready');
  assert.equal(result.files.length, 0);
  assert.equal(calls.filter((call) => call.name === 'browser_click').length, 0);
  assert.equal(calls.filter((call) => call.name === 'browser_navigate').length, 0);
  assert.equal(calls.filter((call) => call.name === 'browser_network_requests').length, 2);
});

test('capture reopens the exact stored conversation when the submitted tab was closed', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'ai-img-gen-mcp-reopen-'));
  const expectedUrl = 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
  const generated = sizedPng(640, 800, 100_000, 3);
  const calls = [];
  let reopened = false;
  const client = {
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'browser_tabs' && args.action === 'list') {
        return { text: reopened
          ? `- 0: [Workbench](http://127.0.0.1:4577/)\n- 1: (current) [Recovered](${expectedUrl})`
          : '- 0: (current) [Workbench](http://127.0.0.1:4577/)' };
      }
      if (name === 'browser_tabs' && args.action === 'new') { reopened = true; return { text: 'opened' }; }
      if (name === 'browser_wait_for') return { text: 'waited' };
      if (name === 'browser_snapshot') return { text: '- button [ref=e900]\n  - img "Generated image" [ref=e901]' };
      if (name === 'browser_network_requests') {
        return { text: reopened
          ? '5. [GET] https://chatgpt.com/old => [200] OK\n6. [GET] https://chatgpt.com/backend-api/estuary/content/generated => [200] OK'
          : '5. [GET] https://chatgpt.com/old => [200] OK' };
      }
      if (name === 'browser_network_request') {
        await writeFile(args.filename, generated);
        return { text: `Saved to ${args.filename}` };
      }
      throw new Error(`Unexpected tool ${name}`);
    },
  };
  const adapter = new captureModule.ChatGptMcpResultCapture({ outputDir });
  const result = await adapter.capture({
    client,
    run: { runId: 'run-reopen', manifest: { capture_context: { chat_url: expectedUrl, browser_tab_index: 9, network_request_count: 452 } } },
  });

  assert.equal(result.state, 'ready');
  assert.equal(result.files.length, 1);
  assert.equal(result.captureContext.chat_url, expectedUrl);
  assert.equal(result.captureContext.browser_tab_index, 1);
  assert.equal(result.captureContext.network_request_count, 0);
  assert.equal(result.captureContext.recovery_mode, 'reopened_conversation');
  assert.match(result.captureContext.recovered_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(calls.filter((call) => call.name === 'browser_tabs' && call.args.action === 'new').length, 1);
  assert.deepEqual(calls.find((call) => call.name === 'browser_tabs' && call.args.action === 'new').args, { action: 'new', url: expectedUrl });
  assert.equal(calls.some((call) => call.name === 'browser_click' || call.name === 'browser_type'), false);
});

test('capture replaces a stale submission baseline after MCP restart', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'ai-img-gen-mcp-stale-baseline-'));
  const expectedUrl = 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
  const generated = sizedPng(640, 800, 100_000, 4);
  const calls = [];
  let reopened = false;
  const client = {
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'browser_tabs' && args.action === 'list') {
        return { text: reopened
          ? `- 0: [Old](${expectedUrl})\n- 1: (current) [Recovered](${expectedUrl})`
          : `- 0: (current) [Old](${expectedUrl})` };
      }
      if (name === 'browser_tabs' && args.action === 'new') { reopened = true; return { text: 'opened' }; }
      if (name === 'browser_wait_for') return { text: 'waited' };
      if (name === 'browser_snapshot') return { text: '- button [ref=e920]\n  - img "Generated image" [ref=e921]' };
      if (name === 'browser_network_requests') {
        return { text: reopened
          ? '20. [GET] https://chatgpt.com/old => [200] OK\n21. [GET] https://chatgpt.com/backend-api/estuary/content/generated => [200] OK'
          : '20. [GET] https://chatgpt.com/old => [200] OK' };
      }
      if (name === 'browser_network_request') {
        await writeFile(args.filename, generated);
        return { text: `Saved to ${args.filename}` };
      }
      throw new Error(`Unexpected tool ${name}`);
    },
  };
  const adapter = new captureModule.ChatGptMcpResultCapture({ outputDir });
  const result = await adapter.capture({
    client,
    run: { runId: 'run-stale', manifest: { capture_context: { chat_url: expectedUrl, browser_tab_index: 0, network_request_count: 452 } } },
  });

  assert.equal(result.state, 'ready');
  assert.equal(result.captureContext.network_request_count, 0);
  assert.equal(result.captureContext.recovery_mode, 'reopened_conversation');
  assert.equal(calls.filter((call) => call.name === 'browser_tabs' && call.args.action === 'new').length, 1);
});

test('capture opens at most one recovery tab and reports an inaccessible conversation without submitting', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'ai-img-gen-mcp-inaccessible-'));
  const expectedUrl = 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
  const calls = [];
  const client = {
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'browser_tabs' && args.action === 'list') return { text: '- 0: (current) [ChatGPT](https://chatgpt.com/)' };
      if (name === 'browser_tabs' && args.action === 'new') return { text: 'opened' };
      if (name === 'browser_wait_for') return { text: 'waited' };
      if (name === 'browser_network_requests') return { text: '3. [GET] https://chatgpt.com/ => [200] OK' };
      throw new Error(`Unexpected tool ${name}`);
    },
  };
  const adapter = new captureModule.ChatGptMcpResultCapture({ outputDir });
  const result = await adapter.capture({
    client,
    run: { runId: 'run-inaccessible', manifest: { capture_context: { chat_url: expectedUrl, network_request_count: 10 } } },
  });

  assert.equal(result.state, 'capture_reopen_failed');
  assert.match(result.message, /could not be reopened|无法重新打开/i);
  assert.equal(calls.filter((call) => call.name === 'browser_tabs' && call.args.action === 'new').length, 1);
  assert.equal(calls.some((call) => call.name === 'browser_click' || call.name === 'browser_type'), false);
});

test('reopened conversation that is still loading returns refreshed context for a later capture attempt', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'ai-img-gen-mcp-reopen-not-ready-'));
  const expectedUrl = 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
  const calls = [];
  let reopened = false;
  const client = {
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'browser_tabs' && args.action === 'list') {
        return { text: reopened ? `- 0: (current) [Recovered](${expectedUrl})` : '- 0: (current) [Workbench](http://127.0.0.1:4577/)' };
      }
      if (name === 'browser_tabs' && args.action === 'new') { reopened = true; return { text: 'opened' }; }
      if (name === 'browser_wait_for') return { text: 'waited' };
      if (name === 'browser_snapshot') return { text: '- heading "Generating"' };
      throw new Error(`Unexpected tool ${name}`);
    },
  };
  const adapter = new captureModule.ChatGptMcpResultCapture({ outputDir });
  const result = await adapter.capture({
    client,
    run: { runId: 'run-reopen-not-ready', manifest: { capture_context: { chat_url: expectedUrl, browser_tab_index: 9, network_request_count: 400 } } },
  });

  assert.equal(result.state, 'capture_not_ready');
  assert.match(result.message, /reopened|重新打开/i);
  assert.equal(result.captureContext.browser_tab_index, 0);
  assert.equal(result.captureContext.network_request_count, 0);
  assert.equal(result.captureContext.recovery_mode, 'reopened_conversation');
  assert.equal(calls.filter((call) => call.name === 'browser_snapshot').length, 2);
  assert.equal(calls.filter((call) => call.name === 'browser_tabs' && call.args.action === 'new').length, 1);
});

test('reopened URL that resolves to an inaccessible ChatGPT workspace is not mistaken for a generated image page', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'ai-img-gen-mcp-workspace-mismatch-'));
  const expectedUrl = 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
  let reopened = false;
  const client = {
    async callTool(name, args) {
      if (name === 'browser_tabs' && args.action === 'list') {
        return { text: reopened ? `- 0: (current) [Recovered](${expectedUrl})` : '- 0: (current) [Workbench](http://127.0.0.1:4577/)' };
      }
      if (name === 'browser_tabs' && args.action === 'new') { reopened = true; return { text: 'opened' }; }
      if (name === 'browser_wait_for') return { text: 'waited' };
      if (name === 'browser_snapshot') {
        return { text: [
          '- img "Folder icon"',
          '- button "分享" [disabled]',
          '- textbox "与 ChatGPT 聊天" [disabled]',
          '- button "发送提示" [disabled]',
        ].join('\n') };
      }
      throw new Error(`Unexpected tool ${name}`);
    },
  };
  const adapter = new captureModule.ChatGptMcpResultCapture({ outputDir });
  const result = await adapter.capture({
    client,
    run: { runId: 'run-workspace-mismatch', manifest: { capture_context: { chat_url: expectedUrl, network_request_count: 400 } } },
  });

  assert.equal(result.state, 'capture_access_mismatch');
  assert.match(result.message, /工作区|登录|access/i);
  assert.equal(result.files.length, 0);
  assert.equal(result.captureContext.recovery_mode, 'reopened_conversation');
});

test('capture service appends refreshed recovery context without another submission when recovery is not ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-capture-recovery-context-'));
  const run = await submittedRun(root);
  const recoveredContext = {
    chat_url: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',
    browser_tab_index: 2,
    network_request_count: 0,
    recovery_mode: 'reopened_conversation',
    recovered_at: new Date().toISOString(),
  };
  const adapter = {
    async capture() {
      return { state: 'capture_not_ready', message: 'Conversation reopened; result not ready', files: [], captureContext: recoveredContext };
    },
  };
  const checked = await captureModule.captureRunArtifacts({ root, runId: run.runId, adapter, client: {} });

  assert.equal(checked.manifest.capture.state, 'capture_not_ready');
  assert.equal(checked.manifest.capture_context.browser_tab_index, 2);
  assert.equal(checked.manifest.capture_context.network_request_count, 0);
  assert.equal(checked.manifest.capture_context.recovery_mode, 'reopened_conversation');
  assert.equal(checked.events.filter((event) => event.type === 'RunSubmitted').length, 1);
  assert.equal(checked.events.filter((event) => event.type === 'CaptureContextUpdated').length, 1);
  assert.equal(checked.events.filter((event) => event.type === 'CaptureChecked').length, 1);
});

test('capture deduplicates response bodies before enforcing the four-result limit', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'ai-img-gen-mcp-dedup-'));
  const expectedUrl = 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
  const generatedPng = sizedPng(640, 800, 100_000, 5);
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const bodies = new Map([[1, transparentPng], [2, whitePng], [3, generatedPng], [4, generatedPng]]);
  const client = {
    async callTool(name, args) {
      if (name === 'browser_tabs') return { text: `- 0: (current) [Expected](${expectedUrl})` };
      if (name === 'browser_snapshot') return { text: '- button [ref=e900]\n  - img "Generated image" [ref=e901]' };
      if (name === 'browser_network_requests') {
        return { text: [...bodies.keys()].map((index) => `${index}. [GET] https://chatgpt.com/backend-api/estuary/content?id=${index} => [200] OK`).join('\n') };
      }
      if (name === 'browser_network_request') {
        await writeFile(args.filename, bodies.get(args.index));
        return { text: `Saved to ${args.filename}` };
      }
      throw new Error(`Unexpected tool ${name}`);
    },
  };
  const adapter = new captureModule.ChatGptMcpResultCapture({ outputDir });
  const result = await adapter.capture({
    client,
    run: {
      runId: 'run-dedup',
      manifest: {
        identity_references: [{ sha256: digest(transparentPng) }],
        template_references: [{ sha256: digest(whitePng) }],
        capture_context: { chat_url: expectedUrl, browser_tab_index: 0, network_request_count: 2 },
      },
    },
  });
  assert.equal(result.state, 'ready');
  assert.equal(result.files.length, 1);
  assert.equal(digest(result.files[0].bytes), digest(generatedPng));
});

test('capture excludes a re-encoded identity reference with the same image role metadata before choosing generated output', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'ai-img-gen-mcp-role-filter-'));
  const expectedUrl = 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
  const identity = sizedPng(512, 512, 100_000, 6);
  const reencodedIdentity = sizedPng(512, 512, 100_000, 7);
  const generated = sizedPng(640, 800, 110_000, 8);
  const identityPath = join(outputDir, 'identity.png');
  await writeFile(identityPath, identity);
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const bodies = new Map([[1, generated], [2, reencodedIdentity]]);
  const client = {
    async callTool(name, args) {
      if (name === 'browser_tabs') return { text: `- 0: (current) [Expected](${expectedUrl})` };
      if (name === 'browser_snapshot') return { text: '- button [ref=e930]\n  - img "Generated image" [ref=e931]' };
      if (name === 'browser_network_requests') {
        return { text: [...bodies.keys()].map((index) => `${index}. [GET] https://chatgpt.com/backend-api/estuary/content?id=${index} => [200] OK`).join('\n') };
      }
      if (name === 'browser_network_request') {
        await writeFile(args.filename, bodies.get(args.index));
        return { text: `Saved to ${args.filename}` };
      }
      throw new Error(`Unexpected tool ${name}`);
    },
  };
  const adapter = new captureModule.ChatGptMcpResultCapture({ outputDir });
  const result = await adapter.capture({
    client,
    run: {
      runId: 'run-role-filter',
      manifest: {
        identity_references: [{ path: identityPath, sha256: digest(identity) }],
        template_references: [],
        capture_context: { chat_url: expectedUrl, browser_tab_index: 0, network_request_count: 0 },
      },
    },
  });

  assert.equal(result.state, 'ready');
  assert.equal(result.files.length, 1);
  assert.equal(digest(result.files[0].bytes), digest(generated));
  assert.equal(result.files[0].source.request_index, 1);
});

test('capture excludes a re-fetched uploaded reference by stable ChatGPT asset id before downloading outputs', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'ai-img-gen-mcp-reference-asset-id-'));
  const expectedUrl = 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
  const generated = sizedPng(1122, 1402, 1_700_000, 10);
  const calls = [];
  const client = {
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'browser_tabs') return { text: `- 0: (current) [Expected](${expectedUrl})` };
      if (name === 'browser_snapshot') return { text: '- button [ref=e950]\n  - img "Generated image" [ref=e951]' };
      if (name === 'browser_network_requests') {
        return { text: [
          '11. [GET] https://chatgpt.com/backend-api/estuary/content?id=file_uploaded_identity&sig=changed => [200] OK',
          '12. [GET] https://chatgpt.com/backend-api/estuary/content?id=file_generated_output&sig=new => [200] OK',
        ].join('\n') };
      }
      if (name === 'browser_network_request') {
        await writeFile(args.filename, generated);
        return { text: `Saved to ${args.filename}` };
      }
      throw new Error(`Unexpected tool ${name}`);
    },
  };

  const adapter = new captureModule.ChatGptMcpResultCapture({ outputDir });
  const result = await adapter.capture({
    client,
    run: {
      runId: 'run-reference-asset-id',
      manifest: {
        capture_context: {
          chat_url: expectedUrl,
          browser_tab_index: 0,
          network_request_count: 10,
          reference_asset_ids: ['file_uploaded_identity'],
        },
        identity_references: [],
        template_references: [],
      },
    },
  });

  assert.equal(result.state, 'ready');
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].source.request_index, 12);
  assert.deepEqual(calls.filter((call) => call.name === 'browser_network_request').map((call) => call.args.index), [12]);
});

test('capture keeps the only full-size generated response when it shares identity dimensions and ignores tiny UI images', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'ai-img-gen-mcp-same-dimensions-'));
  const expectedUrl = 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
  const identity = sizedPng(1122, 1402, 120_000, 1);
  const generated = sizedPng(1122, 1402, 1_700_000, 2);
  const thumbnail = sizedPng(128, 128, 3_266, 3);
  const icon = sizedPng(46, 48, 1_843, 4);
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const identityPath = join(outputDir, 'identity.png');
  await writeFile(identityPath, identity);
  const bodies = new Map([[1, thumbnail], [2, generated], [3, icon]]);
  const client = {
    async callTool(name, args) {
      if (name === 'browser_tabs') return { text: `- 0: (current) [Expected](${expectedUrl})` };
      if (name === 'browser_snapshot') return { text: '- button [ref=e940]\n  - img "Generated image" [ref=e941]' };
      if (name === 'browser_network_requests') {
        return { text: [...bodies.keys()].map((index) => `${index}. [GET] https://chatgpt.com/backend-api/estuary/content?id=${index} => [200] OK`).join('\n') };
      }
      if (name === 'browser_network_request') {
        await writeFile(args.filename, bodies.get(args.index));
        return { text: `Saved to ${args.filename}` };
      }
      throw new Error(`Unexpected tool ${name}`);
    },
  };

  const adapter = new captureModule.ChatGptMcpResultCapture({ outputDir });
  const result = await adapter.capture({
    client,
    run: {
      runId: 'run-same-dimensions',
      manifest: {
        identity_references: [{ path: identityPath, sha256: digest(identity) }],
        template_references: [],
        capture_context: { chat_url: expectedUrl, browser_tab_index: 0, network_request_count: 0 },
      },
    },
  });

  assert.equal(result.state, 'ready');
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].source.request_index, 2);
  assert.equal(digest(result.files[0].bytes), digest(generated));
});

test('Playwright MCP capture adapter recovers from a different chat, rejects invalid identity, and refuses binary placeholders', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'ai-img-gen-mcp-invalid-'));
  const expectedUrl = 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555';
  const otherUrl = 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const mismatchCalls = [];
  const mismatchClient = {
    async callTool(name, args) {
      mismatchCalls.push({ name, args });
      if (name === 'browser_tabs' && args.action === 'list') return { text: `- 0: (current) [Other](${otherUrl})` };
      if (name === 'browser_tabs' && args.action === 'new') return { text: 'opened' };
      if (name === 'browser_wait_for') return { text: 'waited' };
      throw new Error(`Unexpected tool ${name}`);
    },
  };
  const adapter = new captureModule.ChatGptMcpResultCapture({ outputDir });
  const mismatch = await adapter.capture({
    client: mismatchClient,
    run: { runId: 'run-test', manifest: { capture_context: { chat_url: expectedUrl, network_request_count: 0 } } },
  });
  assert.equal(mismatch.state, 'capture_reopen_failed');
  assert.equal(mismatchCalls.filter((call) => call.name === 'browser_tabs' && call.args.action === 'new').length, 1);
  assert.equal(mismatchCalls.some((call) => call.name === 'browser_click' || call.name === 'browser_type'), false);

  const invalidContextCalls = [];
  const invalidContextClient = {
    async callTool(name) {
      invalidContextCalls.push(name);
      if (name === 'browser_tabs') return { text: `- 0: (current) [Other](${otherUrl})` };
      throw new Error('An invalid recorded conversation URL must stop before reading the page');
    },
  };
  const invalidContext = await adapter.capture({
    client: invalidContextClient,
    run: { runId: 'run-test', manifest: { capture_context: { chat_url: 'https://chatgpt.com/c/WEB', browser_tab_index: 0, network_request_count: 0 } } },
  });
  assert.equal(invalidContext.state, 'capture_context_mismatch');
  assert.deepEqual(invalidContextCalls, []);

  const placeholderClient = {
    async callTool(name, args) {
      if (name === 'browser_tabs') return { text: `- 0: (current) [Expected](${expectedUrl})` };
      if (name === 'browser_snapshot') return { text: '- button [ref=e990]\n  - img "Generated image" [ref=e991]' };
      if (name === 'browser_network_requests') return { text: '1. [GET] https://chatgpt.com/backend-api/estuary/content/a => [200] OK' };
      if (name === 'browser_network_request') {
        await writeFile(args.filename, Buffer.from('<binary body omitted>'));
        return { text: 'binary placeholder' };
      }
      throw new Error(`Unexpected tool ${name}`);
    },
  };
  const placeholder = await adapter.capture({
    client: placeholderClient,
    run: { runId: 'run-test', manifest: { capture_context: { chat_url: expectedUrl, network_request_count: 0 } } },
  });
  assert.equal(placeholder.state, 'capture_unverified');
  assert.equal(placeholder.files.length, 0);
});
