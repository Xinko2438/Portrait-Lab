import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateReview } from '../src/review-policy.mjs';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/app.css', import.meta.url), 'utf8');

function validReview(overrides = {}) {
  return {
    faceFidelity: 9.1,
    naturalness: 8.4,
    style: 8.6,
    diagnosticCodes: [],
    ...overrides,
  };
}

test('three numeric gates and diagnostic source truth remain separate', () => {
  const evaluated = evaluateReview(validReview({ diagnosticCodes: ['emotion_unclear', 'client_use_case_mismatch'] }));
  assert.equal(evaluated.style_consistency, 8.6);
  assert.deepEqual(evaluated.diagnostic_codes, ['emotion_unclear', 'client_use_case_mismatch']);
  assert.equal(evaluated.preference_eligible, true);
  assert.equal(evaluated.failed_dimensions.length, 0);
  assert.equal(evaluated.emotional_clarity, undefined);
  assert.equal(evaluated.client_suitability, undefined);
  assert.throws(() => evaluateReview(validReview({ styleLevel: 'yes' })), /retired score fields/i);
});

test('review UI exposes three numeric controls and four structured diagnostic groups', () => {
  assert.match(html, /本人特征还原程度/);
  assert.match(html, /画面自然可信程度/);
  assert.match(html, /目标模板风格符合程度/);
  for (const field of ['faceFidelity', 'naturalness', 'style']) {
    assert.match(html, new RegExp(`name="${field}"[^>]*type="number"`));
  }
  assert.equal((html.match(/class="diagnostic-group/g) || []).length, 5);
  for (const code of ['emotion_unclear', 'elements_incoherent', 'subject_not_primary', 'client_use_case_mismatch']) {
    assert.match(html, new RegExp(`name="diagnosticCodes"[^>]*value="${code}"`));
  }
  assert.doesNotMatch(html, /name="styleLevel"/);
  assert.doesNotMatch(html, /name="clientSuitabilityLevel"/);
  assert.match(css, /\.diagnostic-section/);
  assert.match(css, /\.diagnostic-group/);
  assert.match(app, /diagnosticCodesForDisplay/);
  assert.match(app, /data\.getAll\('diagnosticCodes'\)/);
});

test('history import uses image-icon selectors with live selected-file counts', () => {
  const start=html.indexOf('id="historyImportForm"');const history=html.slice(start,html.indexOf('</form>',start));
  assert.equal((history.match(/class="history-image-picker"/g) || []).length, 3);
  assert.equal((history.match(/class="image-picker-icon"/g) || []).length, 3);
  assert.equal((history.match(/data-file-status/g) || []).length, 3);
  assert.match(css, /\.history-file-input/);
  assert.match(css, /\.history-image-picker/);
  assert.match(app, /function updateHistoryFileStatus/);
  assert.match(app, /已选择 \$\{count\} 张/);
});

test('A/B comparison and final delivery reuse the sequential action workspace', () => {
  assert.match(html, /<aside class="review-action-panel">[\s\S]*id="artifactInspector"[\s\S]*id="aestheticComparisonPanel"[\s\S]*id="preferencePanel"/);
  assert.match(html, /纯审美 A\/B 对比/);
  assert.match(html, /最终交付选择/);
  assert.match(css, /\.review-action-panel/);
  assert.match(css, /\.comparison-outcome-grid/);
  assert.match(css, /@media\(max-width:900px\)[\s\S]*\.review-workspace/);
  assert.match(app, /function renderAestheticComparison/);
  assert.doesNotMatch(app, /aestheticComparisonPanel\.open = true/);
});
