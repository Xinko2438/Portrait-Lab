export function initGenerationMode({ getRun, buildForm, acceptResult, showMessage, isBusy, refreshSummary=()=>{}, onConfigChanged=()=>{} }) {
  const mode = document.querySelector('#generationMode');
  const operation = document.querySelector('#apiOperation');
  const dialog = document.querySelector('#generationSettingsDialog');
  const settings = document.querySelector('#imageApiSettingsForm');
  const pendingKey = 'ai-img-gen.image-api.pending';
  let pending = sessionStorage.getItem(pendingKey);
  let config = { configured:false };
  let locked = false;
  let syncedRunId=null;
  const states = {preparing:'正在准备原任务',sending:'已向 API 发送，等待结果',saving:'正在保存原图',saved:'API 原图已保存',submission_uncertain:'发送结果不确定，禁止重复发送',save_failed:'原图保存中断，可恢复本地保存',preparation_failed:'任务准备未完成'};
  const request = async (path, options={}) => {
    const res = await fetch(path, {...options,headers:{'x-image-api-client':'workstation',...options.headers}});
    const data = await res.json(); if(!res.ok) throw new Error(data.error?.message || data.error || `请求失败 ${res.status}`);return data;
  };
  function sync() {
    const run = getRun();
    if(run?.image_api&&syncedRunId!==run.run_id){syncedRunId=run.run_id;for(const [id,key]of [['apiOperation','operation'],['apiImageCount','n'],['apiImageSize','size'],['apiImageQuality','quality']])if(run.image_api[key]!=null)document.getElementById(id).value=String(run.image_api[key]);}
    if(run?.run_id) mode.value = run.image_api ? 'api':'web';
    mode.disabled = Boolean(run?.run_id) || isBusy() || locked || Boolean(pending);
    operation.disabled = mode.disabled;
    document.querySelector('#newTaskButton').hidden=!(run?.run_id||pending);
    const apiMode = mode.value==='api';
    document.querySelector('#apiModeOptions').hidden=!apiMode;
    document.querySelector('#apiAdvancedOptions').hidden=!apiMode;
    document.querySelector('#apiModeStatus').textContent = config.configured ? `${config.model} · ${config.baseUrl}${operation.value==='generate'?'；纯文字模式不会发送左侧参考图':''}` : '请在设置中填写 API 端点、模型和密钥';
    document.querySelector('#checkBrowser').hidden=apiMode;
    const submit = document.querySelector('#prepareRun');
    if(!isBusy()&&!locked) {
      if(apiMode) submit.textContent=(run?.artifacts||[]).length?'继续评分与选择':(pending||run?.image_api)?'查看 / 恢复本次任务':'开始生成';
      else if(!run?.run_id) submit.textContent='开始生成';
    }
    if(apiMode && run?.image_api){
      document.querySelector('#stageRun').disabled=true;
      document.querySelector('#submitRun').disabled=true;
      document.querySelector('#captureRun').disabled=false;
      document.querySelector('#captureRun').textContent='查看 / 恢复 API 结果';
    }
    const note=document.querySelector('.task-submit-note');
    if(note) note.textContent=apiMode?'点击后开始 API 生图；失败不会自动重试':'点击后通过 ChatGPT 网页版生成；失败不会自动重试';
    refreshSummary();
  }
  async function result(data) {
    showMessage(`${states[data.state]||data.state}。${data.message||''}`);
    if(data.runId) await acceptResult(data);
    if(data.state==='saved'){pending=null;sessionStorage.removeItem(pendingKey);}
    if(data.state==='preparation_failed'&&!Number(getRun()?.submission_attempt_count||0)){pending=null;sessionStorage.removeItem(pendingKey);sessionStorage.removeItem(`${pendingKey}.preparedRun`);}
    sync();return data;
  }
  async function resume() {
    const key=getRun()?.image_api?.job_key || pending;
    if(!key) throw new Error('此 API 任务没有可恢复的编号，请在历史记录查看');
    const current=await request(`/api/image-api/jobs/${encodeURIComponent(key)}`);
    if(['save_failed','saving','submission_uncertain'].includes(current.state)) {
      try{return await result(await request(`/api/image-api/jobs/${encodeURIComponent(key)}/recover`,{method:'POST'}));}
      catch(error){await result(current);showMessage(`${error.message}。系统不会重新发送生成请求。`);return current;}
    }
    return result(current);
  }
  async function submit() {
    if(locked)return;locked=true;sync();
    try {
      const run=getRun();
      if(run?.image_api&&!Number(run.submission_attempt_count||0)&&run.status==='prepared'){
        const marker=`${pendingKey}.preparedRun`;if(sessionStorage.getItem(marker)!==run.run_id){pending=crypto.randomUUID();sessionStorage.setItem(pendingKey,pending);sessionStorage.setItem(marker,run.run_id);}
        return await result(await request(`/api/image-api/runs/${run.run_id}/submit`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmed:true,jobKey:pending})}));
      }
      if(getRun()?.image_api||pending)return await resume();
      if(!config.configured){dialog.showModal();throw new Error('请先保存 API 设置');}
      const form=await buildForm(operation.value);
      const key=crypto.randomUUID();pending=key;sessionStorage.setItem(pendingKey,key);
      form.set('jobKey',key);form.set('confirmed','true');form.set('operation',operation.value);
      form.set('n',document.querySelector('#apiImageCount').value);form.set('size',document.querySelector('#apiImageSize').value);form.set('quality',document.querySelector('#apiImageQuality').value);
      const mask=document.querySelector('#apiMask').files[0];if(mask&&operation.value==='edit')form.set('mask',mask);
      showMessage('正在通过 API 生成并保存。');
      return await result(await request('/api/image-api/jobs',{method:'POST',body:form}));
    } finally {locked=false;sync();}
  }
  function reset(){pending=null;syncedRunId=null;sessionStorage.removeItem(pendingKey);sessionStorage.removeItem(`${pendingKey}.preparedRun`);sync();}
  const open=()=>dialog.showModal();
  document.querySelector('#openGenerationSettings').addEventListener('click',open);
  document.querySelector('#configureImageApi').addEventListener('click',open);
  document.querySelector('#closeGenerationSettings').addEventListener('click',()=>dialog.close());
  settings.addEventListener('submit',async event=>{
    event.preventDefault();const button=settings.querySelector('button[type=submit]');button.disabled=true;
    try{config=await request('/api/image-api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(settings)))});settings.elements.apiKey.value='';document.querySelector('#imageApiSettingsMessage').textContent='设置已保存';chooseInitialMode();sync();await onConfigChanged(config);}
    catch(error){document.querySelector('#imageApiSettingsMessage').textContent=error.message;}
    finally{button.disabled=false;}
  });
  const queryMode=new URLSearchParams(location.search).get('mode');
  const chooseInitialMode=()=>{if(!getRun()?.run_id&&!pending&&!['api','web'].includes(queryMode)&&!localStorage.getItem('ai-img-gen.generation-mode'))mode.value=config.configured?'api':'web';};
  mode.value=['api','web'].includes(queryMode)?queryMode:localStorage.getItem('ai-img-gen.generation-mode')||'web';
  mode.addEventListener('change',()=>{localStorage.setItem('ai-img-gen.generation-mode',mode.value);sync();});operation.addEventListener('change',sync);document.querySelector('#apiImageCount').addEventListener('change',sync);
  request('/api/image-api/config').then(data=>{config=data;chooseInitialMode();for(const name of ['baseUrl','model','resultHosts','generatePath','editPath'])settings.elements[name].value=data[name]||(name==='generatePath'?'images/generations':name==='editPath'?'images/edits':'');sync();if(new URLSearchParams(location.search).get('settings')==='1')open();}).catch(()=>{showMessage('API 设置暂不可用，请检查后端版本或连接');});
  sync();
  if(pending&&!getRun()?.run_id)request(`/api/image-api/jobs/${encodeURIComponent(pending)}`).then(result).catch(error=>showMessage(`${error.message}；原任务编号已保留，尚未再次发送。`));
  return {sync,submit,resume,reset,usesApi:()=>getRun()?.run_id?Boolean(getRun().image_api):mode.value==='api'||Boolean(pending)};
}
