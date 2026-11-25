import { createHash, randomUUID } from 'node:crypto';
import { readPrivateConfig, writePrivateConfig } from './private-config.mjs';
import { readFile, writeFile, mkdir, rename, access } from 'node:fs/promises';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { inspectImage } from './image-metadata.mjs';
import { materializeReusedReferences,readVerifiedRunFile,runCustomerId } from './reference-reuse.mjs';
import { buildSubmissionSnapshot } from './generation-details.mjs';
import { createCustomerVisualService } from './customer-visual-analysis.mjs';
import { resolveSmartSubmission,smartManualFromForm,assertSmartReady } from './smart-task-resolution.mjs';
import { assertTemplatesNotRejected } from './face-tag-store.mjs';
import { customerIdFromName, taskIntentFromForm } from '../public/task-intent.js';
import { normalizeTaskIntent } from './intelligent-workbench/intent-schema.mjs';
import { preparePromptCompilation } from './intelligent-workbench/prompt-recipe-runtime.mjs';
import { mapFormToTaskBrief } from '../public/template-library.js';
import { resolveCatalogSelectionForRun } from './catalog-run-integration.mjs';
import { materializeIdentitySet, createIdentitySet } from './customer-identity-store.mjs';
import { selectCustomerIdentityFiles } from './customer-photo-selection.mjs';
import { createRunSnapshot, loadRun, recordRunEvent, beginRunSubmissionAttempt, importArtifacts } from './run-store.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const MAX_IMAGE = 25 * 1024 * 1024;
const preparedRunFlights=new Map();
const keyPattern = /^[a-zA-Z0-9_-]{8,128}$/;
const configPath = root => join(root, 'data', 'private-config', 'image-api-config.json');
const legacyConfigPath = root => join(root, '.runtime', 'image-api-config.json');
async function readImageConfig(root,{forSave=false}={}) {
  let current;
  try { current=await readPrivateConfig(configPath(root)); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  if(current) {
    let legacyExists=false;
    try{await access(legacyConfigPath(root));legacyExists=true;}catch(error){if(error.code!=='ENOENT')throw error;}
    if(legacyExists)throw fail('配置来源冲突：新旧位置同时存在，需核对后再使用；未自动选择或覆盖',409);
    return current;
  }
  // Existing installations keep their current source until a separately scoped
  // migration. Reading compatibility never creates or updates the legacy path.
  const legacy=await readPrivateConfig(legacyConfigPath(root));
  if(forSave)throw fail('现有配置仍在旧位置，需先完成单独授权的迁移；原配置继续可用',409);
  return legacy;
}
const jobPath = (root, key) => {
  if (!keyPattern.test(key)) throw fail('任务编号不合法');
  return join(root, 'data', 'image-api-jobs', `${digest(key)}.json`);
};
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function atomicJson(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}
function validateConfig(input) {
  let url;
  try { url = new URL(input.baseUrl); } catch { throw fail('请输入完整 API 地址，例如 https://api.openai.com/v1'); }
  if (url.username || url.password || url.search || url.hash) throw fail('API 地址不得包含密钥、查询参数或账号');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw fail('API 地址需要 HTTPS；本机调试可用 HTTP');
  const model = String(input.model || '').trim();
  if (!/^[a-zA-Z0-9._:/-]{1,150}$/.test(model)) throw fail('请填写服务商支持的图片模型名称');
  const apiKey = String(input.apiKey || '').trim();
  if (!apiKey || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw fail('请填写有效的 API Key');
  const resultHosts = [...new Set(String(input.resultHosts || '').split(/[\s,]+/).filter(Boolean))];
  if (resultHosts.some(host => !/^[a-zA-Z0-9.-]+$/.test(host) || host.includes('..') || isIP(host) || !host.includes('.'))) throw fail('结果图片域名必须是明确的主机名，不支持通配符或 IP');
  const endpointPath = (value, fallback) => {
    const path = String(value || fallback).trim().replace(/^\/+/, '');
    if (!/^[a-zA-Z0-9_/-]+$/.test(path) || path.includes('..')) throw fail('端点请输入相对 API 地址的路径，不含查询参数或密钥');
    return path;
  };
  return { baseUrl: url.href.replace(/\/$/, ''), model, apiKey, resultHosts: resultHosts.join(','), generatePath: endpointPath(input.generatePath, 'images/generations'), editPath: endpointPath(input.editPath, 'images/edits') };
}
export async function imageApiConfig(root, { secret = false } = {}) {
  let config;
  try { config = validateConfig(await readImageConfig(root)); }
  catch (error) { if (error.code === 'ENOENT') return { configured: false, baseUrl: 'https://api.openai.com/v1', model: '', resultHosts: '', hasKey: false }; throw error; }
  if (secret) return config;
  return { configured: true, baseUrl: config.baseUrl, model: config.model, resultHosts: config.resultHosts, generatePath: config.generatePath, editPath: config.editPath, hasKey: true };
}
export async function saveImageApiConfig(root, input) {
  let prior = {};
  try { prior = await readImageConfig(root,{forSave:true}); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = validateConfig({ ...prior, ...input, apiKey: input.apiKey || prior.apiKey });
  await writePrivateConfig({path:configPath(root),ownerRoot:root,ownerId:'project.ai-img-gen',value:config});
  return imageApiConfig(root);
}

async function boundedBody(response, max) {
  if (Number(response.headers.get('content-length')) > max) throw fail('服务商响应超过大小限制', 502);
  const reader = response.body?.getReader();
  if (!reader) throw fail('服务商没有返回图片', 502);
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > max) throw fail('服务商响应超过大小限制', 502);
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return Buffer.concat(chunks);
}
function privateAddress(address) {
  return !isIP(address) || /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::|f[cd]|fe[89ab])/i.test(address);
}
async function resultBytes(urlString, config, fetchImpl) {
  const url = new URL(urlString);
  const hosts = config.resultHosts.split(',').filter(Boolean);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || isIP(url.hostname) || !hosts.includes(url.hostname)) throw fail('结果下载域名未允许，请先在 API 设置中配置服务商的图片域名；本次不会重发', 502);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) throw fail('结果下载地址不安全', 502);
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw fail('结果图片下载失败；本次不会重发', 502);
  return boundedBody(response, MAX_IMAGE);
}
export async function callImageApi({ config, operation, prompt, identityFiles = [], templateFiles = [], mask = null, n = 1, size = '1024x1536', quality = 'auto', fetchImpl = fetch }) {
  const endpoint = operation === 'edit' ? (config.editPath || 'images/edits') : (config.generatePath || 'images/generations');
  let body; const headers = { Authorization: `Bearer ${config.apiKey}` };
  if (operation === 'edit') {
    body = new FormData();
    for (const [key, value] of Object.entries({ model: config.model, prompt, n, size, quality })) body.set(key, String(value));
    for (const [index, file] of [...identityFiles, ...templateFiles].entries()) {
      const metadata = inspectImage(file.bytes);
      body.append('image[]', new Blob([file.bytes], { type: metadata.mimeType }), `reference-${index + 1}${metadata.extension}`);
    }
    if (mask) body.set('mask', new Blob([mask.bytes], { type: 'image/png' }), 'mask.png');
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ model: config.model, prompt, n, size, quality });
  }
  let response;
  try {
    response = await fetchImpl(`${config.baseUrl}/${endpoint}`, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(900000) });
  } catch { throw fail('API 请求连接中断或超时，发送状态不确定；禁止自动重发', 502); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw fail(`图片 API 返回 HTTP ${response.status}；本次不会重发`, 502); }
  let json;
  try { json = JSON.parse((await boundedBody(response, 145 * 1024 * 1024)).toString('utf8')); }
  catch { throw fail('图片 API 返回无法解析或过大的响应；本次不会重发', 502); }
  if (!Array.isArray(json.data) || !json.data.length || json.data.length > n) throw fail('图片 API 返回的图片数量异常；本次不会重发', 502);
  const files = [];
  for (const item of json.data) {
    let bytes;
    if (typeof item.b64_json === 'string') {
      if (item.b64_json.length > Math.ceil(MAX_IMAGE * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.b64_json)) throw fail('图片 Base64 数据不合法', 502);
      bytes = Buffer.from(item.b64_json, 'base64');
    } else if (typeof item.url === 'string') bytes = await resultBytes(item.url, config, fetchImpl);
    else throw fail('服务商未返回 Base64 或图片 URL', 502);
    let metadata;
    try { metadata = inspectImage(bytes); } catch { throw fail('服务商返回的文件不是受支持的原始图片', 502); }
    files.push({ name: `api-${files.length + 1}${metadata.extension}`, bytes });
  }
  const requestId = response.headers.get('x-request-id');
  return { files, requestId: /^[\w-]{1,150}$/.test(requestId || '') ? requestId : null };
}

