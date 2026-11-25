import {
  buildSelectionDecision,
  createRecommendationController,
  createTemplateLibraryController,
  formatHistoryTemplateItem,
  mapFormToTaskBrief,
  normalizeCatalogTemplate,
  templateRejectionText,
} from './template-library.js';
import { openArtifactAnnotation } from './annotation-editor.js';
import { customerIdFromName, taskIntentFromForm } from './task-intent.js';
import { clampPreviewZoom, orderedPreviewItems, wrappedPreviewIndex } from './media-preview-state.js';
import { COMPLETED_RUN_NOTICE, INVALID_RUN_NOTICE, parseRunLocation, resolveRunStartup, shouldClearRunUrlAfterPreference } from './navigation-state.js';
import { clipboardImageFiles, isEditablePasteTarget, mergeFilesWithinLimit } from './clipboard-image.js';
import { artifactStylePanelMarkup, deriveReviewNavigationState, deriveReviewWorkspaceState, resolveReviewNavigationView, reviewArtifactFileUrl, reviewSubmitLabel } from './review-workspace-state.js';
import { createHistoryWorkspaceState, deriveHistoryRunState, filterAndSortHistoryRuns, historyCustomerOptions, transitionHistoryWorkspace } from './history-workspace.js';
import { manualPrimaryAfterRemoval, normalizeManualPrimaryIndex, reorderManualPrimary } from './manual-primary-selection.js';
import { getDefaultFaceAngleAnalyzer } from './face-angle-analyzer.js';
import { createFaceAngleWorkflow } from './face-angle-workflow.js';
import { matchConfidenceLabel } from './face-angle-core.js';
import { createCustomerPhotoPoolState, customerPhotoContextMenuPosition, customerPhotoReferenceUrl, orderedCustomerPhotoOrdinals, reconcileCustomerPhotoPoolState, setCustomerPhotoPrimary, toggleCustomerPhotoSelection } from './customer-photo-pool.js';
import { attachHorizontalWheelScroll } from './horizontal-wheel-scroll.js';
import { resolveActiveCustomerPhotoPool } from './active-customer-photo-pool.js';
import {
  buildSendSummary,
  deriveCustomerFieldVisibility,
  derivePrimaryAction,
  deriveStageAvailability,
  deriveSubmitRecoveryState,
  formatRunIdentity,
} from './workbench-optimization-state.js';
import { buildWorkLibrary, deriveWorkLibraryMetrics } from './work-library-state.js';
import { initGenerationMode } from './generation-mode.js';
import { initResultWorkbench, generationDetailsMarkup } from './result-workbench.js';
import { createSmartTaskWorkflow } from './smart-task-workflow.js';

const currentRubricVersion = 'portrait-review-v3-three-score-diagnostics-20260816';

const numericScoreFields = [
  ['faceFidelity', 'face_identity_fidelity'],
  ['naturalness', 'realism_naturalness'],
  ['style', 'style_consistency'],
];

const reviewScoreKeys = [
  'face_identity_fidelity',
  'realism_naturalness',
  'style_consistency',
];

const legacyDiagnosticMap = {
  emotional_clarity: 'emotion_unclear',
  element_coherence: 'elements_incoherent',
  visual_hierarchy: 'subject_not_primary',
  client_suitability: 'client_use_case_mismatch',
};

const elements = {
  appState: document.querySelector('#appState'),
  browserState: document.querySelector('#browserState'),
  prepareResult: document.querySelector('#prepareResult'),
  workflowResult: document.querySelector('#workflowResult'),
  resultMessage: document.querySelector('#resultMessage'),
  preferenceMessage: document.querySelector('#preferenceMessage'),
  runPanel: document.querySelector('#runPanel'),
  runId: document.querySelector('#runId'),
  copyRunId: document.querySelector('#copyRunId'),
  runStatus: document.querySelector('#runStatus'),
  preflightMessage: document.querySelector('#preflightMessage'),
  stageRun: document.querySelector('#stageRun'),
  submitRun: document.querySelector('#submitRun'),
  captureRun: document.querySelector('#captureRun'),
  artifactGallery: document.querySelector('#artifactGallery'),
  artifactInspector: document.querySelector('#artifactInspector'),
  reviewReferences: document.querySelector('#reviewReferences'),
  artifactImportForm: document.querySelector('#artifactImportForm'),
  artifactReviewTemplate: document.querySelector('#artifactReviewTemplate'),
  identityInput: document.querySelector('#identity'),
  templateInput: document.querySelector('#templates'),
  customerSelector: document.querySelector('#customerSelector'),
  customerName: document.querySelector('#customerName'),
  existingCustomerFields: document.querySelector('#existingCustomerFields'),
  newCustomerFields: document.querySelector('#newCustomerFields'),
  customerPhotoPool: document.querySelector('#customerPhotoPool'),
  customerPhotoPoolGrid: document.querySelector('#customerPhotoPoolGrid'),
  customerPhotoPoolSummary: document.querySelector('#customerPhotoPoolSummary'),
  customerPhotoPoolMessage: document.querySelector('#customerPhotoPoolMessage'),
  appendCustomerPhotosButton: document.querySelector('#appendCustomerPhotosButton'),
  customerPhotoAppendInput: document.querySelector('#customerPhotoAppendInput'),
  customerPhotoContextMenu: document.querySelector('#customerPhotoContextMenu'),
  customerPhotoRenameDialog: document.querySelector('#customerPhotoRenameDialog'),
  customerPhotoRenameForm: document.querySelector('#customerPhotoRenameForm'),
  customerPhotoRenameInput: document.querySelector('#customerPhotoRenameInput'),
  customerPhotoRenameExtension: document.querySelector('#customerPhotoRenameExtension'),
  customerPhotoRenameMessage: document.querySelector('#customerPhotoRenameMessage'),
  cancelCustomerPhotoRename: document.querySelector('#cancelCustomerPhotoRename'),
  closeCustomerPhotoRename: document.querySelector('#closeCustomerPhotoRename'),
  saveCustomerPhotoRename: document.querySelector('#saveCustomerPhotoRename'),
  identityUploadWorkspace: document.querySelector('#identityUploadWorkspace'),
  previewCompiledPrompt: document.querySelector('#previewCompiledPrompt'),
  compiledPromptPreview: document.querySelector('#compiledPromptPreview'),
  promptCompilationNotice: document.querySelector('#promptCompilationNotice'),
  identityPreviewGrid: document.querySelector('#identityPreviewGrid'),
  templatePreviewGrid: document.querySelector('#templatePreviewGrid'),
  openTemplateLibraryButton: document.querySelector('#openTemplateLibraryButton'),
  templateLibraryDialog: document.querySelector('#templateLibraryDialog'),
  templateLibraryCountBadge: document.querySelector('#templateLibraryCountBadge'),
  librarySelectedCount: document.querySelector('#librarySelectedCount'),
  confirmLibrarySelection: document.querySelector('#confirmLibrarySelection'),
  closeTemplateLibraryButton: document.querySelector('#closeTemplateLibraryButton'),
  templateSearchInput: document.querySelector('#templateSearchInput'),
  templateStyleFilter: document.querySelector('#templateStyleFilter'),
  templateScaleFilter: document.querySelector('#templateScaleFilter'),
  templateAngleFilter: document.querySelector('#templateAngleFilter'),
  templateRiskFilter: document.querySelector('#templateRiskFilter'),
  templateGrid: document.querySelector('#templateGrid'),
  templateGridEmpty: document.querySelector('#templateGridEmpty'),
  templateDetailDrawer: document.querySelector('#templateDetailDrawer'),
  drawerTemplateName: document.querySelector('#drawerTemplateName'),
  drawerTemplateImage: document.querySelector('#drawerTemplateImage'),
  drawerMetadata: document.querySelector('#drawerMetadata'),
  drawerSelectButton: document.querySelector('#drawerSelectButton'),
  closeDrawerButton: document.querySelector('#closeDrawerButton'),
  requestRecommendationsButton: document.querySelector('#requestRecommendationsButton'),
  recommendationsSection: document.querySelector('#recommendationsSection'),
  recommendationStateNotice: document.querySelector('#recommendationStateNotice'),
  recommendationsContainer: document.querySelector('#recommendationsContainer'),
  top4RecommendationsGrid: document.querySelector('#top4RecommendationsGrid'),
  safeInspirationSection: document.querySelector('#safeInspirationSection'),
  safeInspirationGrid: document.querySelector('#safeInspirationGrid'),
  safeInspirationMessage: document.querySelector('#safeInspirationMessage'),
  refreshSafeInspirationButton: document.querySelector('#refreshSafeInspirationButton'),
  top10RecommendationsDisclosure: document.querySelector('#top10RecommendationsDisclosure'),
  top10RecommendationsGrid: document.querySelector('#top10RecommendationsGrid'),
  recommendationAlternativesCount: document.querySelector('#recommendationAlternativesCount'),
  toggleAllRecommendationsButton: document.querySelector('#toggleAllRecommendationsButton'),
  identityQuality: document.querySelector('#identityQuality'),
  identityAngleStatus: document.querySelector('#identityAngleStatus'),
  identityAngleFallback: document.querySelector('.identity-angle-fallback'),
  advancedReferenceSettings: document.querySelector('.advanced-reference-settings'),
  moreTaskSettings: document.querySelector('#moreTaskSettings'),
  sendPromptPreviewDetails: document.querySelector('#sendPromptPreviewDetails'),
  reviewedCount: document.querySelector('#reviewedCount'),
  qualifiedCount: document.querySelector('#qualifiedCount'),
  comparisonMediaStage: document.querySelector('#comparisonMediaStage'),
  aestheticComparisonPanel: document.querySelector('#aestheticComparisonPanel'),
  aestheticComparisonForm: document.querySelector('#aestheticComparisonForm'),
  aestheticComparisonMessage: document.querySelector('#aestheticComparisonMessage'),
  comparisonUnavailable: document.querySelector('#comparisonUnavailable'),
  comparisonArtifactA: document.querySelector('#comparisonArtifactA'),
  comparisonArtifactB: document.querySelector('#comparisonArtifactB'),
  comparisonPreviewA: document.querySelector('#comparisonPreviewA'),
  comparisonPreviewB: document.querySelector('#comparisonPreviewB'),
  comparisonPreviewALabel: document.querySelector('#comparisonPreviewALabel'),
  comparisonPreviewBLabel: document.querySelector('#comparisonPreviewBLabel'),
  preferencePanel: document.querySelector('#preferencePanel'),
  preferenceForm: document.querySelector('#preferenceForm'),
  winnerArtifactId: document.querySelector('#winnerArtifactId'),
  winnerField: document.querySelector('#winnerField'),
  newTaskButton: document.querySelector('#newTaskButton'),
  openHistory: document.querySelector('#openHistory'),
  historyDialog: document.querySelector('#historyDialog'),
  compoundingSummary: document.querySelector('#compoundingSummary'),
  historyHeaderAction: document.querySelector('#historyHeaderAction'),
  openHistoryImport: document.querySelector('#openHistoryImport'),
  historyContent: document.querySelector('#historyContent'),
  historyLibraryView: document.querySelector('#historyLibraryView'),
  historyImportView: document.querySelector('#historyImportView'),
  historySearch: document.querySelector('#historySearch'),
  historyCustomerFilter: document.querySelector('#historyCustomerFilter'),
  historyStatusFilter: document.querySelector('#historyStatusFilter'),
  historySort: document.querySelector('#historySort'),
  historyResultCount: document.querySelector('#historyResultCount'),
  historyList: document.querySelector('#historyList'),
  workLibraryViewButtons: [...document.querySelectorAll('[data-work-library-view]')],
  historyImportForm: document.querySelector('#historyImportForm'),
  historyImportMessage: document.querySelector('#historyImportMessage'),
  historyRecordView: document.querySelector('#historyRecordView'),
  historyRecordTitle: document.querySelector('#historyRecordTitle'),
  historyRecordSummary: document.querySelector('#historyRecordSummary'),
  historyRecordMedia: document.querySelector('#historyRecordMedia'),
  historyRecordForm: document.querySelector('#historyRecordForm'),
  historyRecordMessage: document.querySelector('#historyRecordMessage'),
  openRecordReview: document.querySelector('#openRecordReview'),
  mediaPreviewDialog: document.querySelector('#mediaPreviewDialog'),
  mediaPreviewImage: document.querySelector('#mediaPreviewImage'),
  mediaPreviewCaption: document.querySelector('#mediaPreviewCaption'),
  mediaPreviewCounter: document.querySelector('#mediaPreviewCounter'),
  mediaPreviewStage: document.querySelector('#mediaPreviewStage'),
  previewPrevious: document.querySelector('#previewPrevious'),
  previewNext: document.querySelector('#previewNext'),
  previewZoomOut: document.querySelector('#previewZoomOut'),
  previewZoomReset: document.querySelector('#previewZoomReset'),
  previewZoomIn: document.querySelector('#previewZoomIn'),
  previewZoomValue: document.querySelector('#previewZoomValue'),
  reviewActionContent: document.querySelector('.review-action-content'),
  reviewStepButtons: [...document.querySelectorAll('[data-review-step-target]')],
  stageTabs: [...document.querySelectorAll('[data-stage-target]')],
  stagePanels: [...document.querySelectorAll('[data-stage-panel]')],
};

for (const strip of [elements.identityPreviewGrid, elements.customerPhotoPoolGrid]) attachHorizontalWheelScroll(strip);

const requestedLocation = parseRunLocation(window.location.search);
let currentRunId = requestedLocation.runId;
let currentRunOpenedFromHistory = requestedLocation.fromHistory;
let currentManifest = null;
let captureBusy = false;
const captureRefreshState={runId:null,timer:null,deadline:0,inFlight:false};
let smartTaskWorkflow=null;
let smartResolved=null;
let smartRestoredRunId=null;
let templateChoiceRevision=0;
const pendingTemplateChoices=new Set();
let customerPoolLoading=null;
let runHydration=null;
let userStageRevision=0;
let smartDraftCustomerId=sessionStorage.getItem('ai-img-gen.smart-draft-customer')||'';
let resultWorkbench = null;
let activeReuseDraft = null;
let reuseFileDescriptors = new Map();
let selectedArtifactId = null;
let activeStage = 'references';
let inspectorDirty = false;
let activeReviewViewOverride = '';
let pendingReviewMessage = '';
const referenceFileState = { identity: [], templates: [] };
const referencePreviewUrls = { identity: [], templates: [] };
let activePasteTarget = null;
const browserFetch = window.fetch.bind(window);
const templateLibraryController = createTemplateLibraryController({ fetch: browserFetch });
const recommendationController = createRecommendationController({ fetch: browserFetch });
const faceAngleAnalyzer = getDefaultFaceAngleAnalyzer();
const faceAngleWorkflow = createFaceAngleWorkflow({ analyze: (source, context) => faceAngleAnalyzer.analyzeFacePose(source, context) });
let faceAngleViewState = faceAngleWorkflow.getState();
let faceAngleInputRevision = 0;
let manualPrimaryIdentityIndex = null;
let manualAngleCoverageTouched = false;
let faceAngleCapability = 'checking';
let artifactRevisionCapability = 'checking';
let foundationCustomers = [];
let customerPhotoPoolState = createCustomerPhotoPoolState();
let managedCustomerPhotoOrdinal = null;
let customerPhotoMenuRestoreFocus = null;
let showAllRecommendations = false;
let previewItems = [];
let previewIndex = 0;
let previewTrigger = null;
let previewTransform = { zoom: 1, x: 0, y: 0 };
let previewDrag = null;
let historyRunsById = new Map();
let historyRuns = [];
let historyWorkspaceState = createHistoryWorkspaceState();
let activeHistoryRecordId = null;
let activeWorkLibraryView = 'all';
let primaryActionBusy = false;
let generationMode = null;
const templateSelectionSources = new Map();
const historyReturnStorageKey = 'ai-img-gen.history-return-record';
const homeNoticeStorageKey = 'ai-img-gen.home-notice';
const runCreationStorageKey = 'ai-img-gen.pending-run-creation-idempotency-key';

function pendingRunCreationIdempotencyKey() {
  const existing = sessionStorage.getItem(runCreationStorageKey);
  if (existing) return existing;
  const created = `run-create:${crypto.randomUUID()}`;
  sessionStorage.setItem(runCreationStorageKey, created);
  return created;
}

function clearPendingRunCreationIdempotencyKey() {
  sessionStorage.removeItem(runCreationStorageKey);
}

const statusLabels = {
  prepared: '本地已准备',
  staged: '已装载，未发送',
  submitted: '已发送，等待结果',
  submission_uncertain: '发送状态待确认',
  provider_rate_limited: 'ChatGPT 暂时限流',
  provider_error: 'ChatGPT 返回错误',
  artifacts_saved: '结果已保存',
  preference_pending: '评分已保存，暂未决定',
  completed: '本次评审已完成',
};

