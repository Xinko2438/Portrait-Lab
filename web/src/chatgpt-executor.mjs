import { assertTemplateSelectionLinked } from './catalog-run-integration.mjs';
import { buildSubmissionSnapshot } from './generation-details.mjs';
import { classifyProviderFailure } from './playwright-bridge.mjs';
import { assertReferenceReady } from './reference-policy.mjs';
import { countNetworkRequests, extractCurrentChatPageTab, extractCurrentChatTab, extractProviderAssetIds } from './result-capture.mjs';
import { isArtifactRevisionRun, normalizeChatGptConversationUrl } from './artifact-revision-store.mjs';

const composerTarget = '#prompt-textarea';
const angleLabels = {
  frontal: '正脸',
  left_45: '左 45 度',
  right_45: '右 45 度',
  full_profile: '完整侧脸',
  other: '其他明确角度',
};
const framingLabels = {
  close_up: '近景',
  headshot: '头像近景',
  half_body: '半身',
  three_quarter: '七分身',
  full_body: '全身',
  mixed: '混合景别',
  other: '其他景别',
};

function labelAngle(value) {
  return angleLabels[value] || value || '未标记';
}

function labelFraming(value) {
  return framingLabels[value] || value || '未标记';
}

function snapshotRef(line = '') {
  return String(line).match(/\[ref=(e\d+)\]/)?.[1] || null;
}

export function findActiveAddFilesRef(snapshot = '') {
  const labels = ['添加文件等', 'Add files'];
  const line = String(snapshot).split(/\r?\n/).find((value) => (
    value.includes('[active]')
    && labels.some((label) => value.includes(label))
  ));
  return snapshotRef(line);
}

export function findComputerUploadAction(snapshot = '') {
  const lines = String(snapshot).split(/\r?\n/);
  const labels = ['从电脑上传', '添加照片和文件', 'Upload from computer', 'Add photos and files', 'Add photos & files'];
  const labelIndex = lines.findIndex((line) => labels.some((label) => line.includes(label)));
  if (labelIndex < 0) return null;
  for (let index = labelIndex; index >= Math.max(0, labelIndex - 6); index -= 1) {
    if (!lines[index].includes('cursor=pointer')) continue;
    const ref = snapshotRef(lines[index]);
    if (ref) return { ref, active: lines.slice(index, labelIndex + 1).some((line) => line.includes('[active]')) };
  }
  return null;
}

export function findComputerUploadRef(snapshot = '') {
  return findComputerUploadAction(snapshot)?.ref || null;
}

export function findVisibleSendRef(snapshot = '') {
  const labels = ['发送提示', '发送消息', 'Send prompt', 'Send message'];
  const line = String(snapshot).split(/\r?\n/).find((value) => (
    value.includes('button')
    && value.includes('[ref=')
    && !value.includes('[disabled]')
    && labels.some((label) => value.includes(label))
  ));
  return snapshotRef(line);
}

export function findActiveComposerRef(snapshot = '') {
  const labels = ['与 ChatGPT 聊天', 'Message ChatGPT'];
  const line = String(snapshot).split(/\r?\n/).find((value) => (
    value.includes('textbox')
    && value.includes('[active]')
    && value.includes('[ref=')
    && labels.some((label) => value.includes(label))
  ));
  return snapshotRef(line);
}

function isMissingFileChooserModalError(error) {
  return /browser_file_upload[\s\S]*related modal state present|No file chooser visible/i
    .test(String(error?.message || error));
}

export function fileDropOverlayVisible(snapshot = '') {
  return /添加任意内容|将任意文件拖放到此处|拖放到此处|Add any content|Drop (?:any )?(?:files?|content) here/i
    .test(String(snapshot || ''));
}

function normalizedSnapshotText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function submittedPromptVisible(snapshot = '', prompt = '') {
  const normalizedPrompt = normalizedSnapshotText(prompt);
  if (!normalizedPrompt) return false;
  const evidence = normalizedPrompt.slice(0, Math.min(64, normalizedPrompt.length));
  return normalizedSnapshotText(snapshot).includes(evidence);
}

