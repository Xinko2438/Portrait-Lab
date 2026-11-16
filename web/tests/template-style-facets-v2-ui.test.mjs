import test from 'node:test';
import assert from 'node:assert/strict';

const ui = await import('../public/template-style-facets-v2.js').catch(() => ({}));

test('candidate card renders three separate groups for an eligible active template', () => {
  assert.equal(typeof ui.renderFacetCardHtml, 'function');
  const html = ui.renderFacetCardHtml({
    template_uid: 'tpl-active',
    template_name: '黑白时装样例',
    image_url: '/reference.jpg',
    template_state: 'active',
    suggestion: {
      work_type: 'fashion_editorial',
      treatments: ['monochrome', 'dark_low_key', 'grunge_collage'],
      positioning: ['luxury', 'avant_garde'],
    },
  });
  assert.match(html, /作品类型/);
  assert.match(html, /时尚编辑/);
  assert.match(html, /画面处理/);
  assert.match(html, /黑白/);
  assert.match(html, /暗调/);
  assert.match(html, /粗粝拼贴/);
  assert.match(html, /气质定位/);
  assert.match(html, /高级/);
  assert.match(html, /前卫/);
  assert.doesNotMatch(html, /确认|保存|提交/);
});

test('candidate card renders whole-template exclusion and no old parameters for rejected state', () => {
  const html = ui.renderFacetCardHtml({
    template_uid: 'tpl-rejected',
    template_name: '淘汰样例',
    image_url: '/rejected.jpg',
    template_state: 'rejected',
    suggestion: { work_type: 'fashion_editorial', treatments: ['monochrome'], positioning: ['luxury'] },
    legacy_v1: { primary_style: 'black_white_magazine', face_angle: 'front' },
  });
  assert.match(html, /整张模板不再推荐/);
  assert.doesNotMatch(html, /时尚编辑|黑白|高级|front|black_white_magazine/);
});

test('candidate samples contain active templates only and versioned suggestion evidence', async () => {
  const samples = await import('../public/template-style-facets-v2-samples.js').catch(() => ({}));
  assert.ok(samples.TEMPLATE_STYLE_FACET_SAMPLES.length >= 8);
  assert.ok(samples.TEMPLATE_STYLE_FACET_SAMPLES.every((item) => item.template_state === 'active'));
  assert.ok(samples.TEMPLATE_STYLE_FACET_SAMPLES.every((item) => item.model_version && item.prompt_version));
});