const verdictLabels = {
  identity_rejected: '人脸不一致，直接淘汰',
  client_mismatch_revise: '客户适配不足，不进入最好看比较',
  naturalness_revise: '真实自然不足，不进入最好看比较',
  style_revise: '目标风格不一致，不进入最好看比较',
  emotion_revise: '情绪表达不足，不进入最好看比较',
  coherence_revise: '元素不统一，不进入最好看比较',
  hierarchy_revise: '视觉主次不清，不进入最好看比较',
  qualified: '全部门槛通过，可参与最好看选择',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function readableFailure(value){
  const text=String(value||'').replace(/\u001b\[[0-9;]*m/g,'');
  if(/TimeoutError|Timeout \d+ms exceeded|browserBackend\.callTool/.test(text))return 'ChatGPT 页面或控件暂未就绪。任务已保留，系统不会自动重发。';
  if(/did not export verifiable original image bytes/.test(text))return '浏览器暂未提供可验证的原图响应，请稍后检测或手动导入。';
  return text.split(/\r?\n/).filter(line=>line.trim()&&!/^###/.test(line))[0]?.slice(0,220)||'操作未完成，请稍后重试。';
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(readableFailure(data.error?.message || data.error || `请求失败：${response.status}`));
    error.status = response.status;
    error.code = data.error?.code || null;
    error.runId = data.error?.run_id || null;
    throw error;
  }
  return data;
}

function previewDeckForRun({ runId, templateTotal = 0, templateReferences = [], identityTotal = 0, artifacts = [] }) {
  const encodedRunId = encodeURIComponent(runId);
  return orderedPreviewItems({
    templates: Array.from({ length: templateTotal }, (_, index) => {
      const reference = templateReferences[index] || {};
      const evidence = formatHistoryTemplateItem(reference);
      return {
        kind: 'template',
        url: `/api/runs/${encodedRunId}/references/template/${index}/file`,
        caption: evidence.isCatalog ? evidence.name : `参考图 ${index + 1}`,
        ...evidence,
        selectedRank: reference.selected_rank ?? null,
        relevanceScore: reference.relevance_score ?? null,
        rankingPolicyVersion: reference.ranking_policy_version || null,
        catalogProjectionVersion: reference.catalog_projection_version || null,
        referenceImageSha256: reference.reference_image_sha256 || reference.sha256 || null,
        generationBlueprintSha256: reference.generation_blueprint_sha256 || null,
      };
    }),
    identities: Array.from({ length: identityTotal }, (_, index) => ({
      kind: 'identity',
      url: `/api/runs/${encodedRunId}/references/identity/${index}/file`,
      caption: `客户图 ${index + 1}`,
    })),
    generated: artifacts.map((artifact, index) => ({
      kind: 'generated',
      url: `/api/runs/${encodedRunId}/artifacts/${encodeURIComponent(artifact.artifact_id)}/file`,
      caption: `生成图 ${artifact.ordinal || index + 1}`,
    })),
  });
}

function previewDeckForManifest(runId, manifest) {
  return previewDeckForRun({
    runId,
    templateTotal: manifest?.template_references?.length || 0,
    templateReferences: manifest?.template_references || [],
    identityTotal: manifest?.identity_references?.length || 0,
    artifacts: manifest?.artifacts || [],
  });
}

function applyPreviewTransform() {
  const { zoom, x, y } = previewTransform;
  elements.mediaPreviewImage.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${zoom})`;
  elements.previewZoomValue.textContent = `${Math.round(zoom * 100)}%`;
}

function resetPreviewTransform() {
  previewTransform = { zoom: 1, x: 0, y: 0 };
  previewDrag = null;
  elements.mediaPreviewStage.classList.remove('dragging');
  applyPreviewTransform();
}

function setPreviewZoom(nextZoom) {
  previewTransform.zoom = clampPreviewZoom(nextZoom);
  applyPreviewTransform();
}

function preloadAdjacentPreview() {
  if (previewItems.length < 2) return;
  for (const delta of [-1, 1]) {
    const item = previewItems[wrappedPreviewIndex(previewIndex, delta, previewItems.length)];
    if (!item?.url) continue;
    const image = new Image();
    image.src = item.url;
  }
}

function renderMediaPreview() {
  const item = previewItems[previewIndex];
  if (!item) return;
  resetPreviewTransform();
  elements.mediaPreviewImage.src = item.url;
  elements.mediaPreviewImage.alt = item.caption;
  elements.mediaPreviewCaption.textContent = item.caption;
  elements.mediaPreviewCounter.textContent = `${previewIndex + 1} / ${previewItems.length}`;
  const multiple = previewItems.length > 1;
  elements.previewPrevious.hidden = !multiple;
  elements.previewNext.hidden = !multiple;
  preloadAdjacentPreview();
}

function openMediaPreview(items, index = 0, trigger = null) {
  if (!items.length) return;
  previewItems = items;
  previewIndex = wrappedPreviewIndex(index, 0, items.length);
  previewTrigger = trigger;
  renderMediaPreview();
  if (!elements.mediaPreviewDialog.open) elements.mediaPreviewDialog.showModal();
}

function moveMediaPreview(delta) {
  if (!previewItems.length) return;
  previewIndex = wrappedPreviewIndex(previewIndex, delta, previewItems.length);
  renderMediaPreview();
}

function closeMediaPreview() {
  if (elements.mediaPreviewDialog.open) elements.mediaPreviewDialog.close();
}

function formatHistoryDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function historicalRecordState(run) {
  return {
    pending_review: { key: 'pending-review', badge: 'pending', label: '待评' },
    pending_choice: { key: 'pending-choice', badge: 'choice', label: '待选择' },
    completed: { key: 'record-complete', badge: 'complete', label: '已完成' },
  }[deriveHistoryRunState(run)];
}

function historyRunCard(run, { child = false } = {}) {
  const runId = encodeURIComponent(run.run_id);
  const recordState = historicalRecordState(run);
  const progressState = Number(run.reviewed_count || 0) < Number(run.artifact_count || 0) ? 'pending' : 'complete';
  const artifacts = (run.artifacts || []).map((artifact) => {
    const url = `/api/runs/${runId}/artifacts/${encodeURIComponent(artifact.artifact_id)}/file`;
    return `<button class="history-result-thumb" type="button" data-preview-url="${escapeHtml(url)}" data-preview-caption="${escapeHtml(`${run.customer_name || '未命名客户'} · 成品 ${artifact.ordinal}`)}" aria-label="预览成品 ${artifact.ordinal}">
      <img src="${escapeHtml(url)}" alt="成品 ${artifact.ordinal}" loading="lazy">
      <span>${String(artifact.ordinal).padStart(2, '0')}</span>
    </button>`;
  }).join('');
  const batch = run.history_import?.batch_label || (run.image_api ? 'API 生成记录' : '网页生成记录');
  const relation = child || run.relationLabel ? `<span class="history-revision-badge">${escapeHtml(run.relationLabel || '修改版')}</span>` : '';
  const learningWarning = run.template_learning?.state === 'degraded'
    ? '<span class="history-progress-tag pending">模板证据异常</span>'
    : '';
  const children = (run.children || []).map((item) => historyRunCard(item, { child: true })).join('');
  return `<div class="history-run-tree${child ? ' is-child' : ''}"><article class="history-run-card ${recordState.key}" data-history-run="${escapeHtml(run.run_id)}">
    <div class="history-result-list">${artifacts}</div>
    <div class="history-run-copy history-record-trigger" role="button" tabindex="0" data-view-history-record="${escapeHtml(run.run_id)}" aria-label="查看${escapeHtml(run.customer_name || '未命名客户')}的历史记录">
      <div class="history-run-title"><strong>${escapeHtml(run.customer_name || '未命名客户')}</strong>${relation}<span class="history-review-status ${recordState.badge}">${recordState.label}</span><time>${escapeHtml(formatHistoryDate(run.created_at))}</time></div>
      <div class="history-run-meta"><span class="history-meta-tag">${escapeHtml(batch)}</span><span class="history-meta-tag">${run.identity_count} 张身份图</span><span class="history-meta-tag">${run.template_count} 张模板图</span><span class="history-progress-tag ${progressState}">${run.reviewed_count} / ${run.artifact_count} 已评分</span>${learningWarning}</div>
      <p class="history-prompt-summary" title="进入详情查看完整提示词">${escapeHtml(run.prompt || '未记录提示词')}</p>
    </div>
  </article>${children}</div>`;
}

function historyRecordMediaGroup(title, items) {
  if (!items.length) return '';
  return `<section class="history-record-media-group"><div><strong>${title}</strong><span>${items.length} 张</span></div><div>${items.map((item) => {
    const badge = item.badgeText ? `<span class="template-badge">${escapeHtml(item.badgeText)}</span>` : '';
    const userEvidenceRows = item.isCatalog ? [
      item.badgeText ? `来源：${item.badgeText}` : '来源：模板库',
      item.selectedRank != null ? `系统推荐第 ${item.selectedRank} 位` : '',
      item.relevanceScore != null ? `相关度 ${item.relevanceScore}` : '',
    ].filter(Boolean) : [];
    const technicalRows = item.isCatalog ? [
      item.templateUid ? `模板编号：${item.templateUid}` : '',
      item.rankingPolicyVersion ? `排序规则：${item.rankingPolicyVersion}` : '',
      item.catalogProjectionVersion ? `模板库版本：${item.catalogProjectionVersion}` : '',
      item.referenceImageSha256 ? `参考图校验码：${item.referenceImageSha256.slice(0, 12)}…` : '',
      item.generationBlueprintSha256 ? `生成蓝图校验码：${item.generationBlueprintSha256.slice(0, 12)}…` : '',
    ].filter(Boolean) : [];
    const technicalEvidence = technicalRows.length
      ? `<details class="history-technical-evidence"><summary>技术证据</summary>${technicalRows.map((row) => `<small>${escapeHtml(row)}</small>`).join('')}</details>`
      : '';
    const evidence = userEvidenceRows.length || technicalEvidence
      ? `<div class="history-template-evidence"><strong>${escapeHtml(item.name)}</strong>${userEvidenceRows.map((row) => `<small>${escapeHtml(row)}</small>`).join('')}${technicalEvidence}</div>`
      : '';
    return `<article class="history-record-media-item"><button type="button" class="history-record-thumb" data-preview-url="${escapeHtml(item.url)}" data-preview-caption="${escapeHtml(item.caption)}" aria-label="预览${escapeHtml(item.caption)}"><img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.caption)}" loading="lazy">${badge}</button>${evidence}</article>`;
  }).join('')}</div></section>`;
}

function applyHistoryWorkspaceView() {
  const isList = historyWorkspaceState.view === 'list';
  const isImport = historyWorkspaceState.view === 'import';
  const isDetail = historyWorkspaceState.view === 'detail';
  elements.historyContent.hidden = isDetail;
  elements.historyRecordView.hidden = !isDetail;
  elements.historyLibraryView.hidden = !isList;
  elements.historyImportView.hidden = !isImport;
  elements.openHistoryImport.hidden = !isList;
  if (isList) {
    elements.historyHeaderAction.textContent = '关闭';
    elements.historyHeaderAction.setAttribute('aria-label', '关闭历史生成结果');
  } else {
    elements.historyHeaderAction.textContent = '返回';
    elements.historyHeaderAction.setAttribute('aria-label', '返回历史列表');
  }
}

function showHistoryList() {
  activeHistoryRecordId = null;
  historyWorkspaceState = transitionHistoryWorkspace(historyWorkspaceState, { type: 'BACK_TO_LIST' });
  applyHistoryWorkspaceView();
  renderHistory(historyRuns);
}

function showHistoryImport() {
  activeHistoryRecordId = null;
  historyWorkspaceState = transitionHistoryWorkspace(historyWorkspaceState, { type: 'OPEN_IMPORT' });
  applyHistoryWorkspaceView();
}

function showHistoryRecord(runId) {
  const run = historyRunsById.get(runId);
  if (!run) return false;
  activeHistoryRecordId = runId;
  historyWorkspaceState = transitionHistoryWorkspace(historyWorkspaceState, { type: 'OPEN_DETAIL', runId });
  applyHistoryWorkspaceView();
  const state = historicalRecordState(run);
  elements.historyRecordTitle.textContent = run.customer_name || '未命名客户';
  elements.historyRecordSummary.textContent = `${state.label} · ${run.reviewed_count} / ${run.artifact_count} 已评分 · ${formatHistoryDate(run.created_at)}`;
  const deck = previewDeckForRun({
    runId: run.run_id,
    templateTotal: run.template_count,
    templateReferences: run.template_references || [],
    identityTotal: run.identity_count,
    artifacts: run.artifacts,
  });
  elements.historyRecordMedia.innerHTML = [
    historyRecordMediaGroup('参考图', deck.filter((item) => item.kind === 'template')),
    historyRecordMediaGroup('客户图', deck.filter((item) => item.kind === 'identity')),
    historyRecordMediaGroup('生成图', deck.filter((item) => item.kind === 'generated')),
  ].join('');
  const form = elements.historyRecordForm;
  form.elements.runId.value = run.run_id;
  form.elements.customerName.value = run.customer_name || '';
  form.elements.batchLabel.value = run.history_import?.batch_label || '';
  form.elements.intendedUse.value = run.intended_use || '';
  form.elements.prompt.value = run.prompt || '';
  elements.historyRecordMessage.textContent = run.record_revision ? `已保存 ${run.record_revision} 次信息修订。` : '尚未修改。';
  const details=document.querySelector('#historyGenerationDetails');
  if(details){details.innerHTML='<summary>生成详情（发送记录）</summary><p>正在读取…</p>';details.open=false;
    api(`/api/runs/${encodeURIComponent(runId)}`).then(data=>{if(activeHistoryRecordId!==runId)return;details.innerHTML=`<summary>生成详情（发送记录）</summary>${generationDetailsMarkup(data.generation_details)}`;
      if(data.manifest.run_kind==='artifact_revision'){
        const refs=data.generation_details.references||[];const group=(title,roles)=>historyRecordMediaGroup(title,refs.filter(r=>r.url&&roles.includes(r.role)).map(r=>({url:r.url,caption:r.name||title})));
        elements.historyRecordMedia.innerHTML=group('修改前成品',['clean_original'])+group('客户图',['identity_support'])+group('模板图',['style_reference'])+group('批注定位图',['annotated_location_guidance'])+historyRecordMediaGroup('生成图',deck.filter(item=>item.kind==='generated'));
      }
    }).catch(error=>{if(activeHistoryRecordId===runId)details.textContent=`生成详情不可用：${error.message}`;});
  }
  return true;
}

function renderHistory(runs) {
  historyRuns = Array.isArray(runs) ? runs : [];
  historyRunsById = new Map(historyRuns.map((run) => [run.run_id, run]));
  const options = historyCustomerOptions(historyRuns);
  elements.historyCustomerFilter.innerHTML = ['<option value="">全部客户</option>', ...options.map((option) => `<option value="${escapeHtml(option.key)}">${escapeHtml(option.label)}</option>`)].join('');
  if (historyWorkspaceState.customerKey && !options.some((option) => option.key === historyWorkspaceState.customerKey)) {
    historyWorkspaceState = transitionHistoryWorkspace(historyWorkspaceState, { type: 'SET_CUSTOMER', value: '' });
  }
  elements.historySearch.value = historyWorkspaceState.query;
  elements.historyCustomerFilter.value = historyWorkspaceState.customerKey;
  elements.historyStatusFilter.value = historyWorkspaceState.status;
  elements.historySort.value = historyWorkspaceState.sort;
  const visibleRuns = filterAndSortHistoryRuns(historyRuns, historyWorkspaceState);
  const library = buildWorkLibrary(visibleRuns, { view: activeWorkLibraryView });
  elements.historyResultCount.textContent = `${library.runCount} / ${historyRuns.length} 条记录`;
  for (const button of elements.workLibraryViewButtons) {
    const active = button.dataset.workLibraryView === activeWorkLibraryView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  elements.historyList.innerHTML = library.groups.length
    ? library.groups.map((group) => `<section class="work-library-customer-group"><header><strong>${escapeHtml(group.customerLabel)}</strong><span>${group.runs.length} 组任务</span></header>${group.runs.map((run) => historyRunCard(run)).join('')}</section>`).join('')
    : `<div class="empty-state">${historyRuns.length ? '没有符合当前筛选的记录。' : '还没有保存过可评审的成品记录。'}</div>`;
  renderWorkLibraryMetrics(historyRuns);
}

function renderWorkLibraryMetrics(runs) {
  const metrics = deriveWorkLibraryMetrics(runs);
  const items = [metrics.reviewed, metrics.finalChoice, metrics.completeTemplateLoop, metrics.templatesWithRealOutcomes];
  elements.compoundingSummary.innerHTML = items.map((item) => {
    const value = item.evidence_state === 'degraded'
      ? `证据异常 · 已确认 ${item.value}`
      : item.total == null ? item.value : `${item.value} / ${item.total}`;
    const label = item.evidence_state === 'degraded'
      ? `${item.label}（${item.degraded_run_count} 个任务需检查）`
      : item.label;
    return `<div class="compounding-metric"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`;
  }).join('');
}

function metricPercent(metric) {
  const value = metric && typeof metric === 'object' ? metric.value : metric;
  return value == null || !Number.isFinite(Number(value)) ? '证据不足' : `${Math.round(Number(value) * 100)}%`;
}

function renderCompoundingSummary(metrics = {}) {
  const items = [
    ['评审完成率', metricPercent(metrics.artifact_review_coverage)],
    ['最终选择率', metricPercent(metrics.final_preference_coverage)],
    ['Outcome 覆盖', metricPercent(metrics.template_outcome_coverage)],
    ['v6 覆盖', metricPercent(metrics.prompt_compilation_coverage)],
  ];
  elements.compoundingSummary.innerHTML = items.map(([label, value]) => `<div class="compounding-metric"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join('');
}

async function loadCompoundingSummary() {
  try {
    const data = await api('/api/compounding/metrics');
    renderCompoundingSummary(data.metrics || {});
  } catch {
    elements.compoundingSummary.innerHTML = '<span>复利指标尚未建立；当前人工评审仍正常保存。</span>';
  }
}

async function loadHistory() {
  elements.historyList.innerHTML = '<div class="empty-state">正在读取历史记录。</div>';
  try {
    const data = await api('/api/runs?artifactsOnly=true&limit=200');
    renderHistory(data.runs || []);
    return data.runs || [];
  } catch (error) {
    elements.historyList.innerHTML = `<div class="empty-state">无法读取历史记录：${escapeHtml(error.message)}</div>`;
    return [];
  }
}

function setBusy(button, busy, text) {
  if (!button) return;
  if (busy) {
    if(button.dataset.busy!=='true')button.dataset.originalText = button.textContent;
    button.dataset.busy='true';
    button.textContent = text;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    delete button.dataset.originalText;
    delete button.dataset.busy;
    button.disabled = false;
  }
}

function setStage(stage) {
  if (!elements.stagePanels.some((panel) => panel.dataset.stagePanel === stage)) return;
  if (stage !== 'references' && !currentRunId) return;
  activeStage = stage;
  for (const panel of elements.stagePanels) panel.hidden = panel.dataset.stagePanel !== stage;
  for (const tab of elements.stageTabs) {
    const selected = tab.dataset.stageTarget === stage;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
  }
}

function updateStageAvailability(manifest) {
  const hasRun = Boolean(currentRunId);
  if (elements.newTaskButton) elements.newTaskButton.hidden = !hasRun;
  const hasArtifacts = (manifest?.artifacts || []).length > 0;
  const reviewComplete = ['winner', 'none'].includes(manifest?.preference?.decision);
  const availability = deriveStageAvailability({ currentRunId, manifest: manifest || {} });
  for (const tab of elements.stageTabs) {
    const stage = tab.dataset.stageTarget;
    tab.disabled = availability[stage] !== true;
    const complete = stage === 'references' ? hasRun
      : stage === 'generation' ? ['submitted', 'submission_uncertain', 'artifacts_saved', 'preference_pending', 'completed'].includes(manifest?.status)
        : stage === 'results' ? hasArtifacts
          : reviewComplete;
    tab.classList.toggle('complete', complete);
  }
}

function renderBrowserStatus(data) {
  elements.appState.textContent = '已运行';
  elements.appState.className = 'good-text';
  elements.browserState.textContent = data.browser.ready ? '已连接' : data.browser.state === 'not_checked' ? '未检查' : '需检查';
  elements.browserState.title = data.browser.message;
  elements.browserState.className = data.browser.ready ? 'good-text' : 'warn-text';
}

function renderCustomerFieldVisibility() {
  const selectedCustomerId = String(elements.customerSelector?.value || '');
  const visibility = deriveCustomerFieldVisibility({ mode: selectedCustomerId ? 'existing' : 'new' });
  if (elements.existingCustomerFields) elements.existingCustomerFields.hidden = false;
  if (elements.newCustomerFields) elements.newCustomerFields.hidden = !visibility.showNewCustomerFields;
  if (elements.customerName) elements.customerName.required = !smartTaskWorkflow && visibility.requiresNewCustomerName;
}

function selectedOptionText(control) {
  return control?.selectedOptions?.[0]?.textContent?.trim() || '';
}

function currentSendSummary() {
  const managedReferences = customerPhotoPoolState.references || [];
  const primaryManaged = managedReferences.find((reference) => reference.ordinal === customerPhotoPoolState.primaryOrdinal);
  const identityReferences = customerPhotoPoolState.selectedOrdinals?.length
    ? customerPhotoPoolState.selectedOrdinals.map((ordinal) => managedReferences.find((reference) => reference.ordinal === ordinal) || { ordinal })
    : referenceFileState.identity.map((file, index) => ({
      display_name: file.name || `身份图 ${index + 1}`,
      role: index === manualPrimaryIdentityIndex ? 'primary' : 'support',
    }));
  const templateReferences = [
    ...referenceFileState.templates.map((file) => ({ template_name: file.name || '上传模板' })),
    ...templateLibraryController.getSelectedTemplates().map((item) => ({ template_name: item.name })),
  ];
  const overrides = {};
  const labels = {
    targetFraming: '景别',
    targetIntentAngle: '角度',
    layoutIntent: '版式',
    temperamentKeywords: '气质',
    businessDomain: '客户领域',
  };
  const targetFraming = document.querySelector('#targetFraming')?.value || '';
  const targetIntentAngle = document.querySelector('#targetIntentAngle')?.value || '';
  const layoutIntent = document.querySelector('#layoutIntent')?.value || '';
  const temperamentKeywords = [...document.querySelectorAll('input[name="temperamentKeywords"]:checked')].map((item) => item.parentElement?.textContent?.trim() || item.value);
  const businessDomain = document.querySelector('#businessDomain')?.value?.trim() || '';
  if (targetFraming && targetFraming !== 'follow_template') overrides.targetFraming = selectedOptionText(document.querySelector('#targetFraming'));
  if (targetIntentAngle && targetIntentAngle !== 'follow_identity') overrides.targetIntentAngle = selectedOptionText(document.querySelector('#targetIntentAngle'));
  if (layoutIntent && layoutIntent !== 'follow_template') overrides.layoutIntent = selectedOptionText(document.querySelector('#layoutIntent'));
  if (temperamentKeywords.length) overrides.temperamentKeywords = temperamentKeywords;
  if (businessDomain) overrides.businessDomain = businessDomain;
  if(smartTaskWorkflow&&smartEditingEnabled()){
    const manual=smartTaskWorkflow.manual;
    for(const key of Object.keys(overrides)){const field=key==='targetIntentAngle'?'targetFaceAngle':key;if(manual[field]==null)delete overrides[key];}
  }
  const selectedCustomer = foundationCustomers.find((item) => item.customer_id === elements.customerSelector?.value);
  const enteredCustomer=String(elements.customerName?.value||'').trim();
  const summaryCustomer=selectedCustomer||(enteredCustomer.startsWith('未命名客户-')?'本次新客户':enteredCustomer);
  const apiText=document.querySelector('#generationMode')?.value==='api'&&document.querySelector('#apiOperation')?.value==='generate';
  return buildSendSummary({
    customer: summaryCustomer,
    identityReferences:apiText?[]:identityReferences,
    identityCount: apiText?0:identityReferences.length,
    primaryIdentity: apiText?null:primaryManaged || identityReferences.find((item) => item.role === 'primary'),
    templateReferences:apiText?[]:templateReferences,
    templateCount: apiText?0:templateReferences.length,
    useCase: smartResolved?.task_intent?.custom_use_case||selectedOptionText(document.querySelector('#intendedUse')),
    explicitOverrides: overrides,
    overrideLabels: labels,
  });
}

function renderSendSummary() {
  const summary = currentSendSummary();
  const missing = !currentRunId && !summary.identities.count && !(document.querySelector('#generationMode')?.value === 'api' && document.querySelector('#apiOperation')?.value === 'generate');
  document.querySelector('#prepareRun')?.setAttribute('aria-disabled', String(missing));
  const hint = document.querySelector('#creationReadiness');
  if (hint) { hint.hidden = !missing; hint.textContent = missing ? '先添加一张客户照片，即可继续' : ''; }
  if (!missing && elements.prepareResult.textContent === '请先添加一张客户照片，或从已有客户中选择照片。') elements.prepareResult.textContent = '';
}


async function loadFoundationCustomers() {
  if (!elements.customerSelector) return;
  const data = await api('/api/customers').catch(() => ({ customers: [] }));
  foundationCustomers = data.customers || [];
  elements.customerSelector.innerHTML = '<option value="">本次上传新客户</option>' + foundationCustomers.map((item) => `<option value="${escapeHtml(item.customer_id)}">${escapeHtml(item.display_name || item.customer_id)}</option>`).join('');
  renderCustomerFieldVisibility();
  renderSendSummary();
}

function clearUploadedIdentityFiles() {
  referenceFileState.identity = [];
  setReferenceInputFiles(elements.identityInput, []);
  manualPrimaryIdentityIndex = null;
  manualAngleCoverageTouched = false;
  renderReferencePreviews('identity');
}

function useIdentityUploadMode({ clearPool = true } = {}) {
  closeCustomerPhotoContextMenu();
  if (clearPool) {
    customerPhotoPoolState = createCustomerPhotoPoolState();
    elements.customerPhotoPoolGrid.innerHTML = '';
    elements.customerPhotoPoolSummary.textContent = '等待选择客户';
    elements.customerPhotoPoolMessage.textContent = '';
  }
  elements.customerPhotoPool.hidden = true;
  elements.identityUploadWorkspace.hidden = false;
  elements.identityInput.disabled = false;
  if (elements.identityAngleFallback) elements.identityAngleFallback.hidden = false;
  elements.identityQuality.textContent = referenceFileState.identity.length ? `已选择 ${referenceFileState.identity.length} 张` : '等待上传';
  elements.identityQuality.className = `quality-badge${referenceFileState.identity.length ? ' ready' : ''}`;
}

function renderCustomerPhotoPool({semantic=true}={}) {
  closeCustomerPhotoContextMenu();
  const state = customerPhotoPoolState;
  if (!state.identitySetId || !state.references.length) { useIdentityUploadMode({ clearPool: false }); return; }
  const selected = new Set(state.selectedOrdinals);
  elements.customerPhotoPool.hidden = false;
  elements.identityUploadWorkspace.hidden = true;
  elements.identityInput.disabled = true;
  if (elements.identityAngleFallback) elements.identityAngleFallback.hidden = true;
  elements.customerPhotoPoolGrid.innerHTML = state.references.map((reference) => {
    const isSelected = selected.has(reference.ordinal);
    const isPrimary = state.primaryOrdinal === reference.ordinal;
    const name = reference.original_name || `客户照片 ${reference.ordinal}`;
    const url = customerPhotoReferenceUrl({ customerId: state.customerId, identitySetId: state.identitySetId, ordinal: reference.ordinal });
    return `<article class="customer-pool-tile${isSelected ? ' is-selected' : ''}${isPrimary ? ' is-primary' : ''}" role="option" tabindex="0" aria-selected="${isSelected}" aria-label="${escapeHtml(name)}，右键管理照片" data-pool-ordinal="${reference.ordinal}" data-pool-sha256="${escapeHtml(reference.sha256 || '')}">
      <button type="button" class="customer-pool-select" data-pool-toggle="${reference.ordinal}" aria-pressed="${isSelected}" aria-label="${isSelected ? '取消选择' : '选择'} ${escapeHtml(name)}">
        <img src="${escapeHtml(url)}" alt="客户照片 ${reference.ordinal}"><span class="customer-pool-check">✓</span>${isPrimary ? '<span class="customer-pool-primary-badge">主身份图</span>' : ''}
      </button>
      <div class="customer-pool-meta"><div><strong>${escapeHtml(name)}</strong><small>${reference.role==='primary_front'?'主身份参考':'身份辅助参考'}</small></div><button type="button" class="customer-pool-primary${isPrimary ? ' is-primary' : ''}" data-pool-primary="${reference.ordinal}"${isSelected ? '' : ' disabled'}>${isPrimary ? '当前主图' : '设为主图'}</button></div>
    </article>`;
  }).join('');
  elements.customerPhotoPoolSummary.textContent = `已选择 ${state.selectedOrdinals.length} / ${state.references.length} 张 · 最多 4 张`;
  elements.customerPhotoPoolMessage.textContent = state.limitReached ? '一次最多选择 4 张客户照片。' : '点击图片选择；右键可重命名或删除，主身份图会排在本次生成的第 1 张。';
  elements.customerPhotoPoolMessage.classList.toggle('is-warning', state.limitReached);
  elements.identityQuality.textContent = state.primaryOrdinal ? `照片池 · ${state.selectedOrdinals.length} 张` : '请从照片池选择';
  elements.identityQuality.className = `quality-badge${state.selectedOrdinals.length ? ' ready' : ''}`;
  elements.identityAngleStatus.textContent = state.primaryOrdinal ? `照片池第 ${state.primaryOrdinal} 张为主身份图` : '请先选择一张客户照片';
  smartTaskWorkflow?.schedule({semantic});
}

function managedCustomerPhotoReference() {
  return customerPhotoPoolState.references.find((reference) => Number(reference.ordinal) === Number(managedCustomerPhotoOrdinal)) || null;
}

function closeCustomerPhotoContextMenu({ restoreFocus = false } = {}) {
  if (!elements.customerPhotoContextMenu) return;
  elements.customerPhotoContextMenu.hidden = true;
  if (restoreFocus && customerPhotoMenuRestoreFocus?.isConnected) customerPhotoMenuRestoreFocus.focus();
  customerPhotoMenuRestoreFocus = null;
}

function openCustomerPhotoContextMenu({ ordinal, x, y, trigger = null }) {
  const reference = customerPhotoPoolState.references.find((item) => Number(item.ordinal) === Number(ordinal));
  if (!reference || !elements.customerPhotoContextMenu) return;
  managedCustomerPhotoOrdinal = Number(reference.ordinal);
  customerPhotoMenuRestoreFocus = trigger;
  const removeButton = elements.customerPhotoContextMenu.querySelector('[data-customer-photo-action="remove"]');
  if (removeButton) {
    removeButton.disabled = customerPhotoPoolState.references.length <= 1;
    removeButton.title = removeButton.disabled ? '身份池必须至少保留一张照片' : '';
  }
  elements.customerPhotoContextMenu.style.left = '0px';
  elements.customerPhotoContextMenu.style.top = '0px';
  elements.customerPhotoContextMenu.hidden = false;
  requestAnimationFrame(() => {
    if (elements.customerPhotoContextMenu.hidden) return;
    const menuBox = elements.customerPhotoContextMenu.getBoundingClientRect();
    const position = customerPhotoContextMenuPosition({
      x,
      y,
      menuWidth: menuBox.width,
      menuHeight: menuBox.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      margin: 8,
    });
    elements.customerPhotoContextMenu.style.left = `${position.left}px`;
    elements.customerPhotoContextMenu.style.top = `${position.top}px`;
    elements.customerPhotoContextMenu.querySelector('[data-customer-photo-action="rename"]')?.focus();
  });
}

function photoNameParts(reference) {
  const originalName = String(reference?.original_name || `客户照片 ${reference?.ordinal || ''}`).trim();
  const extension = String(reference?.extension || originalName.match(/\.(png|jpe?g|webp)$/i)?.[0] || '').toLowerCase();
  const base = extension && originalName.toLowerCase().endsWith(extension)
    ? originalName.slice(0, -extension.length)
    : originalName;
  return { base, extension };
}

function openCustomerPhotoRenameDialog() {
  const reference = managedCustomerPhotoReference();
  if (!reference || !elements.customerPhotoRenameDialog) return;
  const { base, extension } = photoNameParts(reference);
  elements.customerPhotoRenameInput.value = base;
  elements.customerPhotoRenameExtension.textContent = extension;
  elements.customerPhotoRenameMessage.textContent = '';
  if (!elements.customerPhotoRenameDialog.open) elements.customerPhotoRenameDialog.showModal();
  requestAnimationFrame(() => {
    elements.customerPhotoRenameInput.focus();
    elements.customerPhotoRenameInput.select();
  });
}

async function mutateManagedCustomerPhoto({ method, name = '' }) {
  const reference = managedCustomerPhotoReference();
  const customerId = customerPhotoPoolState.customerId;
  const identitySetId = customerPhotoPoolState.identitySetId;
  const customer = foundationCustomers.find((item) => item.customer_id === customerId);
  if (!reference || !customerId || !identitySetId || !customer?.active_identity_set_id) throw new Error('照片池状态已变化，请刷新后重试');
  const previousState = customerPhotoPoolState;
  const body = {
    expected_reference_sha256: reference.sha256,
    expected_active_identity_set_id: customer.active_identity_set_id,
    ...(method === 'PATCH' ? { name } : {}),
  };
  const data = await api(`/api/customers/${encodeURIComponent(customerId)}/identity-sets/${encodeURIComponent(identitySetId)}/references/${reference.ordinal}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!data.no_changes) customer.active_identity_set_id = data.identity_set.identity_set_id;
  await loadFoundationActivePhotoPool(customerId, { previousState });
  return data;
}

async function removeManagedCustomerPhoto() {
  const reference = managedCustomerPhotoReference();
  if (!reference) return;
  if (customerPhotoPoolState.references.length <= 1) {
    elements.customerPhotoPoolMessage.textContent = '身份池必须至少保留一张照片，当前唯一照片不能删除。';
    elements.customerPhotoPoolMessage.classList.add('is-warning');
    return;
  }
  const name = reference.original_name || `客户照片 ${reference.ordinal}`;
  if (!window.confirm(`确定从当前身份池删除“${name}”吗？历史身份组和已有任务仍会保留原图。`)) {
    elements.customerPhotoPoolMessage.textContent = '已取消删除，照片池没有变化。';
    elements.customerPhotoPoolMessage.classList.remove('is-warning');
    return;
  }
  elements.customerPhotoPoolMessage.textContent = '正在从当前身份池删除照片…';
  try {
    await mutateManagedCustomerPhoto({ method: 'DELETE' });
    elements.customerPhotoPoolMessage.textContent = `已从当前身份池删除“${name}”；历史身份组仍保留原图。`;
    elements.customerPhotoPoolMessage.classList.remove('is-warning');
  } catch (error) {
    elements.customerPhotoPoolMessage.textContent = `无法删除照片：${error.message}`;
    elements.customerPhotoPoolMessage.classList.add('is-warning');
  }
}

async function appendCustomerPhotos(files = elements.customerPhotoAppendInput?.files) {
  const customerId = customerPhotoPoolState.customerId;
  const identitySetId = customerPhotoPoolState.identitySetId;
  const selectedFiles = Array.from(files || []);
  if (!customerId || !identitySetId || !selectedFiles.length) return;
  const form = new FormData();
  for (const file of selectedFiles) form.append('identity', file, file.name);
  setBusy(elements.appendCustomerPhotosButton, true, '添加中');
  try {
    const data = await api(`/api/customers/${encodeURIComponent(customerId)}/identity-sets/${encodeURIComponent(identitySetId)}/append`, { method: 'POST', body: form });
    const customer = foundationCustomers.find((item) => item.customer_id === customerId);
    if (customer) customer.active_identity_set_id = data.identity_set.identity_set_id;
    await loadFoundationActivePhotoPool(customerId);
    elements.customerPhotoPoolMessage.textContent = data.no_changes
      ? `没有新增照片：已跳过 ${data.duplicate_count} 张重复图片。`
      : `已添加 ${data.appended_count} 张照片${data.duplicate_count ? `，跳过 ${data.duplicate_count} 张重复图片` : ''}。`;
    elements.customerPhotoPoolMessage.classList.remove('is-warning');
  } catch (error) {
    elements.customerPhotoPoolMessage.textContent = `无法添加照片：${error.message}`;
    elements.customerPhotoPoolMessage.classList.add('is-warning');
  } finally {
    if (elements.customerPhotoAppendInput) elements.customerPhotoAppendInput.value = '';
    setBusy(elements.appendCustomerPhotosButton, false);
  }
}

function activateCustomerPhotoPool(identitySet, { previousState = null } = {}) {
  clearUploadedIdentityFiles();
  customerPhotoPoolState = previousState
    ? reconcileCustomerPhotoPoolState({ previousState, customerId: elements.customerSelector.value, identitySet, limit: 4 })
    : createCustomerPhotoPoolState({ customerId: elements.customerSelector.value, identitySet, limit: 4 });
  renderCustomerPhotoPool({semantic:false});
}

async function loadFoundationActivePhotoPool(customerId, { previousState = null } = {}) {
  if (!customerId) { useIdentityUploadMode(); return; }
  const loading=(async()=>{
    const data=await api(`/api/customers/${encodeURIComponent(customerId)}/identity-sets`);
    if(elements.customerSelector.value!==customerId)return;
    const customer = foundationCustomers.find((item) => item.customer_id === customerId);
    const selected = resolveActiveCustomerPhotoPool({ customer, identitySets: data.identity_sets || [] });
    elements.customerName.value = customer?.display_name || '';
    if (selected) {elements.customerName.value = customer?.display_name || selected.display_name || '';activateCustomerPhotoPool(selected,{previousState});}
    else useIdentityUploadMode();
  })();customerPoolLoading=loading;
  try{await loading;}finally{if(customerPoolLoading===loading)customerPoolLoading=null;}
}

async function previewFoundationPrompt() {
  const apiMode = generationMode?.usesApi();
  if(smartTaskWorkflow&&smartEditingEnabled()){
    const form=smartTaskWorkflow.formNow();form.set('previewPrompt','true');form.set('generationMode',apiMode?'api':'web');
    const response=await fetch('/api/task-resolutions',{method:'POST',headers:{'x-smart-task-client':'workstation'},body:form});const data=await response.json();
    if(!response.ok)throw new Error(data.error?.message||data.error||'无法预览提示词');
    if(apiMode&&(!data.compilation?.blocks?.some(b=>b.block_id==='validated-identity-transfer')||data.compilation.candidate_slate_request))throw new Error('服务尚未加载 API 换脸提示词更新，请重启 4577 服务后再操作；尚未发送');
    elements.compiledPromptPreview.textContent=data.compilation.compiled_prompt;
    elements.promptCompilationNotice.textContent='已使用同源换脸提示词，按当前图片、模板和手动设置预览；发送时重新校验，预览不触发生图。';
    return data.compilation;
  }
  const templateCount = templateLibraryController.getSelectedCount()+referenceFileState.templates.length;
  if(apiMode && (document.querySelector('#apiOperation').value !== 'edit' || !templateCount)){
    const prompt=apiPromptFromForm(new FormData(document.querySelector('#runForm')));
    elements.compiledPromptPreview.textContent=prompt;
    elements.promptCompilationNotice.textContent='API 模式发送内容预览';return;
  }
  const form = new FormData(document.querySelector('#runForm'));
  const selected = templateLibraryController.getSelectedTemplates();
  const payload = { taskIntent: taskIntentFromForm(form), identityReferenceTotal: Math.max(referenceFileState.identity.length, customerPhotoPoolState.selectedOrdinals.length), identityAngles: form.getAll('identityAngles'), templates: selected.map((item, index) => ({ ordinal: index + 2, sha256: item.reference_image_sha256, template_uid: item.uid, template_name: item.name, style_category: item.style_category, portrait_scale: item.portrait_scale, face_angle: item.face_angle })) };
  if (apiMode) {
    payload.generationMode = 'api';
    payload.templates = [...referenceFileState.templates.map(file=>({template_name:file.name})), ...selected.map(item=>({template_name:item.name}))]
      .map((item,index)=>({...item,ordinal:payload.identityReferenceTotal+index+1}));
  }
  const data = await api('/api/prompt-compilations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (apiMode && (!data.compilation.blocks?.some(block=>block.block_id==='validated-identity-transfer') || data.compilation.candidate_slate_request)) {
    throw new Error('服务尚未加载 API 换脸提示词更新，请重启 4577 服务后再操作；尚未发送');
  }
  elements.compiledPromptPreview.textContent = data.compilation.compiled_prompt;
  elements.promptCompilationNotice.textContent = apiMode ? 'API 已使用网页端同源换脸提示词；张数由 API 设置决定' : data.compilation.conflict_resolutions?.length ? `已处理 ${data.compilation.conflict_resolutions.length} 个意图冲突` : '提示词已按当前任务意图编译';
  return data.compilation;
}
async function loadStatus() {
  try {
    renderBrowserStatus(await api('/api/status'));
  } catch {
    elements.appState.textContent = '未连接';
    elements.appState.className = 'warn-text';
    elements.browserState.textContent = '无法读取状态';
    elements.browserState.className = 'warn-text';
  }
}

async function loadFaceAngleCapability() {
  try {
    const health = await api('/api/health');
    faceAngleCapability = health.face_angle_matching === 'ready' ? 'ready' : 'unavailable';
    artifactRevisionCapability = health.artifact_revision === 'ready' ? 'ready' : 'unavailable';
  } catch {
    faceAngleCapability = 'unavailable';
    artifactRevisionCapability = 'unavailable';
  }
  if (elements.identityAngleFallback) elements.identityAngleFallback.open = false;
  renderFaceAngleSummary();
  if (faceAngleCapability === 'ready' && referenceFileState.identity.length) scheduleFaceAngleAnalysis();
}

async function checkBrowser() {
  elements.browserState.textContent = '检查中';
  try {
    renderBrowserStatus(await api('/api/browser/probe', { method: 'POST' }));
  } catch {
    elements.browserState.textContent = '无法检查';
    elements.browserState.className = 'warn-text';
  }
}

function renderPreflight(preflight) {
  if (!preflight) {
    elements.preflightMessage.textContent = '当前任务没有参考图预检记录。';
    elements.preflightMessage.className = 'preflight-message blocked';
    return false;
  }
  if (preflight.state === 'blocked') {
    elements.preflightMessage.textContent = `预检未通过：${preflight.blocking_issues.map((item) => item.message).join('；')}`;
    elements.preflightMessage.className = 'preflight-message blocked';
    return false;
  }
  const warnings = preflight.warnings?.map((item) => item.message).join('；');
  elements.preflightMessage.textContent = warnings
    ? `预检通过，但请注意：${warnings}`
    : '参考图预检通过：身份角度覆盖目标，模板角度与景别匹配。';
  elements.preflightMessage.className = `preflight-message ${warnings ? 'warning' : 'passed'}`;
  return true;
}

async function sha256Blob(blob) {
  if (!blob || typeof blob.arrayBuffer !== 'function' || !window.crypto?.subtle) return '';
  const digest = await window.crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function identityPoseByIndex(index) {
  return faceAngleViewState.identityObservations?.find((item) => Number(item.source_index) === Number(index)) || null;
}

function templatePoseByIndex(index) {
  return faceAngleViewState.uploadedTemplateObservations?.find((item) => Number(item.source_index) === Number(index)) || null;
}

function catalogPoseByIndex(index) {
  return faceAngleViewState.catalogTemplateObservations?.find((item) => Number(item.source_index) === Number(index)) || null;
}

function poseTileState({ observation, index, identity = false }) {
  const match = faceAngleViewState.match;
  const workflowIndex = match?.final_identity_source_index != null ? Number(match.final_identity_source_index) : null;
  const finalIndex = manualPrimaryIdentityIndex ?? workflowIndex;
  const hasFinalIdentity = finalIndex != null;
  const primary = identity && hasFinalIdentity && Number.isFinite(finalIndex) && finalIndex === Number(index);
  const primaryLabel = primary ? (manualPrimaryIdentityIndex == null && match?.selection_mode === 'automatic' ? '推荐主图' : '主身份图') : '';
  const angleLabel = faceAngleViewState.status === 'preparing' || faceAngleViewState.status === 'analyzing'
    ? '本地分析中'
    : observation?.pose_label || observation?.display_label || (observation ? '无法自动判断' : smartTaskWorkflow ? (identity?'身份参考':'模板参考') : '等待分析');
  const expressionLabel = observation?.expression?.label || '';
  const expressionState = observation?.expression?.state || '';
  const smileScore = Number.isFinite(Number(observation?.expression?.smile_score)) ? Number(observation.expression.smile_score) : '';
  const poseDetail = observation?.pose_detail || '';
  return { primary, primaryLabel, angleLabel, expressionLabel, expressionState, smileScore, poseDetail };
}

function renderFaceAngleSummary() {
  if (!elements.identityAngleStatus) return;
  if (manualPrimaryIdentityIndex != null) {
    elements.identityAngleStatus.textContent = `已选择第 ${manualPrimaryIdentityIndex + 1} 张身份图作为主图`;
    return;
  }
  if (faceAngleCapability === 'checking') {
    elements.identityAngleStatus.textContent = '第一张自动作为主图，也可以点击更换';
    return;
  }
  if (faceAngleCapability !== 'ready') {
    elements.identityAngleStatus.textContent = '第一张自动作为主图，也可以点击更换';
    return;
  }
  const identityReferenceTotal = referenceFileState.identity.length;
  const templateReferenceTotal = referenceFileState.templates.length + templateLibraryController.getSelectedCount();
  if (!identityReferenceTotal) {
    elements.identityAngleStatus.textContent = '添加照片后，第一张自动作为主图';
    return;
  }
  if (!templateReferenceTotal) {
    elements.identityAngleStatus.textContent = '客户图已准备好，第一张作为主图';
    return;
  }
  if (['preparing', 'analyzing'].includes(faceAngleViewState.status)) {
    elements.identityAngleStatus.textContent = '正在本地分析人脸方向，不会上传到新的服务';
    return;
  }
  const match = faceAngleViewState.match;
  if (!match) {
    elements.identityAngleStatus.textContent = '自动分析尚未完成';
    return;
  }
  const hasFinalIdentity = match.final_identity_source_index != null;
  const displayIndex = hasFinalIdentity ? Number(match.final_identity_source_index) + 1 : null;
  if (hasFinalIdentity && (match.selection_mode === 'manual_override' || match.selection_mode === 'manual_fallback')) {
    elements.identityAngleStatus.textContent = `已手动选择第 ${displayIndex} 张身份图作为主图`;
  } else if (match.state === 'recommended') {
    elements.identityAngleStatus.textContent = `自动推荐第 ${displayIndex} 张 · ${matchConfidenceLabel(match.match_score)}`;
  } else if (match.state === 'low_similarity') {
    elements.identityAngleStatus.textContent = `第 ${displayIndex} 张最接近，但角度差仍较大，建议检查`;
  } else {
    elements.identityAngleStatus.textContent = '无法可靠判断模板角度，请点击一张身份图作为主图';
  }
}

function applyDerivedIdentityCoverage() {
  if (manualAngleCoverageTouched) return;
  const reliableAngles = new Set((faceAngleViewState.identityObservations || [])
    .filter((item) => item.reliability === 'reliable')
    .map((item) => item.legacy_angle)
    .filter(Boolean));
  if (!reliableAngles.size) return;
  for (const checkbox of document.querySelectorAll('input[name="identityAngles"]')) {
    checkbox.checked = reliableAngles.has(checkbox.value);
    checkbox.dataset.angleSource = checkbox.checked ? 'automatic' : '';
  }
}

async function catalogFaceAngleSource(template) {
  try {
    const response = await browserFetch(template.image_url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { source: await response.blob(), uid: template.uid, sha256: template.reference_image_sha256 || '' };
  } catch {
    return { source: null, uid: template.uid, sha256: template.reference_image_sha256 || '' };
  }
}

function scheduleFaceAngleAnalysis(options={}) {
  smartTaskWorkflow?.schedule(options);
  const activeRevision = ++faceAngleInputRevision;
  if (faceAngleCapability !== 'ready') {
    faceAngleViewState = { ...faceAngleViewState, revision: activeRevision, status: 'unavailable', match: null };
    renderFaceAngleSummary();
    return Promise.resolve();
  }
  if (!referenceFileState.identity.length || !(referenceFileState.templates.length + templateLibraryController.getSelectedCount())) {
    faceAngleViewState = {
      revision: activeRevision,
      status: 'idle',
      identityObservations: [],
      uploadedTemplateObservations: [],
      catalogTemplateObservations: [],
      match: null,
    };
    renderFaceAngleSummary();
    return Promise.resolve();
  }
  faceAngleViewState = { ...faceAngleViewState, status: 'preparing', match: null };
  renderFaceAngleSummary();
  const task = (async () => {
    const identitySources = await Promise.all(referenceFileState.identity.map(async (file) => ({ source: file, sha256: await sha256Blob(file) })));
    const uploadedTemplateSources = await Promise.all(referenceFileState.templates.map(async (file) => ({ source: file, sha256: await sha256Blob(file) })));
    const catalogTemplateSources = await Promise.all(templateLibraryController.getSelectedTemplates().map(catalogFaceAngleSource));
    if (activeRevision !== faceAngleInputRevision) return;
    const pending = faceAngleWorkflow.setInputs({ identitySources, uploadedTemplateSources, catalogTemplateSources });
    faceAngleViewState = faceAngleWorkflow.getState();
    renderReferencePreviews('identity');
    renderReferencePreviews('templates');
    renderFaceAngleSummary();
    await pending;
    if (activeRevision !== faceAngleInputRevision) return;
    faceAngleViewState = faceAngleWorkflow.getState();
    applyDerivedIdentityCoverage();
    renderReferencePreviews('identity');
    renderReferencePreviews('templates');
    renderFaceAngleSummary();
    renderIdentityCoverage();
  })().catch(() => {
    if (activeRevision !== faceAngleInputRevision) return;
    faceAngleViewState = faceAngleWorkflow.getState();
    renderReferencePreviews('identity');
    renderReferencePreviews('templates');
    renderFaceAngleSummary();
  });
  return task;
}

function revokeReferencePreviewUrls(kind) {
  for (const url of referencePreviewUrls[kind]) URL.revokeObjectURL(url);
  referencePreviewUrls[kind] = [];
}

function setReferenceInputFiles(input, files) {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
}

function renderReferencePreviews(kind) {
  const isIdentity = kind === 'identity';
  const input = isIdentity ? elements.identityInput : elements.templateInput;
  const grid = isIdentity ? elements.identityPreviewGrid : elements.templatePreviewGrid;
  const files = referenceFileState[kind];
  revokeReferencePreviewUrls(kind);
  const tiles = files.map((file, index) => {
    const url = URL.createObjectURL(file);
    referencePreviewUrls[kind].push(url);
    const pose = isIdentity ? identityPoseByIndex(index) : templatePoseByIndex(index);
    const tileState = poseTileState({ observation: pose, index, identity: isIdentity });
    const primaryClass = tileState.primary ? ' face-angle-primary' : '';
    const primaryLabel = tileState.primaryLabel ? `<span class="face-angle-primary-label">${escapeHtml(tileState.primaryLabel)}</span>` : '';
    const selectButton = isIdentity ? `<button class="select-primary-reference" type="button" data-select-primary="${index}" aria-label="将第 ${index + 1} 张设为主身份图"></button>` : '';
    return `<article class="reference-preview-tile${primaryClass}" data-reference-kind="${kind}" data-reference-index="${index}" data-expression-state="${escapeHtml(tileState.expressionState)}" data-smile-score="${escapeHtml(tileState.smileScore)}">
      <img src="${escapeHtml(url)}" alt="${isIdentity ? '身份参考图' : '模板参考图'} ${index + 1}">
      ${selectButton}
      ${primaryLabel}
      ${tileState.expressionLabel ? `<span class="face-expression-label">${escapeHtml(tileState.expressionLabel)}</span>` : ''}
      <span class="face-angle-label"${tileState.poseDetail ? ` title="${escapeHtml(tileState.poseDetail)}"` : ''}>${escapeHtml(tileState.angleLabel)}</span>
      <button class="remove-reference" type="button" data-remove-reference="${kind}" data-file-index="${index}" aria-label="移除 ${escapeHtml(file.name)}">×</button>
    </article>`;
  });

  const catalogTiles = !isIdentity ? (templateLibraryController ? templateLibraryController.getSelectedTemplates().map((t, idx) => {
    const pose = catalogPoseByIndex(idx);
    const tileState = poseTileState({ observation: pose, index: idx, identity: false });
    return `<article class="reference-preview-tile catalog-tile" data-reference-kind="catalog-template" data-reference-index="${idx}" data-expression-state="${escapeHtml(tileState.expressionState)}" data-smile-score="${escapeHtml(tileState.smileScore)}">
      <img src="${escapeHtml(t.image_url)}" alt="模板库参考 ${escapeHtml(t.name)}">
      <span class="template-source-chip">模板库</span>
      ${tileState.expressionLabel ? `<span class="face-expression-label">${escapeHtml(tileState.expressionLabel)}</span>` : ''}
      <span class="face-angle-label"${tileState.poseDetail ? ` title="${escapeHtml(tileState.poseDetail)}"` : ''}>${escapeHtml(tileState.angleLabel)}</span>
      <button class="remove-reference" type="button" data-remove-catalog="${escapeHtml(t.uid)}" aria-label="移除 ${escapeHtml(t.name)}">×</button>
    </article>`;
  }) : []) : [];
const slotCopy = isIdentity
    ? [
        ['添加客户照片', '一张清晰照片就可以'],
        ['添加更多照片（可选）', '不同角度有助于更像本人'],
      ]
    : [
        ['添加自己的模板', '也可以从模板库选择'],
        ['再加一张（可选）', '用于补充不同方向'],
      ];
  const referenceCount=files.length+(isIdentity?0:catalogTiles.length);
  const emptySlots = 1;
  const addLabels = Array.from({ length: emptySlots }, (_, offset) => {
    const copy = slotCopy[Math.min(referenceCount + offset, slotCopy.length - 1)];
    const requiredClass = isIdentity && referenceCount === 0 && offset === 0 ? ' required-slot' : '';
    const requiredLabel = requiredClass ? '<span class="required-label">必需</span>' : '';
    return `<label class="reference-preview-tile add-reference${requiredClass}" for="${input.id}">${requiredLabel}<span class="add-icon">+</span><strong>${copy[0]}</strong><small>${copy[1]}</small></label>`;
  });
  grid.innerHTML = `${tiles.join('')}${catalogTiles.join('')}${addLabels.join('')}`;
  if (isIdentity) {
    elements.identityQuality.textContent = files.length ? `已选择 ${files.length} 张` : '等待上传';
    elements.identityQuality.className = `quality-badge${files.length ? ' ready' : ''}`;
    renderFaceAngleSummary();
  }
}

function referenceFileLimit(kind) {
  return kind === 'identity' ? 4 : Math.max(0, 4 - templateLibraryController.getSelectedCount());
}

function mergeReferenceFiles(kind, incomingFiles) {
  const input = kind === 'identity' ? elements.identityInput : elements.templateInput;
  const merged = mergeFilesWithinLimit(referenceFileState[kind], incomingFiles, referenceFileLimit(kind));
  referenceFileState[kind] = merged.files;
  setReferenceInputFiles(input, merged.files);
  if (kind === 'identity') {
    manualAngleCoverageTouched = false;
    manualPrimaryIdentityIndex = normalizeManualPrimaryIndex(manualPrimaryIdentityIndex, merged.files.length);
  }
  scheduleFaceAngleAnalysis();
  renderReferencePreviews(kind);
  return merged;
}

function mergeReferenceSelection(kind, input) {
  return mergeReferenceFiles(kind, [...input.files]);
}

function removeReferenceFile(kind, index) {
  const input = kind === 'identity' ? elements.identityInput : elements.templateInput;
  referenceFileState[kind].splice(index, 1);
  setReferenceInputFiles(input, referenceFileState[kind]);
  if (kind === 'identity') {
    manualAngleCoverageTouched = false;
    manualPrimaryIdentityIndex = manualPrimaryAfterRemoval(manualPrimaryIdentityIndex, index, referenceFileState.identity.length);
  }
  scheduleFaceAngleAnalysis();
  renderReferencePreviews(kind);
}

function renderIdentityCoverage() {
  if (!referenceFileState.identity.length) elements.identityQuality.textContent = '等待上传';
  else if (manualPrimaryIdentityIndex != null) elements.identityQuality.textContent = `主图：第 ${manualPrimaryIdentityIndex + 1} 张`;
  else if (faceAngleViewState.match?.final_identity_source_index != null) elements.identityQuality.textContent = `主图：第 ${Number(faceAngleViewState.match.final_identity_source_index) + 1} 张`;
  else elements.identityQuality.textContent = `已选择 ${referenceFileState.identity.length} 张`;
  renderFaceAngleSummary();
}

function scoreValue(review, key) {
  const value = review?.[key];
  return Number.isFinite(Number(value)) ? String(value) : '';
}

function diagnosticCodesForDisplay(review) {
  if (!review) return new Set();
  if (Array.isArray(review.diagnostic_codes)) return new Set(review.diagnostic_codes);
  const codes = new Set();
  for (const failure of review.failed_dimensions || []) {
    const code = legacyDiagnosticMap[failure?.dimension];
    if (code) codes.add(code);
  }
  for (const [dimension, code] of Object.entries(legacyDiagnosticMap)) {
    const value = Number(review?.[dimension]);
    if (Number.isFinite(value) && value < 7) codes.add(code);
  }
  return codes;
}

function overallScore(review) {
  if (!review) return null;
  const values = reviewScoreKeys
    .map((reviewName) => Number(review[reviewName]))
    .filter(Number.isFinite);
  if (!values.length) return null;
  return (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1);
}

function artifactCard(artifact, review, annotation) {
  const verdict = review?.verdict;
  const badgeClass = verdict === 'qualified' ? 'success' : verdict === 'identity_rejected' ? 'danger' : review ? 'warning' : 'neutral';
  const badgeText = review ? (verdictLabels[verdict] || verdict) : '尚未评分';
  const score = overallScore(review);
  const annotationCount = Number(annotation?.annotation_count || 0);
  const selected = artifact.artifact_id === selectedArtifactId;
  return `<article class="artifact-candidate${selected ? ' selected' : ''}" data-artifact-id="${escapeHtml(artifact.artifact_id)}">
    <button class="candidate-open" type="button" data-open-annotation="${escapeHtml(artifact.artifact_id)}" aria-label="打开候选 ${artifact.ordinal} 并添加批注">
      <div class="artifact-image-wrap">
        <img src="/api/runs/${encodeURIComponent(currentRunId)}/artifacts/${encodeURIComponent(artifact.artifact_id)}/file" alt="候选 ${artifact.ordinal}" loading="lazy">
        <span class="artifact-rank">${String(artifact.ordinal).padStart(2, '0')}</span>
        <span class="candidate-badge ${badgeClass}" title="${escapeHtml(badgeText)}">${escapeHtml(badgeText)}</span>
        <span class="annotation-count${annotationCount ? ' has-annotations' : ''}">${annotationCount ? `批注 ${annotationCount}` : '查看并批注'}</span>
      </div>
    </button>
    <button class="artifact-caption candidate-select" type="button" data-select-artifact="${escapeHtml(artifact.artifact_id)}" aria-pressed="${selected}"><strong>候选 ${artifact.ordinal}</strong>${score ? `<span class="overall-score" title="核心三维均分">${score}</span>` : '<span>未评分</span>'}</button>
  </article>`;
}

function renderArtifactInspector(manifest) {
  const artifact = (manifest.artifacts || []).find((item) => item.artifact_id === selectedArtifactId);
  if (!artifact) {
    elements.artifactInspector.innerHTML = '<div class="inspector-empty"><strong>选择一张候选图</strong><span>评分和备注会集中显示在这里。</span></div>';
    return;
  }
  const review = manifest.artifact_reviews?.[artifact.artifact_id];
  const verdictText = review ? (verdictLabels[review.verdict] || review.verdict) : '尚未评分';
  elements.artifactInspector.innerHTML = `<div class="inspector-header">
    <img class="inspector-thumb" src="/api/runs/${encodeURIComponent(currentRunId)}/artifacts/${encodeURIComponent(artifact.artifact_id)}/file" alt="候选 ${artifact.ordinal}">
    <div class="inspector-heading"><span>Selected candidate</span><h2>候选 ${artifact.ordinal}</h2><p title="${escapeHtml(artifact.original_name || artifact.filename)}">${escapeHtml(artifact.original_name || artifact.filename)}</p></div>
  </div>`;
  const styleSuggestion = manifest.artifact_style_suggestions?.[artifact.artifact_id] || null;
  if (styleSuggestion) elements.artifactInspector.insertAdjacentHTML('beforeend', artifactStylePanelMarkup(styleSuggestion));
  const fragment = elements.artifactReviewTemplate.content.cloneNode(true);
  const form = fragment.querySelector('.artifact-review-form');
  form.dataset.artifactId = artifact.artifact_id;
  const suggestion = manifest.review_suggestions?.[artifact.artifact_id] || null;
  const suggestionPanel = form.querySelector('.ai-suggestion-panel');
  const suggestionStatus = form.querySelector('[data-ai-suggestion-status]');
  const applySuggestion = form.querySelector('[data-apply-ai-suggestion]');
  suggestionPanel.hidden = !suggestion;
  if (suggestion) {
    suggestionStatus.textContent = `AI 建议已生成（${suggestion.provider_id || 'provider'} / ${suggestion.model_id || 'model'}），尚未成为人工评审。`;
    applySuggestion.hidden = false;
    applySuggestion.addEventListener('click', () => {
      const suggestionScores = suggestion.scores || suggestion;
      form.elements.faceFidelity.value = scoreValue(suggestionScores, 'face_identity_fidelity');
      form.elements.naturalness.value = scoreValue(suggestionScores, 'realism_naturalness');
      form.elements.style.value = scoreValue(suggestionScores, 'style_consistency');
      const suggestedCodes = new Set(suggestion.diagnostic_codes || []);
      for (const checkbox of form.querySelectorAll('input[name="diagnosticCodes"]')) checkbox.checked = suggestedCodes.has(checkbox.value);
      form.querySelector('.artifact-review-message').textContent = 'AI 建议已填入；只有点击保存后才会成为人工评审。';
    });
  } else {
    suggestionStatus.textContent = 'AI 建议未启用；人工评审仍是唯一正式结果。';
  }
  for (const [formName, reviewName] of numericScoreFields) form.elements[formName].value = scoreValue(review, reviewName);
  const diagnosticCodes = diagnosticCodesForDisplay(review);
  for (const checkbox of form.querySelectorAll('input[name="diagnosticCodes"]')) {
    checkbox.checked = diagnosticCodes.has(checkbox.value);
  }
  const legacyNote = form.querySelector('.legacy-review-note');
  if (legacyNote) legacyNote.hidden = !review || review.review_rubric_version === currentRubricVersion;
  form.elements.notes.value = review?.notes || '';
  form.querySelector('button[type="submit"]').textContent = reviewSubmitLabel(manifest, artifact.artifact_id);
  form.querySelector('.artifact-review-message').textContent = pendingReviewMessage || (review ? verdictText : '');
  pendingReviewMessage = '';
  elements.artifactInspector.append(fragment);
}

function renderCaptureBody(manifest=currentManifest,{busy=captureBusy}={}){
  const artifacts=manifest?.artifacts||[];
  const state=manifest?.capture?.state||'';
  const submitted=Number(manifest?.submission_attempt_count||0)>0||['submitted','submission_uncertain','capture_pending'].includes(manifest?.status);
  const warning=['capture_ambiguous','capture_unverified','capture_access_mismatch','capture_reopen_failed','capture_tab_unavailable'].includes(state)||['provider_error','provider_rate_limited'].includes(manifest?.status);
  const saved=artifacts.length>0;
  const responsePending=state==='capture_response_pending';
  const pagePending=state==='capture_page_not_ready';
  document.getElementById('captureOverview').dataset.state=busy?'busy':saved?'saved':warning?'warning':'waiting';
  document.getElementById('captureOverview').setAttribute('aria-busy',String(busy));
  document.getElementById('captureStateIcon').textContent=busy?'…':saved?'✓':warning?'!':'·';
  document.getElementById('captureStateTitle').textContent=busy?'正在检测原图':saved?`已保存 ${artifacts.length} 张图片`:responsePending?'等待原图响应':pagePending?'等待页面就绪':warning?'需要检查任务':submitted?'等待生成结果':'等待任务提交';
  document.getElementById('captureStateDetail').textContent=saved?'点击下方图片查看原图':responsePending?'图片已显示，正在读取可验证的原图。':pagePending?'页面暂未就绪，稍后继续检测原任务。':state==='capture_tab_unavailable'?'请打开原 ChatGPT 对话后再检测。':warning?'可再次检测，或使用右侧手动导入。':submitted?'可检测原图，也可在右侧导入。':'提交后只检测对应对话中的结果。';
  document.getElementById('captureProcess').hidden=saved;
  document.getElementById('discardRun').hidden=!saved;
  const grid=document.getElementById('captureOutputGrid');grid.hidden=!saved;
  grid.innerHTML=artifacts.map((artifact,index)=>`<button class="capture-output" type="button" data-capture-preview="${index}" aria-label="查看候选 ${artifact.ordinal||index+1} 原图"><img src="/api/runs/${encodeURIComponent(currentRunId)}/artifacts/${encodeURIComponent(artifact.artifact_id)}/file" alt="候选 ${artifact.ordinal||index+1}"><span>候选 ${artifact.ordinal||index+1}</span><small>${artifact.width} × ${artifact.height}</small></button>`).join('');
}

function renderArtifacts(manifest) {
  renderCaptureBody(manifest);
  const artifacts = manifest.artifacts || [];
  const reviews = manifest.artifact_reviews || {};
  const annotations = manifest.artifact_annotations || {};
  if (!artifacts.some((artifact) => artifact.artifact_id === selectedArtifactId)) {
    selectedArtifactId = artifacts.find((artifact) => !reviews[artifact.artifact_id])?.artifact_id || artifacts[0]?.artifact_id || null;
  }
  elements.artifactGallery.innerHTML = artifacts.length
    ? artifacts.map((artifact) => artifactCard(artifact, reviews[artifact.artifact_id], annotations[artifact.artifact_id])).join('')
    : '<div class="empty-state">保存结果后，候选图片会在这里并排展示。</div>';
  const reviewed = artifacts.filter((artifact) => reviews[artifact.artifact_id]).length;
  const qualified = artifacts.filter((artifact) => reviews[artifact.artifact_id]?.preference_eligible === true).length;
  elements.reviewedCount.textContent = `${reviewed} / ${artifacts.length}`;
  elements.qualifiedCount.textContent = String(qualified);
  renderArtifactInspector(manifest);
}

function reviewReferenceGroup({ kind, title, references }) {
  if (!references.length) return '';
  const thumbnails = references.map((_, index) => {
    const url = `/api/runs/${encodeURIComponent(currentRunId)}/references/${kind}/${index}/file`;
    const caption = `${title} ${index + 1}`;
    return `<button class="review-reference-thumb" type="button" data-preview-url="${url}" data-preview-caption="${caption}" aria-label="预览${caption}" title="预览${caption}"><img src="${url}" alt="${caption}"></button>`;
  }).join('');
  return `<section class="review-reference-group"><div class="review-reference-label"><strong>${title}</strong><span>${references.length} 张</span></div><div class="review-reference-list">${thumbnails}</div></section>`;
}

function renderReviewReferences(manifest) {
  const groups = [
    reviewReferenceGroup({ kind: 'template', title: '构图 / 风格参考', references: manifest.template_references || [] }),
    reviewReferenceGroup({ kind: 'identity', title: '客户身份原图', references: manifest.identity_references || [] }),
  ].filter(Boolean);
  elements.reviewReferences.innerHTML = groups.join('');
  elements.reviewReferences.dataset.hasReferences = String(groups.length > 0);
  elements.reviewReferences.hidden = groups.length === 0;
}

function renderReviewWorkspaceStep(manifest) {
  const navigationState = deriveReviewNavigationState(manifest);
  const activeView = resolveReviewNavigationView(manifest, activeReviewViewOverride);
  const showComparison = activeView === 'choice' && navigationState.choiceSections.includes('comparison');
  const mediaMode = showComparison ? 'comparison' : 'gallery';
  for (const button of elements.reviewStepButtons) {
    const target = button.dataset.reviewStepTarget;
    const available = navigationState.navigableViews.includes(target);
    button.disabled = !available;
    button.setAttribute('aria-selected', String(target === activeView));
  }
  elements.reviewActionContent.dataset.reviewView = activeView;
  elements.artifactGallery.hidden = mediaMode === 'comparison';
  elements.comparisonMediaStage.hidden = mediaMode !== 'comparison';
  elements.reviewReferences.hidden = mediaMode === 'comparison' || elements.reviewReferences.dataset.hasReferences !== 'true';
  elements.artifactInspector.hidden = activeView !== 'score';
  elements.aestheticComparisonPanel.hidden = !showComparison;
  elements.preferencePanel.hidden = activeView !== 'choice';
}

function renderComparisonPreview(image, label, artifact, prefix) {
  if (!artifact) {
    image.removeAttribute('src');
    image.hidden = true;
    label.textContent = prefix;
    return;
  }
  image.src = reviewArtifactFileUrl(currentRunId, artifact.artifact_id);
  image.alt = `${prefix}：候选 ${artifact.ordinal}`;
  image.hidden = false;
  label.textContent = `${prefix} · 候选 ${artifact.ordinal}`;
}

function renderComparisonPreviews(manifest, artifactAId = elements.comparisonArtifactA.value, artifactBId = elements.comparisonArtifactB.value) {
  const artifacts = manifest.artifacts || [];
  renderComparisonPreview(
    elements.comparisonPreviewA,
    elements.comparisonPreviewALabel,
    artifacts.find((artifact) => artifact.artifact_id === artifactAId),
    '候选 A',
  );
  renderComparisonPreview(
    elements.comparisonPreviewB,
    elements.comparisonPreviewBLabel,
    artifacts.find((artifact) => artifact.artifact_id === artifactBId),
    '候选 B',
  );
}

function renderAestheticComparison(manifest) {
  const reviews = manifest.artifact_reviews || {};
  const previousA = elements.comparisonArtifactA.value;
  const previousB = elements.comparisonArtifactB.value;
  const workspaceState = deriveReviewWorkspaceState(manifest, { preferredA: previousA, preferredB: previousB });
  const { eligible, artifactAId, artifactBId, enabled } = workspaceState.comparison;
  const optionMarkup = eligible.length
    ? eligible.map((artifact) => {
      const issueCount = diagnosticCodesForDisplay(reviews[artifact.artifact_id]).size;
      const context = issueCount ? ` · ${issueCount} 个诊断` : '';
      return `<option value="${escapeHtml(artifact.artifact_id)}">候选 ${artifact.ordinal}${context}</option>`;
    }).join('')
    : '<option value="">没有通过三项门槛的候选</option>';
  elements.comparisonArtifactA.innerHTML = optionMarkup;
  elements.comparisonArtifactB.innerHTML = optionMarkup;
  elements.comparisonArtifactA.value = artifactAId;
  elements.comparisonArtifactB.value = artifactBId;
  elements.comparisonUnavailable.hidden = enabled;
  elements.aestheticComparisonForm.hidden = !enabled;
  elements.comparisonArtifactA.disabled = !enabled;
  elements.comparisonArtifactB.disabled = !enabled;
  for (const button of elements.aestheticComparisonForm.querySelectorAll('[data-comparison-outcome]')) button.disabled = !enabled;
  elements.aestheticComparisonForm.elements.notes.disabled = !enabled;
  elements.aestheticComparisonMessage.textContent = workspaceState.comparison.message;
  elements.comparisonUnavailable.querySelector('span').textContent = workspaceState.comparison.message;
  renderComparisonPreviews(manifest, artifactAId, artifactBId);
}

function renderPreference(manifest) {
  const artifacts = manifest.artifacts || [];
  const reviews = manifest.artifact_reviews || {};
  const eligible = artifacts.filter((artifact) => reviews[artifact.artifact_id]?.preference_eligible === true);
  const allReviewed = artifacts.length > 0 && artifacts.every((artifact) => reviews[artifact.artifact_id]);
  const current = manifest.preference || { decision: 'pending', winner_artifact_id: null, notes: '' };
  const winnerRadio = elements.preferenceForm.querySelector('input[value="winner"]');
  const noneRadio = elements.preferenceForm.querySelector('input[value="none"]');
  winnerRadio.disabled = !allReviewed || !eligible.length;
  noneRadio.disabled = !allReviewed;
  elements.winnerArtifactId.disabled = !allReviewed || !eligible.length;
  elements.winnerArtifactId.innerHTML = eligible.length
    ? `<option value="">请选择</option>${eligible.map((artifact) => `<option value="${escapeHtml(artifact.artifact_id)}">候选 ${artifact.ordinal}</option>`).join('')}`
    : '<option value="">没有通过全部门槛的候选</option>';
  const decision = ['winner', 'none', 'pending'].includes(current.decision) ? current.decision : 'pending';
  const radio = elements.preferenceForm.querySelector(`input[name="decision"][value="${decision}"]`);
  if (radio && !radio.disabled) radio.checked = true;
  else elements.preferenceForm.querySelector('input[value="pending"]').checked = true;
  elements.winnerArtifactId.value = current.winner_artifact_id || '';
  elements.preferenceForm.elements.notes.value = current.notes || '';
  const selectedDecision = elements.preferenceForm.querySelector('input[name="decision"]:checked')?.value || 'pending';
  elements.winnerField.hidden = selectedDecision !== 'winner';
  const winnerOrdinal = artifacts.find((item) => item.artifact_id === current.winner_artifact_id)?.ordinal;
  const messages = {
    winner: `最好看：候选 ${winnerOrdinal || ''}`,
    none: '本次全部不要',
    pending: '暂不决定',
  };
  elements.preferenceMessage.textContent = manifest.preference
    ? messages[current.decision]
    : allReviewed ? '评分已完成，等待选择' : '尚未记录';
}

function setPrimaryNotice(message,state='error'){
  const notice=elements.prepareResult;
  if(notice.textContent!==message)notice.textContent=message;
  notice.dataset.state=state;
}

function renderPrimaryActionPresentation(manifest=currentManifest){
  if(!currentRunId||!manifest||manifest.image_api)return;
  const saved=manifest.artifacts?.length||0;
  const confirmed=manifest.status==='submitted'||saved>0;
  const uncertain=manifest.status==='submission_uncertain'&&Number(manifest.submission_attempt_count||0)>0;
  const captureNeedsAttention=!saved&&['capture_ambiguous','capture_unverified','capture_access_mismatch','capture_reopen_failed','capture_tab_unavailable','provider_error'].includes(manifest.capture?.state);
  const message=saved?`已保存 ${saved} 张图片，可以继续评审。`:captureNeedsAttention?readableFailure(manifest.capture.message||'任务已发送，但结果保存需要检查；不会重新发送。'):confirmed?'已发送一次，正在自动检测并保存结果。':uncertain?'发送结果待确认，系统只检测原任务，不会重复发送。':null;
  if(message){
    setPrimaryNotice(message,confirmed&&!captureNeedsAttention?'success':'warning');
    if(elements.workflowResult.textContent!==message)elements.workflowResult.textContent=message;
  }
  const button=document.querySelector('#prepareRun');
  if(!button)return;
  if(primaryActionBusy){
    if(confirmed)button.textContent=saved?'结果已保存':'已发送，正在同步状态';
    return;
  }
  const action=derivePrimaryAction({currentRunId,manifest});
  button.textContent={continue_same_run:'继续本次任务并发送一次',submit_once_same_run:'发送一次',capture_results:'检测并保存结果',capture_only:'仅检测结果（禁止重发）',review_artifacts:'继续评分与选择',manual_recovery_required:'需要从历史恢复'}[action.kind]||'开始生成';
  button.disabled=action.kind==='manual_recovery_required';
}

function renderRun(data) {
  const manifest = data.manifest;
  if (currentRunId && currentRunId !== data.runId) activeReviewViewOverride = '';
  currentRunId = data.runId;
  clearPendingRunCreationIdempotencyKey();
  currentManifest = manifest;
  document.querySelector('#prepareRun')?.setAttribute('aria-disabled', 'false');
  resultWorkbench?.render(data);
  const runIdentity = formatRunIdentity(data.runId);
  elements.runId.textContent = runIdentity.visibleId;
  elements.runId.title = runIdentity.title;
  elements.runId.dataset.fullRunId = runIdentity.fullId;
  if (elements.copyRunId) elements.copyRunId.hidden = false;
  elements.runStatus.textContent = statusLabels[manifest.status] || manifest.status;
  elements.runStatus.className = `state-badge ${['artifacts_saved', 'completed'].includes(manifest.status) ? 'success' : ['submission_uncertain', 'provider_error', 'provider_rate_limited'].includes(manifest.status) ? 'warning' : 'neutral'}`;
  updateStageAvailability(manifest);
  renderPrimaryActionPresentation(manifest);
  const preflightPassed = renderPreflight(manifest.reference_preflight);
  const retryableProvider = ['provider_rate_limited', 'provider_error'].includes(manifest.status) && Number(manifest.submission_attempt_count || 0) === 0;
  elements.stageRun.disabled = !preflightPassed || !(manifest.status === 'prepared' || manifest.status === 'staged' || retryableProvider);
  elements.submitRun.disabled = manifest.status !== 'staged';
  const count = manifest.artifacts?.length || 0;
  elements.captureRun.disabled = captureBusy || (!count && !['submitted', 'submission_uncertain','capture_pending'].includes(manifest.status));
  if(!captureBusy) elements.captureRun.textContent = count ? '前往评分' : manifest.image_api ? '查看 / 恢复 API 结果' : '检测并保存结果';
  elements.artifactImportForm.querySelector('input[type="file"]').disabled = count >= 4;
  elements.artifactImportForm.querySelector('button[type="submit"]').disabled = count >= 4;
  renderImportAction();
  if (count) elements.resultMessage.textContent = `已保存 ${count} 张独立候选图。每张图都有自己的文件、哈希和评分记录。`;
  else if (manifest.capture?.message) elements.resultMessage.textContent = readableFailure(manifest.capture.message);
  renderReviewReferences(manifest);
  renderArtifacts(manifest);
  renderAestheticComparison(manifest);
  renderPreference(manifest);
  renderReviewWorkspaceStep(manifest);
  generationMode?.sync();
  syncCaptureRefresh();
}

async function applyRunData(data) {
  renderRun(data);
  if(smartTaskWorkflow&&smartRestoredRunId!==data.runId&&!Number(data.manifest.submission_attempt_count||0)&&!data.manifest.artifacts?.length){
    const intent=data.manifest.task_intent||{};const prior=data.manifest.task_resolution?.manual_overrides||{...(intent.use_case?{useCase:intent.use_case}:{}),...(intent.user_supplement?{userSupplement:intent.user_supplement}:{}),...(intent.target_framing&&intent.target_framing!=='follow_template'?{targetFraming:intent.target_framing}:{}),...(intent.target_face_angle&&!intent.target_face_angle.startsWith('follow_')?{targetFaceAngle:intent.target_face_angle}:{})};
    smartTaskWorkflow.restore(prior);smartRestoredRunId=data.runId;
  }
  const restoring=restoreCatalogSelectionFromRun(data.manifest);runHydration=restoring;
  await restoring.catch((error) => {
    elements.prepareResult.textContent = `模板选择恢复失败：${error.message}`;
  }).finally(()=>{if(runHydration===restoring)runHydration=null;});
  if(smartTaskWorkflow&&!Number(data.manifest.submission_attempt_count||0)&&!data.manifest.artifacts?.length)smartTaskWorkflow.schedule({semantic:false});
  return data;
}

async function refreshRun() {
  if (!currentRunId) return null;
  return applyRunData(await api(`/api/runs/${currentRunId}`));
}

function syncCaptureRefresh(){
  const pending=currentRunId&&!captureBusy&&!currentManifest?.image_api&&!currentManifest?.artifacts?.length&&(['submitted','submission_uncertain','capture_pending'].includes(currentManifest?.status)||primaryActionBusy);
  if(!pending){
    if(captureRefreshState.timer)clearTimeout(captureRefreshState.timer);
    captureRefreshState.timer=null;captureRefreshState.runId=null;return;
  }
  if(captureRefreshState.runId!==currentRunId){
    if(captureRefreshState.timer)clearTimeout(captureRefreshState.timer);
    captureRefreshState.timer=null;captureRefreshState.runId=currentRunId;captureRefreshState.deadline=Date.now()+15*60*1000;
  }
  if(captureRefreshState.timer||captureRefreshState.inFlight||Date.now()>captureRefreshState.deadline)return;
  const runId=currentRunId;
  captureRefreshState.timer=setTimeout(async()=>{
    captureRefreshState.timer=null;
    if(currentRunId!==runId||captureRefreshState.runId!==runId)return;
    captureRefreshState.inFlight=true;
    try{
      // Local status only: never trigger browser capture, upload or submission.
      const data=await api(`/api/runs/${encodeURIComponent(runId)}`);
      if(currentRunId===runId&&captureRefreshState.runId===runId&&data.runId===runId&&!captureBusy&&(!primaryActionBusy||Number(data.manifest?.submission_attempt_count||0)>0||data.manifest?.artifacts?.length))await applyRunData(data);
    }catch{
      // A transient local disconnect must not replace the durable task state.
    }finally{
      captureRefreshState.inFlight=false;syncCaptureRefresh();
    }
  },3000);
}

function returnToNewTask(notice) {
  currentRunId = null;
  activeReviewViewOverride = '';
  currentManifest = null;
  syncCaptureRefresh();
  renderCaptureBody(null);
  resultWorkbench?.clear();
  smartTaskWorkflow?.clear();smartResolved=null;smartRestoredRunId=null;
  activeReuseDraft=null;reuseFileDescriptors.clear();
  generationMode?.reset();
  selectedArtifactId = null;
  inspectorDirty = false;
  templateSelectionSources.clear();
  currentRunOpenedFromHistory = false;
  history.replaceState(null, '', '/');
  elements.runId.textContent = 'NEW RUN';
  elements.runId.title = '';
  delete elements.runId.dataset.fullRunId;
  if (elements.copyRunId) elements.copyRunId.hidden = true;
  elements.runStatus.textContent = '等待输入';
  elements.runStatus.className = 'state-badge neutral';
  updateStageAvailability(null);
  setStage('references');
  elements.prepareResult.textContent = notice || '';
  elements.prepareResult.dataset.state='neutral';
  const primaryButton = document.querySelector('#prepareRun');
  if (primaryButton) {
    primaryButton.disabled = false;
    primaryButton.textContent = '保存并提交生成';
  }
  renderSendSummary();
}

async function restoreRequestedRun() {
  if (!currentRunId) return;
  const stageRevision=userStageRevision;
  try {
    const data = await api(`/api/runs/${currentRunId}`);
    const destination = resolveRunStartup({ manifest: data.manifest, fromHistory: currentRunOpenedFromHistory });
    if (destination.mode === 'new') {
      returnToNewTask(destination.notice);
      return;
    }
    await applyRunData(data);
    if(stageRevision===userStageRevision)setStage(smartTaskWorkflow&&!Number(data.manifest.submission_attempt_count||0)&&!data.manifest.artifacts?.length?'references':destination.stage);
  } catch {
    returnToNewTask(INVALID_RUN_NOTICE);
  }
}

function reviewPayload(form) {
  const data = new FormData(form);
  return {
    faceFidelity: Number(data.get('faceFidelity')),
    naturalness: Number(data.get('naturalness')),
    style: Number(data.get('style')),
    diagnosticCodes: data.getAll('diagnosticCodes').map(String),
    notes: String(data.get('notes') || ''),
  };
}

async function saveAestheticComparison(outcome) {
  if (!currentRunId) return;
  const data = new FormData(elements.aestheticComparisonForm);
  const artifactAId = String(data.get('artifactAId') || '');
  const artifactBId = String(data.get('artifactBId') || '');
  if (!artifactAId || !artifactBId) throw new Error('请先选择两张合格候选');
  if (artifactAId === artifactBId) throw new Error('候选 A 和 B 必须是两张不同的图');
  const buttons = [...elements.aestheticComparisonForm.querySelectorAll('[data-comparison-outcome]')];
  for (const button of buttons) button.disabled = true;
  elements.aestheticComparisonMessage.textContent = '正在保存对比…';
  try {
    const result = await api(`/api/runs/${currentRunId}/comparison`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        artifactAId,
        artifactBId,
        outcome,
        notes: String(data.get('notes') || ''),
      }),
    });
    elements.aestheticComparisonMessage.textContent = `已记录 ${result.comparisonCount} 次`;
    elements.aestheticComparisonForm.elements.notes.value = '';
  } finally {
    await refreshRun().catch(() => {});
  }
}

for (const tab of elements.stageTabs) tab.addEventListener('click', () => {userStageRevision++;setStage(tab.dataset.stageTarget);});
elements.newTaskButton.addEventListener('click', () => {
  if (inspectorDirty && !window.confirm('当前候选的评分尚未保存。新建任务会丢失这些未保存输入，是否继续？')) return;
  generationMode?.reset();
  sessionStorage.removeItem('ai-img-gen.smart-draft-customer');smartTaskWorkflow?.clear();
  window.location.assign('/');
});
elements.copyRunId?.addEventListener('click', async () => {
  if (!currentRunId) return;
  try {
    await navigator.clipboard.writeText(currentRunId);
    elements.copyRunId.textContent = '已复制';
    setTimeout(() => { elements.copyRunId.textContent = '复制'; }, 1200);
  } catch (error) {
    elements.copyRunId.title = `复制失败：${error.message}`;
  }
});
for (const button of document.querySelectorAll('[data-go-stage]')) button.addEventListener('click', () => {userStageRevision++;setStage(button.dataset.goStage);});
document.querySelector('#checkBrowser').addEventListener('click', checkBrowser);
elements.openHistory.addEventListener('click', async () => {
  showHistoryList();
  if (!elements.historyDialog.open) elements.historyDialog.showModal();
  await loadHistory();
});
elements.openHistoryImport.addEventListener('click', showHistoryImport);
elements.historyHeaderAction.addEventListener('click', () => {
  if (historyWorkspaceState.view !== 'list') {
    showHistoryList();
    return;
  }
  elements.historyDialog.close();
});
document.querySelector('#refreshHistory').addEventListener('click', loadHistory);
for (const button of elements.workLibraryViewButtons) {
  button.addEventListener('click', () => {
    activeWorkLibraryView = button.dataset.workLibraryView || 'all';
    renderHistory(historyRuns);
  });
}
elements.historySearch.addEventListener('input', () => {
  historyWorkspaceState = transitionHistoryWorkspace(historyWorkspaceState, { type: 'SET_QUERY', value: elements.historySearch.value });
  renderHistory(historyRuns);
});
elements.historyCustomerFilter.addEventListener('change', () => {
  historyWorkspaceState = transitionHistoryWorkspace(historyWorkspaceState, { type: 'SET_CUSTOMER', value: elements.historyCustomerFilter.value });
  renderHistory(historyRuns);
});
elements.historyStatusFilter.addEventListener('change', () => {
  historyWorkspaceState = transitionHistoryWorkspace(historyWorkspaceState, { type: 'SET_STATUS', value: elements.historyStatusFilter.value });
  renderHistory(historyRuns);
});
elements.historySort.addEventListener('change', () => {
  historyWorkspaceState = transitionHistoryWorkspace(historyWorkspaceState, { type: 'SET_SORT', value: elements.historySort.value });
  renderHistory(historyRuns);
});
document.querySelector('#closeMediaPreview').addEventListener('click', closeMediaPreview);
elements.previewPrevious.addEventListener('click', () => moveMediaPreview(-1));
elements.previewNext.addEventListener('click', () => moveMediaPreview(1));
elements.previewZoomOut.addEventListener('click', () => setPreviewZoom(previewTransform.zoom - 0.25));
elements.previewZoomReset.addEventListener('click', resetPreviewTransform);
elements.previewZoomIn.addEventListener('click', () => setPreviewZoom(previewTransform.zoom + 0.25));
elements.mediaPreviewStage.addEventListener('wheel', (event) => {
  event.preventDefault();
  setPreviewZoom(previewTransform.zoom + (event.deltaY < 0 ? 0.25 : -0.25));
}, { passive: false });
elements.mediaPreviewStage.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  previewDrag = {
    pointerId: event.pointerId,
    pointerX: event.clientX,
    pointerY: event.clientY,
    originX: previewTransform.x,
    originY: previewTransform.y,
  };
  elements.mediaPreviewStage.classList.add('dragging');
  elements.mediaPreviewStage.setPointerCapture?.(event.pointerId);
  event.preventDefault();
});
elements.mediaPreviewStage.addEventListener('pointermove', (event) => {
  if (!previewDrag || previewDrag.pointerId !== event.pointerId) return;
  previewTransform.x = previewDrag.originX + event.clientX - previewDrag.pointerX;
  previewTransform.y = previewDrag.originY + event.clientY - previewDrag.pointerY;
  applyPreviewTransform();
});
function finishPreviewDrag(event) {
  if (!previewDrag || previewDrag.pointerId !== event.pointerId) return;
  previewDrag = null;
  elements.mediaPreviewStage.classList.remove('dragging');
  if (elements.mediaPreviewStage.hasPointerCapture?.(event.pointerId)) elements.mediaPreviewStage.releasePointerCapture(event.pointerId);
}
elements.mediaPreviewStage.addEventListener('pointerup', finishPreviewDrag);
elements.mediaPreviewStage.addEventListener('pointercancel', finishPreviewDrag);
elements.mediaPreviewStage.addEventListener('dblclick', resetPreviewTransform);
elements.mediaPreviewDialog.addEventListener('close', () => {
  elements.mediaPreviewImage.removeAttribute('src');
  const trigger = previewTrigger;
  previewItems = [];
  previewIndex = 0;
  previewTrigger = null;
  resetPreviewTransform();
  trigger?.focus?.();
});
document.addEventListener('keydown', (event) => {
  if (!elements.mediaPreviewDialog.open) return;
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    moveMediaPreview(-1);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    moveMediaPreview(1);
  }
});
elements.reviewReferences.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-preview-url]');
  if (!trigger || !currentRunId || !currentManifest) return;
  const items = previewDeckForManifest(currentRunId, currentManifest);
  const index = Math.max(0, items.findIndex((item) => item.url === trigger.dataset.previewUrl));
  openMediaPreview(items, index, trigger);
});
elements.historyList.addEventListener('click', (event) => {
  const preview = event.target.closest('[data-preview-url]');
  if (preview) {
    const runCard = preview.closest('[data-history-run]');
    const run = historyRunsById.get(runCard?.dataset.historyRun);
    if (!run) return;
    const items = previewDeckForRun({
      runId: run.run_id,
      templateTotal: run.template_count,
      identityTotal: run.identity_count,
      artifacts: run.artifacts,
    });
    const index = Math.max(0, items.findIndex((item) => item.url === preview.dataset.previewUrl));
    openMediaPreview(items, index, preview);
    return;
  }
  const viewButton = event.target.closest('[data-view-history-record]');
  if (!viewButton) return;
  showHistoryRecord(viewButton.dataset.viewHistoryRecord);
});
elements.historyList.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  const trigger = event.target.closest('.history-record-trigger');
  if (!trigger) return;
  event.preventDefault();
  showHistoryRecord(trigger.dataset.viewHistoryRecord);
});
elements.historyRecordMedia.addEventListener('click', (event) => {
  const preview = event.target.closest('[data-preview-url]');
  if (!preview || !activeHistoryRecordId) return;
  const run = historyRunsById.get(activeHistoryRecordId);
  if (!run) return;
  const items = previewDeckForRun({
    runId: run.run_id,
    templateTotal: run.template_count,
    identityTotal: run.identity_count,
    artifacts: run.artifacts,
  });
  const index = Math.max(0, items.findIndex((item) => item.url === preview.dataset.previewUrl));
  openMediaPreview(items, index, preview);
});
elements.historyRecordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const runId = String(form.elements.runId.value || '');
  const button = form.querySelector('button[type="submit"]');
  if (!runId) return;
  setBusy(button, true, '正在保存');
  elements.historyRecordMessage.textContent = '正在追加本次信息修订。';
  try {
    await api(`/api/runs/${encodeURIComponent(runId)}/record`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customerName: form.elements.customerName.value,
        batchLabel: form.elements.batchLabel.value,
        intendedUse: form.elements.intendedUse.value,
        prompt: form.elements.prompt.value,
      }),
    });
    await loadHistory();
    showHistoryRecord(runId);
    elements.historyRecordMessage.textContent = '记录信息已保存，并保留了最初版本。';
    if (currentRunId === runId) await refreshRun();
  } catch (error) {
    elements.historyRecordMessage.textContent = `无法保存：${error.message}`;
  } finally {
    setBusy(button, false);
  }
});

async function openHistoryRecordReview(runId) {
  if (!runId) return;
  if (inspectorDirty && !window.confirm('当前候选的评分尚未保存。打开历史记录会丢失这些未保存输入，是否继续？')) return;
  sessionStorage.setItem(historyReturnStorageKey, runId);
  history.pushState({ source: 'history-record', runId }, '', `?run=${encodeURIComponent(runId)}&from=history`);
  activeReviewViewOverride = '';
  currentRunId = runId;
  currentRunOpenedFromHistory = true;
  currentManifest = null;
  selectedArtifactId = null;
  inspectorDirty = false;
  elements.historyDialog.close();
  try {
    await refreshRun();
    setStage('review');
  } catch (error) {
    elements.prepareResult.textContent = `无法打开历史记录：${error.message}`;
  }
}
elements.openRecordReview.addEventListener('click', () => openHistoryRecordReview(activeHistoryRecordId));
document.querySelector('#reuseHistorySettings')?.addEventListener('click',async()=>{
  try{await recallRunSettings(await api(`/api/runs/${activeHistoryRecordId}`));}catch(error){elements.historyRecordMessage.textContent=error.message;}
});
window.addEventListener('popstate', async () => {
  const recordId = sessionStorage.getItem(historyReturnStorageKey);
  if (!recordId) return;
  sessionStorage.removeItem(historyReturnStorageKey);
  const restoredLocation = parseRunLocation(window.location.search);
  if (restoredLocation.runId) {
    activeReviewViewOverride = '';
    currentRunId = restoredLocation.runId;
    currentRunOpenedFromHistory = restoredLocation.fromHistory;
    await refreshRun().catch(() => null);
  }
  if (!elements.historyDialog.open) elements.historyDialog.showModal();
  await loadHistory();
  if (!showHistoryRecord(recordId)) showHistoryList();
});

function updateHistoryFileStatus(input) {
  const picker = input.nextElementSibling;
  const status = picker?.querySelector('[data-file-status]');
  if (!picker || !status) return;
  const count = input.files?.length || 0;
  status.textContent = count ? `已选择 ${count} 张` : '尚未选择';
  picker.classList.toggle('has-files', count > 0);
}

for (const input of elements.historyImportForm.querySelectorAll('.history-file-input')) {
  input.addEventListener('change', () => updateHistoryFileStatus(input));
}

function renderImportAction(){
  const input=document.getElementById('artifactResults');
  const count=input.files?.length||0;
  const actions=document.getElementById('artifactImportActions');
  actions.hidden=false;
  const button=actions.querySelector('button');
  button.textContent=count?`导入 ${count} 张图片`:'导入图片';
  button.disabled=!count||input.disabled||!input.validity.valid;
}
const uploadPreviewUrls=new WeakMap();
for(const input of document.querySelectorAll('.polished-file-input')){
  const update=()=>{
    updateHistoryFileStatus(input);
    for(const url of uploadPreviewUrls.get(input)||[])URL.revokeObjectURL(url);
    const preview=document.getElementById(input.dataset.uploadPreview);
    preview.replaceChildren();
    const files=[...input.files];const urls=[];
    const limit=Number(input.dataset.maxFiles)||1;
    input.setCustomValidity(files.length>limit?`最多选择 ${limit} 张图片。`:'');
    input.setAttribute('aria-invalid',String(files.length>limit));
    for(const file of files){
      const item=document.createElement('div'),img=document.createElement('img'),name=document.createElement('span'),meta=document.createElement('small');
      img.addEventListener('load',()=>{meta.textContent=`${img.naturalWidth} × ${img.naturalHeight}`;});
      img.addEventListener('error',()=>{meta.textContent='无法预览';});
      const url=URL.createObjectURL(file);urls.push(url);img.src=url;img.alt=file.name;name.textContent=file.name;item.append(img,name,meta);preview.append(item);
    }
    uploadPreviewUrls.set(input,urls);
    if(input.id==='artifactResults')renderImportAction();
  };
  input.addEventListener('change',update);
  input.form?.addEventListener('reset',()=>requestAnimationFrame(update));
}

elements.historyImportForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true, '正在导入');
  elements.historyImportMessage.textContent = '正在保存身份图、模板图、提示词和成品；不会打开 ChatGPT。';
  try {
    const data = await api('/api/history/import', { method: 'POST', body: new FormData(form) });
    elements.historyImportMessage.textContent = `已导入为新记录：${data.runId}，共 ${data.manifest.artifacts.length} 张成品。`;
    form.reset();
    for (const input of form.querySelectorAll('.history-file-input')) updateHistoryFileStatus(input);
    await loadHistory();
  } catch (error) {
    elements.historyImportMessage.textContent = `无法导入：${error.message}`;
  } finally {
    setBusy(button, false);
  }
});
elements.identityInput.addEventListener('change', () => { useIdentityUploadMode(); mergeReferenceSelection('identity', elements.identityInput); });
elements.templateInput.addEventListener('change', () => mergeReferenceSelection('templates', elements.templateInput));

function setActivePasteTarget(kind) {
  activePasteTarget = kind;
  elements.identityPreviewGrid.classList.toggle('paste-target-active', kind === 'identity');
  elements.templatePreviewGrid.classList.toggle('paste-target-active', kind === 'templates');
  elements.customerPhotoPool.classList.toggle('paste-target-active', kind === 'customer-pool');
}

for (const [kind, grid] of [['identity', elements.identityPreviewGrid], ['templates', elements.templatePreviewGrid], ['customer-pool', elements.customerPhotoPool]]) {
  grid.addEventListener('pointerenter', () => setActivePasteTarget(kind));
  grid.addEventListener('focusin', () => setActivePasteTarget(kind));
  grid.addEventListener('click', () => setActivePasteTarget(kind));
  grid.addEventListener('pointerleave', () => {
    if (!grid.contains(document.activeElement) && activePasteTarget === kind) setActivePasteTarget(null);
  });
  grid.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!grid.contains(document.activeElement) && activePasteTarget === kind) setActivePasteTarget(null);
    }, 0);
  });
}

document.addEventListener('paste', (event) => {
  if (!activePasteTarget || isEditablePasteTarget(event.target)) return;
  const clipboardKind = activePasteTarget === 'templates' ? 'templates' : 'identity';
  const files = clipboardImageFiles(event.clipboardData, { kind: clipboardKind });
  if (!files.length) {
    const message = '剪贴板中没有可用的 PNG、JPEG 或 WebP 图片。请使用“复制图片”或截图后再粘贴。';
    if (activePasteTarget === 'customer-pool') elements.customerPhotoPoolMessage.textContent = message;
    else elements.prepareResult.textContent = message;
    return;
  }
  event.preventDefault();
  if (activePasteTarget === 'customer-pool') {
    elements.customerPhotoPoolMessage.textContent = `正在从剪贴板添加 ${files.length} 张照片…`;
    appendCustomerPhotos(files);
    return;
  }
  const merged = mergeReferenceFiles(activePasteTarget, files);
  const label = activePasteTarget === 'identity' ? '身份参考图' : '模板参考图';
  if (merged.added_count) {
    elements.prepareResult.textContent = `已粘贴 ${merged.added_count} 张${label}，当前为待提交状态；提交后会保存到本地。${merged.rejected_count ? ` 另有 ${merged.rejected_count} 张超过数量限制。` : ''}`;
  } else if (merged.duplicate_count) {
    elements.prepareResult.textContent = '这张图片已经在当前参考图中。';
  } else {
    elements.prepareResult.textContent = `${label}已达到数量上限。`;
  }
});
elements.identityPreviewGrid.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-reference]');
  if (button) {
    removeReferenceFile(button.dataset.removeReference, Number(button.dataset.fileIndex));
    return;
  }
  const primaryButton = event.target.closest('[data-select-primary]');
  if (!primaryButton) return;
  const selectedIndex = Number(primaryButton.dataset.selectPrimary);
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= referenceFileState.identity.length) return;
  manualPrimaryIdentityIndex = selectedIndex;
  try {
    if (faceAngleCapability === 'ready') faceAngleViewState = faceAngleWorkflow.overridePrimary(selectedIndex);
    renderReferencePreviews('identity');
    renderFaceAngleSummary();
    renderIdentityCoverage();
  } catch {
    elements.prepareResult.textContent = '主身份图选择未能保存，请重新点击。';
  }
});
elements.customerPhotoPoolGrid?.addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-pool-toggle]');
  if (toggle) {
    customerPhotoPoolState = toggleCustomerPhotoSelection(customerPhotoPoolState, Number(toggle.dataset.poolToggle));
    renderCustomerPhotoPool();
    return;
  }
  const primary = event.target.closest('[data-pool-primary]');
  if (!primary) return;
  try { customerPhotoPoolState = setCustomerPhotoPrimary(customerPhotoPoolState, Number(primary.dataset.poolPrimary)); }
  catch (error) { elements.customerPhotoPoolMessage.textContent = error.message; }
  renderCustomerPhotoPool();
});
elements.customerPhotoPoolGrid?.addEventListener('contextmenu', (event) => {
  const tile = event.target.closest('.customer-pool-tile[data-pool-ordinal]');
  if (!tile) return;
  event.preventDefault();
  openCustomerPhotoContextMenu({ ordinal: Number(tile.dataset.poolOrdinal), x: event.clientX, y: event.clientY, trigger: tile });
});
elements.customerPhotoPoolGrid?.addEventListener('keydown', (event) => {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
  const tile = event.target.closest('.customer-pool-tile[data-pool-ordinal]');
  if (!tile) return;
  event.preventDefault();
  const box = tile.getBoundingClientRect();
  openCustomerPhotoContextMenu({ ordinal: Number(tile.dataset.poolOrdinal), x: box.left + 18, y: box.top + 18, trigger: tile });
});
elements.customerPhotoContextMenu?.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-customer-photo-action]');
  if (!action || action.disabled) return;
  closeCustomerPhotoContextMenu();
  if (action.dataset.customerPhotoAction === 'rename') {
    openCustomerPhotoRenameDialog();
    return;
  }
  if (action.dataset.customerPhotoAction === 'remove') await removeManagedCustomerPhoto();
});
document.addEventListener('pointerdown', (event) => {
  if (!elements.customerPhotoContextMenu?.hidden && !elements.customerPhotoContextMenu.contains(event.target)) closeCustomerPhotoContextMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.customerPhotoContextMenu?.hidden) closeCustomerPhotoContextMenu({ restoreFocus: true });
});
document.addEventListener('scroll', () => closeCustomerPhotoContextMenu(), true);
window.addEventListener('resize', () => closeCustomerPhotoContextMenu());
elements.templatePreviewGrid.addEventListener('click', async (event) => {
  const catalogButton = event.target.closest('[data-remove-catalog]');
  if (catalogButton) {
    const item = templateLibraryController.getSelectedTemplates().find((template) => template.uid === catalogButton.dataset.removeCatalog);
    if (item) await toggleCatalogTemplate(item).catch((error) => { elements.prepareResult.textContent = error.message; });
    return;
  }
  const button = event.target.closest('[data-remove-reference]');
  if (button) removeReferenceFile(button.dataset.removeReference, Number(button.dataset.fileIndex));
});
document.querySelector('#identityCoverage').addEventListener('change', () => {
  manualAngleCoverageTouched = true;
  renderIdentityCoverage();
});
window.addEventListener('beforeunload', () => {
  revokeReferencePreviewUrls('identity');
  revokeReferencePreviewUrls('templates');
});
renderReferencePreviews('identity');
renderReferencePreviews('templates');

async function stageAndSubmitRunOnce(runId, { probeBrowserFirst = true } = {}) {
  const reconcile=async()=>{
    const data=await api(`/api/runs/${encodeURIComponent(runId)}`);
    const manifest=data.manifest||{};
    if(manifest.artifacts?.length||Number(manifest.submission_attempt_count||0)>0){
      if(currentRunId===runId)await applyRunData(data);
      return {state:manifest.status==='submitted'||manifest.artifacts?.length?'submitted':'submission_uncertain',alreadyAttempted:true,retryAutomatically:false,message:manifest.artifacts?.length?'原任务已保存结果。':manifest.status==='submitted'?'原任务已发送一次，正在检测结果。':'原任务已有发送记录，只检测结果，不会重复发送。'};
    }
    return null;
  };
  const prior=await reconcile();if(prior)return prior;
  try{
  if (probeBrowserFirst) {
    const probe = await api('/api/browser/probe', { method: 'POST' });
    renderBrowserStatus(probe);
    if (!probe.browser.ready) {
      throw new Error(probe.browser.message || 'Playwright 尚未连接默认 Chrome，系统没有上传或发送。');
    }
  }
  const staged = await api(`/api/runs/${runId}/stage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed: true }),
  });
  if (staged.state !== 'awaiting_submission_confirmation') {
    const existing=await reconcile();if(existing)return existing;
    throw new Error(staged.message || '参考图未能装载到 ChatGPT，系统没有发送。');
  }
  return await api(`/api/runs/${runId}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed: true }),
  });
  }catch(error){
    const progressed=await reconcile().catch(()=>null);if(progressed)return progressed;
    throw error;
  }
}

async function createAndSubmitArtifactRevision({ runId, artifactId }) {
  const probe = await api('/api/browser/probe', { method: 'POST' });
  renderBrowserStatus(probe);
  if (!probe.browser.ready) {
    throw new Error(probe.browser.message || 'Playwright 尚未连接默认 Chrome，系统没有创建、上传或发送修改任务。');
  }
  const child = await api(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/revisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed: true }),
  });
  const childRunId = child.runId;
  const submitted = await stageAndSubmitRunOnce(childRunId, { probeBrowserFirst: false });
  if (!['submitted', 'submission_uncertain'].includes(submitted.state)) {
    throw new Error(submitted.message || `子任务 ${childRunId} 未能发送；系统没有重试。`);
  }
  activeReviewViewOverride = '';
  currentRunId = childRunId;
  currentRunOpenedFromHistory = false;
  history.replaceState(null, '', `?run=${encodeURIComponent(childRunId)}`);
  await refreshRun();
  setStage('results');
  monitorAutomaticCapture(childRunId).catch(() => {});
  return {
    runId: childRunId,
    state: submitted.state,
    message: submitted.state === 'submitted'
      ? `子任务 ${childRunId} 已在原对话发送一次，正在自动保存修改结果。`
      : (submitted.message || `子任务 ${childRunId} 已尝试发送一次，系统不会重复发送。`),
  };
}

async function monitorAutomaticCapture(runId) {
  if(currentRunId===runId)syncCaptureRefresh();
  return null;
}


function currentTaskFormValues() {
  const formData = new FormData(document.querySelector('#runForm'));
  const customerName = String(formData.get('customerName') || '');
  const customerScopeId = String(formData.get('customerId') || '') || customerIdFromName(customerName);
  return {
    customerName,
    customerScopeId,
    intendedUse: formData.get('intendedUse'),
    targetFraming: formData.get('targetFraming'),
    targetAngle: formData.get('targetIntentAngle') || formData.get('targetAngle'),
    temperamentKeywords: formData.getAll('temperamentKeywords'),
    prompt: formData.get('userSupplement'),
    businessDomain: formData.get('businessDomain'),
  };
}

function currentTemplateTaskBrief() {
  return smartResolved?.recommendation_brief || mapFormToTaskBrief({...currentTaskFormValues(),intendedUse:currentTaskFormValues().intendedUse||'portrait'});
}

function invalidateRecommendationIfTaskChanged() {
  if (!recommendationController.getSelection()) return false;
  const taskBrief = currentTemplateTaskBrief();
  if (recommendationController.matchesTaskBrief(taskBrief)) return false;
  recommendationController.clearSelectionState();
  templateLibraryController.setActiveSelection(null);
  // Keep the user's chosen templates; only the recommendation evidence is stale.
  templateSelectionSources.clear();
  showAllRecommendations = false;
  elements.recommendationsContainer.hidden = true;
  elements.safeInspirationGrid.innerHTML = '';
  elements.top4RecommendationsGrid.innerHTML = '';
  elements.top10RecommendationsGrid.innerHTML = '';
  elements.recommendationStateNotice.hidden = false;
  elements.recommendationStateNotice.textContent = '任务条件已变化，旧推荐已失效；请重新获取推荐。';
  refreshTemplateSelectionViews();
  return true;
}

const templateValueLabels = {
  low: '低风险', medium: '中风险', high: '高风险',
  front: '正脸', front_15_degree: '轻微侧转', front_30_degree: '侧转', side_45_degree: '侧脸 45°', extreme_side: '完整侧脸',
  close_up: '特写', bust: '胸像', half_body: '半身', full_body: '全身', environmental_portrait: '环境人像',
  black_white_magazine: '黑白杂志', bold_color_graphic: '强色彩图形', cinematic_mood: '电影氛围', clean_magazine: '清爽杂志', dark_grunge: '暗黑拼贴',
  documentary_poster: '纪实海报', luxury_fashion: '静奢时尚', minimal_personal_brand: '极简个人品牌', retro_poster: '复古海报', streetwear_editorial: '街头时尚编辑',
};

function templateValueLabel(value) {
  const normalized = String(value || '').trim();
  return templateValueLabels[normalized] || normalized.replaceAll('_', ' ');
}

function populateTemplateFilters(vocabulary = {}) {
  const configs = [
    [elements.templateStyleFilter, 'style_category', '所有风格'],
    [elements.templateScaleFilter, 'portrait_scale', '所有景别'],
    [elements.templateAngleFilter, 'face_angle', '所有角度'],
    [elements.templateRiskFilter, 'identity_preservation_risk', '所有风险'],
  ];
  for (const [control, key, emptyLabel] of configs) {
    if (!control) continue;
    const current = control.value;
    const values = Array.isArray(vocabulary[key]) ? vocabulary[key] : [];
    control.innerHTML = [`<option value="">${emptyLabel}</option>`, ...values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(templateValueLabel(value))}</option>`)].join('');
    control.value = values.includes(current) ? current : '';
  }
}

