import {setManualParameter,SMART_FIELDS} from './smart-task-state.js';
const fieldIds={useCase:'intendedUse',targetFraming:'targetFraming',targetFaceAngle:'targetIntentAngle',layoutIntent:'layoutIntent',styleCategory:'smartStyleCategory',userSupplement:'userSupplement'};
const sourceLabel={manual:'手动指定',template:'跟随主模板',visual:'来自照片分析',default:'系统默认'};
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createSmartTaskWorkflow({getForm,isEnabled,onResolution,onRecommend,onStatus,onRevision=()=>{},fetchImpl=fetch}){
 let manual={},resolution=null,revision=0,timer=null,analysisKey=null,analysisFlight=null,config=null,analyzing=false;
 const hashCache=new WeakMap();
 const reusedIdentity=form=>{try{const refs=JSON.parse(form.get('reuseReferences')||'[]');return Array.isArray(refs)?refs.filter(r=>r.role==='identity'):[];}catch{return [];}};
 const request=async(url,options={})=>{const response=await fetchImpl(url,{...options,headers:{'x-smart-task-client':'workstation',...(options.headers||{})}});const body=await response.json();if(!response.ok)throw Object.assign(new Error(typeof body.error==='string'?body.error:body.error?.message||'任务解析暂不可用'),{status:response.status});return body;};
 async function inputKey(form){
  const images=form.getAll('identity').filter(f=>typeof f!=='string'&&f.size);const hashes=[];
  for(const file of images){let hash=hashCache.get(file);if(!hash){hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(n=>n.toString(16).padStart(2,'0')).join('');hashCache.set(file,hash);}hashes.push(hash);}
  return JSON.stringify([form.get('customerId'),form.get('identitySetId'),form.getAll('identityReferenceOrdinals'),form.get('storedReferenceHashes'),hashes,form.get('sourceRunId'),reusedIdentity(form)]);
 }
 function formNow(){const form=getForm();form.set('smartTask','true');form.set('smartOverrides',JSON.stringify(manual));return form;}
 function applyFields(value){
  for(const [field,id]of Object.entries(fieldIds)){const el=document.getElementById(id),p=value.parameters[field];if(el&&p&&el.value!==String(p.value))el.value=String(p.value);}
  for(const el of document.querySelectorAll('[name=temperamentKeywords]'))el.checked=value.parameters.temperamentKeywords.value.includes(el.value);
  for(const el of document.querySelectorAll('[data-smart-source]')){const p=value.parameters[el.dataset.smartSource];el.textContent=p?sourceLabel[p.source]:'';}
  const conflicts=document.getElementById('smartTaskConflicts');if(conflicts){conflicts.hidden=!value.conflicts.length;conflicts.innerHTML=value.conflicts.map(c=>`<p>${escape(c.message)}</p>`).join('')+(value.conflicts.length?'<button type="button" class="secondary compact-action" data-smart-resolve-conflicts>使用建议设置</button>':'');}
 }
 async function resolveNow({recommend=false,analyze=false,forceAnalysis=false}={}){
  if(!isEnabled())return null;const token=revision;const form=formNow();
  if(analyze){
   const key=await inputKey(form);if(token!==revision)return null;
   const hasImages=form.getAll('identity').some(f=>typeof f!=='string'&&f.size)||form.getAll('identityReferenceOrdinals').length||form.get('useStoredReferences')==='true'||(form.get('sourceRunId')&&reusedIdentity(form).length);
   if(hasImages&&(key!==analysisKey||forceAnalysis)){
    analysisKey=key;analyzing=true;onStatus('正在看图分析；切换模板和参数不会重复分析。');
    if(forceAnalysis){form.set('reanalyze','true');form.set('analysisIdempotencyKey',crypto.randomUUID());}
    const flight=request('/api/customer-visual-analysis',{method:'POST',body:form});analysisFlight=flight;
    try{const data=await flight;if(token!==revision)return null;config=data.config;
      const entries=data.entries||[];const ready=entries.filter(e=>e.state==='ready');
      const fullyAnalyzed=ready.filter(e=>!e.visual_analysis_state||e.visual_analysis_state==='ready');
      onStatus(fullyAnalyzed.length===entries.length&&entries.length?`已分析 ${ready.length} 张客户图（同图使用缓存）；用于视觉匹配，不判断真实人格。`:ready.some(e=>e.source?.includes('human'))?'已采用人工确认的照片资料；视觉风格分析尚未完成，不会自动重试。':entries.some(e=>e.state==='disabled')?'看图分析未开启；当前仅按模板和手动设置推荐。':'部分照片分析未完成；不会自动重试，可继续按模板操作。');
    }catch(error){if(token===revision)onStatus(`看图分析未完成：${error.message}。可继续选模板，不自动重试。`);}
    finally{if(analysisFlight===flight){analysisFlight=null;analyzing=false;if(token!==revision&&isEnabled())schedule({semantic:false});}}
   }
  }
  const response=await request('/api/task-resolutions',{method:'POST',body:formNow()});if(token!==revision)return null;
  resolution=response.resolution;applyFields(resolution);onResolution(resolution);
  if(recommend&&(resolution.parameters&&!(resolution.blocking_issues||[]).some(i=>['identity_required','multiple_faces','identity_unusable'].includes(i.code))))await onRecommend(resolution);
  return resolution;
 }
 function schedule({semantic=true}={}){if(semantic){revision++;onRevision();}clearTimeout(timer);if(!isEnabled())return;const token=revision;timer=setTimeout(()=>resolveNow({analyze:true,recommend:true}).catch(e=>{if(token===revision)onStatus(e.message);}),450);}
 function changed(event){
  const target=event?.target;if(!target)return;
  const entry=Object.entries(fieldIds).find(([,id])=>target.id===id);
  if(entry)manual=setManualParameter(manual,entry[0],target.value);
  else if(target.name==='temperamentKeywords')manual=setManualParameter(manual,'temperamentKeywords',[...document.querySelectorAll('[name=temperamentKeywords]:checked')].map(e=>e.value));
  schedule();
 }
 document.addEventListener('click',event=>{
  const reset=event.target.closest('[data-smart-auto]');if(reset){manual=setManualParameter(manual,reset.dataset.smartAuto,null);schedule();}
  if(event.target.closest('[data-smart-resolve-conflicts]')){for(const c of resolution?.conflicts||[])manual=setManualParameter(manual,c.field,null);schedule();}
 });
 document.getElementById('reanalyzeCustomer')?.addEventListener('click',()=>{revision++;onRevision();clearTimeout(timer);resolveNow({analyze:true,recommend:true,forceAnalysis:true}).catch(e=>onStatus(e.message));});
 async function prepare(){clearTimeout(timer);const token=revision;if(analysisFlight)await analysisFlight.catch(()=>{});if(token!==revision)throw new Error('输入已更新，已取消这次发送，请核对后再点击发送。');const value=await resolveNow({analyze:true,recommend:false});if(!value)throw new Error('输入已更新，请核对后再点击发送。');if(!value.ready)throw new Error(value.blocking_issues[0]?.message||value.conflicts[0]?.message||'请检查参考图');return value;}
 return {schedule,changed,prepare,resolveNow,get resolution(){return resolution;},get manual(){return structuredClone(manual);},get analyzing(){return analyzing;},formNow,
  restore(overrides={}){manual={};for(const key of SMART_FIELDS)if(overrides[key]!=null)manual=setManualParameter(manual,key,overrides[key]);revision++;onRevision();resolution=null;},
  clear(){revision++;onRevision();clearTimeout(timer);manual={};resolution=null;analysisKey=null;},
  async loadConfig(){config=await request('/api/customer-visual-analysis/config');return config;},
  async saveConfig(input){config=await request('/api/customer-visual-analysis/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});analysisKey=null;schedule();return config;},
 };
}
