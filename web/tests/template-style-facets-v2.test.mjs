import test from 'node:test';
import assert from 'node:assert/strict';

const facets = await import('../src/template-style-facets-v2.mjs').catch(() => ({}));

test('V2 represents one fashion family with compatible monochrome dark grunge and luxury traits', () => {
  assert.equal(typeof facets.normalizeStyleFacetTag, 'function');
  const tag = facets.normalizeStyleFacetTag({
    work_type: 'fashion_editorial',
    treatments: ['monochrome', 'dark_low_key', 'grunge_collage'],
    positioning: ['luxury', 'avant_garde'],
  });
  assert.deepEqual(tag, {
    schema_version: 'ai-img-gen.template-style-facets.v2',
    work_type: 'fashion_editorial',
    treatments: ['monochrome', 'dark_low_key', 'grunge_collage'],
    positioning: ['luxury', 'avant_garde'],
  });
});

test('V2 fails closed on unknown duplicate and unfocused facet sets', () => {
  assert.throws(() => facets.normalizeStyleFacetTag({ work_type: 'luxury', treatments: [], positioning: [] }), /work type/i);
  assert.throws(() => facets.normalizeStyleFacetTag({ work_type: 'graphic_poster', treatments: ['monochrome', 'monochrome'], positioning: [] }), /duplicate/i);
  assert.throws(() => facets.normalizeStyleFacetTag({ work_type: 'graphic_poster', treatments: ['monochrome', 'dark_low_key', 'retro_film', 'vivid_color'], positioning: [] }), /three/i);
  assert.throws(() => facets.normalizeStyleFacetTag({ work_type: 'graphic_poster', treatments: [], positioning: ['luxury', 'street', 'professional'] }), /two/i);
});

test('active templates expose suggestions while rejected templates expose zero facets', () => {
  const tag = facets.normalizeStyleFacetTag({ work_type: 'cinematic_narrative', treatments: ['dark_low_key'], positioning: ['romantic'] });
  assert.deepEqual(facets.projectStyleFacetEligibility({ templateUid: 'active-1', templateState: 'active', suggestion: tag }), {
    template_uid: 'active-1', eligible: true, reason: 'active_template', facets: tag,
  });
  assert.deepEqual(facets.projectStyleFacetEligibility({ templateUid: 'rejected-1', templateState: 'rejected', suggestion: tag, legacyV1: { primary_style: 'cinematic_mood' } }), {
    template_uid: 'rejected-1', eligible: false, reason: 'rejected_template', facets: null,
  });
});

test('V2 vocabulary separates family treatment and positioning instead of ten competing styles', () => {
  assert.deepEqual(facets.STYLE_FACET_VOCABULARY.work_types.map((item) => item.key), [
    'fashion_editorial', 'cinematic_narrative', 'graphic_poster', 'documentary_lifestyle', 'commercial_branding', 'other_uncertain',
  ]);
  assert.deepEqual(facets.STYLE_FACET_VOCABULARY.treatments.map((item) => item.key), [
    'monochrome', 'dark_low_key', 'bright_high_key', 'vivid_color', 'retro_film', 'grunge_collage',
  ]);
  assert.deepEqual(facets.STYLE_FACET_VOCABULARY.positioning.map((item) => item.key), [
    'luxury', 'professional', 'street', 'romantic', 'avant_garde', 'natural_friendly',
  ]);
});
