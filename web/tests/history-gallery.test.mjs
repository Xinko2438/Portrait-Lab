import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as runStore from '../src/run-store.mjs';
import { wrappedPreviewIndex } from '../public/media-preview-state.js';

const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const whitePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlAT8sAAAAASUVORK5CYII=', 'base64');

const prompt = 'Historical portrait prompt';
const historicalInput = {
  customerName: 'History Customer',
  prompt,
  identityFiles: [{ name: 'identity.png', bytes: transparentPng }],
  templateFiles: [{ name: 'template.png', bytes: whitePng }],
  resultFiles: [{ name: 'result.png', bytes: transparentPng }],
  referencePlan: { identityAngles: ['frontal'], targetAngle: 'frontal', targetFraming: 'half_body' },
  customerContext: { intendedUse: 'historical portrait record' },
  source: { batch_label: 'history-fixture' },
};

test('preview navigation wraps in both directions', () => {
  assert.equal(wrappedPreviewIndex(0, -1, 3), 2);
  assert.equal(wrappedPreviewIndex(2, 1, 3), 0);
  assert.equal(wrappedPreviewIndex(1, 1, 3), 2);
  assert.equal(wrappedPreviewIndex(0, 1, 0), 0);
});

test('historical import creates one reviewable Run without any GPT submission', async () => {
  assert.equal(typeof runStore.createHistoricalRun, 'function');
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-history-'));
  const imported = await runStore.createHistoricalRun({ root, ...historicalInput });
  const loaded = await runStore.loadRun({ root, runId: imported.runId });

  assert.equal(loaded.manifest.customer_name, historicalInput.customerName);
  assert.equal(loaded.manifest.artifacts.length, 1);
  assert.equal(loaded.manifest.history_import.batch_label, 'history-fixture');
  assert.equal(loaded.events.at(-1).type, 'HistoricalRunImported');
  assert.equal(loaded.manifest.submission_attempt_count, 0);
  assert.equal(loaded.events.some((event) => ['RunStaged', 'RunSubmitted', 'CaptureChecked'].includes(event.type)), false);
  assert.deepEqual(await readFile(loaded.manifest.artifacts[0].path), transparentPng);
});

test('history projection includes only artifact-bearing non-verification Runs by default', async () => {
  assert.equal(typeof runStore.listRuns, 'function');
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-history-list-'));
  const included = await runStore.createHistoricalRun({ root, ...historicalInput });
  const excluded = await runStore.createHistoricalRun({ root, ...historicalInput, source: { batch_label: 'excluded-fixture' } });
  await runStore.recordRunEvent({ root, runId: excluded.runId, type: 'RunExcludedFromLearning', data: { reason: 'test' } });
  await runStore.createRunSnapshot({ root, ...historicalInput, resultFiles: undefined });

  const history = await runStore.listRuns({ root });
  assert.deepEqual(history.map((item) => item.run_id), [included.runId]);
  assert.equal(history[0].artifact_count, 1);
  assert.equal(history[0].identity_count, 1);
  assert.equal(history[0].template_count, 1);
  assert.equal(history[0].prompt, prompt);
  assert.equal('path' in history[0], false);
  assert.equal('customer_id' in history[0], true);
  assert.equal(history[0].run_kind, 'generation');
  assert.equal('parent_run_id' in history[0], true);
  assert.equal('parent_artifact_id' in history[0], true);
  assert.equal('preference' in history[0], true);
  assert.equal(history[0].template_learning.state, 'not_applicable');
  assert.equal(history[0].template_learning.reason, 'manual_template');
  assert.equal('preference_eligible' in history[0].artifacts[0], true);
  assert.equal('is_winner' in history[0].artifacts[0], true);
  assert.equal('comparison_state' in history[0].artifacts[0], true);
});