function renderTemplateLibraryCards(items) {
  if (!elements.templateGrid) return;
  if (!items?.length) {
    elements.templateGrid.innerHTML = '';
    elements.templateGridEmpty.hidden = false;
    return;
  }
  elements.templateGridEmpty.hidden = true;
  elements.templateGrid.innerHTML = items.map((item) => {
    const template = normalizeCatalogTemplate(item);
    const isSelected = templateLibraryController.isSelected(template.uid);
    const eligibility = templateLibraryController.getTemplateEligibility(template.uid);
    const unavailable = eligibility.state === 'ineligible';
    return `<article class="template-card${isSelected ? ' is-selected' : ''}${unavailable ? ' is-unavailable' : ''}" data-template-uid="${escapeHtml(template.uid)}" tabindex="0" role="option" aria-selected="${isSelected}" aria-disabled="${unavailable}">
      <div class="template-card-media">
        <img src="${escapeHtml(template.image_url)}" alt="${escapeHtml(template.name)}" loading="lazy">
        <span class="template-card-check">${isSelected ? '✓' : ''}</span>
        ${unavailable ? '<span class="template-unavailable-badge">你已淘汰</span>' : ''}
      </div>
      <div class="template-card-info">
        <h4 class="template-card-title">${escapeHtml(template.name)}</h4>
        <div class="template-card-tags">
          ${template.style_category ? `<span class="template-tag">${escapeHtml(templateValueLabel(template.style_category))}</span>` : ''}
          ${template.portrait_scale ? `<span class="template-tag">${escapeHtml(templateValueLabel(template.portrait_scale))}</span>` : ''}
          <span class="template-tag risk-${escapeHtml(template.identity_preservation_risk || 'unknown')}">${escapeHtml(templateValueLabel(template.identity_preservation_risk || 'unknown'))}</span>
        </div>
        ${eligibility.reason_codes.length ? `<small class="template-unavailable-reason">${escapeHtml(templateRejectionText(eligibility.reason_codes))}</small>` : ''}
      </div>
    </article>`;
  }).join('');
}