async function waitForFileDropOverlayToClear(client, { initialSnapshot = null, maxChecks = 4 } = {}) {
  if (initialSnapshot && !fileDropOverlayVisible(initialSnapshot)) return;
  await client.callTool('browser_press_key', { key: 'Escape' });
  for (let attempt = 0; attempt < maxChecks; attempt += 1) {
    await client.callTool('browser_wait_for', { time: 1 });
    const snapshot = await client.callTool('browser_snapshot', {});
    if (!fileDropOverlayVisible(snapshot.text)) return;
    await client.callTool('browser_press_key', { key: 'Escape' });
  }
  throw new Error('ChatGPT file-drop overlay remained open after dismissal attempts; nothing was typed or sent');
}

export function buildGenerationPrompt(run) {
  if (
    (['ai-img-gen.web-run.v6', 'ai-img-gen.web-run.v7'].includes(run?.manifest?.schema_version) || run?.manifest?.task_resolution?.policy_version==='image-first-task-v1')
    && String(run.manifest.prompt_compilation?.compiled_prompt || '').trim()
  ) {
    return String(run.manifest.prompt_compilation.compiled_prompt).trim();
  }
  const identityCount = run.manifest.identity_references.length;
  const templateCount = run.manifest.template_references.length;
  const identityRange = identityCount === 1 ? '第 1 张' : `第 1-${identityCount} 张`;
  const templateStart = identityCount + 1;
  const templateEnd = identityCount + templateCount;
  const templateRange = templateCount === 0 ? '本次没有风格模板图' : (templateCount === 1 ? `第 ${templateStart} 张` : `第 ${templateStart}-${templateEnd} 张`);
  const referencePlan = run.manifest.reference_plan || {};
  const customerContext = run.manifest.customer_context || {};
  const guidance = run.manifest.learning_guidance_snapshot?.active_guidance || [];
  const recordedTemplateMetadata = [
    referencePlan.template_angle ? `模板主角角度为${labelAngle(referencePlan.template_angle)}` : '',
    referencePlan.template_framing ? `模板景别为${labelFraming(referencePlan.template_framing)}` : '',
  ].filter(Boolean);
  const compositionConstraint = recordedTemplateMetadata.length
    ? `历史模板元数据记录：${recordedTemplateMetadata.join('，')}；仅作为风险提示，最终以本次目标设置和模板图片为准。`
    : '模板的构图、姿势和景别直接以模板图片为准，无需重复文字标注。';

  const sections = [
    '请生成一张高质量、自然、可供客户真实使用的人像写真。',
    `身份参考：${identityRange}图片是同一位客户的身份参考，用于综合确认五官、脸型和人物身份。`,
    templateCount ? `风格参考：${templateRange}图片只用于构图、姿势、服装、场景、光影和视觉风格。不得继承这些模板人物的身份或面部特征。` : '',
    `角度与构图约束：本次出图角度为${labelAngle(referencePlan.target_angle)}，目标景别为${labelFraming(referencePlan.target_framing)}。${compositionConstraint}`,
    `客户语境：客户领域为“${customerContext.business_domain || '未提供'}”，实际用途为“${customerContext.intended_use || '未提供'}”。场景、道具、服装和可见文字必须与此语境一致。`,
    '硬性底线：最终人物必须与身份参考保持高度一致；人脸不一致的结果不可接受。画面不得突兀、僵硬或不自然。',
    `本次要求：${run.prompt}`,
  ].filter(Boolean);

  if (guidance.length) {
    sections.push(`历史评审中重复出现的问题，本次需要特别避免：\n${guidance.map((item, index) => `${index + 1}. ${item.prompt_guidance}`).join('\n')}`);
  }
  return sections.join('\n\n');
}

function durableSubmissionEvidence(run) {
  const manifest = run?.manifest || {};
  const status = String(manifest.status || '');
  const hasAttemptCount = Object.prototype.hasOwnProperty.call(manifest, 'submission_attempt_count');
  const submissionAttempts = hasAttemptCount ? manifest.submission_attempt_count : 0;
  if (hasAttemptCount && (typeof submissionAttempts !== 'number'
    || !Number.isSafeInteger(submissionAttempts)
    || submissionAttempts < 0)) {
    throw new Error('Run submission attempt evidence is invalid');
  }
  return { status, submissionAttempts };
}

