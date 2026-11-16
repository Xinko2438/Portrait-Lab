import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('formal tagging page replaces V1 primary style with three V2 facet groups', async () => {
  const [html, app, css] = await Promise.all([
    readFile(new URL('../public/face-tagging.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/face-tagging.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/face-tagging.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="styleFacetWorkTypeChoices"/);
  assert.match(html, /id="styleFacetTreatmentChoices"/);
  assert.match(html, /id="styleFacetPositioningChoices"/);
  assert.doesNotMatch(html, /id="templateStyleChoices"/);
  assert.match(app, /template-style-facets-v2-state\.js/);
  assert.match(app, /\/api\/template-style-facets-v2\/vocabulary/);
  assert.match(app, /\/style-facets-v2/);
  assert.match(app, /toggleStyleFacetTreatment/);
  assert.match(app, /toggleStyleFacetPositioning/);
  assert.match(css, /\.style-facet-group/);
});

test('formal page keeps one confirmation action and makes rejected exclusion explicit', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('../public/face-tagging.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/face-tagging.js', import.meta.url), 'utf8'),
  ]);
  assert.equal((html.match(/id="confirmAndNext"/g) || []).length, 1);
  assert.match(html, /id="styleFacetRejectedNotice"/);
  assert.match(app, /整张模板不再推荐/);
  assert.match(app, /buildStyleFacetConfirmationPayload/);
  assert.doesNotMatch(app, /buildTemplateStyleConfirmationPayload/);
});