test('server exposes history list and one-action import routes without filesystem-path input', async () => {
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /req\.method === 'GET' && url\.pathname === '\/api\/runs'/);
  assert.match(server, /req\.method === 'POST' && url\.pathname === '\/api\/history\/import'/);
  assert.match(server, /createHistoricalRun/);
  assert.doesNotMatch(server, /form\.get\(['"](?:path|sourcePath|folderPath)['"]\)/);
  const historyRoute = server.slice(
    server.indexOf("req.method === 'POST' && url.pathname === '/api/history/import'"),
    server.indexOf("req.method === 'POST' && url.pathname === '/api/runs'"),
  );
  assert.doesNotMatch(historyRoute, /publicRun/);
  assert.match(historyRoute, /identity_count/);
  assert.match(historyRoute, /template_count/);
});

test('confirmed discard physically removes only the selected saved Run', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-result-discard-'));
  const { rm } = await import('node:fs/promises');
  t.after(() => rm(root, { recursive: true, force: true }));
  const discarded = await runStore.createHistoricalRun({ root, ...historicalInput });
  const retained = await runStore.createHistoricalRun({ root, ...historicalInput });
  const settings = { root, runId: discarded.runId };
  await assert.rejects(() => runStore.discardSavedRun(settings), { status: 409 });
  assert.equal((await runStore.listRuns({ root })).length, 2);
  const discardedFile = discarded.manifest.artifacts[0].path;
  await Promise.all([true, true].map(confirmed => runStore.discardSavedRun({ ...settings, confirmed })));
  await assert.rejects(readFile(discardedFile), { code: 'ENOENT' });
  await assert.rejects(runStore.loadRun(settings), { code: 'ENOENT' });
  assert.deepEqual((await runStore.listRuns({ root })).map(run => run.run_id), [retained.runId]);
  assert.deepEqual(await readFile(retained.manifest.artifacts[0].path), transparentPng);
});

test('workbench keeps reference preview and history import inside the current page', async () => {
  const [html, app, css] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
  ]);
  for (const id of ['mediaPreviewDialog', 'mediaPreviewImage', 'previewPrevious', 'previewNext', 'historyDialog', 'historyList', 'historyImportForm']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /ArrowLeft/);
  assert.match(app, /ArrowRight/);
  assert.match(app, /preloadAdjacentPreview/);
  assert.match(app, /\/api\/history\/import/);
  assert.doesNotMatch(app, /review-reference-thumb[^\n]+target="_blank"/);
  assert.match(css, /\.media-preview-dialog/);
  assert.match(css, /\.history-dialog/);
});

test('history dialog presents one full-width library and switches import as a preserved workspace state', async () => {
  const [html, app, css] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
  ]);

  for (const id of ['historySearch', 'historyCustomerFilter', 'historyStatusFilter', 'historySort', 'openHistoryImport', 'historyLibraryView', 'historyImportView']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const view of ['pending', 'final', 'qualified', 'all']) {
    assert.match(html, new RegExp(`data-work-library-view="${view}"`));
  }
  assert.match(html, /id="historyImportView"[^>]*hidden/);
  assert.match(app, /createHistoryWorkspaceState/);
  assert.match(app, /filterAndSortHistoryRuns/);
  assert.match(app, /historyCustomerOptions/);
  assert.match(app, /transitionHistoryWorkspace/);
  assert.match(app, /buildWorkLibrary/);
  assert.match(app, /deriveWorkLibraryMetrics/);
  assert.match(app, /work-library-state\.js/);
  assert.match(css, /\.history-filters/);
  assert.match(css, /\.history-content\s*\{[^}]*display:\s*block/is);
  assert.match(css, /\.history-prompt-summary/);
  assert.match(css, /\.work-library-view-tabs/);
  assert.match(css, /\.work-library-customer-group/);
  assert.match(css, /@media\s*\(max-width:\s*900px\)[\s\S]*?\.history-filters/is);
  assert.match(css, /@media\s*\(max-width:\s*560px\)\{\.compounding-summary\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/is);
});