function assertRunReadyForStaging(run) {
  if (run?.manifest?.image_api) throw new Error('API image Runs must use the API channel, not browser staging');
  const { status, submissionAttempts } = durableSubmissionEvidence(run);
  if (submissionAttempts > 0 || ['submitted', 'submission_uncertain'].includes(status)) {
    throw new Error(status === 'submitted'
      ? 'Run was already submitted and cannot be staged again'
      : 'Run already has a submission attempt and cannot be staged again');
  }
  if (!['prepared', 'staged', 'provider_error', 'provider_rate_limited'].includes(status)) {
    throw new Error(`Run status cannot be staged: ${status || 'missing'}`);
  }
  if (!isArtifactRevisionRun(run)) {
    assertTemplateSelectionLinked(run);
    assertReferenceReady(run.manifest);
    return;
  }
  const source = run.manifest.revision_source || {};
  const conversationUrl = normalizeChatGptConversationUrl(source.parent_chat_url);
  if (!conversationUrl) throw new Error('Artifact revision is missing a valid original ChatGPT conversation');
  if (!source.original_path || !source.annotated_preview_path) throw new Error('Artifact revision source files are incomplete');
  if (source.parent_run_id !== run.manifest.parent_run_id || source.parent_artifact_id !== run.manifest.parent_artifact_id) {
    throw new Error('Artifact revision lineage is inconsistent');
  }
}

function promptForRun(run) {
  return isArtifactRevisionRun(run) ? String(run.prompt || '').trim() : buildGenerationPrompt(run);
}

function stagingTargetForRun(run) {
  return isArtifactRevisionRun(run)
    ? normalizeChatGptConversationUrl(run.manifest.revision_source?.parent_chat_url)
    : 'https://chatgpt.com/';
}

function uploadPathsForRun(run) {
  if (isArtifactRevisionRun(run)) {
    return [
      run.manifest.revision_source.original_path,
      run.manifest.revision_source.annotated_preview_path,
    ];
  }
  return [
    ...run.manifest.identity_references.map((item) => item.path),
    ...run.manifest.template_references.map((item) => item.path),
  ];
}

export class ChatGptExecutor {
  constructor({ clientFactory }) {
    this.clientFactory = clientFactory;
    this.sessions = new Map();
    this.activeRunId = null;
  }