export function validateImageJob(input) {
  if (!['edit', 'generate'].includes(input.operation)) throw fail('未知生图模式');
  const prompt = String(input.prompt || '').trim();
  if (!prompt || prompt.length > 16000) throw fail('提示词不能为空，且不得超过 16000 字');
  const customerName = String(input.customerName || '').trim();
  if (!customerName || customerName.length > 120) throw fail('请填写客户或项目名称');
  const n = Number(input.n ?? 1);
  if (!Number.isInteger(n) || n < 1 || n > 4) throw fail('生成数量必须为 1 至 4 张');
  if (!['auto','1024x1024','1024x1536','1536x1024'].includes(input.size)) throw fail('不支持的输出尺寸');
  if (!['auto','low','medium','high'].includes(input.quality)) throw fail('不支持的质量参数');
  const identityFiles = input.identityFiles || [], templateFiles = input.templateFiles || [];
  if (identityFiles.length > 4 || templateFiles.length > 4) throw fail('身份图和模板图各最多 4 张');
  if (input.operation === 'edit' && !identityFiles.length) throw fail('参考图编辑至少需要一张身份图或待编辑原图');
  if (input.operation === 'generate' && (identityFiles.length || templateFiles.length || input.mask)) throw fail('纯文字生图不能携带参考图，请选择参考图编辑');
  for (const file of [...identityFiles, ...templateFiles]) inspectImage(file.bytes);
  if (input.mask) {
    const a = inspectImage(input.mask.bytes), b = inspectImage(identityFiles[0].bytes);
    if (a.mimeType !== 'image/png' || a.width !== b.width || a.height !== b.height || ![4,6].includes(input.mask.bytes[25])) throw fail('遮罩必须为带透明通道的 PNG，并与第一张原图尺寸一致');
  }
  return { operation: input.operation, prompt, customerName, identityFiles, templateFiles, mask: input.mask || null, n, size: input.size, quality: input.quality };
}