function renderTaskTemplateLibrary() {
  const visible = templateLibraryController.getTaskPickerItems();
  const hidden = templateLibraryController.getTaskPickerHiddenRejectedCount();
  renderTemplateLibraryCards(visible);
  elements.templateLibraryCountBadge.textContent = `${visible.length} 个模板${hidden ? ` · 已隐藏 ${hidden} 个淘汰` : ''}`;
}

function updateLibrarySelectedCounter() {
  if (!elements.librarySelectedCount) return;
  const selectedCount = templateLibraryController.getSelectedCount();
  const availableCatalogSlots = Math.max(0, 4 - referenceFileState.templates.length);
  elements.librarySelectedCount.textContent = `已选 ${selectedCount} / ${availableCatalogSlots}`;
}

function renderTemplateDetailDrawer(item) {
  if (!elements.templateDetailDrawer || !item) return;
  const template = normalizeCatalogTemplate(item);
  elements.drawerTemplateName.textContent = template.name;
  elements.drawerTemplateImage.src = template.image_url;
  elements.drawerTemplateImage.alt = template.name;
  const rows = [
    ['模板 ID', template.uid],
    ['风格分类', template.style_category || '未分类'],
    ['建议景别', template.portrait_scale || '自适应'],
    ['人脸角度', template.face_angle || '自适应'],
    ['保真风险', template.identity_preservation_risk || '未知'],
    ['生成难度', template.generation_difficulty || '未知'],
  ];
  elements.drawerMetadata.innerHTML = rows.map(([label, value]) => `<div class="drawer-meta-row"><span class="drawer-meta-label">${escapeHtml(label)}</span><span class="drawer-meta-value">${escapeHtml(value)}</span></div>`).join('');
  const eligibility = templateLibraryController.getTemplateEligibility(template.uid);
  const unavailable = eligibility.state === 'ineligible';
  if(eligibility.state==='advisory')elements.drawerMetadata.insertAdjacentHTML('beforeend',`<div class="drawer-meta-row"><span class="drawer-meta-label">参考提示</span><span class="drawer-meta-value">${escapeHtml(templateRejectionText(eligibility.reason_codes))}</span></div>`);
  elements.drawerSelectButton.textContent = unavailable
    ? '你已淘汰此模板'
    : templateLibraryController.isSelected(template.uid) ? '移出本次任务' : '加入本次任务';
  elements.drawerSelectButton.disabled = unavailable;
  elements.drawerSelectButton.dataset.templateUid = template.uid;
  elements.templateDetailDrawer.hidden = false;
}

