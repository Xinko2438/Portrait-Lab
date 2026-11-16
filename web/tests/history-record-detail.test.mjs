import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as runStore from '../src/run-store.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test('record edits append evidence and preserve the original prompt file', async () => {
  assert.equal(typeof runStore.updateRunRecord, 'function');
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-record-edit-'));
  const created = await runStore.createHistoricalRun({
    root,
    customerName: 'Original customer',
    prompt: 'Original prompt',
    identityFiles: [{ name: 'identity.png', bytes: png }],
    templateFiles: [{ name: 'template.png', bytes: png }],
    resultFiles: [{ name: 'result.png', bytes: png }],
    referencePlan: { identityAngles: ['frontal'], targetAngle: 'frontal', targetFraming: 'half_body' },
    customerContext: { intendedUse: 'Original use' },
    source: { batch_label: 'Original batch' },
  });
  const promptPath = join(created.runDir, 'prompt.txt');
  const originalPromptFile = await readFile(promptPath, 'utf8');

  await runStore.updateRunRecord({
    root,
    runId: created.runId,
    customerName: 'Updated customer',
    prompt: 'Updated prompt',
    batchLabel: 'Updated batch',
    intendedUse: 'Updated use',
  });
  const loaded = await runStore.loadRun({ root, runId: created.runId });
  const history = await runStore.listRuns({ root });

  assert.equal(await readFile(promptPath, 'utf8'), originalPromptFile);
  assert.equal(loaded.prompt, 'Updated prompt');
  assert.equal(loaded.manifest.customer_name, 'Updated customer');
  assert.equal(loaded.manifest.history_import.batch_label, 'Updated batch');
  assert.equal(loaded.manifest.customer_context.intended_use, 'Updated use');
  assert.equal(loaded.events.at(-1).type, 'RunRecordUpdated');
  assert.equal(loaded.events.at(-1).data.prompt_text, 'Updated prompt');
  assert.equal(loaded.manifest.submission_attempt_count, 0);
  assert.equal(history[0].prompt, 'Updated prompt');
});

test('server exposes a record-update action without any provider route', async () => {
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /updateRunRecord/);
  assert.match(server, /action === 'record'/);
  assert.match(server, /RunRecordUpdated/);
});

test('history opens record detail, marks pending work and restores it after Back', async () => {
  const [html, app, css] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
  ]);
  for (const id of ['historyRecordView', 'historyRecordForm', 'historyRecordMedia', 'historyHeaderAction', 'openRecordReview']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /id="historyRecordBack"/);
  assert.doesNotMatch(app, /data-open-history-run[^\n]*>进入评审</);
  assert.match(app, /history-record-trigger/);
  assert.match(app, /historyHeaderAction\.textContent\s*=\s*'返回'/);
  assert.match(app, /historyList\.addEventListener\('keydown'/);
  assert.doesNotMatch(app, /\?{4,}/);
  assert.match(app, /history\.pushState/);
  assert.match(app, /popstate/);
  assert.match(app, /sessionStorage/);
  assert.match(css, /\.history-run-card\.pending-review/);
  assert.match(css, /\.history-review-status\.pending/);
  assert.match(css, /\.history-progress-tag\.pending/);
  const pendingCardRule = css.match(/\.history-run-card\.pending-review\{([^}]*)\}/s)?.[1] || '';
  assert.doesNotMatch(pendingCardRule, /background|border-left/);
  assert.match(css, /\.history-run-card\s*\{[^}]*grid-template-columns:minmax\(280px,360px\) minmax\(0,1fr\)[^}]*grid-template-areas:"media copy"/s);
  assert.match(css, /\.history-run-copy\s*\{[^}]*grid-area:copy[^}]*border-left:1px solid var\(--line\)/s);
  assert.match(css, /\.history-run-title strong\s*\{[^}]*font-size:15px/s);
  assert.match(css, /\.history-run-meta span\s*\{[^}]*font-size:10px/s);
  assert.match(css, /\.history-prompt-summary\s*\{[^}]*font-size:11px/s);
  assert.match(css, /\.history-content\{display:block;overflow:auto\}\.history-library\{display:block;min-height:0\}/);
  assert.match(css, /\.media-preview-stage img\s*\{[^}]*position:absolute[^}]*height:calc\(100% - var\(--preview-pad-top\) - var\(--preview-pad-bottom\)\)/s);
});
