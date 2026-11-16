import { TEMPLATE_STYLE_FACET_SAMPLES } from './template-style-facets-v2-samples.js';

const LABELS = Object.freeze({
  fashion_editorial: ['时尚编辑', 'Fashion Editorial'], cinematic_narrative: ['电影叙事', 'Cinematic Narrative'], graphic_poster: ['图形海报', 'Graphic Poster'], documentary_lifestyle: ['纪实生活', 'Documentary / Lifestyle'], commercial_branding: ['商业形象', 'Commercial Branding'], other_uncertain: ['其他 / 不确定', 'Other / Uncertain'],
  monochrome: ['黑白', 'Monochrome'], dark_low_key: ['暗调', 'Dark / Low-key'], bright_high_key: ['明亮清透', 'Bright / High-key'], vivid_color: ['鲜艳撞色', 'Vivid Color'], retro_film: ['复古胶片', 'Retro Film'], grunge_collage: ['粗粝拼贴', 'Grunge / Collage'],
  luxury: ['高级', 'Luxury'], professional: ['专业', 'Professional'], street: ['街头', 'Street'], romantic: ['浪漫', 'Romantic'], avant_garde: ['前卫', 'Avant-garde'], natural_friendly: ['自然亲和', 'Natural / Friendly'],
});

function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
function chip(key, tone = '') { const value = LABELS[key] || [key, '']; return `<span class="facet-chip ${tone}"><b>${escapeHtml(value[0])}</b><small>${escapeHtml(value[1])}</small></span>`; }
function group(title, subtitle, values, tone) { return `<section class="facet-group"><header><b>${title}</b><small>${subtitle}</small></header><div class="facet-values">${values.length ? values.map((value) => chip(value, tone)).join('') : '<span class="facet-empty">无明显特征</span>'}</div></section>`; }

export function renderFacetCardHtml(item) {
  if (item.template_state === 'rejected') return `<article class="facet-card is-rejected"><div class="rejected-mark">已淘汰</div><h3>${escapeHtml(item.template_name || item.template_uid)}</h3><p>整张模板不再推荐。旧的人脸、角度和风格参数不作为 V2 分类、匹配或学习依据。</p></article>`;
  const suggestion = item.suggestion || {};
  return `<article class="facet-card"><div class="facet-image"><img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.template_name)}"><span>正式可用 · AI样例</span></div><div class="facet-body"><div class="facet-title"><div><small>TEMPLATE FACETS V2</small><h3>${escapeHtml(item.template_name)}</h3></div><span class="candidate-badge">候选</span></div>${group('作品类型', '只选一个 · 决定它是什么作品', [suggestion.work_type], 'is-family')}${group('画面处理', '可多选 · 决定画面怎么被处理', suggestion.treatments || [], 'is-treatment')}${group('气质定位', '可多选 · 决定它传达什么感觉', suggestion.positioning || [], 'is-positioning')}</div></article>`;
}

function boot() {
  const root = document.querySelector('#facetSamples');
  if (!root) return;
  root.innerHTML = TEMPLATE_STYLE_FACET_SAMPLES.map(renderFacetCardHtml).join('');
  document.querySelector('#sampleCount').textContent = `${TEMPLATE_STYLE_FACET_SAMPLES.length} 张正式可用样例`;
}

if (typeof document !== 'undefined') boot();