function renderRecommendationCards(grid, candidates, { sourceKind = '', sourceSlateId = '', badgePrefix = 'Top' } = {}) {
  if (!grid) return;
  grid.innerHTML = candidates.map((candidate) => {
    const template = normalizeCatalogTemplate(candidate);
    const isSelected = templateLibraryController.isSelected(template.uid);
    const reasons=[];
    if(candidate.matched_evidence?.some(e=>e.field==='customer_compatibility'&&e.matched?.length))reasons.push('贴近指定画面气质');
    const cueWords={professional:'专业',approachable:'亲和',premium:'高级',cool:'酷感',calm:'沉稳',editorial:'杂志',cinematic:'电影'};
    const visualCues=(smartResolved?.observations||[]).filter(o=>o.state==='ready').flatMap(o=>o.observation?.visual_style_tags||[]);
    if(visualCues.some(cue=>(candidate.selection_tags?.best_client_temperament||[]).some(tag=>String(tag).includes(cueWords[cue]||'__unknown__'))))reasons.push('与照片呈现的风格相近');
    reasons.push(`${templateValueLabel(template.portrait_scale)} · 身份风险：${templateValueLabel(template.identity_preservation_risk)}`);
    return `<article class="recommendation-card${isSelected ? ' is-selected' : ''}" data-template-uid="${escapeHtml(template.uid)}" data-source-kind="${escapeHtml(sourceKind)}" data-source-slate-id="${escapeHtml(sourceSlateId)}" tabindex="0" role="option" aria-selected="${isSelected}">
      <div class="recommendation-card-media">
        <img src="${escapeHtml(template.image_url)}" alt="${escapeHtml(template.name)}" loading="lazy">
        <span class="recommendation-badge">${escapeHtml(badgePrefix)} ${escapeHtml(template.rank)}</span>
      </div>
      <div class="recommendation-card-info">
        <div class="recommendation-card-title">${escapeHtml(template.name)}</div>
        <div class="recommendation-card-meta">${escapeHtml(reasons.slice(0,2).join('；'))}</div>
        <button type="button" class="quiet-button" data-preview-recommendation="${escapeHtml(template.uid)}" aria-label="查看${escapeHtml(template.name)}大图">查看大图</button>
      </div>
    </article>`;
  }).join('');
}

