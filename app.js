import {
  buildSelectionDecision,
  createRecommendationController,
  createTemplateLibraryController,
  formatHistoryTemplateItem,
  mapFormToTaskBrief,
  normalizeCatalogTemplate,
  templateRejectionText,
} from './template-library.js?v=ccec7fd4d171';
import { customerIdFromName, taskIntentFromForm } from './task-intent.js';
import { clampPreviewZoom, orderedPreviewItems, wrappedPreviewIndex } from './media-preview-state.js';
import { COMPLETED_RUN_NOTICE, INVALID_RUN_NOTICE, apiRunState, buildHistoryPageUrl, buildHistoryRunUrl, isHistoryPageLocation, parseRunLocation, resolveRunStartup, shouldClearRunUrlAfterPreference } from './navigation-state.js';
import { ACCEPTED_CLIPBOARD_IMAGE_TYPES, clipboardImageFiles, isEditablePasteTarget, mergeFilesWithinLimit } from './clipboard-image.js';
import { artifactStylePanelMarkup, deriveReviewWorkspaceState, reviewArtifactFileUrl } from './review-workspace-state.js';
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
import { buildWorkLibrary } from './work-library-state.js';
import { initGenerationMode } from './generation-mode.js?v=9e98a6cdedc1';
import { initResultWorkbench, generationDetailsMarkup } from './result-workbench.js';
import { createSmartTaskWorkflow } from './smart-task-workflow.js';
import { mountWorkbenchRail } from './workbench-rail.js?v=87f6b5274469';

const workbenchRail = mountWorkbenchRail(document.querySelector('#workbenchRail'));

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
  appShell: document.querySelector('.app-shell'),
  stageContainer: document.querySelector('.stage-container'),
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
  openCustomerProfile: document.querySelector('#openCustomerProfile'),
  customerProfileDialog: document.querySelector('#customerProfileDialog'),
  customerProfileForm: document.querySelector('#customerProfileForm'),
  customerProfileName: document.querySelector('#customerProfileName'),
  customerProfileMessage: document.querySelector('#customerProfileMessage'),
  cancelCustomerProfile: document.querySelector('#cancelCustomerProfile'),
  saveCustomerProfile: document.querySelector('#saveCustomerProfile'),
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
  aestheticComparisonPanel: document.querySelector('#aestheticComparisonPanel'),
  aestheticComparisonForm: document.querySelector('#aestheticComparisonForm'),
  aestheticComparisonMessage: document.querySelector('#aestheticComparisonMessage'),
  comparisonArtifactA: document.querySelector('#comparisonArtifactA'),
  comparisonArtifactB: document.querySelector('#comparisonArtifactB'),
  preferencePanel: document.querySelector('#preferencePanel'),
  preferenceForm: document.querySelector('#preferenceForm'),
  newTaskButton: document.querySelector('#newTaskButton'),
  openHistory: document.querySelector('#openHistory'),
  historyPage: document.querySelector('#historyPage'),
  historyPageTitle: document.querySelector('#historyPageTitle'),
  historyNavigationMessage: document.querySelector('#historyNavigationMessage'),
  historyRefresh: document.querySelector('#refreshHistory'),
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
  stageTabs: [...document.querySelectorAll('[data-stage-target]')],
  stagePanels: [...document.querySelectorAll('[data-stage-panel]')],
};

for (const strip of [elements.identityPreviewGrid, elements.customerPhotoPoolGrid]) attachHorizontalWheelScroll(strip);

function setupReferenceSplitter(splitter) {
  const workspace = splitter.closest('.reference-workspace');
  const settings = document.getElementById(splitter.getAttribute('aria-controls'));
  let drag;

  function widthLimits() {
    const style = getComputedStyle(workspace);
    const minimum = parseFloat(style.getPropertyValue('--settings-min-width'));
    const referenceMinimum = parseFloat(style.getPropertyValue('--reference-min-width'));
    const maximum = workspace.clientWidth - referenceMinimum - splitter.offsetWidth;
    return { minimum, maximum };
  }

  function syncSplitterValue() {
    if (!splitter.offsetWidth) return;
    const { minimum, maximum } = widthLimits();
    const width = Math.round(settings.getBoundingClientRect().width);
    splitter.setAttribute('aria-valuemin', String(minimum));
    splitter.setAttribute('aria-valuemax', String(maximum));
    splitter.setAttribute('aria-valuenow', String(width));
    splitter.setAttribute('aria-valuetext', `${width} 像素`);
  }

  function setWidth(width) {
    const { minimum, maximum } = widthLimits();
    const clamped = Math.max(minimum, Math.min(maximum, width));
    workspace.style.setProperty('--settings-width', `${clamped}px`);
  }

  function resetWidth() {
    workspace.style.removeProperty('--settings-width');
  }

  splitter.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag) return;
    splitter.setPointerCapture(event.pointerId);
    drag = { pointerId: event.pointerId, x: event.clientX, width: settings.getBoundingClientRect().width };
    workspace.classList.add('is-resizing');
  });
  splitter.addEventListener('pointermove', (event) => {
    if (drag?.pointerId === event.pointerId) setWidth(drag.width + drag.x - event.clientX);
  });
  splitter.addEventListener('lostpointercapture', (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    drag = null;
    workspace.classList.remove('is-resizing');
  });
  splitter.addEventListener('dblclick', resetWidth);
  splitter.addEventListener('keydown', (event) => {
    const width = settings.getBoundingClientRect().width;
    const step = event.shiftKey ? 48 : 16;
    switch (event.key) {
      case 'ArrowLeft': setWidth(width + step); break;
      case 'ArrowRight': setWidth(width - step); break;
      case 'Home': setWidth(widthLimits().minimum); break;
      case 'End': setWidth(widthLimits().maximum); break;
      case 'Enter': resetWidth(); break;
      default: return;
    }
    event.preventDefault();
  });

  const observer = new ResizeObserver(syncSplitterValue);
  observer.observe(workspace);
  observer.observe(settings);
  syncSplitterValue();
}

setupReferenceSplitter(document.querySelector('#referenceSplitter'));

const requestedLocation = parseRunLocation(window.location.search);
const requestedHistoryPage = isHistoryPageLocation(window.location.search);
let currentRunId = requestedLocation.runId;
let currentRunOpenedFromHistory = requestedLocation.fromHistory || requestedHistoryPage;
let currentRunData = null;
let currentManifest = null;
let captureBusy = false;
let resultDecisionBusy = false;
let captureFailureRunId = null;
let captureAutomationState = null;
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
let activeStage = 'references';
function openArtifactAnnotation(options) {
  return import('./annotation-editor.js').then(module => module.openArtifactAnnotation(options));
}

