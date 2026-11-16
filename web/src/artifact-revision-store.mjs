import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

import { loadArtifactAnnotation, loadRun } from './run-store.mjs';

export const ARTIFACT_REVISION_SCHEMA = 'ai-img-gen.artifact-revision-run.v1';

const reasonLabels = {
  face: '人脸',
  hair: '发型',
  hand: '手部',
  clothing: '服装',
  pose: '姿势',
  background: '背景',
  lighting: '光影',
  text: '文字',
  other: '其他',
};

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function within(base, candidate) {
  const relativePath = relative(resolve(base), resolve(candidate));
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

export function normalizeChatGptConversationUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || !/^\/c\/[a-zA-Z0-9-]{16,}$/.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function isArtifactRevisionRun(run) {
  return run?.manifest?.schema_version === ARTIFACT_REVISION_SCHEMA
    && run.manifest.run_kind === 'artifact_revision';
}

function percent(value) {
  return `${Math.round(Number(value || 0) * 1000) / 10}%`;
}

export function buildArtifactRevisionPrompt({ annotationState }) {
  const annotations = Array.isArray(annotationState?.annotations) ? annotationState.annotations : [];
  if (!annotations.length) throw new Error('At least one saved annotation region is required');
  const instructions = annotations.map((annotation, index) => {
    const bounds = annotation.bounds || {};
    const location = `左上 (${percent(bounds.x)}, ${percent(bounds.y)})，宽 ${percent(bounds.width)}，高 ${percent(bounds.height)}`;
    const reason = reasonLabels[annotation.reason_code] || reasonLabels.other;
    const note = String(annotation.note || '').trim() || `请自然修正这个${reason}区域。`;
    return `${index + 1}. ${reason}区域（${location}）：${note}`;
  });
  const overall = String(annotationState?.overall_note || '').trim();
  return [
    '请继续修改上一轮的人像图片，只输出 1 张修改后的完整图片。',
    '本条消息有两张附件：第 1 张是干净原图，是唯一的像素、人物身份和未修改区域来源；第 2 张是带标记的预览图，只用于标记位置指导。',
    '只修改标记区域以及为保持画面自然所必需的极小过渡范围。人物身份、五官、姿势、服装、构图、尺寸、其余背景和整体风格保持不变。不要把框线、箭头、文字、颜色、马赛克或其他标记画进最终图片。',
    `区域修改要求：\n${instructions.join('\n')}`,
    overall ? `整体补充要求：${overall}` : '',
    '请直接返回修改后的成品图，不要返回解释、对比图、拼图或带标记版本。',
  ].filter(Boolean).join('\n\n');
}

function inheritedCustomerScope(parent) {
  return {
    customer_name: String(parent.manifest.customer_name || ''),
    customer_id: String(parent.manifest.customer_identity_source?.customer_id || ''),
    identity_set_id: String(parent.manifest.customer_identity_source?.identity_set_id || ''),
  };
}

function referenceLineage(parent) {
  const project = (references = []) => references.map((reference) => ({
    sha256: reference.sha256 || null,
    filename: reference.filename || null,
    template_uid: reference.template_uid || null,
  }));
  return {
    identity_references: project(parent.manifest.identity_references),
    template_references: project(parent.manifest.template_references),
  };
}

export async function createArtifactRevisionRun({ root, parentRunId, parentArtifactId }) {
  const parent = await loadRun({ root, runId: parentRunId });
  const artifact = parent.manifest.artifacts?.find((item) => item.artifact_id === parentArtifactId);
  if (!artifact) throw new Error('Parent artifact not found');
  if (!within(parent.runDir, artifact.path)) throw new Error('Parent artifact path is outside the parent Run');

  const loadedAnnotation = await loadArtifactAnnotation({ root, runId: parentRunId, artifactId: parentArtifactId });
  const annotation = loadedAnnotation.annotation;
  const annotationState = loadedAnnotation.state;
  if (!annotation || !annotationState) throw new Error('A saved artifact annotation is required');
  if (!Array.isArray(annotationState.annotations) || !annotationState.annotations.length || Number(annotation.annotation_count || 0) < 1) {
    throw new Error('A non-empty saved artifact annotation is required');
  }
  if (
    annotation.artifact_id !== parentArtifactId
    || annotationState.artifact_id !== parentArtifactId
    || annotation.annotation_session_id !== annotationState.annotation_session_id
    || Number(annotation.annotation_count) !== annotationState.annotations.length
  ) {
    throw new Error('Artifact annotation lineage metadata mismatch');
  }
  if (annotation.original_artifact_sha256 !== artifact.sha256 || annotationState.original_artifact_sha256 !== artifact.sha256) {
    throw new Error('Saved annotation does not match the parent artifact');
  }
  const parentChatUrl = normalizeChatGptConversationUrl(parent.manifest.capture_context?.chat_url);
  if (!parentChatUrl) throw new Error('The parent Run does not have a valid original ChatGPT conversation');

  const [originalBytes, stateBytes, previewBytes] = await Promise.all([
    readFile(artifact.path),
    readFile(annotation.state_path),
    readFile(annotation.preview_path),
  ]);
  if (hash(originalBytes) !== artifact.sha256) throw new Error('Parent artifact hash mismatch');
  if (hash(stateBytes) !== annotation.state_sha256) throw new Error('Annotation state hash mismatch');
  if (hash(previewBytes) !== annotation.preview_sha256) throw new Error('Annotated preview hash mismatch');

  const prompt = buildArtifactRevisionPrompt({ annotationState });
  const now = new Date().toISOString();
  const runId = `run-${now.replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`;
  const runsRoot = join(resolve(root), 'data', 'runs');
  const runDir = join(runsRoot, runId);
  const stagingDir = join(runsRoot, `.preparing-${runId}-${randomUUID().slice(0, 8)}`);
  if (!within(runsRoot, runDir) || !within(runsRoot, stagingDir)) throw new Error('Revision Run path is unsafe');

  const finalInputDir = join(runDir, 'inputs', 'revision');
  const stagingInputDir = join(stagingDir, 'inputs', 'revision');
  const originalExtension = extname(String(artifact.path || '')).toLowerCase() || '.png';
  const originalPath = join(finalInputDir, `original${originalExtension}`);
  const annotationStatePath = join(finalInputDir, 'annotation-state.json');
  const annotatedPreviewPath = join(finalInputDir, 'annotated-preview.png');
  const promptPath = join(stagingDir, 'prompt.txt');
  const manifestPath = join(stagingDir, 'manifest.json');
  const eventsPath = join(stagingDir, 'events.jsonl');
  const promptSha256 = hash(Buffer.from(prompt, 'utf8'));
  const customerScope = inheritedCustomerScope(parent);

  const revisionSource = {
    parent_run_id: parentRunId,
    parent_artifact_id: parentArtifactId,
    parent_artifact_sha256: artifact.sha256,
    parent_chat_url: parentChatUrl,
    annotation_session_id: annotation.annotation_session_id,
    annotation_count: annotationState.annotations.length,
    reason_codes: [...new Set(annotationState.annotations.map((item) => item.reason_code))],
    overall_note: String(annotationState.overall_note || ''),
    annotations: structuredClone(annotationState.annotations),
    original_path: originalPath,
    original_sha256: artifact.sha256,
    annotation_state_path: annotationStatePath,
    annotation_state_sha256: annotation.state_sha256,
    annotated_preview_path: annotatedPreviewPath,
    annotated_preview_sha256: annotation.preview_sha256,
  };

  const manifest = {
    schema_version: ARTIFACT_REVISION_SCHEMA,
    run_id: runId,
    run_kind: 'artifact_revision',
    status: 'prepared',
    review_status: 'not_reviewed',
    created_at: now,
    updated_at: now,
    parent_run_id: parentRunId,
    parent_artifact_id: parentArtifactId,
    customer_name: customerScope.customer_name,
    customer_context: structuredClone(parent.manifest.customer_context || {}),
    customer_scope: customerScope,
    source_reference_lineage: referenceLineage(parent),
    revision_source: revisionSource,
    revision_request: {
      schema_version: 'ai-img-gen.artifact-revision-request.v1',
      requested_count: 1,
      auto_retry: false,
      input_roles: ['clean_original', 'annotated_location_guidance'],
      annotation_session_id: annotation.annotation_session_id,
    },
    prompt_sha256: promptSha256,
    reference_preflight: {
      policy_version: 'artifact-revision-preflight-v1',
      state: 'passed',
      blocking_issues: [],
      warnings: [],
    },
    identity_references: [],
    template_references: [],
    artifacts: [],
    invalidated_artifacts: [],
    restored_artifacts: [],
    artifact_reviews: {},
    artifact_annotations: {},
    artifact_style_suggestions: {},
    aesthetic_comparisons: [],
    review_suggestions: {},
    human_corrections: [],
    template_outcome_bridge: {},
    preference: null,
    results: [],
    capture: { state: 'not_started', real_provider_verified: false },
    submission_attempt_count: 0,
    executor: { name: 'playwright-mcp-extension', agent_required: false },
    revision_learning_state: 'record_only',
  };
  const events = [
    {
      schema_version: 'ai-img-gen.run-event.v1',
      event_id: randomUUID(),
      run_id: runId,
      type: 'RunPrepared',
      recorded_at: now,
      data: { prompt_sha256: promptSha256, identity_count: 0, template_count: 0, run_kind: 'artifact_revision' },
    },
    {
      schema_version: 'ai-img-gen.run-event.v1',
      event_id: randomUUID(),
      run_id: runId,
      type: 'ArtifactRevisionPrepared',
      recorded_at: now,
      data: {
        parent_run_id: parentRunId,
        parent_artifact_id: parentArtifactId,
        parent_artifact_sha256: artifact.sha256,
        annotation_session_id: annotation.annotation_session_id,
        annotation_state_sha256: annotation.state_sha256,
        annotated_preview_sha256: annotation.preview_sha256,
        parent_chat_url: parentChatUrl,
        requested_count: 1,
        auto_retry: false,
      },
    },
  ];

  await mkdir(runsRoot, { recursive: true });
  try {
    await mkdir(stagingInputDir, { recursive: true });
    await Promise.all([
      writeFile(join(stagingInputDir, `original${originalExtension}`), originalBytes),
      writeFile(join(stagingInputDir, 'annotation-state.json'), stateBytes),
      writeFile(join(stagingInputDir, 'annotated-preview.png'), previewBytes),
      writeFile(promptPath, `${prompt}\n`, 'utf8'),
      writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
      writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8'),
    ]);
    await rename(stagingDir, runDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }

  return loadRun({ root, runId });
}
