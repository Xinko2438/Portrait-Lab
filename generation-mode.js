import { apiRunState } from './navigation-state.js';

const activeJobStates = new Set(['preparing', 'sending', 'saving']);
const apiStateLabels = {
  preparing: '正在准备 API 任务',
  sending: '正在生成图片',
  saving: '正在保存原图',
  saved: 'API 原图已保存',
  api_rejected: '服务商已拒绝请求',
  submission_uncertain: '发送状态待确认',
  save_failed: '本机保存未完成',
  preparation_failed: '任务准备未完成',
  prepared: '等待任务提交',
};

const maxImageBytes = 10 * 1024 * 1024;
const imageTypes = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp'};
const providerFetch = {credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'};
const providerErrorHints = {
  400:'请检查模型名称、生成参数和图片格式',
  401:'请核对 API 密钥，或确认密钥是否已过期',
  402:'请检查服务商账户余额或计费状态',
  403:'请检查密钥和模型调用权限',
  413:'参考图片总大小超出服务商限制，请减小图片后再提交',
  415:'服务商不接受此上传格式，请检查图片格式和编辑端点',
  422:'请核对该模型支持的参数和参考图片',
  429:'服务商限制了额度或请求频率，请查看账户用量',
};

function describeProviderError(status, editing) {
  const hint = status === 404 ? '请核对 API 地址和' + (editing ? '编辑' : '生成') + '端点路径'
    : status >= 500 ? '服务商暂时不可用，请稍后核实服务状态'
    : providerErrorHints[status] || '请核对服务商的接口要求和账户状态';
  return `生图失败（HTTP ${status}）。${hint}。`;
}

function httpsUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('请填写有效的 HTTPS API 地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('请使用不含登录信息的 HTTPS 地址');
  }
  return url;
}

async function boundedBytes(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('服务商返回了空内容');
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('图片服务返回的内容超过允许大小');
      parts.push(value);
    }
    return new Blob(parts);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function providerImage(item, index, allowedHosts) {
  let blob;
  if (typeof item?.b64_json === 'string' && item.b64_json) {
    if (item.b64_json.length > Math.ceil(maxImageBytes / 3) * 4) throw new Error('结果图片超过 10 MB');
    let bytes;
    try { bytes = Uint8Array.from(atob(item.b64_json), char => char.charCodeAt(0)); }
    catch { throw new Error('服务商返回的图片数据无效'); }
    const type = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' :
      bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' :
      String.fromCharCode(...bytes.slice(8,12)) === 'WEBP' ? 'image/webp' : '';
    blob = new Blob([bytes],{type});
  } else if (typeof item?.url === 'string') {
    const url = httpsUrl(item.url);
    if (!allowedHosts.has(url.hostname)) throw new Error(`请在「图片下载域名」中加入 ${url.hostname}`);
    let response;
    try { response = await fetch(url,{...providerFetch,signal:AbortSignal.timeout(90000)}); }
    catch { throw new Error(`浏览器无法读取 ${url.hostname} 的图片，请核对该域名的跨域或网络设置`); }
    if (!response.ok) throw new Error(`图片链接返回 HTTP ${response.status}，请核对链接有效期或下载权限`);
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    blob = (await boundedBytes(response,maxImageBytes)).slice(0,undefined,type);
  }
  if (!blob?.size || blob.size > maxImageBytes || !imageTypes[blob.type]) throw new Error('服务商未返回可读取的 PNG、JPEG 或 WebP 图片');
  let bitmap;
  try { bitmap = await createImageBitmap(blob); }
  catch { throw new Error('服务商返回的图片无法解码'); }
  bitmap.close();
  return new File([blob],'result-' + (index + 1) + '.' + imageTypes[blob.type],{type:blob.type});
}