function renderSafeInspiration() {
  const slate = recommendationController.getSafeInspiration();
  const candidates = slate?.candidates || [];
  renderRecommendationCards(elements.safeInspirationGrid, candidates, {
    sourceKind: 'exploration_slate',
    sourceSlateId: slate?.slate_id || '',
    badgePrefix: '灵感 · 原排序 #',
  });
  if (elements.safeInspirationMessage) {
    elements.safeInspirationMessage.textContent = candidates.length
      ? `第 ${Number(slate.round_index || 0) + 1} 组 · 本轮 ${candidates.length} 张，Top4 保持不变。`
      : '获取推荐后可刷新安全灵感。';
  }
}

function renderRecommendationAlternatives() {
  const all = recommendationController.getAlternatives({ expanded: true });
  const visible = recommendationController.getAlternatives({ expanded: showAllRecommendations });
  renderRecommendationCards(elements.top10RecommendationsGrid, visible, { sourceKind: 'all_safe', badgePrefix: '原排序 #' });
  if (elements.recommendationAlternativesCount) elements.recommendationAlternativesCount.textContent = all.length
    ? `显示 ${visible.length} / ${all.length} 张备选`
    : '没有额外备选';
  if (elements.toggleAllRecommendationsButton) {
    elements.toggleAllRecommendationsButton.hidden = all.length <= 10;
    elements.toggleAllRecommendationsButton.textContent = showAllRecommendations ? '收起' : `展开全部 (${all.length})`;
  }
}

function renderRecommendationState() {
  const selection = recommendationController.getSelection();
  if (!selection) return;
  elements.recommendationsContainer.hidden = false;
  renderRecommendationCards(elements.top4RecommendationsGrid, selection.top4 || [], { sourceKind: 'top4' });
  renderSafeInspiration();
  renderRecommendationAlternatives();
  const summary = selection.filter_summary || {};
  const rejected = summary.rejected_count || 0;
  const stateText = selection.status === 'blocked'
    ? '暂无匹配的推荐，你可以从模板库自行选择。'
    : selection.status === 'insufficient_candidates'
      ? `当前推荐 ${summary.eligible_count || 0} 个模板，也可以从模板库自行选择。`
      : `按当前照片与要求筛选了 ${summary.eligible_count || 0} 个推荐候选，也可以从模板库自行选择。`;
  elements.recommendationStateNotice.hidden = false;
  elements.recommendationStateNotice.textContent = stateText;
}

async function requestActiveRecommendation(resolutionAlreadyCurrent=false) {
  if(smartTaskWorkflow&&!resolutionAlreadyCurrent)await smartTaskWorkflow.resolveNow();
  const requestedTaskBrief = currentTemplateTaskBrief();
  const created = await recommendationController.requestRecommendations(requestedTaskBrief);
  if (!recommendationController.matchesTaskBrief(currentTemplateTaskBrief())) {
    recommendationController.clearSelectionState();
    throw new Error('任务条件在推荐计算期间发生变化，旧结果已丢弃，请重新获取推荐。');
  }
  showAllRecommendations = false;
  templateLibraryController.setActiveSelection(created.selection);
  renderRecommendationState();
  try {
    await recommendationController.requestSafeInspiration();
    renderSafeInspiration();
  } catch (error) {
    if (elements.safeInspirationMessage) elements.safeInspirationMessage.textContent = `暂无安全灵感：${error.message}`;
  }
  return created.selection;
}

async function ensureActiveRecommendation() {
  if(smartTaskWorkflow)await smartTaskWorkflow.resolveNow();
  const taskBrief = currentTemplateTaskBrief();
  if (recommendationController.matchesTaskBrief(taskBrief)) return recommendationController.getSelection();
  return requestActiveRecommendation();
}

async function persistCatalogSelectionDecision() {
  const selectedUids = templateLibraryController.getSelectedTemplates().map((item) => item.uid);
  if (!selectedUids.length) return null;
  const selection = await ensureActiveRecommendation();
  const decision = buildSelectionDecision({
    selection,
    selectedTemplateUids: selectedUids,
    selectionSources: Object.fromEntries(templateSelectionSources),
  });
  const recorded = await recommendationController.recordDecision(decision);
  templateLibraryController.setActiveSelection(recorded.selection);
  return recorded;
}

function refreshTemplateSelectionViews({semantic=true}={}) {
  renderTaskTemplateLibrary();
  renderRecommendationCards(elements.top4RecommendationsGrid, recommendationController.getTop4(), { sourceKind: 'top4' });
  renderRecommendationAlternatives();
  renderSafeInspiration();
  updateLibrarySelectedCounter();
  renderReferencePreviews('templates');
  scheduleFaceAngleAnalysis({semantic});
  renderSendSummary();
}

async function toggleCatalogTemplate(item, source = {}, {replacePrimary=false}={}) {
  const choiceRevision=++templateChoiceRevision;let settle;const finished=new Promise(resolve=>{settle=resolve;});pendingTemplateChoices.add(finished);
  try {
  const template = normalizeCatalogTemplate(item);
  const wasSelected = templateLibraryController.isSelected(template.uid);
  if (!wasSelected) await ensureActiveRecommendation();
  if(choiceRevision!==templateChoiceRevision)throw new Error('已忽略较早的模板选择。');
  const previous = templateLibraryController.getSelectedTemplates();
  const priorSources=new Map(templateSelectionSources);
  if(replacePrimary&&!wasSelected&&previous.length)templateLibraryController.setSelectedTemplates(previous.slice(1));
  const result = templateLibraryController.toggleSelection(item, referenceFileState.templates.length);
  if(!result.selected&&result.reason){templateLibraryController.setSelectedTemplates(previous);throw new Error(result.reason==='limit_exceeded'?'最多只能选择 4 张模板（包括上传模板）':result.reason==='operator_template_rejected'?'该模板已淘汰，请重新选择':'当前模板不可用，请刷新推荐。');}
  if (!result.selected && result.reason === 'limit_exceeded') throw new Error('最多只能选择 4 张模板（包括人工上传与模板库模板）');
  if (!result.selected && result.reason === 'selection_required') throw new Error('请先生成一次系统推荐，再加入模板库模板');
  if (result.selected) templateSelectionSources.set(template.uid, structuredClone(source));
  else templateSelectionSources.delete(template.uid);
  if(replacePrimary&&!wasSelected&&result.selected){const selected=templateLibraryController.getSelectedTemplates();templateLibraryController.setSelectedTemplates([selected.find(t=>t.uid===template.uid),...selected.filter(t=>t.uid!==template.uid)]);if(previous[0])templateSelectionSources.delete(previous[0].uid);}
  try {
    if (templateLibraryController.getSelectedCount()) await persistCatalogSelectionDecision();
  } catch (error) {
    if(choiceRevision===templateChoiceRevision){templateLibraryController.setSelectedTemplates(previous);templateSelectionSources.clear();for(const [key,value]of priorSources)templateSelectionSources.set(key,value);}
    throw error;
  }
  refreshTemplateSelectionViews();
  return result;
  }finally{pendingTemplateChoices.delete(finished);settle();}
}

async function restoreCatalogSelectionFromRun(manifest) {
  const selectionId = manifest.template_selection?.selection_id;
  const catalogReferences = (manifest.template_references || [])
    .map((reference, index) => ({ reference, index }))
    .filter(({ reference }) => reference.source_type === 'catalog_template');
  if (!selectionId || !catalogReferences.length) return;
  const loaded = await api(`/api/template-selections/${encodeURIComponent(selectionId)}`);
  if(manifest.run_id!==currentRunId)return;
  recommendationController.setSelectionState(loaded.selection);
  templateLibraryController.setActiveSelection(loaded.selection);
  templateLibraryController.setSelectedTemplates(catalogReferences.map(({ reference, index }) => ({
    template_uid: reference.template_uid,
    template_name: reference.template_name,
    reference_image: {
      url: `/api/runs/${encodeURIComponent(manifest.run_id)}/references/template/${index}/file`,
      sha256: reference.reference_image_sha256,
      mime_type: reference.mime_type,
      extension: reference.extension || '',
    },
    rank: reference.selected_rank,
    relevance_score: reference.relevance_score,
  })));
  templateSelectionSources.clear();
  for (const { reference } of catalogReferences) {
    if (reference.selection_source_kind) {
      templateSelectionSources.set(reference.template_uid, {
        source_kind: reference.selection_source_kind,
        source_slate_id: reference.selection_source_slate_id || '',
      });
    }
  }
  refreshTemplateSelectionViews({semantic:false});
}

if (elements.openTemplateLibraryButton) {
  elements.openTemplateLibraryButton.addEventListener('click', async () => {
    try {
      const result = await templateLibraryController.loadTemplates();
      populateTemplateFilters(templateLibraryController.getFilterVocabulary());
      renderTaskTemplateLibrary();
      updateLibrarySelectedCounter();
      elements.templateLibraryDialog.showModal();
    } catch (error) {
      elements.prepareResult.textContent = `模板库加载失败：${error.message}`;
    }
  });
}

elements.closeTemplateLibraryButton?.addEventListener('click', () => elements.templateLibraryDialog.close());
elements.confirmLibrarySelection?.addEventListener('click', () => elements.templateLibraryDialog.close());
elements.closeDrawerButton?.addEventListener('click', () => { elements.templateDetailDrawer.hidden = true; });

async function filterTemplateLibrary() {
  try {
    await templateLibraryController.loadTemplates({
      q: elements.templateSearchInput?.value || '',
      style_category: elements.templateStyleFilter?.value || '',
      portrait_scale: elements.templateScaleFilter?.value || '',
      face_angle: elements.templateAngleFilter?.value || '',
      identity_preservation_risk: elements.templateRiskFilter?.value || '',
    });
    populateTemplateFilters(templateLibraryController.getFilterVocabulary());
    renderTaskTemplateLibrary();
  } catch (error) {
    elements.templateGrid.innerHTML = `<div class="empty-state">筛选失败：${escapeHtml(error.message)}</div>`;
  }
}

elements.templateSearchInput?.addEventListener('input', filterTemplateLibrary);
elements.templateStyleFilter?.addEventListener('change', filterTemplateLibrary);
elements.templateScaleFilter?.addEventListener('change', filterTemplateLibrary);
elements.templateAngleFilter?.addEventListener('change', filterTemplateLibrary);
elements.templateRiskFilter?.addEventListener('change', filterTemplateLibrary);

elements.templateGrid?.addEventListener('click', async (event) => {
  const card = event.target.closest('.template-card');
  if (!card) return;
  const item = templateLibraryController.getItems().find((candidate) => candidate.template_uid === card.dataset.templateUid);
  if (!item) return;
  renderTemplateDetailDrawer(item);
});
elements.templateGrid?.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  const card = event.target.closest('.template-card');
  if (!card) return;
  event.preventDefault();
  card.click();
});

elements.drawerSelectButton?.addEventListener('click', async () => {
  const item = templateLibraryController.getItems().find((candidate) => candidate.template_uid === elements.drawerSelectButton.dataset.templateUid);
  if (!item) return;
  setBusy(elements.drawerSelectButton, true, '保存选择中');
  try {
    const eligibility = templateLibraryController.getTemplateEligibility(normalizeCatalogTemplate(item).uid);
    if (eligibility.state === 'ineligible') throw new Error(templateRejectionText(eligibility.reason_codes));
    await toggleCatalogTemplate(item, { source_kind: 'full_library' });
    renderTemplateDetailDrawer(item);
  } catch (error) {
    elements.recommendationStateNotice.hidden = false;
    elements.recommendationStateNotice.textContent = error.message;
  } finally {
    setBusy(elements.drawerSelectButton, false);
  }
});

if (elements.requestRecommendationsButton) {
  elements.requestRecommendationsButton.addEventListener('click', async () => {
    setBusy(elements.requestRecommendationsButton, true, '计算推荐中');
    elements.recommendationStateNotice.hidden = false;
    elements.recommendationStateNotice.textContent = '正在按现有硬约束计算推荐…';
    try {
      await requestActiveRecommendation();
    } catch (error) {
      elements.recommendationStateNotice.textContent = `获取推荐失败：${error.message}`;
    } finally {
      setBusy(elements.requestRecommendationsButton, false);
    }
  });
}

