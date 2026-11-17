import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const htmlUrl = new URL('../public/index.html', import.meta.url);
const cssUrl = new URL('../public/app.css', import.meta.url);
const appUrl = new URL('../public/app.js', import.meta.url);

test('entry page starts directly with identity references instead of a redundant hero', async () => {
  const html = await readFile(htmlUrl, 'utf8');
  assert.match(html, /class="reference-workspace"/);
  assert.match(html, /id="identityPreviewGrid"/);
  assert.match(html, /id="templatePreviewGrid"/);
  assert.match(html, /class="task-brief"/);
  assert.doesNotMatch(html, /Reference setup/i);
  assert.doesNotMatch(html, /先把参考图准备好/);
  assert.doesNotMatch(html, /class="reference-page-heading"/);
  assert.doesNotMatch(html, /class="reference-counts"/);
  assert.match(html, /id="prepareRun"[^>]*>开始生成/);
  assert.match(html, /data-stage-target="generation"[^>]*>[\s\S]*?<strong>生成状态<\/strong>/);
  assert.doesNotMatch(html, /<strong>确认生成<\/strong>/);
});

test('image-first primary photo is automatic while manual selection stays available', async () => {
  const [html, app] = await Promise.all([readFile(htmlUrl, 'utf8'), readFile(appUrl, 'utf8')]);
  assert.match(html, /<strong>主要照片<\/strong>/);
  assert.match(html, /第一张自动作为主图，也可以点击更换/);
  assert.match(html, /<summary>角度备注<\/summary>/);
  assert.doesNotMatch(html, /自动角度匹配/);
  assert.doesNotMatch(html, /本地自动推荐/);
  assert.match(app, /identityAngleStatus\.textContent\s*=\s*'第一张自动作为主图，也可以点击更换'/);
  assert.doesNotMatch(app, /自动匹配暂未达到启用标准/);
  assert.doesNotMatch(app, /当前服务尚未加载自动分析/);
  assert.match(app, /identityAngleFallback\.open\s*=\s*false/);
  assert.doesNotMatch(app, /identityAngleFallback\.open\s*=\s*faceAngleCapability\s*!==\s*'ready'/);
});

test('removed reference hero leaves no orphaned count-update logic', async () => {
  const app = await readFile(appUrl, 'utf8');
  assert.doesNotMatch(app, /elements\.identityCount/);
  assert.doesNotMatch(app, /elements\.templateCount/);
  assert.doesNotMatch(app, /count\.textContent\s*=/);
});

test('reference inputs keep submission contracts while hiding native controls', async () => {
  const html = await readFile(htmlUrl, 'utf8');
  assert.match(html, /id="identity"[^>]*name="identity"[^>]*class="reference-file-input"/);
  assert.match(html, /id="templates"[^>]*name="templates"[^>]*class="reference-file-input"/);
  assert.match(html, /<dialog[^>]+class="advanced-reference-settings task-options-dialog"[^>]*>/);
  for (const name of ['identityAngles', 'targetAngle', 'targetFraming', 'businessDomain']) {
    assert.match(html, new RegExp(`name="${name}"`));
  }
  assert.doesNotMatch(html, /name="templateAngle"/);
  assert.doesNotMatch(html, /name="templateFraming"/);
});

test('task brief keeps only essential fields primary and moves derived choices into one more-settings disclosure', async () => {
  const [html, app] = await Promise.all([readFile(htmlUrl, 'utf8'), readFile(appUrl, 'utf8')]);
  assert.match(html, /id="existingCustomerFields"/);
  assert.match(html, /id="newCustomerFields"/);
  assert.match(html, /<section[^>]+id="moreTaskSettings"[^>]*>/);
  const disclosure = html.slice(html.indexOf('id="moreTaskSettings"'), html.indexOf('class="customer-visual-status"'));
  for (const id of ['targetFraming', 'targetIntentAngle', 'layoutIntent', 'temperamentOptions', 'businessDomain', 'targetAngle']) {
    assert.match(disclosure, new RegExp(`id="${id}"`), `${id} should be under the shared disclosure`);
  }
  const beforeDisclosure = html.slice(html.indexOf('<aside class="task-brief">'), html.indexOf('id="moreTaskSettings"'));
  const identitySection = html.slice(html.indexOf('<section class="reference-upload-card">'),html.indexOf('class="customer-photo-pool"'));
  assert.match(identitySection, /id="customerSelector"/);
  assert.match(beforeDisclosure, /id="generationMode"/);
  assert.match(beforeDisclosure, /id="userSupplement"/);
  assert.match(beforeDisclosure, /id="apiImageCount"/);
  assert.match(disclosure, /id="intendedUse"/);
  assert.match(disclosure, /id="newCustomerFields"/);
  assert.match(disclosure, /id="apiImageSize"/);
  assert.match(disclosure, /id="apiImageQuality"/);
  assert.match(disclosure, /id="sendPromptPreviewDetails"/);
  assert.match(app, /deriveCustomerFieldVisibility/);
  assert.match(app, /existingCustomerFields/);
  assert.match(app, /newCustomerFields/);
  const css=await readFile(cssUrl,'utf8');
  assert.match(css,/\.advanced-reference-settings:not\(\[open\]\)\s*>\s*\.advanced-settings-body\s*\{[^}]*display:\s*none/is,'closed advanced settings must be visually hidden in the user Chrome surface');
});

