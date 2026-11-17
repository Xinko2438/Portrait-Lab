import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRunSnapshot } from '../src/run-store.mjs';
import { classifyBrowserProbe } from '../src/playwright-bridge.mjs';

test('createRunSnapshot requires identity images and prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-'));
  await assert.rejects(() => createRunSnapshot({ root, prompt: '', identityFiles: [], templateFiles: [] }), /prompt/i);
  await assert.rejects(() => createRunSnapshot({ root, prompt: 'portrait', identityFiles: [], templateFiles: [] }), /identity/i);
});

test('createRunSnapshot stores customer identity and template references separately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-'));
  const run = await createRunSnapshot({
    root,
    customerName: 'Test Customer',
    prompt: 'cinematic portrait',
    identityFiles: [{ name: 'face.png', bytes: Buffer.from('identity') }],
    templateFiles: [{ name: 'style.png', bytes: Buffer.from('template') }],
  });
  const manifest = JSON.parse(await readFile(run.manifestPath, 'utf8'));
  assert.equal(manifest.identity_references.length, 1);
  assert.equal(manifest.template_references.length, 1);
  assert.notEqual(manifest.identity_references[0].path, manifest.template_references[0].path);
  assert.equal(manifest.status, 'prepared');
});

test('browser probe reports missing official extension as a user action', () => {
  const result = classifyBrowserProbe('Error: Playwright Extension not found in Chrome User Data');
  assert.equal(result.state, 'extension_required');
  assert.equal(result.ready, false);
});

test('bridge connectivity does not claim full ChatGPT page readiness and unknown probe errors fail closed',()=>{
 assert.equal(classifyBrowserProbe('').state,'bridge_ready');
 assert.match(classifyBrowserProbe('').message,/编辑区.*核对/);
 assert.equal(classifyBrowserProbe('Protocol error: fixture').ready,false);
});
test('passive service status never creates a browser probe session', async () => {
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const statusStart = server.indexOf("url.pathname === '/api/status'");
  const nextRoute = server.indexOf("url.pathname === '/api/browser/probe'", statusStart);
  const statusRoute = server.slice(statusStart, nextRoute);
  assert.ok(statusStart >= 0);
  assert.doesNotMatch(statusRoute, /probeBrowser/);
  assert.match(server, /url\.pathname === '\/api\/health'/);
  assert.match(server, /url\.pathname === '\/api\/browser\/probe'/);

  const launcher = await readFile(new URL('../start-server.ps1', import.meta.url), 'utf8');
  assert.match(launcher, /\/api\/health/);
  assert.doesNotMatch(launcher, /\/api\/status/);
  assert.match(launcher, /AI_IMG_GEN_AI_PROMPT_WRITER_ENABLED\s*=\s*'true'/);
});

test('formal health exposes the AI prompt writer activation state', async () => {
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /ai_prompt_writer:\s*aiPromptWriter\s*\?\s*'ready'\s*:\s*'disabled'/);
});

test('browser connection check requires an explicit button action', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /async function loadStatus/);
  assert.match(app, /api\('\/api\/browser\/probe',\s*\{\s*method:\s*'POST'\s*\}\)/);
  assert.match(app, /loadStatus\(\);/);
  assert.match(app, /restoreRequestedRun\(\);/);
  assert.doesNotMatch(app, /checkBrowser\(\);\s*restoreRequestedRun\(\);/);
});

import { redactSecrets } from '../src/playwright-bridge.mjs';
test('redactSecrets removes extension tokens from browser output', () => {
  const input = 'chrome-extension://id/connect.html?client=x&token=super-secret-token-1234567890';
  const output = redactSecrets(input);
  assert.equal(output.includes('super-secret-token-1234567890'), false);
  assert.match(output, /token=\[redacted\]/);
});

import { buildMcpLaunch } from '../src/mcp-process.mjs';
test('buildMcpLaunch starts the pinned local MCP package without npx.cmd', () => {
  const launch = buildMcpLaunch({
    token: 'secret-token-value-1234567890',
    outputDir: 'D:/project/.runtime/playwright-mcp',
    workingDirectory: 'D:/project',
  });
  assert.equal(launch.command, process.execPath);
  assert.equal(launch.cwd, 'D:/project');
  assert.match(launch.args[0], /node_modules[\\/]@playwright[\\/]mcp[\\/]cli\.js$/i);
  assert.equal(launch.args.includes('secret-token-value-1234567890'), false);
  assert.equal(launch.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, 'secret-token-value-1234567890');
  assert.equal(launch.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS, '0');
  assert.equal(launch.env.PLAYWRIGHT_MCP_TIMEOUT_ACTION, '15000');
  assert.equal(launch.args.includes('--extension'), true);
  assert.equal(launch.args.includes('--background'), true);
  assert.equal(launch.args.includes('--no-tab-group'), true);
  assert.equal(launch.args.includes('--headless'), false);
});

test('Windows launcher starts the web workbench instead of Python UI', async () => {
  const launcher = await readFile(new URL('../../start-ai-img-gen.cmd', import.meta.url), 'utf8');
  assert.match(launcher, /%~dp0/);
  assert.match(launcher, /web\\start-server\.ps1/i);
  assert.match(launcher, /http:\/\/127\.0\.0\.1:4577\//);
  assert.equal(/app\.py|pyw?\.exe/i.test(launcher), false);
});

test('desktop grid can shrink without horizontal overflow', async () => {
  const css = await readFile(new URL('../public/app.css', import.meta.url), 'utf8');
  assert.match(css, /grid-template-columns:minmax\(0,[^)]+\) minmax\((?:280|300)px,[^)]+\)/);
  assert.match(css, /\.card\{[^}]*min-width:0/);
});

import { classifyProviderFailure } from '../src/playwright-bridge.mjs';

test('Playwright timeout stays concise while preserving diagnostic evidence',()=>{
 const raw='### Error\nTimeoutError: browserBackend.callTool: Timeout 15000ms exceeded.\nCall log:\n\u001b[2m - waiting for locator(aria-ref=e973) <button class="'+ 'x'.repeat(4000)+'">';
 const result=classifyProviderFailure(raw);
 assert.ok(result.message.length<180);
 assert.doesNotMatch(result.message,/locator|class=|\u001b/);
 assert.equal(result.diagnostic,raw);
 assert.equal(result.retryAutomatically,false);
});
test('provider rate limit is not classified as a Playwright connection failure', () => {
  const result = classifyProviderFailure('请求过于频繁，请稍等几分钟后再试。');
  assert.equal(result.state, 'provider_rate_limited');
  assert.equal(result.retryAutomatically, false);
  assert.equal(result.playwrightHealthy, true);
});