async function handleRecommendationCardClick(event) {
  const preview=event.target.closest('[data-preview-recommendation]');
  if(preview){event.stopPropagation();const uid=preview.dataset.previewRecommendation;const item=templateLibraryController.getItems().find(t=>(t.template_uid||t.uid)===uid)||recommendationController.getRankedCandidates().find(t=>t.template_uid===uid);if(item){const t=normalizeCatalogTemplate(item);openMediaPreview([{url:t.image_url,caption:t.name,kind:'template'}],0,preview);}return;}
  const card = event.target.closest('.recommendation-card');
  if (!card) return;
  const candidates = [...recommendationController.getTop4(), ...recommendationController.getRankedCandidates()];
  const item = candidates.find((candidate) => candidate.template_uid === card.dataset.templateUid);
  if (!item) return;
  try {
    await toggleCatalogTemplate(item, {
      source_kind: card.dataset.sourceKind || (elements.safeInspirationGrid?.contains(card) ? 'exploration_slate' : 'top4'),
      source_slate_id: card.dataset.sourceSlateId || '',
    },{replacePrimary:Boolean(smartTaskWorkflow)});
  } catch (error) {
    elements.recommendationStateNotice.hidden = false;
    elements.recommendationStateNotice.textContent = error.message;
  }
}

function handleRecommendationCardKeydown(event) {
  if (!['Enter', ' '].includes(event.key)) return;
  const card = event.target.closest('.recommendation-card');
  if (!card) return;
  event.preventDefault();
  card.click();
}

elements.top4RecommendationsGrid?.addEventListener('click', handleRecommendationCardClick);
elements.top10RecommendationsGrid?.addEventListener('click', handleRecommendationCardClick);
elements.safeInspirationGrid?.addEventListener('click', handleRecommendationCardClick);
elements.top4RecommendationsGrid?.addEventListener('keydown', handleRecommendationCardKeydown);
elements.top10RecommendationsGrid?.addEventListener('keydown', handleRecommendationCardKeydown);
elements.safeInspirationGrid?.addEventListener('keydown', handleRecommendationCardKeydown);
elements.refreshSafeInspirationButton?.addEventListener('click', async () => {
  setBusy(elements.refreshSafeInspirationButton, true, '正在换一组');
  try {
    await recommendationController.requestSafeInspiration();
    renderSafeInspiration();
  } catch (error) {
    elements.safeInspirationMessage.textContent = `无法刷新安全灵感：${error.message}`;
  } finally {
    setBusy(elements.refreshSafeInspirationButton, false);
  }
});
elements.toggleAllRecommendationsButton?.addEventListener('click', () => {
  showAllRecommendations = !showAllRecommendations;
  renderRecommendationAlternatives();
});

async function prepareFaceAngleSubmission(form) {
  if (customerPhotoPoolState.identitySetId) {
    const ordinals = orderedCustomerPhotoOrdinals(customerPhotoPoolState);
    if (!ordinals.length || !customerPhotoPoolState.primaryOrdinal) {
      const error = new Error('请至少从客户照片池选择一张照片。');
      error.code = 'manual_primary_required';
      throw error;
    }
    form.delete('identity');
    form.delete('identityReferenceOrdinals');
    for (const value of ordinals) form.append('identityReferenceOrdinals', String(value));
    form.set('primaryIdentityReferenceOrdinal', String(customerPhotoPoolState.primaryOrdinal));
    form.set('identitySetId', customerPhotoPoolState.identitySetId);
    form.set('customerId', customerPhotoPoolState.customerId);
    return { files: [], selection_mode: 'customer_photo_pool', final_identity_source_index: 0, reference_ordinals: ordinals };
  }
  if (!referenceFileState.identity.length) return null;
  if (faceAngleCapability !== 'ready') {
    const selectedIndex = normalizeManualPrimaryIndex(manualPrimaryIdentityIndex, referenceFileState.identity.length) ?? (smartTaskWorkflow?0:null);
    if (selectedIndex == null) {
      const error = new Error('请先选择一张主身份图。');
      error.code = 'manual_primary_required';
      throw error;
    }
    const files = reorderManualPrimary(referenceFileState.identity, selectedIndex);
    form.delete('identity');
    for (const file of files) form.append('identity', file, file.name);
    form.set('manualPrimaryIdentitySourceIndex', String(selectedIndex));
    return { files, selection_mode: 'manual_fallback', final_identity_source_index: selectedIndex };
  }
  elements.prepareResult.textContent = '正在完成本地角度匹配。';
  const prepared = await faceAngleWorkflow.prepareSubmission(referenceFileState.identity);
  form.delete('identity');
  for (const file of prepared.files) form.append('identity', file, file.name);
  form.set('identityFacePoseObservations', JSON.stringify(prepared.identityObservations));
  form.set('templateFacePoseObservations', JSON.stringify(prepared.uploadedTemplateObservations));
  form.set('catalogTemplateFacePoseObservations', JSON.stringify(prepared.catalogTemplateObservations));
  form.set('faceAngleMatch', JSON.stringify(prepared.match));
  form.set('faceAnglePipelineVersion', 'hybrid-profile-v2');
  form.delete('identityFaceAngles');
  for (const observation of prepared.identityObservations) form.append('identityFaceAngles', observation.legacy_angle || 'other');
  form.delete('templateFaceAngles');
  for (const observation of prepared.uploadedTemplateObservations) form.append('templateFaceAngles', observation.legacy_angle || 'other');

  const derivedCoverage = [...new Set(prepared.identityObservations
    .filter((item) => item.reliability === 'reliable')
    .map((item) => item.legacy_angle)
    .filter(Boolean))];
  if (!manualAngleCoverageTouched || !form.getAll('identityAngles').length) {
    form.delete('identityAngles');
    for (const angle of derivedCoverage.length ? derivedCoverage : ['other']) form.append('identityAngles', angle);
  }

  const primaryIdentityPose = prepared.identityObservations[0];
  const primaryTemplatePose = prepared.uploadedTemplateObservations[0] || Object.values(prepared.catalogTemplateObservations)[0] || null;
  const intent = String(form.get('targetIntentAngle') || 'follow_identity');
  if (intent === 'follow_template' && primaryTemplatePose?.reliability === 'reliable') form.set('targetAngle', primaryTemplatePose.legacy_angle);
  else if (['follow_identity', 'slight_turn'].includes(intent) && primaryIdentityPose?.reliability === 'reliable') form.set('targetAngle', primaryIdentityPose.legacy_angle);
  if (primaryTemplatePose?.reliability === 'reliable') form.set('templateAngle', primaryTemplatePose.legacy_angle);
  return prepared;
}

document.querySelector('#runForm').addEventListener('submit', async (event) => {
  const submittedForm = event.currentTarget;
  event.preventDefault();
  if (primaryActionBusy) return;
  elements.prepareResult.textContent='';delete elements.prepareResult.dataset.state;
  if (document.querySelector('#prepareRun').getAttribute('aria-disabled') === 'true') {
    elements.prepareResult.textContent = '请先添加一张客户照片，或从已有客户中选择照片。';
    elements.identityInput.focus();
    return;
  }
  if(smartTaskWorkflow&&smartEditingEnabled()){
    primaryActionBusy=true;setBusy(document.querySelector('#prepareRun'),true,'正在核对参考图');
    try{const choice=templateChoiceRevision;if(runHydration)await runHydration;if(customerPoolLoading)await customerPoolLoading;await Promise.all([...pendingTemplateChoices]);if(choice!==templateChoiceRevision)throw new Error('模板选择已更新，请核对后再点击发送。');await smartTaskWorkflow.prepare();if(choice!==templateChoiceRevision)throw new Error('模板选择已更新，请核对后再点击发送。');if(currentRunId){await repairCurrentSmartRun();}}
    catch(error){setPrimaryNotice(error.message);primaryActionBusy=false;setBusy(document.querySelector('#prepareRun'),false);return;}
    primaryActionBusy=false;setBusy(document.querySelector('#prepareRun'),false);
  }
  if (generationMode?.usesApi()) {
    primaryActionBusy=true;
    const button=document.querySelector('#prepareRun');setBusy(button,true,'正在处理 API 任务');
    try{if(currentManifest?.artifacts?.length)setStage('review');else await generationMode.submit();}
    catch(error){setPrimaryNotice(error.message);}
    finally{primaryActionBusy=false;setBusy(button,false);generationMode.sync();}
    return;
  }
  primaryActionBusy = true;
  const button = document.querySelector('#prepareRun');
  if (currentRunId) {
    const recoveryState = deriveSubmitRecoveryState({ currentRunId, manifest: currentManifest || {} });
    const action = derivePrimaryAction({ currentRunId, manifest: currentManifest || {} });
    if (recoveryState === 'orphaned_recovery_blocked') {
      elements.prepareResult.textContent = '任务身份或状态不完整，已阻止新建与再次发送；请从历史记录恢复。';
      primaryActionBusy = false;
      return;
    }
    setBusy(button, true, '正在继续本次任务');
    setPrimaryNotice('正在核对并继续原任务。','busy');syncCaptureRefresh();
    try {
      if (action.kind === 'continue_same_run') {
        const submitted = await stageAndSubmitRunOnce(currentRunId);
        elements.prepareResult.textContent = submitted.state === 'submitted'
          ? '已继续原任务并发送一次。'
          : (submitted.message || '原任务已经尝试发送，系统不会重复发送。');
      } else if (action.kind === 'submit_once_same_run') {
        const submitted = await stageAndSubmitRunOnce(currentRunId);
        elements.prepareResult.textContent = submitted.state === 'submitted'
          ? '已发送一次。'
          : (submitted.message || '该任务已经尝试发送，系统不会重复发送。');
      } else if (['capture_results', 'capture_only'].includes(action.kind)) {
        const captured = await api(`/api/runs/${currentRunId}/capture`, { method: 'POST' });
        elements.prepareResult.textContent = captured.artifacts?.length
          ? `已保存 ${captured.artifacts.length} 张候选图。`
          : (captured.capture?.message || '尚未检测到可验证结果；不会重新发送。');
      } else if (action.kind === 'review_artifacts') {
        setStage('review');
        elements.prepareResult.textContent = '当前任务已有结果，请继续评分与选择。';
      } else {
        elements.prepareResult.textContent = '任务身份或状态不完整，已阻止新建与再次发送；请从历史记录恢复。';
      }
      const refreshed = await refreshRun().catch(() => null);
      const recovery = deriveSubmitRecoveryState({ currentRunId, manifest: refreshed?.manifest || currentManifest || {} });
      if (recovery === 'artifacts_review') setStage('review');
      else if (['submitted_capture', 'submission_uncertain_capture_only'].includes(recovery)) setStage('results');
      else if (currentRunId) setStage('generation');
    } catch (error) {
      setPrimaryNotice(`无法继续原任务：${readableFailure(error.message)}`);
      await refreshRun().catch(() => null);
    } finally {
      setBusy(button, false);
      primaryActionBusy = false;
      renderPrimaryActionPresentation();syncCaptureRefresh();
    }
    return;
  }
  const action = derivePrimaryAction({});
  const form = new FormData(submittedForm);
  form.set('runCreationIdempotencyKey', pendingRunCreationIdempotencyKey());
  const selectedCustomerId = String(form.get('customerId') || '');
  if (!selectedCustomerId && form.get('customerName')) form.set('customerId', customerIdFromName(form.get('customerName')));
  // Append catalog template UIDs & selection ID
  const selectedCatalogTemplates = templateLibraryController.getSelectedTemplates();
  for (const t of selectedCatalogTemplates) {
    form.append('catalogTemplateUids', t.uid);
  }
  const activeSelId = recommendationController.getSelectionId();
  if (selectedCatalogTemplates.length && activeSelId) {
    form.append('templateSelectionId', activeSelId);
    const decisionKey = recommendationController.getDecisionIdempotencyKey();
    if (decisionKey) form.append('templateDecisionIdempotencyKey', decisionKey);
  }
  try {
    await prepareFaceAngleSubmission(form);
    applyReuseToForm(form);
  } catch (error) {
    elements.prepareResult.textContent = error.code === 'manual_primary_required'
      ? '请先点击一张身份图作为主图。'
      : `无法确认主身份图：${error.message}`;
    primaryActionBusy = false;
    return;
  }
  if (!referenceFileState.templates.length && !selectedCatalogTemplates.length) {
    elements.prepareResult.textContent = '请至少上传一张模板图，或从模板库选择一张模板。';
    primaryActionBusy = false;
    return;
  }
  if (!smartTaskWorkflow && !form.get('identitySetId') && !form.getAll('identityAngles').length) {
    elements.prepareResult.textContent = '请至少标记一个身份参考图角度。';
    primaryActionBusy = false;
    return;
  }
  const intentAngleMap = { front: 'frontal', left_45: 'left_45', right_45: 'right_45', profile: 'full_profile' };
  form.set('targetAngle', intentAngleMap[String(form.get('targetIntentAngle') || '')] || String(form.get('targetAngle') || 'frontal'));
  const missingSetting = ['targetAngle', 'targetFraming']
    .map((id) => document.querySelector(`#${id}`))
    .find((control) => !control.value);
  if (missingSetting && !smartTaskWorkflow) {
    elements.advancedReferenceSettings.showModal();
    elements.prepareResult.textContent = '请先确认目标景别和本次出图角度。';
    missingSetting.focus();
    primaryActionBusy = false;
    return;
  }
  setBusy(button, true, '正在提交生成');
  setPrimaryNotice('正在保存任务、上传参考图并向 ChatGPT 发送一次。','busy');
  try {
    if (selectedCatalogTemplates.length) {
      await persistCatalogSelectionDecision();
      form.set('templateSelectionId', recommendationController.getSelectionId());
      form.set('templateDecisionIdempotencyKey', recommendationController.getDecisionIdempotencyKey());
    }
    if (!action.createsRun) throw new Error('当前状态不允许创建新任务');
    applySmartSubmission(form);
    const probe = await api('/api/browser/probe', { method: 'POST' });
    renderBrowserStatus(probe);
    if (!probe.browser.ready) {
      throw new Error(probe.browser.message || 'Playwright 尚未连接默认 Chrome，系统没有创建、上传或发送任务。');
    }
    const data = await api('/api/runs', { method: 'POST', body: form });
    activeReviewViewOverride = '';
    currentRunId = data.runId;
    currentRunOpenedFromHistory = false;
    history.replaceState(null, '', `?run=${encodeURIComponent(currentRunId)}`);
    syncCaptureRefresh();
    if (data.referencePreflight.state === 'blocked') {
      elements.prepareResult.textContent = `任务已保存，但预检未通过：${data.referencePreflight.blocking_issues.map((item) => item.message).join('；')}`;
      await refreshRun();
      return;
    }
    const submitted = await stageAndSubmitRunOnce(currentRunId, { probeBrowserFirst: false });
    elements.prepareResult.textContent = submitted.state === 'submitted'
      ? '已向 ChatGPT 发送一次。工作站将在后台自动检测并保存结果；若自动捕获失败，可手工检测或导入。'
      : (submitted.message || '任务已经尝试发送，系统不会重复发送。');
    const refreshed=await refreshRun();
    setStage(refreshed?.manifest?.artifacts?.length?'review':['submitted', 'submission_uncertain'].includes(submitted.state) ? 'results' : 'generation');
    if (['submitted', 'submission_uncertain'].includes(submitted.state)) monitorAutomaticCapture(currentRunId).catch(() => {});
  } catch (error) {
    if (error.runId) {
      currentRunId = error.runId;
      currentRunOpenedFromHistory = false;
      clearPendingRunCreationIdempotencyKey();
      history.replaceState(null, '', `?run=${encodeURIComponent(currentRunId)}`);
      await refreshRun().catch(() => null);
      elements.prepareResult.textContent = '已找回先前创建的同一任务。为避免错发，系统没有按修改后的内容新建或重发；请检查后继续本次任务。';
    } else {
      setPrimaryNotice(`本次提交未完成：${readableFailure(error.message)}`);
      if(currentRunId)await refreshRun().catch(()=>null);
    }
  } finally {
    setBusy(button, false);
    primaryActionBusy = false;
    renderPrimaryActionPresentation();syncCaptureRefresh();
  }
});

elements.stageRun.addEventListener('click', async () => {
  if (!currentRunId) return;
  if (!window.confirm('将把身份参考图、模板图和提示词装载到默认 Chrome 的 ChatGPT，但不会发送。是否继续？')) return;
  setBusy(elements.stageRun, true, '正在装载');
  elements.workflowResult.textContent = 'Playwright 正在默认 Chrome 中打开全新 ChatGPT 对话并装载参考图。';
  try {
    const data = await api(`/api/runs/${currentRunId}/stage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) });
    elements.workflowResult.textContent = data.state === 'awaiting_submission_confirmation'
      ? '已装载到 ChatGPT，当前没有发送。请在默认 Chrome 中检查参考图和提示词。'
      : data.message;
  } catch (error) {
    elements.workflowResult.textContent = `装载失败：${error.message}`;
  } finally {
    setBusy(elements.stageRun, false);
    await refreshRun().catch(() => {});
  }
});

elements.submitRun.addEventListener('click', async () => {
  if (!currentRunId) return;
  if (!window.confirm('即将点击一次 ChatGPT 发送按钮。发送后不会自动重试。是否确认？')) return;
  setBusy(elements.submitRun, true, '正在发送');
  elements.workflowResult.textContent = '正在执行唯一一次发送。';
  try {
    const data = await api(`/api/runs/${currentRunId}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) });
    elements.workflowResult.textContent = data.state === 'submitted'
      ? '已发送一次。等待生图完成后，再进入“结果导入”。'
      : (data.message || '该任务已经尝试发送，系统不会重复点击。');
  } catch (error) {
    elements.workflowResult.textContent = `无法发送：${error.message}`;
  } finally {
    setBusy(elements.submitRun, false);
    await refreshRun().catch(() => {});
    setStage('results');
  }
});

document.getElementById('captureOutputGrid').addEventListener('click',event=>{
  const trigger=event.target.closest('[data-capture-preview]');if(!trigger||!currentManifest)return;
  const items=(currentManifest.artifacts||[]).map((artifact,index)=>({kind:'generated',url:`/api/runs/${encodeURIComponent(currentRunId)}/artifacts/${encodeURIComponent(artifact.artifact_id)}/file`,caption:`候选 ${artifact.ordinal||index+1}`}));
  openMediaPreview(items,Number(trigger.dataset.capturePreview),trigger);
});
const discardRunButton = document.getElementById('discardRun');
const discardRunDialog = document.getElementById('discardRunDialog');
let discardRunId = null;
let discardRunBusy = false;
discardRunButton.addEventListener('click', () => {
  if (!currentRunId || !currentManifest?.artifacts?.length || discardRunBusy) return;
  discardRunId = currentRunId;
  discardRunDialog.showModal();
});
discardRunDialog.addEventListener('close', async () => {
  const runId = discardRunId;
  const confirmed = discardRunDialog.returnValue === 'discard';
  discardRunId = null;
  discardRunDialog.returnValue = '';
  if (!confirmed || !runId || runId !== currentRunId || discardRunBusy) return;
  discardRunBusy = true;
  setBusy(discardRunButton, true, '正在删除');
  elements.captureRun.disabled = true;
  try {
    await api(`/api/runs/${encodeURIComponent(runId)}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    });
    if (runId === currentRunId) {
      generationMode?.reset();
      window.location.replace('/?view=history');
    }
  } catch (error) {
    if (runId === currentRunId) {
      elements.resultMessage.hidden = false;
      elements.resultMessage.textContent = `无法删除本次任务：${error.message}`;
    }
  } finally {
    discardRunBusy = false;
    elements.captureRun.disabled = false;
    setBusy(discardRunButton, false);
  }
});
elements.captureRun.addEventListener('click', async () => {
  if (!currentRunId || captureBusy || discardRunBusy) return;
  if (currentManifest?.artifacts?.length) { setStage('review'); return; }
  if(currentManifest?.image_api){
    setBusy(elements.captureRun,true,'正在恢复 API 结果');
    try{await generationMode.resume();}catch(error){elements.resultMessage.textContent=error.message;}
    finally{setBusy(elements.captureRun,false);generationMode.sync();}return;
  }
  captureBusy=true;
  setBusy(elements.captureRun, true, '正在检测');
  renderCaptureBody(currentManifest,{busy:true});
  elements.resultMessage.textContent = '正在核对当前对话中的新图片资源；不会提交新任务。';
  try {
    const data = await api(`/api/runs/${currentRunId}/capture`, { method: 'POST' });
    elements.resultMessage.textContent = data.artifacts?.length
      ? `已保存 ${data.artifacts.length} 张独立候选图。`
      : (data.capture?.message ? readableFailure(data.capture.message) : '没有找到可验证的原图，请使用人工导入。');
  } catch (error) {
    elements.resultMessage.textContent = `自动保存未完成：${error.message} 请使用人工导入；系统没有重新提交任务。`;
  } finally {
    captureBusy=false;
    setBusy(elements.captureRun, false);
    const data = await refreshRun().catch(() => null);
    renderCaptureBody(currentManifest);
    if (data?.manifest?.artifacts?.length) setStage('review');
  }
});

elements.artifactImportForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form=event.currentTarget;
  if (!currentRunId) return;
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true, '正在导入');
  try {
    const data = await api(`/api/runs/${currentRunId}/artifacts/import`, { method: 'POST', body: new FormData(form) });
    elements.resultMessage.textContent = `已保存 ${data.artifacts.length} 张独立候选图。`;
    form.reset();
  } catch (error) {
    elements.resultMessage.textContent = `无法导入结果：${error.message}`;
  } finally {
    setBusy(button, false);
    renderImportAction();
    const data = await refreshRun().catch(() => null);
    if (data?.manifest?.artifacts?.length) setStage('review');
  }
});

elements.artifactGallery.addEventListener('click', (event) => {
  const annotationButton = event.target.closest('[data-open-annotation]');
  if (annotationButton && currentManifest) {
    const artifactId = annotationButton.dataset.openAnnotation;
    if (inspectorDirty && artifactId !== selectedArtifactId && !window.confirm('当前候选的评分尚未保存。打开其他图片会丢失这些未保存输入，是否继续？')) return;
    selectedArtifactId = artifactId;
    inspectorDirty = false;
    renderArtifacts(currentManifest);
    const artifact = currentManifest.artifacts.find((item) => item.artifact_id === artifactId);
    openArtifactAnnotation({
      runId: currentRunId,
      artifact,
      onSaved: async () => { await refreshRun(); },
      onSubmitRevision: !currentManifest.image_api && artifactRevisionCapability === 'ready' ? createAndSubmitArtifactRevision : null,
    }).catch((error) => { elements.resultMessage.textContent = `无法打开批注：${error.message}`; });
    return;
  }
  const button = event.target.closest('[data-select-artifact]');
  if (!button || !currentManifest) return;
  if (inspectorDirty && !window.confirm('当前候选的评分尚未保存。切换后会丢失这些未保存输入，是否继续？')) return;
  selectedArtifactId = button.dataset.selectArtifact;
  inspectorDirty = false;
  renderArtifacts(currentManifest);
});

elements.artifactInspector.addEventListener('input', (event) => {
  if (event.target.closest('.artifact-review-form')) inspectorDirty = true;
});

elements.artifactInspector.addEventListener('submit', async (event) => {
  const form = event.target.closest('.artifact-review-form');
  if (!form) return;
  event.preventDefault();
  const artifactId = form.dataset.artifactId;
  const button = form.querySelector('button[type="submit"]');
  const message = form.querySelector('.artifact-review-message');
  const nextArtifactId = currentManifest?.artifacts?.find((artifact) => artifact.artifact_id !== artifactId && !currentManifest.artifact_reviews?.[artifact.artifact_id])?.artifact_id || artifactId;
  setBusy(button, true, '正在保存');
  try {
    const data = await api(`/api/runs/${currentRunId}/artifacts/${artifactId}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reviewPayload(form)) });
    inspectorDirty = false;
    selectedArtifactId = nextArtifactId;
    pendingReviewMessage = `上一张已保存：${verdictLabels[data.review.verdict] || data.review.verdict}`;
  } catch (error) {
    message.textContent = `无法保存评分：${error.message}`;
  } finally {
    setBusy(button, false);
    await refreshRun().catch(() => {});
  }
});

for (const button of elements.aestheticComparisonForm.querySelectorAll('[data-comparison-outcome]')) {
  button.addEventListener('click', async () => {
    try {
      await saveAestheticComparison(button.dataset.comparisonOutcome);
    } catch (error) {
      elements.aestheticComparisonMessage.textContent = `无法保存：${error.message}`;
    }
  });
}