  async stageRun({ run, confirmed }) {
    if (confirmed !== true) throw new Error('Upload confirmation is required');
    assertRunReadyForStaging(run);
    if (this.activeRunId && this.activeRunId !== run.runId) {
      throw new Error(`Another run is active: ${this.activeRunId}`);
    }
    const existing = this.sessions.get(run.runId);
    if (existing?.staged) return { state: 'awaiting_submission_confirmation', alreadyStaged: true };

    const client = this.clientFactory();
    const session = { client, staged: false, submissionAttempted: false, state: 'staging' };
    this.sessions.set(run.runId, session);
    this.activeRunId = run.runId;

    try {
      await client.initialize();
      const stagingTarget = stagingTargetForRun(run);
      await client.callTool('browser_tabs', { action: 'new', url: stagingTarget });
      await client.callTool('browser_wait_for', { time: 2 });
      const stagedTabs = await client.callTool('browser_tabs', { action: 'list' });
      if (isArtifactRevisionRun(run)) {
        const currentConversation = extractCurrentChatTab(stagedTabs.text);
        if (!currentConversation || currentConversation.url !== stagingTarget) {
          throw new Error('The exact original ChatGPT conversation did not open; nothing was uploaded or sent');
        }
        session.browserTabIndex = currentConversation.index;
        session.expectedConversationUrl = stagingTarget;
      } else {
        session.browserTabIndex = extractCurrentChatPageTab(stagedTabs.text)?.index ?? null;
      }
      const paths = uploadPathsForRun(run);
      await client.callTool('browser_press_key', { key: 'Escape' });
      let uploadFromComputerAction = null;
      for (let attempt = 0; attempt < 2 && !uploadFromComputerAction; attempt += 1) {
        await client.callTool('browser_type', {
          element: 'ChatGPT message composer',
          target: composerTarget,
          text: '',
          submit: false,
        });
        await client.callTool('browser_press_key', { key: 'Shift+Tab' });
        const addFilesSnapshot = await client.callTool('browser_snapshot', {});
        const addFilesRef = findActiveAddFilesRef(addFilesSnapshot.text);
        if (!addFilesRef) throw new Error('ChatGPT add-files focus check failed; nothing was uploaded or sent');
        await client.callTool('browser_press_key', { key: 'Enter' });
        const uploadMenuSnapshot = await client.callTool('browser_snapshot', {});
        uploadFromComputerAction = findComputerUploadAction(uploadMenuSnapshot.text);
        if (!uploadFromComputerAction && attempt === 0 && /(?:^|\n)\s*- dialog\b/.test(uploadMenuSnapshot.text)) {
          await client.callTool('browser_press_key', { key: 'Escape' });
        }
      }
      if (!uploadFromComputerAction) throw new Error('ChatGPT upload-from-computer option was not found; nothing was uploaded or sent');
      await client.callTool('browser_press_key', { key: 'Enter' });
      try {
        await client.callTool('browser_file_upload', { paths });
      } catch (error) {
        if (!isMissingFileChooserModalError(error)) throw error;
        await client.callTool('browser_drop', {
          element: 'ChatGPT message composer',
          target: composerTarget,
          paths,
        });
        await waitForFileDropOverlayToClear(client);
      }
      session.requestSnapshot=buildSubmissionSnapshot(run,{prompt:promptForRun(run)});
      await client.callTool('browser_type', {
        element: 'ChatGPT message composer',
        target: composerTarget,
        text: session.requestSnapshot.prompt,
        submit: false,
      });
      let evidenceWarning = null;
      try {
        await client.callTool('browser_take_screenshot', {
          filename: `${run.runId}-before-submit.png`,
          fullPage: false,
          scale: 'css',
        });
      } catch (error) {
        evidenceWarning = `Pre-submit screenshot unavailable: ${String(error?.message || error)}`;
      }
      session.staged = true;
      session.state = 'awaiting_submission_confirmation';
      return { state: session.state, alreadyStaged: false, ...(evidenceWarning ? { evidenceWarning } : {}) };
    } catch (error) {
      this.sessions.delete(run.runId);
      this.activeRunId = null;
      if (/Reference preflight failed/i.test(String(error?.message || error))) throw error;
      return classifyProviderFailure(String(error?.message || error));
    }
  }

