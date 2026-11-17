import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const htmlUrl = new URL('../public/index.html', import.meta.url);
const cssUrl = new URL('../public/app.css', import.meta.url);
const appUrl = new URL('../public/app.js', import.meta.url);

test('workbench uses four bounded stages instead of a single long-form stack', async () => {
  const html = await readFile(htmlUrl, 'utf8');
  assert.match(html, /<link rel="icon"[^>]*href="\/brand\/portrait-lab.svg"/);
  assert.match(html, /class="stage-navigation"/);
  for (const stage of ['references', 'generation', 'results', 'review']) {
    assert.match(html, new RegExp(`data-stage-panel="${stage}"`));
  }
  assert.match(html, /id="reviewWorkspace"/);
  assert.match(html, /id="artifactInspector"/);
});

test('gallery review keeps all review evidence in one selected-candidate inspector', async () => {
  const html = await readFile(htmlUrl, 'utf8');
  const app = await readFile(appUrl, 'utf8');
  assert.match(html, /id="artifactReviewTemplate"/);
  for (const field of ['faceFidelity', 'naturalness', 'style']) {
    assert.match(html, new RegExp(`name="${field}"`));
  }
  assert.equal((html.match(/name="diagnosticCodes"/g) || []).length, 9);
  assert.match(html, /id="aestheticComparisonForm"/);
  assert.match(app, /selectedArtifactId/);
  assert.match(app, /renderArtifactInspector/);
  assert.match(app, /artifact-candidate/);
  assert.match(app, /setStage/);
});

test('gallery review shows compact identity and template originals beside generated candidates', async () => {
  const [html, css, app] = await Promise.all([
    readFile(htmlUrl, 'utf8'),
    readFile(cssUrl, 'utf8'),
    readFile(appUrl, 'utf8'),
  ]);
  assert.match(html, /id="reviewReferences"/);
  assert.match(app, /renderReviewReferences/);
  assert.match(app, /references\/\$\{kind\}\/\$\{index\}\/file/);
  assert.match(app, /kind:\s*'identity'/);
  assert.match(app, /kind:\s*'template'/);
  assert.match(app, /客户身份原图/);
  assert.match(app, /构图 \/ 风格参考/);
  assert.match(css, /\.review-reference-strip\s*\{[^}]*display:\s*flex/is);
  assert.match(css, /\.review-reference-thumb img\s*\{[^}]*object-fit:\s*contain/is);
  assert.doesNotMatch(app, /reference\.filename/);
});

