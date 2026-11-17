import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectImage } from './image-metadata.mjs';
import { importArtifacts, loadRun, recordRunEvent } from './run-store.mjs';
import { redactSecrets } from './mcp-client.mjs';

function requestLines(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function requestRecord(line) {
  const match = line.match(/^(\d+)\.\s+\[[A-Z]+\]\s+(\S+)/i)
    || line.match(/^\[(\d+)\]\s+\w+\s+(\S+)/);
  if (!match) return null;
  return { index: Number(match[1]), url: match[2] };
}

function providerAssetId(value) {
  try {
    const url = new URL(String(value || ''));
    if (!/\/backend-api\/estuary\/content$/i.test(url.pathname)) return null;
    return url.searchParams.get('id') || null;
  } catch {
    return null;
  }
}

export function extractProviderAssetIds(text) {
  return [...new Set(requestLines(text)
    .map(requestRecord)
    .filter(Boolean)
    .map((request) => providerAssetId(request.url))
    .filter(Boolean))].sort();
}

function validConversationUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.hostname === 'chatgpt.com'
      && /^\/c\/[a-zA-Z0-9-]{16,}$/.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function parseBrowserTabs(text) {
  return String(text || '').split(/\r?\n/).map((line) => {
    const row = line.match(/^\s*-\s+(\d+):\s+(.+)$/);
    if (!row) return null;
    const body = row[2];
    const markdownUrl = body.match(/\]\(((?:https?:\/\/|chrome-extension:\/\/|about:)[^)]+)\)(?:\s+\[crashed\])?\s*$/)?.[1];
    const plainUrl = [...body.matchAll(/(?:https?:\/\/|chrome-extension:\/\/|about:)[^\s)]+/g)].at(-1)?.[0];
    const url = markdownUrl || plainUrl || '';
    return {
      index: Number(row[1]),
      current: /\(current\)/.test(body),
      url,
      conversationUrl: validConversationUrl(url),
    };
  }).filter(Boolean);
}

export function isWorkbenchConnectionTab(tab){
  try{
    const url=new URL(tab.url);
    const owner=JSON.parse(url.searchParams.get('client')||'{}').name||'';
    return url.protocol==='chrome-extension:'&&url.hostname==='mmlmfjhmonkocbjadbfplnigmagldckm'&&url.pathname==='/connect.html'&&/^ai-img-gen(?:-|$)/.test(owner);
  }catch{return false;}
}