  async submitRun({ run, confirmed }) {
    if (run?.manifest?.image_api) throw new Error('API image Runs cannot be submitted through the browser');
    if (confirmed !== true) throw new Error('Submission confirmation is required');
    const { status: durableStatus, submissionAttempts: durableAttempts } = durableSubmissionEvidence(run);
    if (durableAttempts > 0 || ['submitted', 'submission_uncertain'].includes(durableStatus)) {
      return {
        state: durableStatus === 'submitted' ? 'already_submitted' : 'already_attempted',
        previousState: durableStatus || 'submission_attempt_recorded',
        retryAutomatically: false,
      };
    }
    if (!isArtifactRevisionRun(run)) assertTemplateSelectionLinked(run);
    const session = this.sessions.get(run.runId);
    if (!session?.staged) throw new Error('Run must be staged before submission');
    if (session.submissionAttempted) {
      return { state: session.state === 'submitted' ? 'already_submitted' : 'already_attempted', previousState: session.state };
    }
    if(session.requestSnapshot?.prompt!==promptForRun(run))throw new Error('Prompt changed after staging; 请重新装载原任务后再发送');
    const expected=buildSubmissionSnapshot(run,{prompt:promptForRun(run)});
    if((session.requestSnapshot.preparation_revision_id||null)!==(expected.preparation_revision_id||null)||JSON.stringify(session.requestSnapshot.references)!==JSON.stringify(expected.references))throw new Error('References or preparation changed after staging; 请重新装载原任务后再发送');

    session.submissionAttempted = true;
    session.state = 'submitting';
    try {
      const prompt = session.requestSnapshot.prompt;
      const preSubmitSnapshot = await session.client.callTool('browser_snapshot', {});
      if (fileDropOverlayVisible(preSubmitSnapshot.text)) {
        await waitForFileDropOverlayToClear(session.client, { initialSnapshot: preSubmitSnapshot.text });
      }
      const sendRef = findVisibleSendRef(preSubmitSnapshot.text);
      if (!sendRef) throw new Error('Visible ChatGPT send button was not found; nothing was sent');
      const activeComposerRef = findActiveComposerRef(preSubmitSnapshot.text);
      if (!activeComposerRef) throw new Error('ChatGPT message composer was not active; nothing was sent');
      if (isArtifactRevisionRun(run)) {
        const listed = await session.client.callTool('browser_tabs', { action: 'list' });
        const currentConversation = extractCurrentChatTab(listed.text);
        if (!currentConversation || currentConversation.url !== session.expectedConversationUrl) {
          throw new Error('The active tab is no longer the exact original ChatGPT conversation; nothing was sent');
        }
      }
      const requestsBeforeSubmit = await session.client.callTool('browser_network_requests', { static: true });
      const networkRequestBaseline = countNetworkRequests(requestsBeforeSubmit.text);
      let referenceAssetIds = extractProviderAssetIds(requestsBeforeSubmit.text);
      await session.client.callTool('browser_press_key', { key: 'Enter' });
      let chatTab = null;
      let submissionVerified = false;
      for (let attempt = 0; attempt < 20 && !submissionVerified; attempt += 1) {
        const tabs = await session.client.callTool('browser_tabs', { action: 'list' });
        chatTab = extractCurrentChatTab(tabs.text);
        const exactConversation = !isArtifactRevisionRun(run) || chatTab?.url === session.expectedConversationUrl;
        if (chatTab && exactConversation) {
          const snapshot = await session.client.callTool('browser_snapshot', {});
          submissionVerified = submittedPromptVisible(snapshot.text, prompt);
        }
        if (!submissionVerified && attempt < 19) await session.client.callTool('browser_wait_for', { time: 1 });
      }
      if (submissionVerified) {
        const requestsAfterSubmit = await session.client.callTool('browser_network_requests', { static: true });
        referenceAssetIds = [...new Set([
          ...referenceAssetIds,
          ...extractProviderAssetIds(requestsAfterSubmit.text),
        ])].sort();
      }
      session.captureContext = {
        chat_url: isArtifactRevisionRun(run) ? session.expectedConversationUrl : (chatTab?.url || null),
        browser_tab_index: chatTab?.index ?? session.browserTabIndex,
        network_request_count: networkRequestBaseline,
        reference_asset_ids: referenceAssetIds,
        recorded_at: new Date().toISOString(),
      };
      if (!submissionVerified) {
        session.state = 'submission_uncertain';
        return {
          state: session.state,
          submissionAttempt: 1,
          retryAutomatically: false,
          playwrightHealthy: true,
          captureContext: session.captureContext,
          message: '已点击发送，但尚未在对话中确认完整提示词。系统不会重复发送，可稍后直接检测结果。',
        };
      }
      session.state = 'submitted';
      return { state: 'submitted', submissionAttempt: 1, captureContext: session.captureContext };
    } catch (error) {
      const failure = classifyProviderFailure(String(error?.message || error));
      session.state = failure.state;
      return { ...failure, submissionAttempt: 1 };
    }
  }

  clientForRun(runId) {
    return this.sessions.get(runId)?.client || null;
  }

  hasStagedSession(runId) {
    return this.sessions.get(runId)?.staged === true;
  }
  stagedRequestSnapshot(runId) { return this.sessions.get(runId)?.staged ? this.sessions.get(runId).requestSnapshot : null; }

  clientForCapture(runId) {
    return this.sessions.get(runId)?.client || this.clientFactory();
  }

  releaseRun(runId) {
    this.sessions.delete(runId);
    if (this.activeRunId === runId) this.activeRunId = null;
  }
}