export function createImageApiService({ root, fetchImpl = fetch } = {}) {
  const flights = new Map();
  async function status(key) {
    let job;
    try { job = await readJson(jobPath(root, key)); } catch (error) { if (error.code === 'ENOENT') throw fail('未找到该 API 任务', 404); throw error; }
    if (job.state === 'discarded') throw fail('这个 API 任务已删除', 404);
    let run = null;
    if (job.runId) run = await loadRun({ root, runId: job.runId });
    return { jobKey: key, runId: job.runId || null, state: job.state, message: job.message || '', artifacts: (run?.manifest.artifacts || []).map(a => ({ artifact_id: a.artifact_id, width: a.width, height: a.height, sha256: a.sha256 })), reviewUrl: job.runId ? `/?run=${job.runId}&from=history` : null };
  }
  async function execute(key, rawInput) {
    const path = jobPath(root, key);
    const input = validateImageJob(rawInput);
    await assertTemplatesNotRejected({root,imageHashes:input.templateFiles.map(file=>digest(file.bytes))});
    const config = await imageApiConfig(root, { secret: true });
    if(rawInput.expectedApiConfig && (rawInput.expectedApiConfig.baseUrl!==config.baseUrl || rawInput.expectedApiConfig.model!==config.model))throw fail('API 配置已变化，请刷新修改摘要后再发送；尚未建立任务',409);
    if (!config.apiKey) throw fail('请先配置图片 API 地址、模型和 Key', 409);
    let promptCompilation = null, taskIntent = null;
    if (input.operation === 'edit' && input.templateFiles.length && !rawInput.usePreparedPrompt) {
      try {
        const intent = rawInput.taskIntent || {useCase:'custom',userSupplement:input.prompt};
        taskIntent = normalizeTaskIntent({...intent, useCase:intent.useCase || intent.use_case || 'custom'});
        const prepared = await preparePromptCompilation({
          root, recipeEnabled:true, taskIntent,
          identityReferences:input.identityFiles.map((file,index)=>({ordinal:index+1,sha256:digest(file.bytes),role:file.role || (index===0?'primary_front':'identity_support'),face_angle:file.face_angle || ''})),
          templateReferences:input.templateFiles.map((file,index)=>({...file.promptReference,ordinal:input.identityFiles.length+index+1,sha256:digest(file.bytes),template_name:file.name})),
          // API n controls quantity; do not attach the web-only A/B variation policy.
          candidateSlateRequest:null,
        });
        promptCompilation = prepared.compilation;
        input.prompt = promptCompilation.compiled_prompt;
      } catch { throw fail('换脸提示词编译失败，请检查已验证提示词资产和任务设置；尚未发送', 422); }
    }
    if(!taskIntent && rawInput.taskIntent)taskIntent=normalizeTaskIntent({...rawInput.taskIntent,useCase:rawInput.taskIntent.useCase||rawInput.taskIntent.use_case||'custom'});
    const fingerprint = digest(JSON.stringify({ ...input, taskIntent,...(rawInput.existingRunId?{existingRunId:rawInput.existingRunId,preparationRevision:rawInput.expectedPreparationRevision}:{}), identityFiles: input.identityFiles.map(f => digest(f.bytes)), templateFiles: input.templateFiles.map(f => digest(f.bytes)), mask: input.mask ? digest(input.mask.bytes) : null, provider: config.baseUrl, model: config.model, generatePath:config.generatePath, editPath:config.editPath, runOptions:rawInput.runOptions || null }));
    await mkdir(join(root,'data','image-api-jobs'), { recursive: true });
    const job = { state: 'preparing', fingerprint, runId: null };
    let attemptStarted=false;
    try { await writeFile(path, JSON.stringify(job), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const prior = await readJson(path);
      if (prior.fingerprint !== fingerprint) throw fail('任务内容已改变，请明确新建任务；原任务不会被重发', 409);
      return { ...await status(key), replay: true };
    }
    try {
      const apiSubmission={ provider: config.baseUrl, endpoint: input.operation === 'edit' ? config.editPath : config.generatePath, job_key: key, model: config.model, operation: input.operation, n: input.n, size: input.size, quality: input.quality, mask_sha256: input.mask ? digest(input.mask.bytes) : null };
      const run = rawInput.existingRunId?await loadRun({root,runId:rawInput.existingRunId}):await createRunSnapshot({ root, customerName: input.customerName, customerId: customerIdFromName(input.customerName), prompt: input.prompt, identityFiles: input.identityFiles, templateFiles: rawInput.manualTemplateFiles || input.templateFiles, ...rawInput.runOptions, taskIntent, ...(promptCompilation ? {promptCompilation} : {}), imageApi:apiSubmission, customerContext: { intendedUse: input.operation === 'edit' ? 'API 参考图编辑' : 'API 文字生图' } });
      job.runId = run.runId;
      await atomicJson(path,job);
      if (rawInput.saveIdentitySet) await createIdentitySet({root,customerId:run.manifest.customer_id,displayName:input.customerName,files:input.identityFiles.map((f,i)=>({...f,role:i===0?'primary_front':'identity_support'}))});
      if (input.mask) await writeFile(join(run.runDir, 'mask.png'), input.mask.bytes);
      job.state = 'sending'; await atomicJson(path, job);
      await recordRunEvent({ root, runId: run.runId, type: 'RunStaged', data: { executor: 'openai-compatible-images' } });
      const attempt = await beginRunSubmissionAttempt({ root, runId: run.runId,apiSubmission,expectedPreparationRevision:rawInput.expectedPreparationRevision,requestSnapshot:buildSubmissionSnapshot(run,{prompt:input.prompt,model:config.model,provider:config.baseUrl,operation:input.operation,requestedCount:input.n,size:input.size,quality:input.quality}) });
      if (!attempt.started) throw fail('任务已经尝试发送，禁止重复请求', 409);
      attemptStarted=true;
      const started = Date.now();
      const result = await callImageApi({ ...input, config, fetchImpl });
      const responseDir = join(run.runDir, 'api-response');
      await mkdir(responseDir, { recursive: true });
      for (const file of result.files) await writeFile(join(responseDir, file.name), file.bytes);
      await atomicJson(join(responseDir, 'manifest.json'), { files: result.files.map(f => ({ name: f.name, sha256: digest(f.bytes) })), requestId: result.requestId, elapsedMs: Date.now() - started });
      job.state = 'saving'; await atomicJson(path, job);
      return recover(key);
    } catch (error) {
      job.state = !attemptStarted?'preparation_failed':job.state === 'saving' ? 'save_failed' : 'submission_uncertain';
      job.message = error.status ? error.message : '任务执行或本地保存异常；请检查原任务，禁止自动重发';
      await atomicJson(path, job);
      if (job.runId&&attemptStarted) await recordRunEvent({ root, runId: job.runId, type: 'RunSubmissionUncertain', data: { state: job.state, submission_attempt: 1, message: job.message } });
      return status(key);
    }
  }
  async function recover(key) {
    const path = jobPath(root, key), job = await readJson(path);
    if (job.state === 'discarded') throw fail('这个 API 任务已删除', 404);
    if (!job.runId) throw fail('该任务尚未建立 Run，无法恢复结果', 409);
    const run = await loadRun({ root, runId: job.runId });
    const dir = join(run.runDir, 'api-response');
    let saved;
    try { saved = await readJson(join(dir, 'manifest.json')); } catch { throw fail('尚无可恢复的本地 API 原图，本次不会重发', 409); }
    const files = [];
    for (const item of saved.files) {
      if (!/^api-[1-4]\.(png|jpg|webp)$/.test(item.name)) throw fail('原图清单异常', 409);
      const bytes = await readFile(join(dir, item.name));
      if (digest(bytes) !== item.sha256) throw fail('原图校验失败', 409);
      inspectImage(bytes); files.push({ name: item.name, bytes, source: { provider: run.manifest.image_api.provider, model: run.manifest.image_api.model, request_id: saved.requestId } });
    }
    if (!run.events.some(e => e.type === 'RunSubmitted')) await recordRunEvent({ root, runId: job.runId, type: 'RunSubmitted', data: { submission_attempt: 1, executor: 'openai-compatible-images', elapsed_ms: saved.elapsedMs, request_id: saved.requestId } });
    await importArtifacts({ root, runId: job.runId, files, captureMethod: 'image_api_response' });
    job.state = 'saved'; job.message = '原图已保存，可进入评分与最终选择';
    await atomicJson(path, job); return status(key);
  }
  function single(key, action) {
    if (flights.has(key)) return flights.get(key);
    const promise = action().finally(() => flights.delete(key)); flights.set(key, promise); return promise;
  }
  return { status, submitPrepared: async(key,runId)=>{
    const lockKey=`${root}:${runId}`;const previous=preparedRunFlights.get(lockKey)||Promise.resolve();
    const operation=previous.catch(()=>{}).then(async()=>{
      const run=await loadRun({root,runId});if(!run.manifest.image_api)throw fail('原任务不是 API 模式',422);
      if(Number(run.manifest.submission_attempt_count||0)>0)return status(run.manifest.image_api.job_key);
      if(run.manifest.reference_preflight?.state==='blocked')throw fail('请先修正原任务的准备信息',422);
      const identityFiles=await Promise.all((run.manifest.identity_references||[]).map(r=>readVerifiedRunFile(run,r)));
      const templateFiles=await Promise.all((run.manifest.template_references||[]).map(r=>readVerifiedRunFile(run,r)));
      const mask=run.manifest.image_api.mask_sha256?await readVerifiedRunFile(run,{path:join(run.runDir,'mask.png'),sha256:run.manifest.image_api.mask_sha256}):null;
      return single(key,()=>execute(key,{existingRunId:runId,expectedPreparationRevision:run.manifest.preparation_revision_id||null,usePreparedPrompt:true,operation:run.manifest.image_api.operation,prompt:run.manifest.prompt_compilation?.compiled_prompt||run.prompt,customerName:run.manifest.customer_name,n:run.manifest.image_api.n,size:run.manifest.image_api.size,quality:run.manifest.image_api.quality,identityFiles,templateFiles,mask,taskIntent:run.manifest.task_intent,runOptions:{customerId:runCustomerId(run.manifest)}}));
    });preparedRunFlights.set(lockKey,operation);try{return await operation;}finally{if(preparedRunFlights.get(lockKey)===operation)preparedRunFlights.delete(lockKey);}
  }, submit: async (key, input) => {
    if (flights.has(key)) { await flights.get(key); return execute(key, input); }
    return single(key, () => execute(key, input));
  }, recover: key => single(key, () => recover(key)) };
}

export function createImageApiHandler({ root, fetchImpl = fetch }) {
  const service = createImageApiService({ root, fetchImpl });
  const visualService=createCustomerVisualService({root,defaultEnabled:process.env.AI_IMG_GEN_AI_PROMPT_WRITER_ENABLED==='true'});
  const json = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/image-api/')) return false;
    try {
      if (req.method !== 'GET') {
        if (req.headers['x-image-api-client'] !== 'workstation' || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) throw fail('仅允许工作台同源请求', 403);
      }
      if (url.pathname === '/api/image-api/config') {
        if (req.method === 'GET') json(res, 200, await imageApiConfig(root));
        else if (req.method === 'POST') {
          let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 12000) throw fail('配置过大', 413); }
          json(res, 200, await saveImageApiConfig(root, JSON.parse(text)));
        } else throw fail('不支持该请求方法', 405);
        return true;
      }
      const jobRoute = url.pathname.match(/^\/api\/image-api\/jobs\/([\w-]{8,128})(\/recover)?$/);
      const preparedRoute=url.pathname.match(/^\/api\/image-api\/runs\/(run-[a-zA-Z0-9-]+)\/submit$/);
      if(preparedRoute&&req.method==='POST'){let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)throw fail('请求过大',413);}const data=JSON.parse(body);if(data.confirmed!==true)throw fail('未授权发送',409);json(res,200,await service.submitPrepared(String(data.jobKey||''),preparedRoute[1]));return true;}
      if (jobRoute) {
        if (req.method === 'GET' && !jobRoute[2]) json(res, 200, await service.status(jobRoute[1]));
        else if (req.method === 'POST' && jobRoute[2]) json(res, 200, await service.recover(jobRoute[1]));
        else throw fail('不支持该请求方法', 405);
        return true;
      }
      if (url.pathname === '/api/image-api/jobs' && req.method === 'POST') {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 110 * 1024 * 1024) throw fail('上传总量超过 110 MB', 413); chunks.push(chunk); }
        const form = await new Request('http://localhost', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) }).formData();
        if (form.get('confirmed') !== 'true') throw fail('未明确授权发送', 409);
        const files = async name => Promise.all(form.getAll(name).filter(f => typeof f !== 'string' && f.size).map(async f => ({ name: f.name, bytes: Buffer.from(await f.arrayBuffer()) })));
        const masks = await files('mask'); if (masks.length > 1) throw fail('只支持一个遮罩');
        let identityFiles = await files('identity'); let manualTemplateFiles=await files('templates');
        let templateFiles=manualTemplateFiles, customerName=String(form.get('customerName')||'');
        const customerId=String(form.get('customerId')||'')||customerIdFromName(customerName);
        const identitySetId=String(form.get('identitySetId')||'');
        const runOptions={customerId};
        const sourceRunId=String(form.get('sourceRunId')||'');
        if(sourceRunId){
          if(identitySetId)throw fail('沿用参考图不能同时选择另一照片池');
          const reused=await materializeReusedReferences({root,sourceRunId,customerId,references:JSON.parse(form.get('reuseReferences')||'[]'),identityFiles,templateFiles:manualTemplateFiles});
          identityFiles=reused.identityFiles;manualTemplateFiles=reused.templateFiles;templateFiles=manualTemplateFiles;runOptions.sourceRunId=sourceRunId;
        }
        if (identitySetId) {
          const materialized=await materializeIdentitySet({root,customerId,identitySetId});
          const selected=selectCustomerIdentityFiles({customerId,identitySetId,materialized,selectedOrdinals:form.getAll('identityReferenceOrdinals').map(Number),primaryOrdinal:form.get('primaryIdentityReferenceOrdinal'),uploadedFiles:identityFiles,explicitSelection:true});
          identityFiles=selected.files;runOptions.customerIdentitySource=selected.source;customerName=materialized.identitySet.display_name;
        }
        const catalogTemplateUids=form.getAll('catalogTemplateUids').map(String);
        const smartResolution=form.get('smartTask')==='true'?await resolveSmartSubmission({root,customerId,identityFiles,templateFiles:manualTemplateFiles,catalogTemplateUids,identitySetId,manual:smartManualFromForm(form),visualService}):null;
        if(smartResolution){assertSmartReady(smartResolution);runOptions.taskResolution=smartResolution;}
        if(catalogTemplateUids.length){
          const taskBrief=smartResolution?.recommendation_brief || mapFormToTaskBrief({customerName,customerScopeId:customerId,intendedUse:form.get('intendedUse'),targetFraming:form.get('targetFraming'),targetAngle:form.get('targetIntentAngle')||form.get('targetAngle'),temperamentKeywords:form.getAll('temperamentKeywords'),prompt:form.get('userSupplement'),businessDomain:form.get('businessDomain')});
          const templateSelectionId=String(form.get('templateSelectionId')||'');
          const resolved=await resolveCatalogSelectionForRun({root,templateSelectionId,catalogTemplateUids,expectedTaskBrief:taskBrief});
          templateFiles=[...manualTemplateFiles,...resolved.catalogReferences.map(r=>({name:r.template_name,bytes:r.image_bytes}))];
          Object.assign(runOptions,{templateSelectionId,catalogTemplateUids,templateSelectionTaskBrief:taskBrief,templateDecisionIdempotencyKey:String(form.get('templateDecisionIdempotencyKey')||'')});
        }
        const taskIntent = smartResolution?.task_intent || taskIntentFromForm(form);
        if (!form.has('userSupplement')) taskIntent.userSupplement = String(form.get('prompt') || '');
        const result = await service.submit(String(form.get('jobKey') || ''), { operation: form.get('operation'), prompt: form.get('prompt'), taskIntent, customerName, n: form.get('n'), size: form.get('size'), quality: form.get('quality'), identityFiles, templateFiles, manualTemplateFiles, runOptions, saveIdentitySet:!identitySetId&&form.get('saveIdentitySet')==='true', mask: masks[0] || null });
        json(res, 200, result); return true;
      }
      throw fail('接口不存在', 404);
    } catch (error) { json(res, error.status || 500, { error: error.status ? error.message : 'API 通道处理异常，请检查本地配置和原任务' }); return true; }
  };
}