test('approved B palette uses porcelain surfaces and indigo accents without a dark outer frame', async () => {
  const css = await readFile(cssUrl, 'utf8');
  assert.match(css, /--canvas:\s*#f3f4f8/i);
  assert.match(css, /--surface:\s*#ffffff/i);
  assert.match(css, /--accent:\s*#5544ed/i);
  assert.match(css, /--accent-strong:\s*#4338ca/i);
  assert.match(css, /body\s*\{[^}]*background:\s*var\(--surface\)/is);
  assert.doesNotMatch(css, /body\s*\{[^}]*background:\s*#202126/is);
  assert.match(css, /\.app-shell\s*\{[^}]*background:\s*var\(--surface\)[^}]*border:\s*0/is);
  assert.doesNotMatch(css, /--frame-blue:/i);
});

test('review workspace has desktop media/action focus and mobile single-column fallback', async () => {
  const css = await readFile(cssUrl, 'utf8');
  assert.match(css, /\.review-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(500px,560px\)/is);
  assert.doesNotMatch(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(340px,420px\)\s+minmax\(360px,440px\)/is);
  assert.match(css, /@media\s*\(max-width:\s*900px\)/i);
  assert.match(css, /\.review-workspace\s*\{[^}]*grid-template-columns:\s*1fr/is);
});

test('desktop shell keeps global stages inside one compact header row', async () => {
  const [html, css] = await Promise.all([readFile(htmlUrl, 'utf8'), readFile(cssUrl, 'utf8')]);
  const header = html.match(/<header class="app-header">[\s\S]*?<\/header>/)?.[0] || '';
  assert.match(header, /class="brand-block"[\s\S]*class="stage-navigation"[\s\S]*class="task-summary"[\s\S]*class="connection-cluster"/);
  assert.doesNotMatch(html, /<\/header>\s*<nav class="stage-navigation"/);
  assert.match(css, /\.app-shell\{[^}]*grid-template-rows:64px minmax\(0,1fr\)/);
  assert.match(css, /\.app-header\{[^}]*grid-template-columns:auto minmax\(360px,1fr\) auto auto/);
  assert.match(css, /@media\(max-width:900px\)[\s\S]*\.app-shell\{[^}]*grid-template-rows:118px auto/);
});

test('normal workstation header exposes a discoverable template tagging entry', async () => {
  const [html, css] = await Promise.all([readFile(htmlUrl, 'utf8'), readFile(cssUrl, 'utf8')]);
  const header = html.match(/<header class="app-header">[\s\S]*?<\/header>/)?.[0] || '';
  assert.match(header, /href="\/face-tagging\.html"/);
  assert.match(header, /模板标注/);
  assert.match(header, /aria-label="打开模板标注工作区"/);
  assert.match(css, /\.template-tagging-entry/);
  assert.match(css, /@media\(max-width:900px\)[\s\S]*\.template-tagging-entry span\{display:none\}/);
});

test('generated candidates open a full-screen editable annotation workspace', async () => {
  const [html, css, app] = await Promise.all([
    readFile(htmlUrl, 'utf8'),
    readFile(cssUrl, 'utf8'),
    readFile(appUrl, 'utf8'),
  ]);
  assert.match(html, /id="annotationDialog"/);
  assert.match(html, /id="annotationCanvas"/);
  for (const tool of ['select', 'freehand', 'rectangle', 'ellipse', 'arrow', 'text', 'mosaic']) {
    assert.match(html, new RegExp(`data-annotation-tool="${tool}"`));
  }
  for (const id of ['annotationReason', 'annotationNote', 'annotationOverallNote', 'saveAnnotation', 'closeAnnotation']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /openArtifactAnnotation/);
  assert.match(app, /data-open-annotation/);
  assert.match(app, /annotation_count/);
  assert.match(css, /\.annotation-dialog/);
  assert.match(css, /\.annotation-workspace/);
  assert.match(css, /\.annotation-toolbar/);

  const editor = await readFile(new URL('../public/annotation-editor.js', import.meta.url), 'utf8');
  assert.match(editor, /from '\/vendor\/fabric\.mjs'/);
  assert.match(editor, /PencilBrush/);
  assert.match(editor, /toDataURL/);
  assert.match(editor, /annotations\/latest/);
  assert.match(editor, /undo/);
  assert.match(editor, /redo/);
  assert.doesNotMatch(editor, /submitRun|stageRun|ChatGPT/);
});

test('annotation toolbar uses compact icons with visible color and stroke-width choices', async () => {
  const [html, css, editor] = await Promise.all([
    readFile(htmlUrl, 'utf8'),
    readFile(cssUrl, 'utf8'),
    readFile(new URL('../public/annotation-editor.js', import.meta.url), 'utf8'),
  ]);

  for (const tool of ['select', 'freehand', 'rectangle', 'ellipse', 'arrow', 'text']) {
    const button = html.match(new RegExp(`<button[^>]*data-annotation-tool="${tool}"[\\s\\S]*?<\\/button>`))?.[0] || '';
    assert.match(button, /aria-label="[^"]+"/);
    assert.match(button, /<svg\b/);
  }
  assert.doesNotMatch(html, />\s*(?:画笔|矩形|圆形|箭头|文字)\s*<\/button>/);

  for (const color of ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#111827']) {
    assert.match(html, new RegExp(`data-annotation-color="${color}"`, 'i'));
  }
  for (const width of ['2', '4', '8']) {
    assert.match(html, new RegExp(`data-annotation-width="${width}"`));
  }
  for (const variant of ['soft_blur', 'haze', 'frosted']) {
    assert.match(html, new RegExp(`data-mosaic-variant="${variant}"`));
  }
  assert.match(html, /id="annotationColor"[^>]*type="color"/);
  assert.match(html, /id="annotationWidth"[^>]*type="hidden"[^>]*value="4"/);
  assert.match(css, /\.annotation-color-swatch/);
  assert.match(css, /\.annotation-width-choice/);
  assert.match(css, /\.mosaic-variant-group/);
  assert.match(editor, /dataset\.annotationColor/);
  assert.match(editor, /dataset\.annotationWidth/);
  assert.match(editor, /dataset\.mosaicVariant/);
  assert.match(editor, /applySelectedStrokeWidth/);
  assert.match(editor, /perPixelTargetFind:\s*true/);
  assert.match(editor, /targetFindTolerance:\s*6/);
});