async function generateThroughProvider(form, config) {
  const base = httpsUrl(config.baseUrl);
  const editing = form.get('operation') === 'edit';
  const endpoint = editing ? config.editPath : config.generatePath;
  if (base.search || !/^[\w-]+(?:\/[\w-]+)*$/.test(endpoint)) {
    throw new Error('API 地址不能带查询参数，端点请填写相对路径，例如 images/edits');
  }
  const url = new URL(base.href.replace(/\/$/,'') + '/' + endpoint);
  const headers = {authorization:'Bearer ' + config.apiKey};
  const params = {model:config.model,prompt:form.get('prompt'),n:Number(form.get('n')),size:form.get('size'),quality:form.get('quality')};
  let body;
  if (editing) {
    body = new FormData();
    const identity = form.getAll('identity');
    const templates = form.getAll('templates');
    const files = [...identity,...templates];
    const mask = form.get('mask');
    if ([...files,...(mask ? [mask] : [])].some(file => !imageTypes[file.type] || !file.size || file.size > maxImageBytes)) {
      throw new Error('请选择 PNG、JPEG 或 WebP，每张图片最多 10 MB');
    }
    if (identity.length > 4 || templates.length > 4) throw new Error('客户照片和模板图各最多 4 张');
    for (const [key,value] of Object.entries(params)) body.set(key,String(value));
    for (const file of files) body.append('image[]',file);
    if (mask) body.set('mask',mask);
  } else {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(params);
  }
  let response;
  const signal = AbortSignal.timeout(240000);
  const waitForProvider = '等待服务商响应超时。请先在服务商处核对任务状态。本次不会自动重试。';
  try { response = await fetch(url,{...providerFetch,method:'POST',headers,body,signal}); }
  catch {
    if (signal.aborted) throw new Error(waitForProvider);
    if (url.origin === 'https://sub.200204.asia' && ['/v1/images/edits','/v1/images/generations'].includes(url.pathname)) {
      throw new Error('浏览器无法连接三千。该节点曾拒绝网页的跨域预检。请改用允许网页直连的端点。');
    }
    throw new Error('浏览器无法连接生图服务。请检查 API 地址，以及服务商的跨域或网络设置。本次不会自动重试。');
  }
  if (!response.ok) throw new Error(describeProviderError(response.status,editing));
  try {
    const data = await (await boundedBytes(response,60 * 1024 * 1024)).text();
    let result;
    try { result = JSON.parse(data); }
    catch { throw new Error('成片返回格式不兼容，预期为 JSON'); }
    if (!Array.isArray(result?.data) || !result.data.length || result.data.length > 4) throw new Error('服务商返回的成片数量无效');
    const hosts = new Set(config.resultHosts.toLowerCase().split(/[\s,]+/).filter(Boolean));
    return await Promise.all(result.data.map((item,index) => providerImage(item,index,hosts)));
  } catch (error) {
    if (signal.aborted) throw new Error(waitForProvider);
    throw new Error(`无法读取成片（${error.message}）。生成请求没有自动重发。`);
  }
}