export async function closeConnectionWelcomeTabs(client,tabs,expectedUrl){
  const attached=tabs.find(tab=>tab.current&&tab.url===expectedUrl&&/^https:\/\/chatgpt\.com\//.test(tab.url));
  if(!attached)return 0;
  const helpers=tabs.filter(tab=>tab.index!==attached.index&&isWorkbenchConnectionTab(tab)).sort((a,b)=>b.index-a.index);
  let closed=0;
  for(const tab of helpers){
    try{await client.callTool('browser_tabs',{action:'close',index:tab.index});closed++;}
    catch{/* Helper hygiene must not discard an attached generation task. */}
  }
  return closed;
}

export function extractCurrentChatTab(text) {
  const tab = parseBrowserTabs(text).find((item) => item.current && item.conversationUrl);
  return tab ? { index: tab.index, url: tab.conversationUrl } : null;
}

export function extractCurrentChatPageTab(text) {
  const tab = parseBrowserTabs(text).find((item) => {
    if (!item.current) return false;
    try { return new URL(item.url).hostname === 'chatgpt.com'; } catch { return false; }
  });
  return tab ? { index: tab.index, url: tab.url } : null;
}

async function currentNetworkRequestMax(client) {
  const listed = await client.callTool('browser_network_requests', { static: true });
  return countNetworkRequests(listed.text);
}

async function openRecoveryTab(client, context, expectedUrl, reuseCurrent = false) {
  if(reuseCurrent)await client.callTool('browser_navigate',{url:expectedUrl});
  else await client.callTool('browser_tabs', { action: 'new', url: expectedUrl });
  await client.callTool('browser_wait_for', { time: 2 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const listed = await client.callTool('browser_tabs', { action: 'list' });
    const tabs=parseBrowserTabs(listed.text);
    let target = tabs.find((tab) => tab.current && tab.conversationUrl === expectedUrl);
    if (target) {
      if(await closeConnectionWelcomeTabs(client,tabs,expectedUrl)){
        const refreshed=await client.callTool('browser_tabs',{action:'list'});
        target=parseBrowserTabs(refreshed.text).find(tab=>tab.current&&tab.conversationUrl===expectedUrl);
        if(!target)break;
      }
      return {
        state: 'ready',
        reopened: true,
        captureContext: {
          chat_url: expectedUrl,
          browser_tab_index: target.index,
          network_request_count: 0,
          recorded_at: context.recorded_at || new Date().toISOString(),
          recovery_mode: 'reopened_conversation',
          recovered_at: new Date().toISOString(),
          reference_asset_ids: Array.isArray(context.reference_asset_ids) ? context.reference_asset_ids : [],
          ...(context.response_refresh_attempted?{response_refresh_attempted:true}:{}),
        },
      };
    }
    if (attempt === 0) await client.callTool('browser_wait_for', { time: 2 });
  }
  return {
    state: 'capture_reopen_failed',
    message: '无法重新打开本次提交的 ChatGPT 对话；它可能已被删除、当前未登录或无权访问。',
  };
}

async function selectCaptureTab(client, context, {allowTabRecovery=false}={}) {
  const expectedUrl = validConversationUrl(context.chat_url);
  if (!expectedUrl) {
    return { state: 'capture_context_mismatch', message: '未找到本次提交对应的 ChatGPT 对话标识。' };
  }
  let listed = await client.callTool('browser_tabs', { action: 'list' });
  let tabs = parseBrowserTabs(listed.text);
  let target = Number.isInteger(context.browser_tab_index)
    ? tabs.find((tab) => tab.index === context.browser_tab_index && tab.conversationUrl === expectedUrl)
    : null;
  if (!target) target = tabs.find((tab) => tab.conversationUrl === expectedUrl);
  if((!target||!target.current)&&!allowTabRecovery){
    return {state:'capture_tab_unavailable',message:'原任务对话暂未连接。请打开原 ChatGPT 对话后再检测；系统不会新开标签或强制切页。'};
  }
  if (!target) return openRecoveryTab(client, context, expectedUrl,tabs.some(tab=>tab.current&&isWorkbenchConnectionTab(tab)));
  if (!target.current) {
    await client.callTool('browser_tabs', { action: 'select', index: target.index });
    listed = await client.callTool('browser_tabs', { action: 'list' });
    tabs = parseBrowserTabs(listed.text);
    target = tabs.find((tab) => tab.index === target.index && tab.current);
  }
  if (!target?.conversationUrl || target.conversationUrl !== expectedUrl) {
    return openRecoveryTab(client, context, expectedUrl);
  }
  if(await closeConnectionWelcomeTabs(client,tabs,expectedUrl)){
    listed=await client.callTool('browser_tabs',{action:'list'});tabs=parseBrowserTabs(listed.text);
    target=tabs.find(tab=>tab.current&&tab.conversationUrl===expectedUrl);
    if(!target)return {state:'capture_context_mismatch',message:'原任务页面连接已变化，请稍后重新检测。'};
  }
  const recordedBaseline = Number(context.network_request_count || 0);
  const currentMaximum = await currentNetworkRequestMax(client);
  if (recordedBaseline > currentMaximum) return openRecoveryTab(client, context, expectedUrl, true);
  return {
    state: 'ready',
    reopened: false,
    captureContext: {
      chat_url: target.conversationUrl,
      browser_tab_index: target.index,
      network_request_count: recordedBaseline,
      recorded_at: context.recorded_at || new Date().toISOString(),
      recovery_mode: 'existing_tab',
      reference_asset_ids: Array.isArray(context.reference_asset_ids) ? context.reference_asset_ids : [],
      ...(context.response_refresh_attempted?{response_refresh_attempted:true}:{}),
    },
  };
}

function generatedImageVisible(snapshotText) {
  return /img\s+"(?:已生成图片|已生成图像|Generated image)/i.test(String(snapshotText || ''));
}

function conversationAccessUnavailable(snapshotText) {
  const text = String(snapshotText || '');
  return /textbox\s+"(?:与 ChatGPT 聊天|Message ChatGPT|询问 ChatGPT)"\s+\[disabled\]/i.test(text)
    && /button\s+"(?:分享|Share)[^"]*"\s+\[disabled\]/i.test(text);
}

export function generatedImageButtonRefs(snapshotText) {
  const lines = String(snapshotText || '').split(/\r?\n/);
  const refs = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/img\s+"(?:已生成图片|已生成图像|Generated image)/i.test(lines[index])) continue;
    for (let parent = index - 1; parent >= Math.max(0, index - 4); parent -= 1) {
      if (!/\bbutton\b/.test(lines[parent])) continue;
      const ref = lines[parent].match(/\[ref=([a-zA-Z0-9_:-]+)\]/)?.[1];
      if (ref && !refs.includes(ref)) refs.push(ref);
      break;
    }
  }
  return refs;
}