let historyPageOrigin = null;
let historyPageEntryPushed = false;
let historyRecordNavigationSequence = 0;
let historyReturnRecordId = null;
let inspectorDirty = false;
let deliveryDraft = null;
let savingDelivery = false;
let comparingPhotos = false;
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
let historyShowingDeleted = false;
let historyLoadRevision = 0;
let historyDeleteTarget = null;
const historyVisibilityChanges = new Set();
const historyDeleteDialog = document.querySelector('#historyDeleteDialog');
const historyShowDeleted = document.querySelector('#historyShowDeleted');
let primaryActionBusy = false;
let customerProfileSaving = false;
let generationMode = null;
const templateSelectionSources = new Map();
const historyReturnStorageKey = 'ai-img-gen.history-return-record';
let historyNavigationError = '';
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
  api_rejected: '服务商已拒绝请求',
  api_save_failed: '本机保存未完成',
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
        url: `/folio/portrait-lab/api/runs/${encodedRunId}/references/template/${index}/file`,
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
      url: `/folio/portrait-lab/api/runs/${encodedRunId}/references/identity/${index}/file`,
      caption: `客户图 ${index + 1}`,
    })),
    generated: artifacts.map((artifact, index) => ({
      kind: 'generated',
      url: `/folio/portrait-lab/api/runs/${encodedRunId}/artifacts/${encodeURIComponent(artifact.artifact_id)}/file`,
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
  if (run.preference?.decision === 'none') {
    return { key: 'record-complete', badge: 'rejected', label: '全部不要' };
  }
  return {
    pending_review: { key: 'pending-review', badge: 'pending', label: '待评' },
    pending_choice: { key: 'pending-choice', badge: 'choice', label: '待选择' },
    completed: { key: 'record-complete', badge: 'complete', label: '已完成' },
  }[deriveHistoryRunState(run)];
}

function historyRunCard(run, { child = false, customerLabel = '', groupSize = 1 } = {}) {
  const runId = encodeURIComponent(run.run_id);
  const recordState = historicalRecordState(run);
  const progressState = Number(run.reviewed_count || 0) < Number(run.artifact_count || 0) ? 'pending' : 'complete';
  const isContextOnly = Boolean(run.viewContextOnly);
  const allArtifacts = Array.isArray(run.artifacts) ? run.artifacts : [];
  const previewArtifacts = isContextOnly ? [] : allArtifacts.slice(0, 2);
  const extraArtifactCount = isContextOnly ? 0 : Math.max(0, allArtifacts.length - previewArtifacts.length);
  const artifacts = previewArtifacts.map((artifact) => {
    const url = `/folio/portrait-lab/api/runs/${runId}/artifacts/${encodeURIComponent(artifact.artifact_id)}/file`;
    const thumb = artifact.artifact_id === 'sample-' + artifact.ordinal
      ? '/folio/portrait-lab/assets/case-' + artifact.ordinal + '-thumb.webp'
      : url;
    return `<span class="history-result-thumb">
      <img src="${escapeHtml(thumb)}" width="240" height="426" alt="成品 ${artifact.ordinal}" loading="lazy">
      <span class="history-result-index">${String(artifact.ordinal).padStart(2, '0')}</span>
    </span>`;
  }).join('');
  const mediaPreview = isContextOnly
    ? '<span class="history-context-preview"><span aria-hidden="true">↳</span><span>关联来源任务</span></span>'
    : artifacts;
  const previewClass = previewArtifacts.length === 1 ? 'has-single' : previewArtifacts.length > 1 ? 'has-multiple' : 'is-empty';
  const batch = run.history_import?.batch_label || (run.image_api ? 'API 生成记录' : '网页生成记录');
  const customer = customerLabel || run.customer_name || '未命名客户';
  const rowTitle = child
    ? batch
    : groupSize === 1 ? customer : batch;
  const batchMeta = !child && groupSize === 1 ? `<span class="history-meta-tag">${escapeHtml(batch)}</span>` : '';
  const artifactCount = Number(run.artifact_count ?? allArtifacts.length);
  const reviewedCount = Number(run.reviewed_count || 0);
  const artifactMeta = isContextOnly
    ? `<span class="history-meta-tag">来源 · ${artifactCount} 张成品</span>`
    : `<span>${artifactCount} 张成品</span>`;
  const preferenceLabel = run.preference?.decision === 'winner'
    ? '已选最终成品'
    : '';
  const rejectedCount = Number(run.rejected_artifact_count || 0);
  const rejectedLabel = rejectedCount > 0 && run.preference?.decision !== 'none'
    ? `<span class="history-meta-tag">已淘汰 ${rejectedCount} 张</span>`
    : '';
  const relation = isContextOnly
    ? '<span class="history-revision-badge">来源</span>'
    : child || run.relationLabel ? `<span class="history-revision-badge">${escapeHtml(run.relationLabel || '修改版')}</span>` : '';
  const learningWarning = run.template_learning?.state === 'degraded'
    ? '<span class="history-progress-tag pending">模板证据异常</span>'
    : '';
  const children = (run.children || []).map((item) => historyRunCard(item, { child: true, customerLabel: customer, groupSize })).join('');
  const operationPending = historyVisibilityChanges.has(run.run_id) ? ' disabled' : '';
  if (run.history_deleted_at) {
    return `<div class="history-run-tree${child ? ' is-child' : ''}"><article class="history-run-card" data-history-run="${escapeHtml(run.run_id)}">
      <div class="history-trash-record">
        <strong>${escapeHtml(customer)} · ${escapeHtml(batch)}</strong>
        <span>${escapeHtml(formatHistoryDate(run.created_at))} · ${artifactCount} 张成品 · 删除于 ${escapeHtml(formatHistoryDate(run.history_deleted_at))}</span>
      </div>
      <div class="history-card-actions"><button class="quiet-button history-record-info" type="button" data-restore-history-record="${escapeHtml(run.run_id)}"${operationPending}>恢复</button></div>
    </article>${children}</div>`;
  }
  const deleteButton = isContextOnly ? '' : `<button class="quiet-button history-record-info history-record-delete" type="button" data-delete-history-record="${escapeHtml(run.run_id)}"${operationPending}>删除</button>`;
  return `<div class="history-run-tree${child ? ' is-child' : ''}"><article class="history-run-card ${recordState.key}${isContextOnly ? ' is-source-context' : ''}" data-history-run="${escapeHtml(run.run_id)}">
      <a class="history-record-trigger${isContextOnly ? ' is-context-only' : ''}${mediaPreview ? ' has-preview' : ''}" href="${escapeHtml(buildHistoryRunUrl(run.run_id, window.location.search))}" data-open-history-review="${escapeHtml(run.run_id)}" aria-label="打开${escapeHtml(customer)} ${escapeHtml(formatHistoryDate(run.created_at))}的${isContextOnly ? '关联来源任务' : '历史任务'}，${artifactCount} 张成品">
        ${mediaPreview ? `<div class="history-result-list ${previewClass}" aria-label="${isContextOnly ? '关联来源任务' : `${allArtifacts.length} 张预览图片`}">${mediaPreview}${extraArtifactCount ? `<span class="history-result-overflow">+${extraArtifactCount}</span>` : ''}</div>` : ''}
        <div class="history-run-copy">
          <div class="history-run-heading"><div class="history-run-title"><strong>${escapeHtml(rowTitle)}</strong>${relation}<span class="history-review-status ${recordState.badge}">${recordState.label}</span></div><time>${escapeHtml(formatHistoryDate(run.created_at))}</time></div>
          <div class="history-run-meta">${batchMeta}${artifactMeta}<span>${Number(run.identity_count || 0)} 张身份图</span><span>${Number(run.template_count || 0)} 张模板图</span><span class="history-progress-tag ${progressState}">${reviewedCount} / ${artifactCount} 已评分</span>${preferenceLabel ? `<span class="history-meta-tag">${preferenceLabel}</span>` : ''}${rejectedLabel}${learningWarning}</div>
        <p class="history-prompt-summary" title="打开记录查看完整提示词">${escapeHtml(run.prompt || '未记录提示词')}</p>
        </div>
      </a>
      <div class="history-card-actions"><button class="quiet-button history-record-info" type="button" data-view-history-record="${escapeHtml(run.run_id)}" aria-label="编辑${escapeHtml(run.customer_name || '未命名客户')}的记录信息">编辑信息</button>${deleteButton}</div>
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
  elements.openHistoryImport.hidden = !isList || historyShowingDeleted;
  elements.historyRefresh.hidden = !isList;
  historyShowDeleted.hidden = !isList;
  elements.historyPageTitle.textContent = isList && historyShowingDeleted ? '已删除记录' : '历史生成结果';
  const backLabel = isList && !historyShowingDeleted ? '返回工作台' : '返回历史列表';
  elements.historyHeaderAction.setAttribute('aria-label', backLabel);
  elements.historyHeaderAction.dataset.tooltip = backLabel;
}

function setHistoryPageVisible(visible, { focus = true } = {}) {
  elements.historyPage.hidden = !visible;
  elements.stageContainer.hidden = visible;
  elements.appShell.classList.toggle('history-page-active', visible);
  workbenchRail.setCurrent(visible ? 'history' : 'workbench', activeStage);
  if (!focus) return;
  if (visible) requestAnimationFrame(() => elements.historyPageTitle.focus({ preventScroll: true }));
  else elements.openHistory.focus({ preventScroll: true });
}

async function openHistoryPage({ push = true, origin = null } = {}) {
  if (!elements.historyPage.hidden) return;
  const previous = origin || {
    runId: currentRunId,
    fromHistory: currentRunOpenedFromHistory,
    stage: activeStage,
    view: historyWorkspaceState.view,
    runData: currentRunData,
  };
  historyPageOrigin = {
    ...previous,
    runData: previous.runData || (previous.runId === currentRunId ? currentRunData : null),
  };
  if (push) {
    const stateOrigin = {
      runId: historyPageOrigin.runId,
      fromHistory: historyPageOrigin.fromHistory,
      stage: historyPageOrigin.stage,
      view: historyPageOrigin.view,
    };
    const url = `${window.location.pathname}${buildHistoryPageUrl(window.location.search)}${window.location.hash}`;
    history.pushState({ source: 'history-page', origin: stateOrigin }, '', url);
  }
  historyPageEntryPushed = Boolean(push || history.state?.source === 'history-page');
  elements.historyNavigationMessage.textContent = historyNavigationError;
  historyNavigationError = '';
  setHistoryPageVisible(true);
  applyHistoryWorkspaceView();
  await loadHistory();
}

function hasUnsavedCreationDraft() {
  return !currentRunId && Boolean(
    referenceFileState.identity.length
    || referenceFileState.templates.length
    || customerPhotoPoolState.identitySetId
    || customerPhotoPoolState.selectedOrdinals?.length
    || templateLibraryController.getSelectedCount()
    || elements.customerSelector.value
    || document.querySelector('#customerName')?.value.trim()
    || document.querySelector('#userSupplement')?.value.trim()
  );
}

function hasUnsavedHistoryMetadata() {
  if (historyWorkspaceState.view !== 'detail' || !activeHistoryRecordId) return false;
  const original = historyRunsById.get(activeHistoryRecordId);
  if (!original) return false;
  const form = elements.historyRecordForm;
  return form.elements.customerName.value !== (original.customer_name || '')
    || form.elements.batchLabel.value !== (original.history_import?.batch_label || '')
    || form.elements.intendedUse.value !== (original.intended_use || '')
    || form.elements.prompt.value !== (original.prompt || '');
}

async function restoreHistoryPageOrigin(origin, { keepHistoryRoute = true } = {}) {
  const runId = origin?.runId || null;
  if (!runId) {
    if (currentRunId) returnToNewTask('', { replaceUrl: !keepHistoryRoute });
    else setStage(origin?.stage || 'references');
    currentRunOpenedFromHistory = false;
    return;
  }
  if (origin.runData?.runId === runId) {
    renderRun(origin.runData);
  } else if (currentRunId !== runId) {
    currentRunId = runId;
    currentRunOpenedFromHistory = Boolean(origin.fromHistory);
    await refreshRun();
  }
  currentRunOpenedFromHistory = Boolean(origin.fromHistory);
  setStage(origin.stage || resolveRunStartup({ manifest: currentManifest || {}, fromHistory: true }).stage);
}

async function closeHistoryPage({ stage } = {}) {
  if (stage && historyPageOrigin) {
    historyPageOrigin.stage = stage;
    historyPageOrigin.keepRailFocus = true;
  }
  if (historyPageEntryPushed && history.state?.source === 'history-page') {
    history.back();
    return;
  }
  const origin = historyPageOrigin;
  const url = new URL(window.location.href);
  url.searchParams.delete('view');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  await restoreHistoryPageOrigin(origin, { keepHistoryRoute: false }).catch(() => null);
  setHistoryPageVisible(false, { focus: !stage });
  historyPageOrigin = null;
  historyPageEntryPushed = false;
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
    api(`/folio/portrait-lab/api/runs/${encodeURIComponent(runId)}`).then(data=>{if(activeHistoryRecordId!==runId)return;details.innerHTML=`<summary>生成详情（发送记录）</summary>${generationDetailsMarkup(data.generation_details)}`;
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
  const library = historyShowingDeleted
    ? buildWorkLibrary(historyRuns, { view: 'all', sort: historyWorkspaceState.sort })
    : renderActiveHistoryFilters();
  elements.historyResultCount.textContent = `${library.runCount} / ${historyRuns.length} 条记录`;
  renderHistoryRows(library);
}

function renderActiveHistoryFilters() {
  const options = historyCustomerOptions(historyRuns);
  elements.historyCustomerFilter.innerHTML = ['<option value="">全部客户</option>', ...options.map((option) => `<option value="${escapeHtml(option.key)}">${escapeHtml(option.label)}</option>`)].join('');
  if (historyWorkspaceState.customerKey && !options.some((option) => option.key === historyWorkspaceState.customerKey)) {
    historyWorkspaceState = transitionHistoryWorkspace(historyWorkspaceState, { type: 'SET_CUSTOMER', value: '' });
  }
  elements.historySearch.value = historyWorkspaceState.query;
  elements.historyCustomerFilter.value = historyWorkspaceState.customerKey;
  elements.historyStatusFilter.value = historyWorkspaceState.status;
  elements.historySort.value = historyWorkspaceState.sort;
  const { status, sort } = historyWorkspaceState;
  const visibleRuns = filterAndSortHistoryRuns(historyRuns, { ...historyWorkspaceState, status: 'all' });
  return buildWorkLibrary(visibleRuns, { view: status, sort });
}

function renderHistoryRows(library) {
  const emptyMessage = historyShowingDeleted ? '没有已删除的记录。'
    : historyWorkspaceState.status === 'rejected' ? '没有符合筛选条件的淘汰图片。'
      : historyRuns.length ? '没有符合当前筛选的记录。' : '还没有保存过可评审的成品记录。';
  elements.historyList.innerHTML = library.groups.length
    ? library.groups.map((group) => {
      const groupHeading = group.runs.length > 1
        ? `<header><strong>${escapeHtml(group.customerLabel)}</strong><span>${group.runs.length} 组任务</span></header>`
        : '';
      const rows = group.runs.map((run) => historyRunCard(run, { customerLabel: group.customerLabel, groupSize: group.runs.length })).join('');
      return `<section class="work-library-customer-group">${groupHeading}<div class="history-run-list">${rows}</div></section>`;
    }).join('')
    : `<div class="empty-state">${emptyMessage}</div>`;
}

async function loadHistory() {
  const request = ++historyLoadRevision;
  const scope = historyShowingDeleted ? 'deleted' : 'active';
  elements.historyList.innerHTML = '<div class="empty-state workbench-loading" role="status"><progress aria-hidden="true" class="workbench-spinner"></progress>正在读取历史记录</div>';
  try {
    const data = await api(`/folio/portrait-lab/api/runs?artifactsOnly=true&limit=200&history=${scope}`);
    if (request !== historyLoadRevision) return [];
    renderHistory(data.runs || []);
    return data.runs || [];
  } catch (error) {
    if (request !== historyLoadRevision) return [];
    elements.historyList.innerHTML = `<div class="empty-state">无法读取历史记录：${escapeHtml(error.message)}</div>`;
    return [];
  }
}

async function changeHistoryVisibility(runId, deleted, trigger) {
  if (historyVisibilityChanges.has(runId)) return;
  historyVisibilityChanges.add(runId);
  setBusy(trigger, true, deleted ? '正在删除' : '正在恢复');
  elements.historyNavigationMessage.textContent = '';
  try {
    await api(`/folio/portrait-lab/api/runs/${encodeURIComponent(runId)}/history`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleted }),
    });
    historyVisibilityChanges.delete(runId);
    if (document.activeElement === trigger) historyShowDeleted.focus({ preventScroll: true });
    await loadHistory();
    elements.historyNavigationMessage.textContent = deleted ? '记录已移入「已删除」。' : '记录已恢复到成品记录。';
  } catch (error) {
    elements.historyNavigationMessage.textContent = `${deleted ? '删除' : '恢复'}失败：${error.message}`;
  } finally {
    historyVisibilityChanges.delete(runId);
    setBusy(trigger, false);
  }
}

function setBusy(button, busy, text) {
  if (!button) return;
  if (busy) {
    if(button.dataset.busy!=='true')button.dataset.originalText = button.textContent;
    button.dataset.busy='true';
    button.setAttribute('aria-busy', 'true');
    button.textContent = text;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    delete button.dataset.originalText;
    delete button.dataset.busy;
    button.removeAttribute('aria-busy');
    button.disabled = false;
  }
}

function setStage(stage) {
  if (stage === 'generation') stage = 'results';
  if (!elements.stagePanels.some((panel) => panel.dataset.stagePanel === stage)) return;
  if (stage !== 'references' && !currentRunId) return;
  activeStage = stage;
  for (const panel of elements.stagePanels) panel.hidden = panel.dataset.stagePanel !== stage;
  workbenchRail.setCurrent(elements.historyPage.hidden ? 'workbench' : 'history', stage);
}

function updateStageAvailability(manifest) {
  const hasRun = Boolean(currentRunId);
  const availability = deriveStageAvailability({ currentRunId, manifest: manifest || {} });
  for (const tab of elements.stageTabs) {
    const stage = tab.dataset.stageTarget;
    tab.disabled = stage === 'results' ? !hasRun || (!availability.generation && !availability.results) : availability[stage] !== true;
    const label = tab.getAttribute('aria-label');
    if (tab.disabled) tab.title = `${label}（${stage === 'review' ? '保存结果后可用' : '创建任务后可用'}）`;
    else tab.removeAttribute('title');
  }
}

function renderBrowserStatus(data) {
  elements.appState.textContent = '已运行';
  elements.appState.className = 'good-text';
  elements.browserState.textContent = data.browser.ready ? '已连接' : data.browser.state === 'not_checked' ? '未检查' : '需检查';
  elements.browserState.title = data.browser.message;
  elements.browserState.className = data.browser.ready ? 'good-text' : 'warn-text';
  syncBrowserRailStatus();
}

function syncBrowserRailStatus() {
  const control = document.querySelector('#checkBrowser');
  const status = elements.browserState.textContent;
  const label = `检查 ChatGPT 连接：${status}`;
  control.dataset.tooltip = label;
  control.setAttribute('aria-label', label);
  control.dataset.connectionState = elements.browserState.classList.contains('good-text') ? 'ready' : elements.browserState.classList.contains('warn-text') ? 'warning' : 'unknown';
}

function renderCustomerFieldVisibility() {
  const selectedCustomerId = String(elements.customerSelector?.value || '');
  const visibility = deriveCustomerFieldVisibility({ mode: selectedCustomerId ? 'existing' : 'new' });
  if (elements.existingCustomerFields) elements.existingCustomerFields.hidden = false;
  elements.newCustomerFields.hidden = !visibility.showNewCustomerFields
    || Boolean(currentRunId || activeReuseDraft)
    || !referenceFileState.identity.length;
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
  const summaryCustomer = selectedCustomer || activeReuseDraft?.customer_name
    || currentManifest?.customer_name || (enteredCustomer && elements.customerSelector.value ? enteredCustomer : '临时上传');
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
  renderCustomerFieldVisibility();
  const summary = currentSendSummary();
  const missing = !currentRunId && !summary.identities.count && !(document.querySelector('#generationMode')?.value === 'api' && document.querySelector('#apiOperation')?.value === 'generate');
  document.querySelector('#prepareRun')?.setAttribute('aria-disabled', String(missing));
  const hint = document.querySelector('#creationReadiness');
  if (hint) { hint.hidden = !missing; hint.textContent = missing ? '先添加一张客户照片，即可继续' : ''; }
  if (!missing && elements.prepareResult.textContent === '请先添加一张客户照片，或从已有客户中选择照片。') elements.prepareResult.textContent = '';
}


function renderFoundationCustomerPicker(selectedId = elements.customerSelector.value) {
  elements.customerSelector.innerHTML = '<option value="">临时上传（仅本次）</option>' + foundationCustomers.map((item) => `<option value="${escapeHtml(item.customer_id)}">${escapeHtml(item.display_name || item.customer_id)}</option>`).join('');
  if (foundationCustomers.some((item) => item.customer_id === selectedId)) elements.customerSelector.value = selectedId;
  renderCustomerFieldVisibility();
}

async function loadFoundationCustomers() {
  if (!elements.customerSelector) return;
  const data = await api('/folio/portrait-lab/api/customers').catch(() => null);
  if (data) foundationCustomers = data.customers || [];
  renderFoundationCustomerPicker();
  renderSendSummary();
}

async function saveNewCustomerProfile(event) {
  event.preventDefault();
  if (customerProfileSaving || primaryActionBusy || elements.newCustomerFields.hidden) return;
  const name = elements.customerProfileName.value.trim();
  if (!name) {
    elements.customerProfileName.setCustomValidity('请输入客户名称。');
    elements.customerProfileName.reportValidity();
    return;
  }
  const files = referenceFileState.identity.slice();
  const primary = normalizeManualPrimaryIndex(manualPrimaryIdentityIndex, files.length) ?? 0;
  const customerId = getTemporaryCustomerId();
  const form = new FormData();
  form.set('displayName', name);
  for (const file of reorderManualPrimary(files, primary)) form.append('identity', file, file.name);

  customerProfileSaving = true;
  setBusy(elements.saveCustomerProfile, true, '正在保存');
  elements.cancelCustomerProfile.disabled = true;
  elements.customerProfileMessage.textContent = '';
  try {
    const { identity_set: pool } = await api(`/folio/portrait-lab/api/customers/${encodeURIComponent(customerId)}/identity-sets`, {
      method: 'POST',
      body: form,
    });
    const saved = { customer_id: customerId, display_name: pool.display_name, active_identity_set_id: pool.identity_set_id };
    foundationCustomers = [...foundationCustomers.filter((item) => item.customer_id !== customerId), saved]
      .sort((left, right) => String(left.display_name || '').localeCompare(String(right.display_name || ''), 'zh-CN'));
    renderFoundationCustomerPicker(customerId);
    elements.customerName.value = saved.display_name;
    smartDraftCustomerId = '';
    sessionStorage.removeItem('ai-img-gen.smart-draft-customer');
    activateCustomerPhotoPool(pool);
    elements.customerPhotoPoolMessage.textContent = '已保存为客户，当前任务继续使用这些照片。';
    elements.customerProfileDialog.close();
    elements.customerSelector.focus({ preventScroll: true });
    renderSendSummary();
  } catch (error) {
    elements.customerProfileMessage.textContent = `无法保存客户：${error.message}`;
  } finally {
    customerProfileSaving = false;
    elements.cancelCustomerProfile.disabled = false;
    setBusy(elements.saveCustomerProfile, false);
  }
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
  elements.customerPhotoContextMenu.querySelector('[data-customer-photo-action="rename"]')?.focus({ preventScroll: true });
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
  const data = await api(`/folio/portrait-lab/api/customers/${encodeURIComponent(customerId)}/identity-sets/${encodeURIComponent(identitySetId)}/references/${reference.ordinal}`, {
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
    const data = await api(`/folio/portrait-lab/api/customers/${encodeURIComponent(customerId)}/identity-sets/${encodeURIComponent(identitySetId)}/append`, { method: 'POST', body: form });
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
    const data=await api(`/folio/portrait-lab/api/customers/${encodeURIComponent(customerId)}/identity-sets`);
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
    const response=await fetch('/folio/portrait-lab/api/task-resolutions',{method:'POST',headers:{'x-smart-task-client':'workstation'},body:form});const data=await response.json();
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
  const data = await api('/folio/portrait-lab/api/prompt-compilations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (apiMode && (!data.compilation.blocks?.some(block=>block.block_id==='validated-identity-transfer') || data.compilation.candidate_slate_request)) {
    throw new Error('服务尚未加载 API 换脸提示词更新，请重启 4577 服务后再操作；尚未发送');
  }
  elements.compiledPromptPreview.textContent = data.compilation.compiled_prompt;
  elements.promptCompilationNotice.textContent = apiMode ? 'API 已使用网页端同源换脸提示词；张数由 API 设置决定' : data.compilation.conflict_resolutions?.length ? `已处理 ${data.compilation.conflict_resolutions.length} 个意图冲突` : '提示词已按当前任务意图编译';
  return data.compilation;
}
async function loadStatus() {
  try {
    renderBrowserStatus(await api('/folio/portrait-lab/api/status'));
  } catch {
    elements.appState.textContent = '未连接';
    elements.appState.className = 'warn-text';
    elements.browserState.textContent = '无法读取状态';
    elements.browserState.className = 'warn-text';
    syncBrowserRailStatus();
  }
}

async function loadFaceAngleCapability() {
  try {
    const health = await api('/folio/portrait-lab/api/health');
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
  syncBrowserRailStatus();
  try {
    renderBrowserStatus(await api('/folio/portrait-lab/api/browser/probe', { method: 'POST' }));
  } catch {
    elements.browserState.textContent = '无法检查';
    elements.browserState.className = 'warn-text';
    syncBrowserRailStatus();
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
        ['添加客户照片', '拖入或选择图片'],
        ['添加更多照片（可选）', '不同角度有助于更像本人'],
      ]
    : [
        ['添加自己的模板', '拖入或选择图片'],
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
    renderCustomerFieldVisibility();
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

function reviewLetter(item) {
  return String.fromCharCode(64 + Number(item.ordinal));
}

const reviewIcons = {
  heart: '<path d="M20.3 5.7a4.9 4.9 0 0 0-7 0L12 7l-1.3-1.3a4.95 4.95 0 0 0-7 7L12 21l8.3-8.3a4.9 4.9 0 0 0 0-7Z"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.7 2.7L16.5 9"/>',
  pen: '<path d="m15.5 4.5 4 4M4 20l4.8-1 11-11a2.8 2.8 0 0 0-4-4l-11 11Z"/>',
};

function reviewIcon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${reviewIcons[name]}</svg>`;
}

function artifactCard(artifact) {
  const id = escapeHtml(artifact.artifact_id);
  const name = reviewLetter(artifact);
  return `<figure class="review-photo" data-artifact-id="${id}">
    <button type="button" class="photo-enlarge" data-enlarge="${id}" aria-label="放大候选 ${name}"><img src="${reviewArtifactFileUrl(currentRunId, artifact.artifact_id)}" alt="候选 ${name}"></button>
    <figcaption><span class="candidate-key">${name}</span><span class="photo-verdict"></span>
      <div class="card-tools">
        <button type="button" data-open-annotation="${id}" title="查看与批注" aria-label="批注候选 ${name}">${reviewIcon('pen')}</button>
        <button type="button" class="heart" data-like="${id}" title="更喜欢这张" aria-label="更喜欢 ${name}" aria-pressed="false">${reviewIcon('heart')}</button>
        <button type="button" class="delivery-pick" data-pick-photo="${id}" title="选为成片" aria-label="将 ${name} 选为成片" aria-pressed="false">${reviewIcon('check')}<span>选为成片</span></button>
      </div>
    </figcaption></figure>`;
}

// Each matrix column belongs to its candidate's form, including its diagnostics and notes.
let scoreSignature = '';
let scoreRun = '';
let savingScores = false;

function renderArtifactInspector(manifest) {
  const items = manifest.artifacts || [];
  const signature = JSON.stringify([currentRunId, items.map(item => item.artifact_id), manifest.artifact_reviews, manifest.review_suggestions, manifest.artifact_style_suggestions]);
  if (scoreRun !== currentRunId) inspectorDirty = false;
  if (signature === scoreSignature || inspectorDirty) return;
  scoreSignature = signature;
  scoreRun = currentRunId;
  const inspector = elements.artifactInspector;
  inspector.replaceChildren();
  if (!items.length) return;
  const heading = document.createElement('h2');
  heading.textContent = '质量评分';
  const table = document.createElement('table');
  table.className = 'quality-matrix';
  table.setAttribute('aria-label', '候选照片质量评分');
  const header = table.createTHead().insertRow();
  header.innerHTML = '<th scope="col">评分项</th>' + items.map(item => '<th scope="col">'+reviewLetter(item)+'</th>').join('');
  const body = table.createTBody();
  const labels = ['人脸一致性','真实自然','风格一致'];
  const rows = labels.map((label,i) => {
    const row = body.insertRow();
    row.innerHTML = '<th scope="row">'+label+'<small>≥ '+(i === 0 ? '8.0' : '7.0')+'</small></th>';
    return row;
  });
  const extra = document.createElement('details');
  extra.className = 'review-diagnostics';
  extra.innerHTML = '<summary>逐图诊断与备注</summary>';
  inspector.append(heading,table,extra);
  for (const item of items) {
    const review = manifest.artifact_reviews?.[item.artifact_id];
    const form = elements.artifactReviewTemplate.content.querySelector('form').cloneNode(true);
    const letter = reviewLetter(item);
    form.dataset.artifactId = item.artifact_id;
    form.id = 'quality-form-' + letter;
    form.removeAttribute('class');
    const perPhoto = document.createElement('details');
    perPhoto.innerHTML = '<summary>候选 '+letter+'</summary>';
    perPhoto.append(form);
    extra.append(perPhoto);
    numericScoreFields.forEach(([name,key],i) => {
      const input = form.elements[name];
      input.value = scoreValue(review,key);
      input.setAttribute('form',form.id);
      input.setAttribute('aria-label',letter+' '+labels[i]);
      input.placeholder = '—';
      rows[i].insertCell().append(input);
    });
    form.querySelector('.primary-score-grid').remove();
    const diagnosticCodes = diagnosticCodesForDisplay(review);
    for (const checkbox of form.querySelectorAll('[name="diagnosticCodes"]')) checkbox.checked = diagnosticCodes.has(checkbox.value);
    form.elements.notes.value = review?.notes || '';
    form.querySelector('.legacy-review-note').hidden = !review || review.review_rubric_version === currentRubricVersion;
    const styleSuggestion = manifest.artifact_style_suggestions?.[item.artifact_id];
    if (styleSuggestion) form.insertAdjacentHTML('afterbegin', artifactStylePanelMarkup(styleSuggestion));
    const suggestion = manifest.review_suggestions?.[item.artifact_id];
    const panel = form.querySelector('.ai-suggestion-panel');
    panel.hidden = !suggestion;
    if (suggestion) {
      panel.querySelector('[data-ai-suggestion-status]').textContent = '可填入建议值后人工确认';
      const apply = panel.querySelector('button');
      apply.hidden = false;
      apply.onclick = () => {
        for (const [name,key] of numericScoreFields) form.elements[name].value = scoreValue(suggestion.scores || suggestion,key);
        const codes = new Set(suggestion.diagnostic_codes || []);
        for (const box of form.querySelectorAll('[name="diagnosticCodes"]')) box.checked = codes.has(box.value);
        form.dispatchEvent(new Event('input',{bubbles:true}));
      };
    }
  }
  inspector.insertAdjacentHTML('beforeend','<div class="score-save"><span id="scoreStatus" role="status"></span><button type="button" id="saveScores" disabled>保存评分</button></div>');
  document.querySelector('#scoreStatus').textContent = items.every(item => manifest.artifact_reviews?.[item.artifact_id]) ? '已保存' : '待评分';
}

function renderCaptureBody(manifest=currentManifest,{busy=captureBusy}={}){
  const artifacts=manifest?.artifacts||[];
  const apiJob = generationMode?.currentJob();
  const apiState = apiRunState(manifest, apiJob);
  const apiStatus = {
    preparing: ['正在准备 API 任务', '正在核对任务设置和参考图。'],
    sending: ['正在生成图片', '正在等待服务商返回结果。'],
    saving: ['正在保存原图', '正在校验并保存服务商返回的图片。'],
    api_rejected: ['服务商已拒绝请求', '沿用素材调整设置后，可发起新任务。'],
    submission_uncertain: ['发送状态待确认', '可查看原任务状态。'],
    save_failed: ['本机保存未完成', apiJob?.canRecover ? '可从本机恢复已保存的原图。' : '可沿用素材创建新任务。'],
    preparation_failed: ['任务准备未完成', '返回生成设置检查参考图与参数。'],
    prepared: ['等待任务提交', '可以返回生成设置继续。'],
  }[apiState];
  const apiActive = ['preparing', 'sending', 'saving'].includes(apiState);
  const apiFailure = ['api_rejected', 'submission_uncertain', 'save_failed', 'preparation_failed'].includes(apiState);
  const state=manifest?.capture?.state||'';
  const submitted=Number(manifest?.submission_attempt_count||0)>0||['submitted','submission_uncertain','capture_pending'].includes(manifest?.status);
  const warning=apiFailure || !apiState && (['capture_ambiguous','capture_unverified','capture_access_mismatch','capture_reopen_failed','capture_tab_unavailable','capture_context_mismatch'].includes(state)||['provider_error','provider_rate_limited'].includes(manifest?.status)||captureFailureRunId===currentRunId&&Boolean(currentRunId)||['timeout','error'].includes(captureAutomationState));
  const saved=artifacts.length>0;
  const responsePending=state==='capture_response_pending';
  const pagePending=state==='capture_page_not_ready';
  const working = !saved && (busy || apiActive || !apiState && submitted && !warning);
  document.getElementById('captureOverview').dataset.state=working?'busy':saved?'saved':warning?'warning':'waiting';
  document.getElementById('captureStateIcon').textContent=saved?'✓':warning?'!':'·';
  document.getElementById('captureStateTitle').textContent=saved?`已保存 ${artifacts.length} 张图片`:busy?(apiState?'正在读取 API 任务':'正在检测原图'):apiStatus?.[0]||(warning?'需要检查任务':responsePending?'等待原图响应':pagePending?'等待页面就绪':submitted?'等待生成结果':'等待任务提交');
  document.getElementById('captureStateDetail').textContent=saved?'点击下方图片查看原图':apiStatus?.[1]||(state==='capture_tab_unavailable'?'请打开原 ChatGPT 对话后再检测。':warning?'可再次检测或手动导入。':responsePending?'图片已显示，正在读取可验证的原图。':pagePending?'页面暂未就绪，稍后继续检测原任务。':submitted?'可手动检测当前任务。':'提交后只检测对应对话中的结果。');
  const progress = document.getElementById('captureWaiting');
  progress.hidden = !working;
  progress.parentElement.setAttribute('aria-busy', String(working));
  document.getElementById('captureProcess').hidden=true;
  document.getElementById('remakeRun').hidden=!(saved || apiFailure && currentRunData?.reuse?.available);
  document.getElementById('deferRun').hidden=!(saved || apiFailure);
  document.getElementById('discardRun').hidden=!saved;
  document.querySelector('.results-panel').dataset.resultState=saved?'saved':warning?'warning':'waiting';
  document.getElementById('captureFallback').hidden = saved || working || !warning || Boolean(apiState);
  document.getElementById('generationRecovery').hidden = !manifest || submitted || saved || Boolean(apiState);
  const inputGrid=document.getElementById('resultIdentityReferences');
  inputGrid.innerHTML=(manifest?.identity_references||[]).map((_,i)=>`<button type="button" class="result-identity-thumb" data-result-identity="${i}" aria-label="查看输入原图 ${i+1}"><img src="/folio/portrait-lab/api/runs/${encodeURIComponent(currentRunId)}/references/identity/${i}/file" alt="输入原图 ${i+1}"></button>`).join('') || '<p>暂无输入原图</p>';

  const grid=document.getElementById('captureOutputGrid');grid.hidden=!saved;
  grid.innerHTML=artifacts.map((artifact,index)=>`<button class="capture-output" type="button" data-capture-preview="${index}" aria-label="查看候选 ${artifact.ordinal||index+1} 原图"><img src="/folio/portrait-lab/api/runs/${encodeURIComponent(currentRunId)}/artifacts/${encodeURIComponent(artifact.artifact_id)}/file" alt="候选 ${artifact.ordinal||index+1}"><span>候选 ${artifact.ordinal||index+1}</span></button>`).join('');
}

function renderArtifacts(manifest) {
  renderCaptureBody(manifest);
  const items = manifest.artifacts || [];
  const gallery = elements.artifactGallery;
  const signature = JSON.stringify([currentRunId,items.map(item => [item.artifact_id,item.ordinal])]);
  if (gallery.dataset.signature !== signature) {
    gallery.innerHTML = items.length ? items.map(artifactCard).join('') : '<p class="empty-state">暂无候选照片</p>';
    gallery.dataset.signature = signature;
    gallery.dataset.count = String(items.length);
  }
  const reviews = manifest.artifact_reviews || {};
  gallery.querySelectorAll('.review-photo').forEach((card,i) => {
    const review = reviews[items[i].artifact_id];
    const score = overallScore(review);
    card.querySelector('.photo-verdict').textContent = review ? (review.preference_eligible ? score + ' 分' : '未达标') : '待评分';
  });
  elements.reviewedCount.textContent = items.filter(item => reviews[item.artifact_id]).length + ' / ' + items.length;
  elements.qualifiedCount.textContent = String(items.filter(item => reviews[item.artifact_id]?.preference_eligible).length);
  renderArtifactInspector(manifest);
}

function reviewReferenceGroup({ kind, title, references }) {
  if (!references.length) return '';
  const thumbnails = references.map((_, index) => {
    const url = `/folio/portrait-lab/api/runs/${encodeURIComponent(currentRunId)}/references/${kind}/${index}/file`;
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
  const markup = groups.join('');
  if (elements.reviewReferences.dataset.referenceKey !== markup) {
    elements.reviewReferences.innerHTML = markup;
    elements.reviewReferences.dataset.referenceKey = markup;
  }
  elements.reviewReferences.hidden = groups.length === 0;
}

function currentPair() {
  return [elements.comparisonArtifactA.value, elements.comparisonArtifactB.value];
}

function photoDesignation(id) {
  const item = currentManifest?.artifacts?.find(item => item.artifact_id === id);
  return item ? reviewLetter(item) : '';
}

function deliverySelection(manifest) {
  const saved = manifest.preference;
  if (deliveryDraft?.run !== currentRunId ||
      (deliveryDraft?.decision === 'winner' && !manifest.artifact_reviews?.[deliveryDraft.id]?.preference_eligible)) {
    deliveryDraft = null;
  }
  return deliveryDraft || {
    decision: saved?.decision || '',
    id: saved?.winner_artifact_id || '',
    notes: saved?.notes || '',
  };
}

function draftDecision(decision, id = '') {
  deliveryDraft = {run: currentRunId, decision, id, notes: elements.preferenceForm.elements.notes.value};
  renderPreference(currentManifest);
}

function renderComparisonPreviews(manifest) {
  const [a,b] = currentPair();
  const comparison = [...(manifest.aesthetic_comparisons || [])].reverse().find(entry =>
    (entry.artifact_a_id === a && entry.artifact_b_id === b) ||
    (entry.artifact_a_id === b && entry.artifact_b_id === a));
  const preferred = comparison?.outcome === 'a' ? comparison.artifact_a_id :
    comparison?.outcome === 'b' ? comparison.artifact_b_id : '';
  elements.aestheticComparisonMessage.textContent = !a || !b ? '两张照片达标后可比较' : preferred ? '偏好 ' + photoDesignation(preferred) :
    comparison?.outcome === 'tie' ? '两张差不多' : comparison?.outcome === 'skip' ? '已跳过比较' : '未记录';
  const allReviewed = manifest.artifacts.every(item => manifest.artifact_reviews?.[item.artifact_id]);
  const unavailable = !allReviewed || !a || !b || comparingPhotos || savingDelivery || inspectorDirty || savingScores;
  for (const heart of elements.artifactGallery.querySelectorAll('[data-like]')) {
    const id = heart.dataset.like;
    const eligiblePair = [a,b].includes(id) && b;
    heart.disabled = unavailable || !eligiblePair;
    heart.setAttribute('aria-pressed', String(Boolean(preferred) && id === preferred));
    heart.title = !eligiblePair ? '需要两张达标照片组成对比' : preferred === id ? '撤销这次偏好' : '更喜欢这张';
  }
  for (const button of elements.aestheticComparisonForm.querySelectorAll('[data-comparison-outcome]')) {
    button.disabled = unavailable;
    button.setAttribute('aria-pressed', String(button.dataset.comparisonOutcome === comparison?.outcome));
  }
}

function renderAestheticComparison(manifest) {
  const comparison = deriveReviewWorkspaceState(manifest, {
    preferredA: elements.comparisonArtifactA.value, preferredB: elements.comparisonArtifactB.value,
  }).comparison;
  const options = comparison.eligible.map(item =>
    `<option value="${escapeHtml(item.artifact_id)}">候选 ${item.ordinal}</option>`).join('');
  for (const [select, id] of [[elements.comparisonArtifactA, comparison.artifactAId], [elements.comparisonArtifactB, comparison.artifactBId]]) {
    select.innerHTML = options;
    select.value = id;
    select.disabled = !comparison.enabled || comparingPhotos;
  }
  document.querySelector('#pairSettings').hidden = comparison.eligible.length <= 2;
  renderComparisonPreviews(manifest);
}

function renderPreference(manifest) {
  const {decision,id,notes} = deliverySelection(manifest);
  const saved = manifest.preference;
  const unchanged = saved && decision === saved.decision && id === (saved.winner_artifact_id || '') && notes === (saved.notes || '');
  const complete = manifest.artifacts.length > 0 && manifest.artifacts.every(item => manifest.artifact_reviews?.[item.artifact_id]);
  const designation = photoDesignation(id);
  const label = decision === 'winner' ? designation : decision === 'none' ? '全部不要' : '暂不决定';
  for (const button of elements.artifactGallery.querySelectorAll('[data-pick-photo]')) {
    const photo = button.dataset.pickPhoto;
    const chosen = Boolean(photo && decision === 'winner' && photo === id);
    button.disabled = savingDelivery || comparingPhotos || inspectorDirty || savingScores || !complete || !manifest.artifact_reviews?.[photo]?.preference_eligible;
    button.setAttribute('aria-pressed', String(chosen));
    button.querySelector('span').textContent = chosen ? '已选成片' : '选为成片';
    if (photo) button.setAttribute('aria-label', photoDesignation(photo) + ' · ' + button.textContent.replace('✓ ', ''));
    button.closest('figure').classList.toggle('picked', chosen);
  }
  const other = document.querySelector('#otherDelivery');
  other.value = ['none', 'pending'].includes(decision) ? decision : '';
  other.disabled = savingDelivery;
  renderComparisonPreviews(manifest);
  const submit = document.querySelector('#savePreference');
  submit.disabled = savingDelivery || comparingPhotos || inspectorDirty || savingScores || unchanged || !decision || (decision !== 'pending' && !complete);
  submit.textContent = savingDelivery ? '正在保存…' : unchanged ? '已保存' :
    decision === 'winner' ? '确认交付 ' + label : decision === 'none' ? '确认全部不要' : decision === 'pending' ? '保存为暂不决定' : '确认交付';
  elements.preferenceMessage.textContent = decision === 'winner'
    ? (unchanged ? '已交付 ' : '待交付 ') + label
    : decision ? label : !complete ? '完成评分后选片' : currentPair()[0] ? '请选择一张成片' : '暂无合格的交付候选';
  if (elements.preferenceForm.elements.notes.value !== notes) elements.preferenceForm.elements.notes.value = notes;
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
  currentRunData = data;
  const manifest = data.manifest;
  currentRunId = data.runId;
  clearPendingRunCreationIdempotencyKey();
  currentManifest = manifest;
  captureAutomationState = data.capture_automation_state || null;
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
  elements.resultMessage.hidden = count > 0;
  document.getElementById('remakeRun').disabled = resultDecisionBusy || !data.reuse?.available;
  elements.captureRun.disabled = captureBusy || (!count && !['submitted', 'submission_uncertain','capture_pending'].includes(manifest.status));
  if(!captureBusy) elements.captureRun.textContent = count ? '前往评分' : manifest.image_api ? '查看 / 恢复 API 结果' : '检测并保存结果';
  elements.artifactImportForm.querySelector('input[type="file"]').disabled = count >= 4;
  elements.artifactImportForm.querySelector('button[type="submit"]').disabled = count >= 4;
  renderImportAction();
  if (count) elements.resultMessage.textContent = `已保存 ${count} 张独立候选图。每张图都有自己的文件、哈希和评分记录。`;
  else if (manifest.image_api) {
    const failureMessage = manifest.last_error?.message;
    elements.resultMessage.textContent = failureMessage
      && !failureMessage.startsWith('Submission attempt was durably registered') ? failureMessage : '';
    setPrimaryNotice(elements.resultMessage.textContent);
  }
  else if (manifest.capture?.message) elements.resultMessage.textContent = readableFailure(manifest.capture.message);
  renderReviewReferences(manifest);
  renderArtifacts(manifest);
  renderAestheticComparison(manifest);
  renderPreference(manifest);

  generationMode?.sync();
  syncCaptureRefresh();
}

async function applyRunData(data) {
  renderRun(data);
  if (data.manifest.image_api && !data.manifest.artifacts?.length) void generationMode?.observe();
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
  return applyRunData(await api(`/folio/portrait-lab/api/runs/${currentRunId}`));
}

function syncCaptureRefresh(){
  const pending=currentRunId&&!captureBusy&&!currentManifest?.image_api&&!currentManifest?.artifacts?.length&&(['submitted','submission_uncertain','capture_pending'].includes(currentManifest?.status)||primaryActionBusy);
  if(!pending){
    if(captureRefreshState.timer)clearTimeout(captureRefreshState.timer);
    captureRefreshState.timer=null;captureRefreshState.runId=null;return;
  }
  if(captureRefreshState.runId!==currentRunId){
    if(captureRefreshState.timer)clearTimeout(captureRefreshState.timer);
    captureRefreshState.timer=null;captureRefreshState.runId=currentRunId;captureRefreshState.deadline=Date.now()+16*60*1000;
  }
  if(captureRefreshState.timer||captureRefreshState.inFlight||Date.now()>captureRefreshState.deadline)return;
  const runId=currentRunId;
  captureRefreshState.timer=setTimeout(async()=>{
    captureRefreshState.timer=null;
    if(currentRunId!==runId||captureRefreshState.runId!==runId)return;
    captureRefreshState.inFlight=true;
    try{
      // Local status only: never trigger browser capture, upload or submission.
      const data=await api(`/folio/portrait-lab/api/runs/${encodeURIComponent(runId)}`);
      if(currentRunId===runId&&captureRefreshState.runId===runId&&data.runId===runId&&!captureBusy&&(!primaryActionBusy||Number(data.manifest?.submission_attempt_count||0)>0||data.manifest?.artifacts?.length))await applyRunData(data);
    }catch{
      // A transient local disconnect must not replace the durable task state.
    }finally{
      captureRefreshState.inFlight=false;syncCaptureRefresh();
    }
  },3000);
}

function returnToNewTask(notice, { replaceUrl = true } = {}) {
  currentRunId = null;
  currentRunData = null;
  currentManifest = null;
  captureAutomationState = null;
  syncCaptureRefresh();
  renderCaptureBody(null);
  resultWorkbench?.clear();
  smartTaskWorkflow?.clear();smartResolved=null;smartRestoredRunId=null;
  activeReuseDraft=null;reuseFileDescriptors.clear();
  generationMode?.reset();

  inspectorDirty = false;
  templateSelectionSources.clear();
  currentRunOpenedFromHistory = false;
  if (replaceUrl) history.replaceState(null, '', '/folio/portrait-lab/');
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
    const data = await api(`/folio/portrait-lab/api/runs/${currentRunId}`);
    const destination = resolveRunStartup({ manifest: data.manifest, fromHistory: currentRunOpenedFromHistory });
    if (destination.mode === 'run' && data.manifest.artifacts?.length && new URLSearchParams(location.search).get('stage') === 'results') {
      destination.stage = 'results';
    }
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
  const [artifactAId,artifactBId] = currentPair();
  if (!artifactAId || !artifactBId) throw new Error('请先选择两张合格候选');
  if (artifactAId === artifactBId) throw new Error('候选 A 和 B 必须是两张不同的图');
  const buttons = [...elements.aestheticComparisonForm.querySelectorAll('[data-comparison-outcome]')];
  for (const button of buttons) button.disabled = true;
  elements.aestheticComparisonMessage.textContent = '正在保存对比…';
  try {
    const result = await api(`/folio/portrait-lab/api/runs/${currentRunId}/comparison`, {
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

function openWorkbenchStage(stage) {
  if (!elements.historyPage.hidden) {
    if (elements.historyPage.getAttribute('aria-busy') === 'true') return;
    if (hasUnsavedHistoryMetadata() && !window.confirm('这条记录的信息尚未保存，是否返回工作台？')) return;
    closeHistoryPage({ stage });
    return;
  }
  userStageRevision += 1;
  setStage(stage);
}
for (const tab of elements.stageTabs) {
  tab.addEventListener('click', () => openWorkbenchStage(tab.dataset.stageTarget));
}
document.querySelector('#returnWorkbench').addEventListener('click', () => openWorkbenchStage('references'));
elements.newTaskButton.addEventListener('click', () => {
  if (inspectorDirty && !window.confirm('当前候选的评分尚未保存。新建任务会丢失这些未保存输入，是否继续？')) return;
  generationMode?.reset();
  sessionStorage.removeItem('ai-img-gen.smart-draft-customer');smartTaskWorkflow?.clear();
  window.location.assign('/folio/portrait-lab/');
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
  if (!elements.historyPage.hidden) return;
  showHistoryList();
  await openHistoryPage({ push: true });
});
elements.openHistoryImport.addEventListener('click', showHistoryImport);
elements.historyHeaderAction.addEventListener('click', () => {
  if (historyWorkspaceState.view !== 'list') {
    showHistoryList();
    return;
  }
  if (historyShowingDeleted) {
    setHistoryDeletedView(false);
    return;
  }
  closeHistoryPage();
});
elements.historyRefresh.addEventListener('click', loadHistory);
function setHistoryDeletedView(showDeleted) {
  historyShowingDeleted = showDeleted;
  historyShowDeleted.setAttribute('aria-pressed', String(historyShowingDeleted));
  document.querySelector('#historyFilters').hidden = historyShowingDeleted;
  elements.historyLibraryView.classList.toggle('showing-deleted', historyShowingDeleted);
  applyHistoryWorkspaceView();
  elements.historyNavigationMessage.textContent = '';
  historyRuns = [];
  historyRunsById = new Map();
  loadHistory();
}
historyShowDeleted.addEventListener('click', () => setHistoryDeletedView(!historyShowingDeleted));
historyDeleteDialog.addEventListener('close', () => {
  const target = historyDeleteTarget;
  const confirmed = historyDeleteDialog.returnValue === 'delete';
  historyDeleteTarget = null;
  historyDeleteDialog.returnValue = '';
  if (confirmed && target) changeHistoryVisibility(target.runId, true, target.trigger);
});
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
  const restoreButton = event.target.closest('[data-restore-history-record]');
  if (restoreButton) {
    changeHistoryVisibility(restoreButton.dataset.restoreHistoryRecord, false, restoreButton);
    return;
  }
  const deleteButton = event.target.closest('[data-delete-history-record]');
  if (deleteButton) {
    const runId = deleteButton.dataset.deleteHistoryRecord;
    const run = historyRunsById.get(runId);
    if (!run) return;
    historyDeleteTarget = { runId, trigger: deleteButton };
    document.querySelector('#historyDeleteTarget').textContent = `${run.customer_name || '未命名客户'} · ${formatHistoryDate(run.created_at)} · ${run.artifact_count} 张成品`;
    historyDeleteDialog.returnValue = '';
    historyDeleteDialog.showModal();
    return;
  }
  const infoButton = event.target.closest('[data-view-history-record]');
  if (infoButton) {
    showHistoryRecord(infoButton.dataset.viewHistoryRecord);
    return;
  }
  const runLink = event.target.closest('[data-open-history-review]');
  if (!runLink || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  openHistoryRecordReview(runLink.dataset.openHistoryReview);
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
    await api(`/folio/portrait-lab/api/runs/${encodeURIComponent(runId)}/record`, {
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
  if (currentRunId !== runId && inspectorDirty && !window.confirm('当前候选的评分尚未保存。打开另一条历史记录会丢失这些未保存输入，是否继续？')) return;
  if (currentRunId !== runId && hasUnsavedHistoryMetadata() && !window.confirm('这条记录的信息尚未保存。打开评审工作区会丢失这些未保存修改，是否继续？')) return;
  if (!currentRunId && hasUnsavedCreationDraft() && !window.confirm('当前新任务有未提交的照片或设置。打开历史任务会切换离开当前草稿，是否继续？')) return;
  sessionStorage.setItem(historyReturnStorageKey, runId);
  const returnView = historyWorkspaceState.view;
  historyPageOrigin = { ...historyPageOrigin, view: returnView, historyRecordId: activeHistoryRecordId };
  if (history.state?.source === 'history-page') {
    history.replaceState({ source: 'history-page', origin: {
      runId: historyPageOrigin.runId,
      fromHistory: historyPageOrigin.fromHistory,
      stage: historyPageOrigin.stage,
      view: historyPageOrigin.view,
      historyRecordId: historyPageOrigin.historyRecordId,
    } }, '', window.location.href);
  }
  history.pushState({ source: 'history-record', runId }, '', buildHistoryRunUrl(runId, window.location.search));
  const requestSequence = ++historyRecordNavigationSequence;
  const isCurrentRequest = () => requestSequence === historyRecordNavigationSequence
    && currentRunId === runId
    && history.state?.source === 'history-record'
    && history.state?.runId === runId;
  currentRunId = runId;
  currentRunOpenedFromHistory = true;
  currentManifest = null;
  currentRunData = null;

  inspectorDirty = false;
  elements.historyNavigationMessage.textContent = '正在打开记录…';
  elements.historyPage.setAttribute('aria-busy', 'true');
  try {
    const data = await api(`/folio/portrait-lab/api/runs/${encodeURIComponent(runId)}`);
    if (!isCurrentRequest()) return;
    if (data.runId !== runId) throw new Error('读取到的记录与所选任务不一致');
    await applyRunData(data);
    if (!isCurrentRequest()) return;
    const stage = resolveRunStartup({ manifest: data.manifest || {}, fromHistory: true }).stage;
    elements.historyNavigationMessage.textContent = '';
    elements.historyPage.removeAttribute('aria-busy');
    setHistoryPageVisible(false, { focus: false });
    setStage(stage);
    const stagePanel = elements.stagePanels.find((panel) => panel.dataset.stagePanel === stage);
    stagePanel?.setAttribute('tabindex', '-1');
    stagePanel?.focus({ preventScroll: true });
  } catch (error) {
    if (!isCurrentRequest()) return;
    historyNavigationError = `无法打开历史记录：${error.message}`;
    elements.historyPage.removeAttribute('aria-busy');
    elements.historyNavigationMessage.textContent = historyNavigationError;
    if (history.state?.source === 'history-record') history.back();
  }
}
elements.openRecordReview.addEventListener('click', () => openHistoryRecordReview(activeHistoryRecordId));
document.querySelector('#reuseHistorySettings')?.addEventListener('click',async()=>{
  const runId = activeHistoryRecordId;
  if (!runId) return;
  try {
    const data = await api(`/folio/portrait-lab/api/runs/${encodeURIComponent(runId)}`);
    if (activeHistoryRecordId !== runId) return;
    await recallRunSettings(data, { expectedHistoryRecordId: runId });
  } catch(error) {
    if (activeHistoryRecordId === runId) elements.historyRecordMessage.textContent = error.message;
  }
});
window.addEventListener('popstate', async (event) => {
  historyRecordNavigationSequence += 1;
  elements.historyPage.removeAttribute('aria-busy');
  if (isHistoryPageLocation(window.location.search)) {
    const returnedRecordId = sessionStorage.getItem(historyReturnStorageKey);
    if (returnedRecordId) sessionStorage.removeItem(historyReturnStorageKey);
    const routeOrigin = event.state?.source === 'history-page' ? event.state.origin : null;
    const savedOrigin = historyPageOrigin || routeOrigin || {
      runId: parseRunLocation(window.location.search).runId,
      fromHistory: currentRunOpenedFromHistory,
      stage: activeStage,
      view: 'list',
      runData: currentRunData,
    };
    if (routeOrigin) {
      savedOrigin.runId ??= routeOrigin.runId;
      savedOrigin.fromHistory ??= routeOrigin.fromHistory;
      savedOrigin.stage ??= routeOrigin.stage;
      savedOrigin.view ??= routeOrigin.view;
      savedOrigin.historyRecordId ??= routeOrigin.historyRecordId;
      savedOrigin.runData ??= currentRunData?.runId === savedOrigin.runId ? currentRunData : null;
    }
    historyPageOrigin = savedOrigin;
    await restoreHistoryPageOrigin(savedOrigin, { keepHistoryRoute: true }).catch((error) => {
      historyNavigationError = `无法恢复原任务：${error.message}`;
    });
    setHistoryPageVisible(true, { focus: false });
    await loadHistory();
    if (returnedRecordId && savedOrigin.view === 'detail') showHistoryRecord(savedOrigin.historyRecordId || returnedRecordId);
    else showHistoryList();
    elements.historyNavigationMessage.textContent = historyNavigationError;
    historyNavigationError = '';
    const trigger = returnedRecordId && savedOrigin.view === 'detail'
      ? elements.historyPage.querySelector(`[data-view-history-record="${CSS.escape(savedOrigin.historyRecordId || returnedRecordId)}"]`)
      : elements.historyPage.querySelector(`[data-open-history-review="${CSS.escape(returnedRecordId || '')}"]`);
    trigger?.focus({ preventScroll: true });
    return;
  }

  if (!elements.historyPage.hidden) {
    const origin = historyPageOrigin;
    await restoreHistoryPageOrigin(origin, { keepHistoryRoute: false }).catch(() => null);
    setHistoryPageVisible(false, { focus: !origin?.keepRailFocus });
    historyPageOrigin = null;
    historyPageEntryPushed = false;
  }
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
    const data = await api('/folio/portrait-lab/api/history/import', { method: 'POST', body: new FormData(form) });
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

function isFileDrag(event) {
  return event.dataTransfer?.types.includes('Files');
}

for (const [kind, grid] of [['identity', elements.identityPreviewGrid], ['templates', elements.templatePreviewGrid]]) {
  grid.addEventListener('dragover', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    grid.classList.add('file-drop-active');
  });
  grid.addEventListener('dragleave', (event) => {
    if (!grid.contains(event.relatedTarget)) grid.classList.remove('file-drop-active');
  });
  grid.addEventListener('drop', (event) => {
    grid.classList.remove('file-drop-active');
    if (!isFileDrag(event)) return;
    event.preventDefault();
    const dropped = [...event.dataTransfer.files];
    const images = dropped.filter(file => ACCEPTED_CLIPBOARD_IMAGE_TYPES.includes(file.type.toLowerCase()));
    if (!images.length) {
      elements.prepareResult.textContent = '请选择 PNG、JPEG 或 WebP 图片。';
      return;
    }
    const merged = mergeReferenceFiles(kind, images);
    renderSendSummary();
    const warnings = [];
    if (dropped.length > images.length) warnings.push('已跳过不支持的文件。');
    if (merged.rejected_count) warnings.push('已跳过超过数量上限的图片。');
    if (merged.duplicate_count) warnings.push('已跳过重复图片。');
    elements.prepareResult.textContent = warnings.join(' ');
  });
}

for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (event) => {
    if (!event.defaultPrevented && isFileDrag(event) && !document.querySelector('#createCard').hidden) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'none';
    }
  });
}

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
    const data=await api(`/folio/portrait-lab/api/runs/${encodeURIComponent(runId)}`);
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
    const probe = await api('/folio/portrait-lab/api/browser/probe', { method: 'POST' });
    renderBrowserStatus(probe);
    if (!probe.browser.ready) {
      throw new Error(probe.browser.message || 'Playwright 尚未连接默认 Chrome，系统没有上传或发送。');
    }
  }
  const staged = await api(`/folio/portrait-lab/api/runs/${runId}/stage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed: true }),
  });
  if (staged.state !== 'awaiting_submission_confirmation') {
    const existing=await reconcile();if(existing)return existing;
    throw new Error(staged.message || '参考图未能装载到 ChatGPT，系统没有发送。');
  }
  return await api(`/folio/portrait-lab/api/runs/${runId}/submit`, {
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
  const probe = await api('/folio/portrait-lab/api/browser/probe', { method: 'POST' });
  renderBrowserStatus(probe);
  if (!probe.browser.ready) {
    throw new Error(probe.browser.message || 'Playwright 尚未连接默认 Chrome，系统没有创建、上传或发送修改任务。');
  }
  const child = await api(`/folio/portrait-lab/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/revisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed: true }),
  });
  const childRunId = child.runId;
  const submitted = await stageAndSubmitRunOnce(childRunId, { probeBrowserFirst: false });
  if (!['submitted', 'submission_uncertain'].includes(submitted.state)) {
    throw new Error(submitted.message || `子任务 ${childRunId} 未能发送；系统没有重试。`);
  }
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
  const { name: customerName, id: customerScopeId } = smartCustomer();
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
  low: '低风险', medium: '中风险', high: '高风险', fashion_editorial: '时尚杂志', unknown: '未评估',
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
          ${['low', 'medium', 'high'].includes(template.identity_preservation_risk) ? `<span class="template-tag risk-${escapeHtml(template.identity_preservation_risk)}">${escapeHtml(templateValueLabel(template.identity_preservation_risk))}</span>` : ''}
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
    ['风格分类', templateValueLabel(template.style_category) || '未分类'],
    ['建议景别', templateValueLabel(template.portrait_scale) || '自适应'],
    ['人脸角度', templateValueLabel(template.face_angle) || '自适应'],
    ['保真风险', templateValueLabel(template.identity_preservation_risk) || '未评估'],
    ['生成难度', templateValueLabel(template.generation_difficulty) || '未评估'],
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
    if (template.portrait_scale) reasons.push(templateValueLabel(template.portrait_scale));
    if (['low', 'medium', 'high'].includes(template.identity_preservation_risk)) {
      reasons.push('保真风险：' + templateValueLabel(template.identity_preservation_risk));
    }
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
  const loaded = await api(`/folio/portrait-lab/api/template-selections/${encodeURIComponent(selectionId)}`);
  if(manifest.run_id!==currentRunId)return;
  recommendationController.setSelectionState(loaded.selection);
  templateLibraryController.setActiveSelection(loaded.selection);
  templateLibraryController.setSelectedTemplates(catalogReferences.map(({ reference, index }) => ({
    template_uid: reference.template_uid,
    template_name: reference.template_name,
    reference_image: {
      url: `/folio/portrait-lab/api/runs/${encodeURIComponent(manifest.run_id)}/references/template/${index}/file`,
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

elements.openTemplateLibraryButton?.addEventListener('click', () => {
  elements.templateLibraryDialog.showModal();
  void filterTemplateLibrary();
});
document.querySelector('#retryTemplateLibrary')?.addEventListener('click', filterTemplateLibrary);

elements.closeTemplateLibraryButton?.addEventListener('click', () => elements.templateLibraryDialog.close());
elements.confirmLibrarySelection?.addEventListener('click', () => elements.templateLibraryDialog.close());
elements.closeDrawerButton?.addEventListener('click', () => { elements.templateDetailDrawer.hidden = true; });

let templateRequest = 0;
async function filterTemplateLibrary() {
  const request = ++templateRequest;
  const pending = document.querySelector('#templateLoading');
  const failed = document.querySelector('#templateFailed');
  elements.templateGrid.setAttribute('aria-busy', 'true');
  elements.templateGrid.replaceChildren();
  elements.templateGridEmpty.hidden = true;
  failed.hidden = true;
  pending.hidden = false;
  try {
    await templateLibraryController.loadTemplates({
      q: elements.templateSearchInput?.value || '',
      style_category: elements.templateStyleFilter?.value || '',
      portrait_scale: elements.templateScaleFilter?.value || '',
      face_angle: elements.templateAngleFilter?.value || '',
      identity_preservation_risk: elements.templateRiskFilter?.value || '',
    });
    if (request !== templateRequest) return;
    populateTemplateFilters(templateLibraryController.getFilterVocabulary());
    renderTaskTemplateLibrary();
    updateLibrarySelectedCounter();
  } catch {
    if (request === templateRequest) failed.hidden = false;
  } finally {
    if (request === templateRequest) {
      pending.hidden = true;
      elements.templateGrid.setAttribute('aria-busy', 'false');
    }
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
  if (primaryActionBusy || customerProfileSaving) return;
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
    try{
      if(currentManifest?.artifacts?.length)setStage('review');
      else if (generationMode.getState() === 'api_rejected') setStage('results');
      else await generationMode.submit();
    }
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
        const captured = await api(`/folio/portrait-lab/api/runs/${currentRunId}/capture`, { method: 'POST' });
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
      if (recovery === 'artifacts_review') setStage(action.kind === 'review_artifacts' ? 'review' : 'results');
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
  applyCustomerContext(form);
  form.set('runCreationIdempotencyKey', pendingRunCreationIdempotencyKey());
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
    const probe = await api('/folio/portrait-lab/api/browser/probe', { method: 'POST' });
    renderBrowserStatus(probe);
    if (!probe.browser.ready) {
      throw new Error(probe.browser.message || 'Playwright 尚未连接默认 Chrome，系统没有创建、上传或发送任务。');
    }
    const data = await api('/folio/portrait-lab/api/runs', { method: 'POST', body: form });

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
    setStage('results');
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
    const data = await api(`/folio/portrait-lab/api/runs/${currentRunId}/stage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) });
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
    const data = await api(`/folio/portrait-lab/api/runs/${currentRunId}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) });
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
  const items=(currentManifest.artifacts||[]).map((artifact,index)=>({kind:'generated',url:`/folio/portrait-lab/api/runs/${encodeURIComponent(currentRunId)}/artifacts/${encodeURIComponent(artifact.artifact_id)}/file`,caption:`候选 ${artifact.ordinal||index+1}`}));
  openMediaPreview(items,Number(trigger.dataset.capturePreview),trigger);
});
document.getElementById('resultIdentityReferences').addEventListener('click', event => {
  const button=event.target.closest('[data-result-identity]'); if (!button || !currentRunId) return;
  const items=(currentManifest?.identity_references||[]).map((_,i)=>({kind:'identity',url:`/folio/portrait-lab/api/runs/${encodeURIComponent(currentRunId)}/references/identity/${i}/file`,caption:`输入原图 ${i+1}`}));
  openMediaPreview(items,Number(button.dataset.resultIdentity),button);
});
document.getElementById('deferRun').addEventListener('click', () => elements.newTaskButton.click());
const discardRunButton = document.getElementById('discardRun');
const discardRunDialog = document.getElementById('discardRunDialog');
let discardRunId = null;
discardRunButton.addEventListener('click', () => {
  if (!currentRunId || !currentManifest?.artifacts?.length || resultDecisionBusy) return;
  discardRunId = currentRunId;
  discardRunDialog.showModal();
});
discardRunDialog.addEventListener('close', async () => {
  const runId = discardRunId;
  const confirmed = discardRunDialog.returnValue === 'discard';
  discardRunId = null;
  discardRunDialog.returnValue = '';
  if (!confirmed || !runId || runId !== currentRunId || resultDecisionBusy) return;
  resultDecisionBusy = true;
  setBusy(discardRunButton, true, '正在删除');
  elements.captureRun.disabled = true;
  try {
    await api(`/folio/portrait-lab/api/runs/${encodeURIComponent(runId)}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    });
    if (runId === currentRunId) {
      generationMode?.reset();
      window.location.replace('/folio/portrait-lab/?view=history');
    }
  } catch (error) {
    if (runId === currentRunId) {
      elements.resultMessage.hidden = false;
      elements.resultMessage.textContent = `无法删除本次任务：${error.message}`;
    }
  } finally {
    resultDecisionBusy = false;
    elements.captureRun.disabled = false;
    setBusy(discardRunButton, false);
  }
});
document.getElementById('remakeRun').addEventListener('click', async () => {
  if (!currentRunId || !currentRunData?.reuse?.available || resultDecisionBusy) return;
  if (inspectorDirty && !window.confirm('当前评分尚未保存。沿用素材重做会离开评分，是否继续？')) return;
  const runId=currentRunId,button=document.getElementById('remakeRun');resultDecisionBusy=true;setBusy(button,true,'正在准备素材');
  try {
    const data=await api(`/folio/portrait-lab/api/runs/${encodeURIComponent(runId)}`);
    if(currentRunId!==runId)return;
    await recallRunSettings(data,{expectedRunId:runId});
    elements.prepareResult.textContent='已沿用本次素材和要求。调整后，点击开始生成可发起新任务。';
    elements.prepareResult.dataset.state='neutral';
    document.getElementById('userSupplement').focus({preventScroll:true});
  } catch(error) {elements.resultMessage.hidden=false;elements.resultMessage.textContent=error.message;}
  finally {resultDecisionBusy=false;setBusy(button,false);}
});
elements.captureRun.addEventListener('click', async () => {
  if (!currentRunId || captureBusy || resultDecisionBusy) return;
  if (currentManifest?.artifacts?.length) { setStage('review'); return; }
  if(currentManifest?.image_api){
    if (generationMode.getState() === 'prepared') { setStage('references'); return; }
    captureBusy=true;
    setBusy(elements.captureRun,true,'正在读取 API 任务');
    renderCaptureBody();
    try{await generationMode.resume();}catch(error){elements.resultMessage.textContent=error.message;}
    finally{captureBusy=false;setBusy(elements.captureRun,false);generationMode.sync();renderCaptureBody();}return;
  }
  captureBusy=true;
  captureFailureRunId=null;
  setBusy(elements.captureRun, true, '正在检测');
  renderCaptureBody(currentManifest,{busy:true});
  elements.resultMessage.textContent = '正在核对当前对话中的新图片资源；不会提交新任务。';
  try {
    const data = await api(`/folio/portrait-lab/api/runs/${currentRunId}/capture`, { method: 'POST' });
    elements.resultMessage.textContent = data.artifacts?.length
      ? `已保存 ${data.artifacts.length} 张独立候选图。`
      : (data.capture?.message ? readableFailure(data.capture.message) : '没有找到可验证的原图，请使用人工导入。');
  } catch (error) {
    captureFailureRunId=currentRunId;
    elements.resultMessage.textContent = `自动保存未完成：${error.message} 请使用人工导入；系统没有重新提交任务。`;
  } finally {
    captureBusy=false;
    setBusy(elements.captureRun, false);
    const data = await refreshRun().catch(() => null);
    renderCaptureBody(currentManifest);
    if (data?.manifest?.artifacts?.length) setStage('results');
  }
});

elements.artifactImportForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form=event.currentTarget;
  if (!currentRunId) return;
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true, '正在导入');
  try {
    const data = await api(`/folio/portrait-lab/api/runs/${currentRunId}/artifacts/import`, { method: 'POST', body: new FormData(form) });
    elements.resultMessage.textContent = `已保存 ${data.artifacts.length} 张独立候选图。`;
    form.reset();
  } catch (error) {
    elements.resultMessage.textContent = `无法导入结果：${error.message}`;
  } finally {
    setBusy(button, false);
    renderImportAction();
    const data = await refreshRun().catch(() => null);
    if (data?.manifest?.artifacts?.length) setStage('results');
  }
});

function syncReviewControls() {
  if (!currentManifest) return;
  renderPreference(currentManifest);
  const save = document.querySelector('#saveScores');
  if (save) save.disabled = !inspectorDirty || savingScores || comparingPhotos || savingDelivery;
}

elements.artifactInspector.addEventListener('input', event => {
  const form = event.target.form || event.target.closest('form');
  if (!form?.dataset.artifactId) return;
  form.dataset.dirty = 'true';
  inspectorDirty = true;
  document.querySelector('#scoreStatus').textContent = '待保存';
  syncReviewControls();
});
elements.artifactInspector.addEventListener('submit', event => {
  event.preventDefault();
  document.querySelector('#saveScores')?.click();
});
elements.artifactInspector.addEventListener('click', async event => {
  if (!event.target.closest('#saveScores') || savingScores || savingDelivery || comparingPhotos || !currentRunId) return;
  const inspector = elements.artifactInspector;
  const forms = [...inspector.querySelectorAll('form[data-dirty="true"]')];
  if (!forms.length || forms.some(form => !form.reportValidity())) return;
  const run = currentRunId;
  const payloads = forms.map(form => reviewPayload(form));
  savingScores = true;
  inspector.inert = true;
  let failed = '';
  try {
    document.querySelector('#scoreStatus').textContent = '正在保存…';
    syncReviewControls();
    for (const [i,form] of forms.entries()) {
      const id = form.dataset.artifactId;
      const result = await api(`/folio/portrait-lab/api/runs/${encodeURIComponent(run)}/artifacts/${encodeURIComponent(id)}/review`, {
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payloads[i])
      });
      if (currentRunId !== run) break;
      currentManifest.artifact_reviews[id] = result.review;
      delete form.dataset.dirty;
    }
  } catch (error) { failed = '保存失败：' + error.message; }
  finally {
    savingScores = false;
    inspector.inert = false;
    if (currentRunId === run) {
      inspectorDirty = Boolean(inspector.querySelector('form[data-dirty]'));
      await refreshRun().catch(() => { renderArtifacts(currentManifest); renderAestheticComparison(currentManifest); });
      if (failed) document.querySelector('#scoreStatus').textContent = failed;
      syncReviewControls();
    }
  }
});

async function recordComparison(outcome) {
  if (!currentRunId || comparingPhotos || savingDelivery || inspectorDirty || savingScores) return;
  comparingPhotos = true;
  let failure = '';
  try {
    elements.comparisonArtifactA.disabled = elements.comparisonArtifactB.disabled = true;
    syncReviewControls();
    await saveAestheticComparison(outcome);
  } catch (error) { failure = '无法保存：' + error.message; }
  finally {
    comparingPhotos = false;
    elements.comparisonArtifactA.disabled = elements.comparisonArtifactB.disabled = !currentPair()[1];
    syncReviewControls();
    if (failure) elements.aestheticComparisonMessage.textContent = failure;
  }
}
elements.aestheticComparisonForm.addEventListener('click',event => {
  const button = event.target.closest('[data-comparison-outcome]');
  if (button) void recordComparison(button.dataset.comparisonOutcome);
});

elements.artifactGallery.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || !currentManifest) return;
  const id = button.closest('[data-artifact-id]')?.dataset.artifactId;
  const items = currentManifest.artifacts;
  const index = items.findIndex(item => item.artifact_id === id);
  if (index < 0) return;
  if (button.hasAttribute('data-enlarge')) {
    openMediaPreview(items.map(item => ({url:reviewArtifactFileUrl(currentRunId,item.artifact_id),caption:'候选 '+reviewLetter(item)})),index,button);
  } else if (button.hasAttribute('data-open-annotation')) {
    openArtifactAnnotation({runId:currentRunId,artifact:items[index],onSaved:refreshRun,
      onSubmitRevision:!currentManifest.image_api && artifactRevisionCapability === 'ready' ? createAndSubmitArtifactRevision : null})
      .catch(error => {elements.preferenceMessage.textContent = '无法打开批注：' + error.message;});
  } else if (button.hasAttribute('data-pick-photo')) {
    draftDecision('winner',id);
  } else if (button.hasAttribute('data-like')) {
    const side = currentPair().indexOf(id);
    if (side >= 0) void recordComparison(button.getAttribute('aria-pressed') === 'true' ? 'clear' : side === 0 ? 'a' : 'b');
  }
});

document.querySelector('#otherDelivery').addEventListener('change', event => {
  if (event.target.value) draftDecision(event.target.value);
  else if (currentManifest) renderPreference(currentManifest);
});
elements.preferenceForm.elements.notes.addEventListener('input', () => {
  const current = deliverySelection(currentManifest);
  draftDecision(current.decision, current.id);
});

for (const select of [elements.comparisonArtifactA, elements.comparisonArtifactB]) {
  select.addEventListener('change', () => {
    if (!currentManifest || comparingPhotos || savingDelivery) return;
    const other = select === elements.comparisonArtifactA ? elements.comparisonArtifactB : elements.comparisonArtifactA;
    if (other.value === select.value) other.value = [...other.options].find(option => option.value !== select.value).value;
    elements.aestheticComparisonForm.elements.notes.value = '';
    renderComparisonPreviews(currentManifest);
    renderPreference(currentManifest);
  });
}

elements.preferenceForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentRunId || savingDelivery || document.querySelector('#savePreference').disabled) return;
  const run = currentRunId;
  const {decision,id,notes} = deliverySelection(currentManifest);
  savingDelivery = true;
  elements.preferenceForm.elements.notes.disabled = true;
  renderPreference(currentManifest);
  let failure = '';
  try {
    const data = await api(`/folio/portrait-lab/api/runs/${run}/preference`, {method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({decision,winnerArtifactId:decision === 'winner' ? id : null,notes})});
    if (run !== currentRunId) return;
    currentManifest.preference = data.preference;
    deliveryDraft = null;
    if (shouldClearRunUrlAfterPreference(decision, currentRunOpenedFromHistory)) {
      sessionStorage.setItem(homeNoticeStorageKey, COMPLETED_RUN_NOTICE);
      history.replaceState(null, '', '/folio/portrait-lab/');
    }
    await refreshRun().catch(() => {});
  } catch (error) {
    failure = '无法保存：' + error.message;
  } finally {
    savingDelivery = false;
    elements.preferenceForm.elements.notes.disabled = false;
    if (run === currentRunId) {
      syncReviewControls();
      if (failure) elements.preferenceMessage.textContent = failure;
    }
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
elements.openCustomerProfile.addEventListener('click', () => {
  if (primaryActionBusy || elements.newCustomerFields.hidden) return;
  elements.customerProfileName.value = '';
  elements.customerProfileName.setCustomValidity('');
  elements.customerProfileMessage.textContent = '';
  elements.customerProfileDialog.showModal();
});
elements.customerProfileName.addEventListener('input', () => elements.customerProfileName.setCustomValidity(''));
elements.cancelCustomerProfile.addEventListener('click', () => elements.customerProfileDialog.close());
elements.customerProfileDialog.addEventListener('cancel', (event) => {
  if (customerProfileSaving) event.preventDefault();
});
elements.customerProfileForm.addEventListener('submit', saveNewCustomerProfile);
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
  onJobChange:()=>{
    if (!currentManifest?.image_api) return;
    const job = generationMode.currentJob();
    if (job?.message && !currentManifest.artifacts?.length) elements.resultMessage.textContent = job.message;
    renderCaptureBody();
  },
  showMessage:(message,tone)=>{setPrimaryNotice(message,tone);elements.resultMessage.textContent=message;},
  buildForm:async operation=>{
    const form=new FormData(document.querySelector('#runForm'));
    applyCustomerContext(form);
    if(operation==='edit'){
      if (templateLibraryController.getSelectedCount() || referenceFileState.templates.length) await previewFoundationPrompt();
      await prepareFaceAngleSubmission(form);
      const selected=templateLibraryController.getSelectedTemplates();
      if(selected.length){await persistCatalogSelectionDecision();form.set('templateSelectionId',recommendationController.getSelectionId());form.set('templateDecisionIdempotencyKey',recommendationController.getDecisionIdempotencyKey());for(const item of selected)form.append('catalogTemplateUids',item.uid);}
    }else{
      for(const key of ['identity','templates','identitySetId','identityReferenceOrdinals','primaryIdentityReferenceOrdinal'])form.delete(key);
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
    await refreshRun();setStage('results');
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
  form.set('sourceRunId',activeReuseDraft.source_run_id);form.set('reuseReferences',JSON.stringify(references));form.delete('identitySetId');
}
async function recallRunSettings(data,{expectedRunId=null,expectedHistoryRecordId=null}={}){
  const assertSourceStillSelected = () => {
    if (expectedRunId && currentRunId !== expectedRunId) throw new Error('任务已切换，请在当前任务中重新选择。');
    if (expectedHistoryRecordId && activeHistoryRecordId !== expectedHistoryRecordId) throw new Error('历史记录已切换，请重新选择设置。');
  };
  assertSourceStillSelected();
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
  assertSourceStillSelected();
  returnToNewTask('已沿用为草稿，尚未创建或发送任务。');
  if (!elements.historyPage.hidden) setHistoryPageVisible(false, { focus: false });
  historyPageOrigin = null;
  historyPageEntryPushed = false;
  const form=document.querySelector('#runForm');form.reset();useIdentityUploadMode();
  renderFoundationCustomerPicker(reuse.customer_id);
  elements.customerName.value=reuse.customer_name;
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
  invalidateRecommendationIfTaskChanged();templateLibraryController.setSelectedTemplates(chosen);refreshTemplateSelectionViews();generationMode.sync();renderSendSummary();
  const cfg=data.current_api_config||{},old=reuse.api_settings;const changes=old&&(old.model!==cfg.model||old.provider!==cfg.baseUrl);
  const warning=chosen.some(t=>t.operator_rejected)?' 原模板已淘汰，请移除并重新选择。':'';
  elements.prepareResult.textContent=`已沿用草稿，尚未创建或发送任务。${changes?` 原配置 ${old.model} / ${old.provider}；提交将使用当前 ${cfg.model||'未配置'} / ${cfg.baseUrl||'未配置'}。`:''}${warning}${reuse.task_intent?'':' 旧任务未记录结构化设置，请补全；没有把旧完整提示词当作补充要求。'}`;
}
async function resultRevisionRequest({runId,artifactId,instruction,includeAnnotations,annotationSessionId,jobKey,recoverOnly,expectedApiConfig}){
  const request=async(url,options={})=>{const response=await fetch(url,{...options,headers:{'x-image-api-client':'workstation',...(options.headers||{})}});const body=await response.json();if(!response.ok)throw Object.assign(new Error(typeof body.error==='string'?body.error:body.error?.message||'修改任务失败'),{status:response.status});return body;};
  if (recoverOnly) {
    const path = `/folio/portrait-lab/api/image-api/jobs/${encodeURIComponent(jobKey)}`;
    const status = await request(path);
    if (!status.canRecover) return status;
    try { return await request(path + '/recover', { method: 'POST' }); }
    catch (error) { return { ...status, message: error.message }; }
  }
  return request(`/folio/portrait-lab/api/runs/${runId}/artifacts/${artifactId}/revisions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmed:true,jobKey,instruction,includeAnnotations,annotationSessionId,expectedApiConfig})});
}
resultWorkbench=initResultWorkbench({container:document.querySelector('#resultWorkbench'),onRecall:recallRunSettings,onRevision:resultRevisionRequest,
  onViewChange:open=>{document.querySelector('#reviewWorkspace').hidden=open;},
  onOpenRun:async runId=>{currentRunId=runId;history.replaceState(null,'',`?run=${encodeURIComponent(runId)}`);await refreshRun();setStage(currentManifest.artifacts?.length?'review':'results');},
  onAnnotate:async(data,artifactId)=>openArtifactAnnotation({runId:data.runId,artifact:data.manifest.artifacts.find(a=>a.artifact_id===artifactId),onSaved:async()=>refreshRun(),onSubmitRevision:null}),
});
document.querySelector('#openResultWorkbench')?.addEventListener('click',()=>resultWorkbench.open());
function smartEditingEnabled(){return (!currentManifest || (!Number(currentManifest.submission_attempt_count||0)&&!currentManifest.artifacts?.length)) && !(generationMode?.usesApi()&&document.querySelector('#apiOperation').value==='generate');}
function getTemporaryCustomerId() {
  if (!smartDraftCustomerId) {
    smartDraftCustomerId = `cust_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    sessionStorage.setItem('ai-img-gen.smart-draft-customer', smartDraftCustomerId);
  }
  return smartDraftCustomerId;
}

function smartCustomer() {
  const stored = currentManifest && !Number(currentManifest.submission_attempt_count || 0) ? currentManifest : null;
  const selectedId = elements.customerSelector.value;
  const selected = foundationCustomers.find((item) => item.customer_id === selectedId);
  const id = stored?.customer_id || stored?.customer_identity_source?.customer_id
    || activeReuseDraft?.customer_id || selectedId || getTemporaryCustomerId();
  const name = stored?.customer_name || activeReuseDraft?.customer_name || selected?.display_name
    || (selectedId ? selectedOptionText(elements.customerSelector) : '') || '临时客户';
  return { id, name };
}

function applyCustomerContext(form) {
  const { id, name } = smartCustomer();
  form.set('customerId', id);
  form.set('customerName', name);
}
function getSmartDraftForm(){
  const form=new FormData(document.querySelector('#runForm'));
  applyCustomerContext(form);
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
  const response=await fetch(`/folio/portrait-lab/api/runs/${currentRunId}/prepare`,{method:'POST',headers:{'x-smart-task-client':'workstation'},body:form});const data=await response.json();if(!response.ok)throw new Error(typeof data.error==='string'?data.error:data.error?.message||'无法更新原任务');
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
smartTaskWorkflow.loadConfig().catch(() => {});
loadFoundationCustomers();
setStage('references');
loadStatus();
loadFaceAngleCapability();
const queuedHomeNotice = sessionStorage.getItem(homeNoticeStorageKey);
sessionStorage.removeItem(homeNoticeStorageKey);
if (!currentRunId && queuedHomeNotice) elements.prepareResult.textContent = queuedHomeNotice;
if (requestedHistoryPage) {
  const initialHistoryOrigin = history.state?.source === 'history-page'
    ? { ...history.state.origin }
    : { runId: currentRunId, fromHistory: currentRunOpenedFromHistory, stage: activeStage, view: 'list' };
  await restoreRequestedRun().finally(async () => {
    initialHistoryOrigin.runId = currentRunId;
    initialHistoryOrigin.fromHistory = currentRunOpenedFromHistory;
    initialHistoryOrigin.stage = activeStage;
    initialHistoryOrigin.view ||= 'list';
    initialHistoryOrigin.runData = currentRunData;
    await openHistoryPage({ push: false, origin: initialHistoryOrigin });
  });
} else {
  await restoreRequestedRun();
}