export function initGenerationMode({ getRun, buildForm, acceptResult, showMessage, isBusy, refreshSummary=()=>{}, onConfigChanged=()=>{}, onJobChange=()=>{} }) {
  const mode = document.querySelector('#generationMode');
  const operation = document.querySelector('#apiOperation');
  const dialog = document.querySelector('#generationSettingsDialog');
  const settings = document.querySelector('#imageApiSettingsForm');
  const pendingKey = 'ai-img-gen.image-api.pending';
  let pending = sessionStorage.getItem(pendingKey);
  let config = { configured:false };
  let locked = false;
  let syncedRunId=null;
  let observedJob = null;
  let pendingArchive = null;
  let taskRevision = 0;
  let observationTimer = null;
  const request = async (path, options={}) => {
    const res = await fetch(path, {...options,headers:{'x-image-api-client':'workstation',...options.headers}});
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error?.message || data.error || `请求失败 ${res.status}`), { status: res.status });
    return data;
  };
  const runKey = () => getRun()?.image_api?.job_key || pending;
  const currentJob = () => observedJob?.jobKey === runKey() ? observedJob : null;
  const getState = () => apiRunState(getRun(), currentJob());
  function rememberJob(data) {
    observedJob = data;
    clearTimeout(observationTimer);
    if (activeJobStates.has(data.state)) {
      observationTimer = setTimeout(() => observe(data.jobKey), 2500);
    }
  }
  async function observe(key = runKey()) {
    if (!key) return;
    try {
      const data = await request(`/folio/portrait-lab/api/image-api/jobs/${encodeURIComponent(key)}`);
      if (key !== runKey() || locked) return;
      if (data.state === 'saved' && !getRun()?.artifacts?.length) {
        await result(data);
      } else {
        rememberJob({ ...data, jobKey: key });
        sync();
        onJobChange();
      }
    } catch {
      if (key === runKey() && currentJob() && activeJobStates.has(currentJob().state)) {
        observedJob = null;
        sync();
        onJobChange();
      }
    }
  }
  function sync() {
    const run = getRun();
    if(run?.image_api&&syncedRunId!==run.run_id){syncedRunId=run.run_id;for(const [id,key]of [['apiOperation','operation'],['apiImageCount','n'],['apiImageSize','size'],['apiImageQuality','quality']])if(run.image_api[key]!=null)document.getElementById(id).value=String(run.image_api[key]);}
    if(run?.run_id) mode.value = run.image_api ? 'api':'web';
    mode.disabled = Boolean(run?.run_id) || isBusy() || locked || Boolean(pending);
    operation.disabled = mode.disabled;
    const apiMode = mode.value==='api';
    document.querySelector('#apiModeOptions').hidden=!apiMode;
    document.querySelector('#apiAdvancedOptions').hidden=!apiMode;
    document.querySelector('#apiModeStatus').textContent = config.configured ? `${config.model}${operation.value==='generate'?' · 仅发送文字':''}` : '开始生成前请填写 API 地址和密钥';
    document.querySelector('#checkBrowser').hidden=apiMode;
    const submit = document.querySelector('#prepareRun');
    const state = getState();
    const recoverable = currentJob()?.canRecover === true;
    const terminal = state === 'api_rejected' || state === 'save_failed' && !recoverable;
    if(!isBusy()&&!locked) {
      if(apiMode) submit.textContent=pendingArchive?'保存本次成片':state==='saved'?'继续评分与选择':terminal?'查看失败详情':recoverable?'恢复已保存的原图':(pending||run?.image_api)&&state!=='prepared'?'查看任务状态':'开始生成';
      else if(!run?.run_id) submit.textContent='开始生成';
    }
    const capture = document.querySelector('#captureRun');
    capture.hidden = Boolean(apiMode && run?.image_api && terminal);
    if(apiMode && run?.image_api){
      document.querySelector('#stageRun').disabled=true;
      document.querySelector('#submitRun').disabled=true;
      if (capture.dataset.busy !== 'true') {
        capture.disabled=locked || activeJobStates.has(state);
        capture.textContent=state==='saved'?'前往评分':recoverable?'恢复已保存的原图':activeJobStates.has(state)?apiStateLabels[state]:state==='prepared'?'返回生成设置':'查看任务状态';
      }
    }
    const note=document.querySelector('.task-submit-note');
    if(note) note.textContent=apiMode&&run?.image_api?(terminal?'可调整原设置并创建新任务。':'本次任务只发送一次。'):apiMode?'点击后开始 API 生图；失败不会自动重试':'点击后通过 ChatGPT 网页版生成；失败不会自动重试';
    refreshSummary();
  }
  async function result(data) {
    rememberJob({ ...data, jobKey: data.jobKey || runKey() });
    if(data.runId && (getRun()?.run_id !== data.runId || data.state === 'saved')) await acceptResult(data);
    const tone = data.state === 'saved' ? 'success' : activeJobStates.has(data.state) ? 'busy' : 'error';
    showMessage(data.message || apiStateLabels[data.state] || '已读取 API 任务状态', tone);
    if(data.state==='saved'){pending=null;sessionStorage.removeItem(pendingKey);}
    if(data.state==='preparation_failed'&&!Number(getRun()?.submission_attempt_count||0)){pending=null;sessionStorage.removeItem(pendingKey);sessionStorage.removeItem(`${pendingKey}.preparedRun`);}
    sync();onJobChange();return data;
  }
  async function resume() {
    const key=getRun()?.image_api?.job_key || pending;
    if(!key) throw new Error('此 API 任务没有可恢复的编号，请在历史记录查看');
    const current=await request(`/folio/portrait-lab/api/image-api/jobs/${encodeURIComponent(key)}`);
    if(current.canRecover === true) {
      try{return await result(await request(`/folio/portrait-lab/api/image-api/jobs/${encodeURIComponent(key)}/recover`,{method:'POST'}));}
      catch(error){await result(current);showMessage(error.message);return current;}
    }
    return result(current);
  }
  async function submit() {
    if(locked)return;locked=true;sync();
    try {
      const revision = taskRevision;
      const run=getRun();
      if(run?.image_api&&!Number(run.submission_attempt_count||0)&&run.status==='prepared'){
        const marker=`${pendingKey}.preparedRun`;if(sessionStorage.getItem(marker)!==run.run_id){pending=crypto.randomUUID();sessionStorage.setItem(pendingKey,pending);sessionStorage.setItem(marker,run.run_id);}
        return await result(await request(`/folio/portrait-lab/api/image-api/runs/${run.run_id}/submit`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmed:true,jobKey:pending})}));
      }
      if(getRun()?.image_api||pending)return await resume();
      if (!navigator.serviceWorker.controller) throw new Error('浏览器本地保存还未就绪，请刷新后再生成');
      let form = pendingArchive;
      if (!form) {
        if (!config.configured) { open(); return; }
        const selectedOperation = operation.value;
        const provider = {...config};
        form = await buildForm(selectedOperation);
        if (revision !== taskRevision) return;
        form.set('operation',selectedOperation);
        form.set('archiveId',crypto.randomUUID());
        form.set('n',document.querySelector('#apiImageCount').value);
        form.set('size',document.querySelector('#apiImageSize').value);
        form.set('quality',document.querySelector('#apiImageQuality').value);
        const mask = document.querySelector('#apiMask').files[0];
        if (mask && selectedOperation === 'edit') form.set('mask',mask);
        showMessage('正在等待生图服务返回成片。', 'busy');
        for (const file of await generateThroughProvider(form,provider)) form.append('results',file);
        form.delete('mask');
        if (revision === taskRevision) pendingArchive = form;
      }
      showMessage('正在保存到此浏览器。','busy');
      let saved;
      try { saved = await request('/folio/portrait-lab/api/generated-results',{method:'POST',body:form}); }
      catch (error) {
        throw new Error('成片已生成。保存到浏览器失败，可再次点击保存成片。');
      }
      if (revision !== taskRevision) return;
      pendingArchive = null;
      return await result({...saved,state:'saved'});
    } finally {locked=false;sync();}
  }
  function reset(){taskRevision++;pendingArchive=null;pending=null;syncedRunId=null;observedJob=null;mode.value='api';clearTimeout(observationTimer);sessionStorage.removeItem(pendingKey);sessionStorage.removeItem(`${pendingKey}.preparedRun`);sync();}
  const settingsKey = 'portrait-lab.api-settings';
  const settingNames = ['baseUrl', 'model', 'resultHosts', 'generatePath', 'editPath'];
  const message = document.querySelector('#imageApiSettingsMessage');
  try {
    const saved = JSON.parse(sessionStorage.getItem(settingsKey) || '{}');
    for (const name of settingNames) {
      if (typeof saved[name] === 'string' && saved[name].trim()) settings.elements[name].value = saved[name];
    }
  } catch {}
  const open = () => dialog.showModal();
  document.querySelector('#openGenerationSettings').addEventListener('click', open);
  document.querySelector('#configureImageApi').addEventListener('click', open);
  document.querySelector('#closeGenerationSettings').addEventListener('click', () => dialog.close());
  settings.addEventListener('submit', event => {
    event.preventDefault();
    const data = Object.fromEntries(settingNames.map(name => {
      const field = settings.elements[name];
      return [name, field.value.trim() || field.defaultValue];
    }));
    try {
      const url = httpsUrl(data.baseUrl);
      const apiKey = settings.elements.apiKey.value.trim();
      sessionStorage.setItem(settingsKey, JSON.stringify(data));
      config = {...data,baseUrl:url.href,apiKey,configured:Boolean(apiKey)};
      message.textContent = '已在此标签页保存配置。';
      sync();
    } catch {
      message.textContent = '请核对 HTTPS 地址，或检查当前浏览器能否保存设置。';
    }
  });
  settings.addEventListener('reset', () => {
    try { sessionStorage.removeItem(settingsKey); } catch {}
    config = {configured:false};
    message.textContent = '已清空。';
    sync();
  });
  mode.value='api';
  mode.addEventListener('change',()=>{localStorage.setItem('ai-img-gen.generation-mode',mode.value);sync();});operation.addEventListener('change',sync);document.querySelector('#apiImageCount').addEventListener('change',sync);
  sync();
  if(pending&&!getRun()?.run_id)request(`/folio/portrait-lab/api/image-api/jobs/${encodeURIComponent(pending)}`).then(result).catch(error=>showMessage(`${error.message}；原任务编号已保留，尚未再次发送。`));
  return {sync,submit,resume,reset,observe,currentJob,getState,usesApi:()=>getRun()?.run_id?Boolean(getRun().image_api):mode.value==='api'||Boolean(pending)};
}