function generatedImageCarousel(snapshotText) {
  const lines=String(snapshotText||'').split(/\r?\n/);
  const group=lines.findLastIndex(line=>/\bgroup\s+"(?:生成的图像|Generated images)"/.test(line));
  if(group<0)return [];
  const indent=lines[group].match(/^\s*/)[0].length;
  const choices=[];
  for(const line of lines.slice(group+1)){
    if(line.trim()&&line.match(/^\s*/)[0].length<=indent)break;
    const ordinal=line.match(/\bbutton\s+"(?:显示生成的图像|Show generated image)\s+(\d+)"/i)?.[1];
    const ref=line.match(/\[ref=([a-zA-Z0-9_:-]+)\]/)?.[1];
    if(ordinal&&ref&&!line.includes('[disabled]'))choices.push({ordinal:Number(ordinal),ref,selected:line.includes('[pressed]')});
  }
  return choices;
}

export function generatedImageCarouselRefs(snapshotText) {
  return generatedImageCarousel(snapshotText).map(choice=>choice.ref);
}

async function generatedRequests(client, baseline) {
  const listed = await client.callTool('browser_network_requests', {
    static: true,
    filter: 'backend-api/estuary/content|generated|image',
  });
  const requests = requestLines(listed.text)
    .map(requestRecord)
    .filter(Boolean)
    .filter((request) => request.index > baseline && /backend-api\/estuary\/content|image|generated/i.test(request.url));
  return [...new Map(requests.map((request) => [request.url, request])).values()];
}

async function referenceImageProfiles(references = []) {
  const profiles = [];
  for (const reference of references) {
    if (!reference?.path) continue;
    try {
      const metadata = inspectImage(await readFile(reference.path));
      profiles.push({ width: metadata.width, height: metadata.height, mimeType: metadata.mimeType });
    } catch {
      // Exact hash filtering still applies when an older reference lacks a readable local file.
    }
  }
  return profiles;
}

function matchesReferenceRole(metadata, profiles) {
  return profiles.some((profile) => (
    profile.width === metadata.width
    && profile.height === metadata.height
  ));
}

function isSubstantialImage(metadata) {
  return metadata.width >= 256
    && metadata.height >= 256
    && metadata.bytes >= 50 * 1024;
}

export function excludedSourceHashes(run) {
  return new Set([
    ...(run?.manifest?.identity_references || []).map((item) => item.sha256),
    ...(run?.manifest?.template_references || []).map((item) => item.sha256),
    run?.manifest?.revision_source?.original_sha256,
    run?.manifest?.revision_source?.annotated_preview_sha256,
  ].filter(Boolean));
}

function hasMinimumGeneratedDimensions(metadata) {
  return metadata.width >= 256 && metadata.height >= 256;
}

export class ChatGptMcpResultCapture {
  constructor({ outputDir, maxArtifacts = 4, maxNetworkCandidates = 16, allowTabRecovery=false } = {}) {
    if (!outputDir) throw new Error('Capture output directory is required');
    this.outputDir = outputDir;
    this.maxArtifacts = maxArtifacts;
    this.maxNetworkCandidates = maxNetworkCandidates;
    this.allowTabRecovery = allowTabRecovery;
  }