test('selected reference files render local previews and coverage without uploading', async () => {
  const app = await readFile(appUrl, 'utf8');
  assert.match(app, /renderReferencePreviews/);
  assert.match(app, /URL\.createObjectURL/);
  assert.match(app, /URL\.revokeObjectURL/);
  assert.match(app, /identityPreviewGrid/);
  assert.match(app, /templatePreviewGrid/);
  assert.match(app, /renderIdentityCoverage/);
  assert.doesNotMatch(app, /preview-name/);
});

test('reference previews show the complete image in bounded portrait cards', async () => {
  const css = await readFile(cssUrl, 'utf8');
  assert.match(css, /\.horizontal-photo-strip\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*nowrap[^}]*overflow-x:\s*auto/is);
  assert.match(css, /\.horizontal-photo-strip\s*>\s*\*\s*\{[^}]*flex:\s*0\s+0\s+190px/is);
  assert.match(css, /\.template-preview-grid\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*190px\)\)[^}]*justify-content:\s*start/is);
  assert.match(css, /\.reference-preview-tile\s*\{[^}]*max-width:\s*190px[^}]*aspect-ratio:\s*4\s*\/\s*5[^}]*height:\s*auto/is);
  assert.match(css, /\.reference-preview-tile img\s*\{[^}]*object-fit:\s*contain/is);
  assert.doesNotMatch(css, /\.reference-preview-tile \.preview-name/);
  assert.match(css, /@media\s*\(max-width:\s*560px\)[\s\S]*?\.template-preview-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/is);
});

test('large desktop sizing activates at 1800px without changing smaller breakpoints', async () => {
  const css = await readFile(cssUrl, 'utf8');
  assert.match(css, /@media\s*\(min-width:\s*1800px\)/i);
  assert.match(css, /\.reference-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+430px/is);
  assert.match(css, /\.identity-preview-grid/);
  assert.match(css, /\.reference-preview-tile/);
});

test('right task action stays visible while only its content body scrolls on desktop', async () => {
  const [html, css] = await Promise.all([
    readFile(htmlUrl, 'utf8'),
    readFile(cssUrl, 'utf8'),
  ]);

  assert.match(html, /<aside class="task-brief">\s*<div class="task-brief-scroll">[\s\S]*?<\/div>\s*<footer class="task-brief-footer">[\s\S]*?id="prepareResult"[\s\S]*?id="prepareRun"[\s\S]*?<\/footer>\s*<\/aside>/i);
  assert.match(css, /\.task-brief\s*\{[^}]*display:\s*grid[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto[^}]*overflow:\s*hidden/is);
  assert.match(css, /\.task-brief-scroll\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/is);
  assert.match(css, /\.task-brief-footer\s*\{[^}]*border-top:\s*1px solid var\(--line-strong\)[^}]*background:\s*var\(--surface\)/is);
  assert.match(css, /\.task-submit\s*\{[^}]*min-height:\s*48px/is);
  assert.match(css, /@media\s*\(max-width:\s*900px\)[\s\S]*?\.task-brief-scroll\s*\{[^}]*overflow:\s*visible[\s\S]*?\.task-brief-footer\s*\{[^}]*border-top:\s*0/is);
});

test('approved B visual system replaces the rejected pale-blue form theme', async () => {
  const [html, css, app] = await Promise.all([
    readFile(htmlUrl, 'utf8'),
    readFile(cssUrl, 'utf8'),
    readFile(appUrl, 'utf8'),
  ]);

  assert.match(css, /--canvas:\s*#f3f4f8/i);
  assert.match(css, /--accent:\s*#5544ed/i);
  assert.doesNotMatch(css, /--frame-blue:/i);
  assert.doesNotMatch(css, /--canvas:\s*#edf3f5/i);
  assert.match(css, /body\s*\{[^}]*background:\s*var\(--surface\)[^}]*padding:\s*0/is);
  assert.doesNotMatch(css, /body\s*\{[^}]*background:\s*#202126/is);
  assert.match(css, /\.app-shell\s*\{[^}]*width:\s*100%[^}]*height:\s*100vh[^}]*border:\s*0[^}]*border-radius:\s*0[^}]*box-shadow:\s*none/is);
  assert.match(css, /\.stage-tab\.active\s*\{[^}]*background:\s*var\(--accent-soft\)/is);
  assert.match(css, /\.add-reference\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*justify-content:\s*center/is);
  assert.match(css, /\.add-reference\.required-slot\s*\{[^}]*border:\s*2px solid var\(--accent\)[^}]*box-shadow:\s*none/is);
  assert.match(css, /\.required-label\s*\{[^}]*position:\s*absolute/is);
  assert.match(css, /\.horizontal-photo-strip\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*nowrap/is);
  assert.match(css, /\.template-preview-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*190px\)\)/is);
  assert.match(html, /data-stage-target="references"[^>]*>[\s\S]*?<strong>参考图<\/strong>/);
  assert.match(app, /required-slot/);
  assert.match(app, /required-label/);
});