for (const button of elements.reviewStepButtons) {
  button.addEventListener('click', () => {
    if (!currentManifest) return;
    const target = button.dataset.reviewStepTarget;
    if (!deriveReviewNavigationState(currentManifest).navigableViews.includes(target)) return;
    if (inspectorDirty && target !== 'score' && !window.confirm('当前候选的评分尚未保存。切换步骤会丢失这些未保存输入，是否继续？')) return;
    if (target !== 'score') inspectorDirty = false;
    activeReviewViewOverride = target;
    renderReviewWorkspaceStep(currentManifest);
  });
}

elements.comparisonArtifactA.addEventListener('change', () => {
  if (currentManifest) renderComparisonPreviews(currentManifest);
});

elements.comparisonArtifactB.addEventListener('change', () => {
  if (currentManifest) renderComparisonPreviews(currentManifest);
});

elements.preferenceForm.addEventListener('change', (event) => {
  if (event.target.name === 'decision') elements.winnerField.hidden = event.target.value !== 'winner';
});

elements.preferenceForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentRunId) return;
  const form = new FormData(event.currentTarget);
  const selectedCustomerId = String(form.get('customerId') || '');
  if (!selectedCustomerId && form.get('customerName')) form.set('customerId', customerIdFromName(form.get('customerName')));
  const button = document.querySelector('#savePreference');
  setBusy(button, true, '正在保存');
  try {
    const decision = String(form.get('decision') || 'pending');
    const winnerArtifactId = String(form.get('winnerArtifactId') || '');
    if (decision === 'winner' && !winnerArtifactId) throw new Error('请选择一张合格候选作为最终交付结果');
    const data = await api(`/api/runs/${currentRunId}/preference`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, winnerArtifactId: winnerArtifactId || null, notes: String(form.get('notes') || '') }) });
    elements.preferenceMessage.textContent = data.preference.decision === 'winner'
      ? '最终交付结果已记录'
      : data.preference.decision === 'none' ? '本次全部不要' : '暂不决定';
    if (shouldClearRunUrlAfterPreference(data.preference.decision, currentRunOpenedFromHistory)) {
      sessionStorage.setItem(homeNoticeStorageKey, COMPLETED_RUN_NOTICE);
      history.replaceState(null, '', '/');
    }
  } catch (error) {
    elements.preferenceMessage.textContent = `无法保存：${error.message}`;
  } finally {
    setBusy(button, false);
    await refreshRun().catch(() => {});
  }
});


if (elements.customerSelector) elements.customerSelector.addEventListener('change', async () => {
  if(activeReuseDraft && elements.customerSelector.value!==activeReuseDraft.customer_id){activeReuseDraft=null;reuseFileDescriptors.clear();referenceFileState.identity=[];referenceFileState.templates=[];renderReferencePreviews('identity');renderReferencePreviews('templates');}
  renderCustomerFieldVisibility();
  try {
    await loadFoundationActivePhotoPool(elements.customerSelector.value);
  } catch (error) {
    elements.promptCompilationNotice.textContent = error.message;
  }
  renderSendSummary();
});
function handleRunFormTaskChange(event) {
  if(smartTaskWorkflow){smartTaskWorkflow.changed(event);renderSendSummary();return;}
  invalidateRecommendationIfTaskChanged();
  renderSendSummary();
}
document.querySelector('#runForm')?.addEventListener('input', handleRunFormTaskChange);
document.querySelector('#runForm')?.addEventListener('change', handleRunFormTaskChange);
elements.appendCustomerPhotosButton?.addEventListener('click', () => elements.customerPhotoAppendInput?.click());
elements.customerPhotoAppendInput?.addEventListener('change', () => appendCustomerPhotos().catch((error) => {
  elements.customerPhotoPoolMessage.textContent = `无法添加照片：${error.message}`;
  elements.customerPhotoPoolMessage.classList.add('is-warning');
}));
for (const button of [elements.cancelCustomerPhotoRename, elements.closeCustomerPhotoRename]) {
  button?.addEventListener('click', () => elements.customerPhotoRenameDialog?.close());
}
elements.customerPhotoRenameForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = elements.customerPhotoRenameInput.value;
  elements.customerPhotoRenameMessage.textContent = '';
  setBusy(elements.saveCustomerPhotoRename, true, '保存中');
  try {
    const data = await mutateManagedCustomerPhoto({ method: 'PATCH', name: value });
    elements.customerPhotoRenameDialog.close();
    const renamed = data.target?.new_original_name || managedCustomerPhotoReference()?.original_name || value;
    elements.customerPhotoPoolMessage.textContent = data.no_changes ? '照片名称没有变化。' : `照片已重命名为“${renamed}”。`;
    elements.customerPhotoPoolMessage.classList.remove('is-warning');
  } catch (error) {
    elements.customerPhotoRenameMessage.textContent = `无法重命名：${error.message}`;
  } finally {
    setBusy(elements.saveCustomerPhotoRename, false);
  }
});
if (elements.previewCompiledPrompt) elements.previewCompiledPrompt.addEventListener('click', async () => { setBusy(elements.previewCompiledPrompt, true, '编译中'); try { await previewFoundationPrompt(); } catch (error) { elements.promptCompilationNotice.textContent = `无法编译：${error.message}`; } finally { setBusy(elements.previewCompiledPrompt, false); } });
function apiPromptFromForm(form){
  const parts=[...['intendedUse','targetFraming','targetIntentAngle','layoutIntent'].map(id=>`${document.querySelector(`label[for="${id}"]`)?.textContent||id}：${selectedOptionText(document.querySelector(`#${id}`))}`),`人物气质：${[...document.querySelectorAll('input[name="temperamentKeywords"]:checked')].map(e=>e.parentElement.textContent.trim()).join('、')||'自然'}`,String(form.get('userSupplement')||'').trim()];
  return parts.filter(Boolean).join('\n');
}
generationMode=initGenerationMode({
  getRun:()=>currentManifest,
  onConfigChanged:config=>resultWorkbench?.updateApiConfig(config),
  isBusy:()=>primaryActionBusy,
  refreshSummary:renderSendSummary,
  showMessage:message=>{elements.prepareResult.textContent=message;elements.resultMessage.textContent=message;},
  buildForm:async operation=>{
    const form=new FormData(document.querySelector('#runForm'));
    if(operation==='edit'){
      if (templateLibraryController.getSelectedCount() || referenceFileState.templates.length) await previewFoundationPrompt();
      await prepareFaceAngleSubmission(form);
      const selected=templateLibraryController.getSelectedTemplates();
      if(selected.length){await persistCatalogSelectionDecision();form.set('templateSelectionId',recommendationController.getSelectionId());form.set('templateDecisionIdempotencyKey',recommendationController.getDecisionIdempotencyKey());for(const item of selected)form.append('catalogTemplateUids',item.uid);}
    }else{
      for(const key of ['identity','templates','identitySetId','identityReferenceOrdinals','primaryIdentityReferenceOrdinal','saveIdentitySet'])form.delete(key);
    }
    const selectedCustomer=foundationCustomers.find(c=>c.customer_id===String(form.get('customerId')||''));
    if(selectedCustomer)form.set('customerName',selectedCustomer.display_name);
    const supplement=String(form.get('userSupplement')||'').trim();
    if(operation==='generate'&&!supplement)throw new Error('请在补充要求里写明想生成的内容');
    form.set('prompt',apiPromptFromForm(form));applyReuseToForm(form);if(operation==='edit')applySmartSubmission(form);return form;
  },
  acceptResult:async result=>{
    currentRunId=result.runId;currentRunOpenedFromHistory=false;
    history.replaceState(null,'',`?run=${encodeURIComponent(currentRunId)}`);
    await refreshRun();setStage(currentManifest?.artifacts?.length?'review':'results');
  },
});
function applyReuseToForm(form){
  if(!activeReuseDraft)return;
  if(String(form.get('customerId')||'')!==activeReuseDraft.customer_id)throw new Error('沿用草稿客户已变化，请重新选择参考图');
  const references=[];
  for(const [role,field]of [['identity','identity'],['template','templates']]){
    const files=form.getAll(field).filter(f=>typeof f!=='string'&&f.size);form.delete(field);
    files.forEach((file,position)=>{const source=reuseFileDescriptors.get(`${role}:${file.name}`);if(source)references.push({role,ordinal:source.ordinal,sha256:source.sha256,position});else form.append(field,file,file.name);});
  }
  form.set('sourceRunId',activeReuseDraft.source_run_id);form.set('reuseReferences',JSON.stringify(references));form.delete('identitySetId');form.delete('saveIdentitySet');
}
async function recallRunSettings(data){
  const reuse=data.reuse;if(!reuse?.available)throw new Error('此记录没有可沿用的原任务设置');
  const materialized=[];
  for(const r of reuse.references.filter(r=>!r.template_uid)){
    const response=await fetch(r.url);if(!response.ok)throw new Error('原参考图无法读取，请重新选择');
    const file=new File([await response.blob()],`reuse-${crypto.randomUUID()}-${r.name}`,{type:response.headers.get('content-type')||'image/png'});materialized.push({r,file});
  }
  const catalog=await templateLibraryController.loadTemplates();
  const catalogRefs=reuse.references.filter(r=>r.template_uid);const chosen=catalogRefs.map(r=>{
    const item=catalog.templates.find(t=>t.template_uid===r.template_uid);if(!item||item.reference_image.sha256!==r.sha256)throw new Error('原目录模板已变化，请在新任务中重新选择');return item;
  });
  returnToNewTask('已沿用为草稿，尚未创建或发送任务。');elements.historyDialog?.close();
  const form=document.querySelector('#runForm');form.reset();useIdentityUploadMode();
  if(![...elements.customerSelector.options].some(o=>o.value===reuse.customer_id))elements.customerSelector.add(new Option(reuse.customer_name,reuse.customer_id));
  elements.customerSelector.value=reuse.customer_id;elements.customerName.value=reuse.customer_name;
  referenceFileState.identity=materialized.filter(x=>x.r.role==='identity').map(x=>x.file);referenceFileState.templates=materialized.filter(x=>x.r.role==='template').map(x=>x.file);manualPrimaryIdentityIndex=0;
  reuseFileDescriptors=new Map(materialized.map(({r,file})=>[`${r.role}:${file.name}`,r]));activeReuseDraft=reuse;
  setReferenceInputFiles(elements.identityInput,referenceFileState.identity);setReferenceInputFiles(elements.templateInput,referenceFileState.templates);
  renderReferencePreviews('identity');renderReferencePreviews('templates');
  const intent=reuse.task_intent||{};const fields={intendedUse:intent.use_case,targetFraming:intent.target_framing,targetIntentAngle:intent.target_face_angle,layoutIntent:intent.layout_intent,userSupplement:intent.user_supplement};
  smartTaskWorkflow?.restore(reuse.manual_overrides || {useCase:intent.use_case||'custom',userSupplement:intent.user_supplement||'',...(intent.target_framing&&intent.target_framing!=='follow_template'?{targetFraming:intent.target_framing}:{}),...(intent.target_face_angle&&intent.target_face_angle!=='follow_identity'?{targetFaceAngle:intent.target_face_angle}:{})});
  for(const [name,v]of Object.entries(fields))if(v!=null&&form.elements[name])form.elements[name].value=v;
  for(const check of form.querySelectorAll('[name=temperamentKeywords]'))check.checked=(intent.temperament_keywords||[]).includes(check.value);
  document.querySelector('#generationMode').value=reuse.channel;
  for(const [id,key]of [['apiOperation','operation'],['apiImageCount','n'],['apiImageSize','size'],['apiImageQuality','quality']])if(reuse.api_settings?.[key]!=null)document.querySelector(`#${id}`).value=String(reuse.api_settings[key]);
  form.querySelector('[name=saveIdentitySet]').checked=false;
  invalidateRecommendationIfTaskChanged();templateLibraryController.setSelectedTemplates(chosen);refreshTemplateSelectionViews();generationMode.sync();renderSendSummary();
  const cfg=data.current_api_config||{},old=reuse.api_settings;const changes=old&&(old.model!==cfg.model||old.provider!==cfg.baseUrl);
  const warning=chosen.some(t=>t.operator_rejected)?' 原模板已淘汰，请移除并重新选择。':'';
  elements.prepareResult.textContent=`已沿用草稿，尚未创建或发送任务。${changes?` 原配置 ${old.model} / ${old.provider}；提交将使用当前 ${cfg.model||'未配置'} / ${cfg.baseUrl||'未配置'}。`:''}${warning}${reuse.task_intent?'':' 旧任务未记录结构化设置，请补全；没有把旧完整提示词当作补充要求。'}`;
}
async function resultRevisionRequest({runId,artifactId,instruction,includeAnnotations,annotationSessionId,jobKey,recoverOnly,expectedApiConfig}){
  const request=async(url,options={})=>{const response=await fetch(url,{...options,headers:{'x-image-api-client':'workstation',...(options.headers||{})}});const body=await response.json();if(!response.ok)throw Object.assign(new Error(typeof body.error==='string'?body.error:body.error?.message||'修改任务失败'),{status:response.status});return body;};
  if(recoverOnly){const status=await request(`/api/image-api/jobs/${jobKey}`);if(['saving','save_failed','submission_uncertain'].includes(status.state)){try{return await request(`/api/image-api/jobs/${jobKey}/recover`,{method:'POST'});}catch{return status;}}return status;}
  return request(`/api/runs/${runId}/artifacts/${artifactId}/revisions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmed:true,jobKey,instruction,includeAnnotations,annotationSessionId,expectedApiConfig})});
}
resultWorkbench=initResultWorkbench({container:document.querySelector('#resultWorkbench'),onRecall:recallRunSettings,onRevision:resultRevisionRequest,
  onViewChange:open=>{document.querySelector('#reviewWorkspace').hidden=open;},
  onOpenRun:async runId=>{currentRunId=runId;history.replaceState(null,'',`?run=${encodeURIComponent(runId)}`);await refreshRun();setStage(currentManifest.artifacts?.length?'review':'results');},
  onAnnotate:async(data,artifactId)=>openArtifactAnnotation({runId:data.runId,artifact:data.manifest.artifacts.find(a=>a.artifact_id===artifactId),onSaved:async()=>refreshRun(),onSubmitRevision:null}),
});
document.querySelector('#openResultWorkbench')?.addEventListener('click',()=>resultWorkbench.open());
function smartEditingEnabled(){return (!currentManifest || (!Number(currentManifest.submission_attempt_count||0)&&!currentManifest.artifacts?.length)) && !(generationMode?.usesApi()&&document.querySelector('#apiOperation').value==='generate');}
function smartCustomer(){
  const stored=currentManifest&&!Number(currentManifest.submission_attempt_count||0)?currentManifest:null;
  let id=stored?.customer_id||stored?.customer_identity_source?.customer_id||elements.customerSelector.value;
  let name=stored?.customer_name||elements.customerName.value.trim();
  if(!id){if(!smartDraftCustomerId){smartDraftCustomerId=`cust_${crypto.randomUUID().replaceAll('-','').slice(0,16)}`;sessionStorage.setItem('ai-img-gen.smart-draft-customer',smartDraftCustomerId);}id=smartDraftCustomerId;}
  if(!name){name=`未命名客户-${id.slice(-6)}`;elements.customerName.value=name;}
  if(!elements.customerName.value.trim())elements.customerName.value=name;
  return {id,name};
}
function getSmartDraftForm(){
  const ctx=smartCustomer();const form=new FormData(document.querySelector('#runForm'));form.set('customerId',ctx.id);form.set('customerName',ctx.name);
  for(const [id,name]of [['apiImageCount','n'],['apiImageSize','size'],['apiImageQuality','quality']])form.set(name,document.getElementById(id).value);
  form.delete('identity');form.delete('identityReferenceOrdinals');form.delete('identitySetId');form.delete('catalogTemplateUids');
  if(customerPhotoPoolState.identitySetId){const ordinals=orderedCustomerPhotoOrdinals(customerPhotoPoolState);form.set('identitySetId',customerPhotoPoolState.identitySetId);form.set('primaryIdentityReferenceOrdinal',String(customerPhotoPoolState.primaryOrdinal));for(const ordinal of ordinals)form.append('identityReferenceOrdinals',String(ordinal));}
  else if(referenceFileState.identity.length){const index=normalizeManualPrimaryIndex(manualPrimaryIdentityIndex,referenceFileState.identity.length)??0;for(const file of reorderManualPrimary(referenceFileState.identity,index))form.append('identity',file,file.name);}
  for(const t of templateLibraryController.getSelectedTemplates())form.append('catalogTemplateUids',t.uid);
  if(activeReuseDraft)applyReuseToForm(form);
  if(currentRunId&&currentManifest&&!referenceFileState.identity.length&&!customerPhotoPoolState.identitySetId){form.set('existingRunId',currentRunId);form.set('useStoredReferences','true');form.set('storedReferenceHashes',JSON.stringify((currentManifest.identity_references||[]).map(r=>r.sha256)));if(!referenceFileState.templates.length&&!templateLibraryController.getSelectedCount())form.set('useStoredTemplates','true');}
  return form;
}
function applySmartSubmission(form){
  if(!smartTaskWorkflow)return;if(!smartResolved)throw new Error('输入已变化，请核对后再点击发送；本次尚未创建任务。');const ctx=smartCustomer();
  form.set('smartTask','true');form.set('smartOverrides',JSON.stringify(smartTaskWorkflow.manual));form.set('customerId',ctx.id);form.set('customerName',ctx.name);
  const intent=smartResolved.task_intent;form.set('intendedUse',intent.use_case);form.set('targetFraming',intent.target_framing);form.set('targetIntentAngle',intent.target_face_angle);form.set('layoutIntent',intent.layout_intent);form.set('userSupplement',intent.user_supplement);
}
async function repairCurrentSmartRun(){
  await ensureActiveRecommendation();if(templateLibraryController.getSelectedCount())await persistCatalogSelectionDecision();
  const form=smartTaskWorkflow.formNow();const selection=recommendationController.getSelection();
  if(selection){form.set('templateSelectionId',selection.selection_id);form.set('templateDecisionIdempotencyKey',recommendationController.getDecisionIdempotencyKey()||'');}
  const response=await fetch(`/api/runs/${currentRunId}/prepare`,{method:'POST',headers:{'x-smart-task-client':'workstation'},body:form});const data=await response.json();if(!response.ok)throw new Error(typeof data.error==='string'?data.error:data.error?.message||'无法更新原任务');
  await applyRunData(data);
}
smartTaskWorkflow=createSmartTaskWorkflow({getForm:getSmartDraftForm,isEnabled:smartEditingEnabled,
  onRevision:()=>{recommendationController.invalidatePendingRecommendations();smartResolved=null;},
  onResolution:resolution=>{smartResolved=resolution;const missingIdentity=resolution.blocking_issues.some(i=>i.code==='identity_required');elements.recommendationsSection.hidden=missingIdentity;if(resolution.blocking_issues.some(i=>['identity_required','multiple_faces','identity_unusable'].includes(i.code)))elements.recommendationsContainer.hidden=true;renderSendSummary();},
  onRecommend:async resolution=>{if(recommendationController.matchesTaskBrief(resolution.recommendation_brief)){renderRecommendationState();return;}await requestActiveRecommendation(true);},
  onStatus:(message,{state='idle'}={})=>{
    document.querySelector('#customerVisualStatus').textContent=message;
    const notice=document.querySelector('#customerVisualNotice');
    notice.dataset.state=state;
    notice.hidden=!['analyzing','warning','error'].includes(state);
    notice.textContent=state==='analyzing'?'正在分析照片…':message;
    notice.setAttribute('aria-busy',String(state==='analyzing'));
    document.querySelector('#reanalyzeCustomer').disabled=state==='analyzing';
  },
});
document.body.dataset.smartTask='enabled';
const smartFieldIds={useCase:'intendedUse',targetFraming:'targetFraming',targetFaceAngle:'targetIntentAngle',layoutIntent:'layoutIntent',styleCategory:'smartStyleCategory'};
for(const [field,id]of Object.entries(smartFieldIds)){const control=document.getElementById(id);if(control){control.required=false;control.closest('.field')?.insertAdjacentHTML('beforeend',`<div class="smart-field-source"><small data-smart-source="${field}">系统默认</small><button type="button" class="quiet-button" data-smart-auto="${field}">恢复自动</button></div>`);}}
document.querySelector('#intendedUse').value='custom';
document.querySelector('#targetAngle').required=false;
document.querySelector('#customerName').placeholder='可稍后命名，不影响开始';
const taskOptionsDialog=document.querySelector('#taskOptionsDialog');
const taskOptionsBody=document.querySelector('#taskOptionsBody');
const taskOptionsTrigger=document.querySelector('#openTaskOptions');
function updateTaskOptionsScroll(){
  const scrollSurface=getComputedStyle(taskOptionsBody).overflowY==='visible'?taskOptionsDialog:taskOptionsBody;
  const remaining=scrollSurface.scrollHeight-scrollSurface.clientHeight-scrollSurface.scrollTop;
  const overflows=scrollSurface.scrollHeight>scrollSurface.clientHeight+2;
  taskOptionsDialog.dataset.scrollable=String(overflows);
  taskOptionsDialog.dataset.scrolled=String(scrollSurface.scrollTop>2);
  taskOptionsDialog.dataset.moreBelow=String(remaining>3);
  document.querySelector('#taskOptionsScrollHint').textContent=overflows?(remaining>3?'下方还有设置 · 向下滚动':'已到底部 · 全部设置已显示'):'全部设置已显示';
}
taskOptionsTrigger.addEventListener('click',()=>{taskOptionsDialog.showModal();requestAnimationFrame(updateTaskOptionsScroll);});
for(const id of ['closeTaskOptions','doneTaskOptions'])document.getElementById(id).addEventListener('click',()=>taskOptionsDialog.close());
taskOptionsDialog.addEventListener('close',()=>{taskOptionsTrigger.focus({preventScroll:true});renderSendSummary();});
taskOptionsDialog.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.matches('input,select'))event.preventDefault();});
taskOptionsDialog.addEventListener('click',event=>{if(event.target!==taskOptionsDialog)return;const r=taskOptionsDialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)taskOptionsDialog.close();});
taskOptionsBody.addEventListener('scroll',updateTaskOptionsScroll,{passive:true});
taskOptionsDialog.addEventListener('scroll',updateTaskOptionsScroll,{passive:true});
new ResizeObserver(updateTaskOptionsScroll).observe(taskOptionsBody);
document.querySelector('#configureImageApi').addEventListener('click',()=>taskOptionsDialog.close(),true);
const more=document.querySelector('#moreTaskSettings .advanced-settings-body');
if(more){more.prepend(document.querySelector('#intendedUse').closest('.field'));}
const modeField=document.querySelector('#generationMode').closest('.field');modeField.classList.add('generation-mode-field');document.querySelector('.task-brief-heading').after(modeField);
templateLibraryController.loadTemplates().then(data=>{const style=document.querySelector('#smartStyleCategory');style.innerHTML='<option value="">自动</option>'+((data.filters?.style_category)||[]).map(v=>`<option value="${escapeHtml(v)}">${escapeHtml(templateValueLabel(v))}</option>`).join('');}).catch(()=>{});
smartTaskWorkflow.loadConfig().then(config=>{const form=document.querySelector('#visualAnalysisSettingsForm');form.elements.enabled.checked=config.enabled;form.elements.endpoint.value=config.endpoint;form.elements.model.value=config.model;document.querySelector('#customerVisualStatus').textContent=config.enabled?'选择客户图后自动分析并推荐；同一客户的相同图片使用缓存。':'看图分析未开启；可按模板和手动设置操作。';}).catch(error=>{document.querySelector('#customerVisualStatus').textContent=error.message;});
document.querySelector('#visualAnalysisSettingsForm').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button[type=submit]');button.disabled=true;try{await smartTaskWorkflow.saveConfig({enabled:form.elements.enabled.checked,endpoint:form.elements.endpoint.value,model:form.elements.model.value,apiKey:form.elements.apiKey.value});form.elements.apiKey.value='';document.querySelector('#visualAnalysisSettingsMessage').textContent='分析设置已保存；首张所选图片同时验证看图与结构化输出能力。';}catch(error){document.querySelector('#visualAnalysisSettingsMessage').textContent=error.message;}finally{button.disabled=false;}});
loadFoundationCustomers();
setStage('references');
loadStatus();
loadFaceAngleCapability();
const queuedHomeNotice = sessionStorage.getItem(homeNoticeStorageKey);
sessionStorage.removeItem(homeNoticeStorageKey);
if (!currentRunId && queuedHomeNotice) elements.prepareResult.textContent = queuedHomeNotice;
restoreRequestedRun();

if (new URLSearchParams(window.location.search).get('view') === 'history') elements.openHistory.click();