  async capture({ client, run, galleryVisited=false }) {
    await mkdir(this.outputDir, { recursive: true });
    const context = run?.manifest?.capture_context || {};
    const selected = await selectCaptureTab(client, context, {allowTabRecovery:this.allowTabRecovery});
    if (selected.state !== 'ready') return { state: selected.state, message: selected.message, files: [] };
    const { captureContext } = selected;
    run.manifest.capture_context=captureContext;
    if(context.response_refresh_needed && !context.response_refresh_attempted && !selected.reopened){
      // Re-read only the verified original conversation, in the same task tab.
      // Browser navigation does not use MCP's foreground-select/new-tab path.
      await client.callTool('browser_navigate',{url:captureContext.chat_url});
      await client.callTool('browser_wait_for',{time:3});
      run.manifest.capture_context={...captureContext,network_request_count:0,response_refresh_attempted:true};
      return this.capture({client,run,galleryVisited});
    }
    let snapshot = await client.callTool('browser_snapshot', {});
    if (selected.reopened && !generatedImageVisible(snapshot.text)) {
      await client.callTool('browser_wait_for', { time: 3 });
      snapshot = await client.callTool('browser_snapshot', {});
    }
    if (selected.reopened && conversationAccessUnavailable(snapshot.text)) {
      return {
        state: 'capture_access_mismatch',
        message: '对话链接已经记录，但当前 ChatGPT 工作区或登录状态无法访问提交时的对话。请切回提交任务时使用的 ChatGPT 工作区后再检测。',
        files: [],
        captureContext,
      };
    }
    if (!generatedImageVisible(snapshot.text)) {
      return {
        state: 'capture_not_ready',
        message: selected.reopened
          ? '已重新打开原 ChatGPT 对话，但生成结果还在加载，请稍后再次检测。'
          : '当前对话暂未显示新的生成图；检测不会重新发送任务。',
        files: [],
        captureContext,
      };
    }
    const generatedRefs = generatedImageButtonRefs(snapshot.text).slice(0, this.maxArtifacts);
    const gallery=generatedImageCarousel(snapshot.text);
    if (!generatedRefs.length && !gallery.length) {
      return { state: 'capture_not_ready', message: 'Generated image control was not found in the submitted conversation', files: [], captureContext };
    }
    if(gallery.length>this.maxArtifacts)return {state:'capture_ambiguous',message:'生成图数量超出本次保存上限，请人工核对。',files:[],captureContext};
    const generatedControlCount=Math.max(generatedRefs.length,gallery.length);
    const baseline = captureContext.network_request_count;
    let uniqueRequests = await generatedRequests(client, baseline);
    const referenceAssetIds = new Set(Array.isArray(captureContext.reference_asset_ids) ? captureContext.reference_asset_ids : []);
    uniqueRequests = uniqueRequests.filter((request) => !referenceAssetIds.has(providerAssetId(request.url)));
    if (!uniqueRequests.length) {
      return {
        state: 'capture_not_ready',
        message: selected.reopened
          ? '已重新打开原 ChatGPT 对话，但暂时没有可保存的生成图响应，请稍后再次检测。'
          : 'No new generated image request was found',
        files: [],
        captureContext,
      };
    }
    if (uniqueRequests.length > this.maxNetworkCandidates) {
      return { state: 'capture_ambiguous', message: `Found ${uniqueRequests.length} image requests; manual import is required`, files: [], captureContext };
    }
    uniqueRequests.sort((left, right) => left.index - right.index);

    const candidates = [];
    const referenceHashes = excludedSourceHashes(run);
    const identityProfiles = await referenceImageProfiles(run.manifest.identity_references || []);
    const capturedHashes = new Set();
    let invalidExportCount = 0;
    let missingExportCount = 0;
    for (const request of uniqueRequests) {
      const filename = `capture-${run.runId}-${request.index}-${randomUUID()}.bin`;
      const outputPath = join(this.outputDir, filename);
      await client.callTool('browser_network_request', {
        index: request.index,
        part: 'response-body',
        filename: outputPath,
      });
      let bytes;
      try {
        bytes = await readFile(outputPath);
        const metadata = inspectImage(bytes);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (referenceHashes.has(sha256) || capturedHashes.has(sha256)) continue;
        capturedHashes.add(sha256);
        candidates.push({
          metadata,
          bytes,
          source: {
            request_index: request.index,
            provider_asset_url_sha256: createHash('sha256').update(request.url).digest('hex'),
          },
        });
      } catch (error) {
        if(error?.code==='ENOENT')missingExportCount+=1;
        else invalidExportCount += 1;
      }
    }
    if(missingExportCount && candidates.length<generatedControlCount){
      return {state:'capture_response_pending',message:'图片已显示，但浏览器尚未提供可验证的原图响应。系统会继续检测，也可手动导入；不会重新生成。',files:[],captureContext:{...captureContext,response_refresh_needed:true,...(selected.reopened?{response_refresh_attempted:true}:{})}};
    }
    if (!candidates.length && invalidExportCount) {
      return { state: 'capture_unverified', message: '浏览器返回的内容不是可验证的原图，暂未保存。请稍后检测或手动导入。', files: [], captureContext };
    }
    const substantialCandidates = candidates.filter((candidate) => isSubstantialImage(candidate.metadata));
    const nonReferenceSubstantial = substantialCandidates.filter((candidate) => (
      !matchesReferenceRole(candidate.metadata, identityProfiles)
    ));
    const selectedCandidates = substantialCandidates.length
      ? (nonReferenceSubstantial.length ? nonReferenceSubstantial : substantialCandidates)
      : candidates.filter((candidate) => (
        hasMinimumGeneratedDimensions(candidate.metadata)
        && !matchesReferenceRole(candidate.metadata, identityProfiles)
      ));
    const files = selectedCandidates.map((candidate, index) => ({
      name: `generated-${index + 1}${candidate.metadata.extension}`,
      bytes: candidate.bytes,
      source: candidate.source,
    }));
    // Export already observed original responses first. Virtualized, offscreen
    // gallery controls must not block saving originals that are already loaded.
    if(files.length<generatedControlCount && gallery.length && !galleryVisited){
      for(const item of gallery){
        const current=generatedImageCarousel(snapshot.text).find(choice=>choice.ordinal===item.ordinal);
        if(!current)return {state:'capture_not_ready',message:'生成图组已变化，请稍后重新检测；不会重新发送。',files:[],captureContext};
        if(!current.selected){
          await client.callTool('browser_click',{element:`Show generated image ${item.ordinal}`,target:current.ref});
          await client.callTool('browser_wait_for',{time:1});
          snapshot=await client.callTool('browser_snapshot',{});
          if(!generatedImageVisible(snapshot.text))return {state:'capture_not_ready',message:'生成图仍在加载，请稍后检测。',files:[],captureContext};
        }
      }
      return this.capture({client,run,galleryVisited:true});
    }
    if (!files.length) return { state: 'capture_not_ready', message: 'Only uploaded references or generated-control thumbnails were found; the full-size result is not ready', files: [], captureContext };
    if (files.length > generatedControlCount) {
      return { state: 'capture_ambiguous', message: `Found ${files.length} unassigned image responses for ${generatedControlCount} generated image controls; manual review is required`, files: [], captureContext };
    }
    if (files.length > this.maxArtifacts) {
      return { state: 'capture_ambiguous', message: `Found ${files.length} distinct generated images; manual import is required`, files: [], captureContext };
    }
    return { state: 'ready', files, captureContext };
  }
}

