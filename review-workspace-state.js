export function canCompareArtifact(manifest, artifact) {
  return manifest.review_flow === 'score-only-v1' ||
    manifest.artifact_reviews?.[artifact.artifact_id]?.preference_eligible === true;
}

function reviewedArtifacts(manifest) {
  const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];
  const reviews = manifest?.artifact_reviews || {};
  return {
    artifacts,
    reviews,
    allReviewed: artifacts.length > 0 && artifacts.every((artifact) => Boolean(reviews[artifact.artifact_id])),
    eligible: artifacts.filter(artifact => canCompareArtifact(manifest, artifact)),
  };
}

function step(id, state, label, status) {
  return { id, state, label, status };
}

export function deriveReviewWorkspaceState(manifest = {}, { preferredA = '', preferredB = '' } = {}) {
  const { artifacts, allReviewed, eligible } = reviewedArtifacts(manifest);
  const comparisonCount = Array.isArray(manifest.aesthetic_comparisons) ? manifest.aesthetic_comparisons.length : 0;
  const preferenceRecorded = Boolean(manifest.preference);
  const eligibleIds = eligible.map((artifact) => artifact.artifact_id);
  const artifactAId = eligibleIds.includes(preferredA) ? preferredA : (eligibleIds[0] || '');
  const artifactBId = eligibleIds.includes(preferredB) && preferredB !== artifactAId
    ? preferredB
    : (eligibleIds.find((artifactId) => artifactId !== artifactAId) || '');
  const comparisonEnabled = eligible.length >= 2;

  const scoreStep = allReviewed
    ? step('score', 'complete', '逐图评分', '已完成')
    : step('score', 'current', '逐图评分', `${Object.keys(manifest.artifact_reviews || {}).length} / ${artifacts.length}`);

  let compareStep;
  if (!allReviewed) compareStep = step('compare', 'pending', 'A/B 对比', '等待评分');
  else if (!comparisonEnabled) compareStep = step('compare', 'skipped', 'A/B 对比', '无需进行');
  else if (comparisonCount > 0) compareStep = step('compare', 'complete', 'A/B 对比', `已记录 ${comparisonCount} 次`);
  else compareStep = step('compare', 'current', 'A/B 对比', '待比较');

  let deliverStep;
  if (preferenceRecorded) deliverStep = step('deliver', 'complete', '最终交付', '已记录');
  else if (allReviewed && (!comparisonEnabled || comparisonCount > 0)) deliverStep = step('deliver', 'current', '最终交付', '待选择');
  else deliverStep = step('deliver', 'pending', '最终交付', '等待前一步');

  const activeStep = !allReviewed
    ? 'score'
    : preferenceRecorded
      ? 'deliver'
      : comparisonEnabled && comparisonCount === 0
        ? 'compare'
        : 'deliver';
  const navigableSteps = ['score'];
  if (allReviewed) navigableSteps.push('compare', 'deliver');

  return {
    steps: [scoreStep, compareStep, deliverStep],
    activeStep,
    navigableSteps,
    comparison: {
      enabled: comparisonEnabled,
      message: comparisonEnabled
        ? (comparisonCount ? `已记录 ${comparisonCount} 次` : '请选择 A / B / tie / skip')
        : manifest.review_flow === 'score-only-v1' ? '至少需要两张照片才能比较' : '至少需要两张通过三项门槛的候选',
      eligible,
      artifactAId,
      artifactBId,
    },
  };
}

export function resolveReviewWorkspaceStep(manifest = {}, override = '') {
  const state = deriveReviewWorkspaceState(manifest);
  return state.navigableSteps.includes(override) ? override : state.activeStep;
}

export function resolveReviewMediaMode(manifest = {}, activeStep = '') {
  const state = deriveReviewWorkspaceState(manifest);
  return activeStep === 'compare' && state.comparison.enabled ? 'comparison' : 'gallery';
}

export function deriveReviewNavigationState(manifest = {}) {
  const state = deriveReviewWorkspaceState(manifest);
  const scoringComplete = state.steps[0].state === 'complete';
  return {
    activeView: scoringComplete ? 'choice' : 'score',
    navigableViews: scoringComplete ? ['score', 'choice'] : ['score'],
    choiceSections: state.comparison.enabled ? ['comparison', 'delivery'] : ['delivery'],
  };
}

export function resolveReviewNavigationView(manifest = {}, override = '') {
  const state = deriveReviewNavigationState(manifest);
  return state.navigableViews.includes(override) ? override : state.activeView;
}

export function reviewSubmitLabel(manifest = {}, artifactId = '') {
  const reviews = manifest.artifact_reviews || {};
  if (reviews[artifactId]) return '更新评分';
  const hasOtherUnreviewed = (manifest.artifacts || []).some((artifact) => artifact.artifact_id !== artifactId && !reviews[artifact.artifact_id]);
  return hasOtherUnreviewed ? '保存评分并看下一张' : '保存评分并继续';
}

export function reviewArtifactFileUrl(runId, artifactId) {
  if (!runId || !artifactId) return '';
  return `/folio/portrait-lab/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/file`;
}

const artifactStyleLabels = Object.freeze({
  fashion_editorial: '时尚编辑',
  cinematic_narrative: '电影叙事',
  graphic_poster: '图形海报',
  documentary_lifestyle: '纪实生活',
  commercial_branding: '商业形象',
  other_uncertain: '其他 / 不确定',
  monochrome: '黑白',
  dark_low_key: '暗调',
  bright_high_key: '明亮清透',
  vivid_color: '鲜艳撞色',
  retro_film: '复古胶片',
  grunge_collage: '粗粝拼贴',
  luxury: '高级',
  professional: '专业',
  street: '街头',
  romantic: '浪漫',
  avant_garde: '前卫',
  natural_friendly: '自然亲和',
});

function escapeStyleText(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function artifactStylePanelMarkup(suggestion = null) {
  if (!suggestion) return '';
  const tags = [
    suggestion.work_type,
    ...(suggestion.treatments || []),
    ...(suggestion.positioning || []),
    ...(suggestion.scene_tags || []),
  ].filter(Boolean).map((value) => `<span>${escapeStyleText(artifactStyleLabels[value] || value)}</span>`).join('');
  return `<section class="artifact-style-prelabel" data-artifact-style-prelabel>
    <div class="artifact-style-prelabel-heading"><strong>AI 风格预标</strong><small>尚未人工确认</small></div>
    <div class="artifact-style-prelabel-tags">${tags}</div>
    <p>${escapeStyleText(suggestion.style_note || '')}</p>
  </section>`;
}