const pendingCaptures=new Map();
export async function captureRunArtifacts(options) {
  const key=join(options.root,options.runId);
  if(pendingCaptures.has(key))return pendingCaptures.get(key);
  const work=captureRunArtifactsOnce(options).finally(()=>{if(pendingCaptures.get(key)===work)pendingCaptures.delete(key);});
  pendingCaptures.set(key,work);return work;
}

async function captureRunArtifactsOnce({ root, runId, adapter, client }) {
  const run = await loadRun({ root, runId });
  if (run.manifest.image_api) throw new Error('API results must be recovered through the API channel');
  if(run.manifest.artifacts?.length && ['artifacts_saved','completed'].includes(run.manifest.status))return run;
  if (!['submitted', 'submission_uncertain', 'capture_pending'].includes(run.manifest.status)) {
    throw new Error('Run must be submitted before result capture');
  }
  let result;
  try { result=await adapter.capture({client,run}); }
  catch(error){
    if(!/TimeoutError|Timeout \d+ms exceeded|timed?\s*out/i.test(String(error?.message||error)))throw error;
    result={state:'capture_page_not_ready',message:'ChatGPT 页面或图片控件暂未就绪，系统会稍后继续检测原任务；不会重新发送。',diagnostic:redactSecrets(String(error?.message||error)),captureContext:run.manifest.capture_context,files:[]};
  }
  if (result.captureContext) {
    await recordRunEvent({
      root,
      runId,
      type: 'CaptureContextUpdated',
      data: { capture_context: result.captureContext },
    });
  }
  if (result.state !== 'ready') {
    return recordRunEvent({
      root,
      runId,
      type: 'CaptureChecked',
      data: { capture: { state: result.state, message: result.message || '', ...(result.diagnostic?{diagnostic:result.diagnostic}:{}), checked_at: new Date().toISOString(), real_provider_verified: false } },
    });
  }
  const slateRequest = run.manifest.candidate_slate_request || null;
  const capturedFiles = slateRequest
    ? result.files.map((file) => ({
      ...file,
      source: {
        ...(file.source || {}),
        slate_request_id: slateRequest.slate_request_id,
        requested_count: slateRequest.requested_count,
      },
    }))
    : result.files;
  let captured = await importArtifacts({
    root,
    runId,
    files: capturedFiles,
    captureMethod: 'mcp_network_response',
  });
  captured = await recordRunEvent({
    root,
    runId,
    type: 'CaptureChecked',
    data: {
      capture: {
        state: 'saved',
        artifact_count: captured.manifest.artifacts.length,
        checked_at: new Date().toISOString(),
        real_provider_verified: false,
      },
    },
  });
  return captured;
}

export function countNetworkRequests(text) {
  return requestLines(text).map(requestRecord).filter(Boolean).reduce((max, request) => Math.max(max, request.index), 0);
}

export function extractCurrentChatUrl(text) {
  return extractCurrentChatTab(text)?.url || null;
}
