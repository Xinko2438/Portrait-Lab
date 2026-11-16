const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const value=v=>v===null||v===undefined||v===''?'未记录':String(v);
const roleLabels={identity:'身份参考',primary_front:'主身份图',identity_support:'身份辅助',template:'模板参考',style_reference:'原模板',clean_original:'修改前成品',annotated_location_guidance:'批注定位图'};
export function comparisonReferences(data){
 const m=data.manifest||{},run=encodeURIComponent(data.runId||m.run_id);const identity=[],template=[];
 for(const [i,r]of(m.identity_references||[]).entries()){
  const item={url:`/api/runs/${run}/references/identity/${i}/file`,name:r.filename||`身份图 ${i+1}`};
  if(m.run_kind!=='artifact_revision'||r.role==='identity_support')identity.push(item);
  if(r.role==='style_reference')template.push(item);
 }
 for(const [i,r]of(m.template_references||[]).entries())template.push({url:`/api/runs/${run}/references/template/${i}/file`,name:r.template_name||r.filename||`模板 ${i+1}`});
 return {identity,template,result:(m.artifacts||[]).map((a,i)=>({url:`/api/runs/${run}/artifacts/${encodeURIComponent(a.artifact_id)}/file`,name:`成品 ${i+1}`,id:a.artifact_id,width:a.width,height:a.height}))};
}
export function generationDetailsMarkup(d={}){
 const fields=[['生成渠道',d.channel_label],['请求模型',d.model],['服务地址',d.provider],['任务方式',({edit:'参考图编辑',generate:'文字生图'})[d.operation]||d.operation],['请求张数',d.requested_count],['已保存张数',d.returned_count],['尺寸',d.size==='auto'?'自动':d.size],['质量',({auto:'自动',low:'低',medium:'中',high:'高'})[d.quality]||d.quality],['耗时',d.elapsed_ms==null?null:`${(d.elapsed_ms/1000).toFixed(1)} 秒`]];
 return `<dl class="generation-detail-grid">${fields.map(([k,v])=>`<div><dt>${k}</dt><dd>${escape(value(v))}</dd></div>`).join('')}</dl><strong>发送内容</strong><p class="subcopy">${escape(d.prompt_evidence?.label||'未记录可确认的发送内容')}</p><pre class="generation-prompt">${escape(value(d.prompt))}</pre><ol class="generation-inputs">${(d.references||[]).map(r=>`<li>${escape(roleLabels[r.role]||r.role||'参考图')} · ${escape(r.name||'未命名')}</li>`).join('')}</ol>`;
}
export function initResultWorkbench({container,onRecall,onRevision,onAnnotate,onOpenRun,onViewChange=()=>{}}){
 let data=null,refs=null,indices={identity:0,template:0,result:0},transforms={},locked=false,opened=false,draftNotes={},annotationChoices={},viewEpoch=0;
 const state=k=>transforms[k]||(transforms[k]={scale:1,x:0,y:0});
 const apply=()=>{for(const k of ['identity','template','result']){const s=state(k),img=container.querySelector(`[data-compare-image="${k}"]`);if(img)img.style.transform=`translate(${s.x*100}%,${s.y*100}%) scale(${s.scale})`;}};
 const result=()=>refs?.result[indices.result];
 const pendingKey=()=>`ai-img-gen.api-revision.${data.runId}.${result()?.id}`;
 function revisionSummary(){
  const a=result(),cfg=data.current_api_config||{},api=data.manifest.image_api||{};const dim=`${a?.width}x${a?.height}`;const size=['1024x1024','1024x1536','1536x1024'].includes(dim)?dim:'auto';
  const summary=container.querySelector('[data-revision-summary]');if(summary)summary.textContent=`${cfg.model||'未配置模型'} · 1 张 · ${size==='auto'?'自动尺寸（原尺寸不在支持列表）':size} · 质量 ${api.quality||'auto'}。使用当前 API 配置；点击才会计费，不自动重试。`;
  const button=container.querySelector('[data-revision-submit]');if(button)button.textContent=sessionStorage.getItem(pendingKey())?'继续查看本次修改（不重发）':'通过 API 修改这一张';
  const annotation=data.manifest.artifact_annotations?.[a?.id];const include=container.querySelector('[data-include-annotations]');if(include){include.disabled=!annotation;include.checked=Boolean(annotation)&&(annotationChoices[a?.id]??true);}
 }
 function changeImage(k){
  const img=container.querySelector(`[data-compare-image="${k}"]`),item=refs[k][indices[k]];if(img){img.hidden=!item;if(item){img.src=item.url;img.alt=item.name;}}
  if(k==='result'){const note=container.querySelector('[data-revision-note]');if(note)note.value=draftNotes[result()?.id]||'';revisionSummary();}
 }
 function render(next){
  const same=data?.runId===next?.runId;const openPanels=same?[...container.querySelectorAll('details[open]')].map(el=>el.className):[];data=next;refs=comparisonReferences(data);
  if(!same){viewEpoch++;indices={identity:0,template:0,result:0};transforms={};draftNotes={};annotationChoices={};}
  for(const k of Object.keys(indices))if(indices[k]>=refs[k].length)indices[k]=0;
  container.hidden=!refs.result.length||!opened;if(!refs.result.length)return;
  const titles={identity:'客户身份图',template:'模板图',result:'当前成品'};
  container.innerHTML=`<div class="result-workbench-toolbar"><strong>参考对照</strong><button type="button" class="secondary compact-action" data-close-workbench>返回评分</button><label><input type="checkbox" data-sync-view> 联动缩放与拖动</label><button type="button" class="secondary compact-action" data-reset-view>适应图片</button><button type="button" class="secondary compact-action" data-recall ${data.reuse?.available?'':'disabled'}>${data.reuse?.via_revision?'沿用原任务设置':'沿用这次设置'}</button></div>
  <label class="mobile-reference-switch">对照参考 <select data-mobile-reference><option value="identity">身份图</option><option value="template">模板图</option></select></label>
  <div class="reference-compare-grid" data-mobile-kind="identity">${['identity','template','result'].map(k=>`<section class="reference-compare-panel" data-compare-panel="${k}"><header><strong>${titles[k]}</strong><select aria-label="选择${titles[k]}" data-compare-select="${k}" ${refs[k].length?'':'disabled'}>${refs[k].length?refs[k].map((r,i)=>`<option value="${i}" ${i===indices[k]?'selected':''}>${escape(r.name)}</option>`).join(''):'<option>无参考图</option>'}</select></header><div class="compare-viewport" data-compare-viewport="${k}" tabindex="0" aria-label="${titles[k]}，可拖动和缩放"><img data-compare-image="${k}" draggable="false" ${refs[k].length?'':'hidden'}></div><label class="compare-zoom">缩放 <input type="range" min="1" max="4" step="0.1" value="${state(k).scale}" data-compare-zoom="${k}" aria-label="${titles[k]}缩放"></label></section>`).join('')}</div>
  <details class="generation-details"><summary>生成详情</summary>${generationDetailsMarkup(data.generation_details)}</details>
  ${data.capabilities?.api_revision?`<details class="api-revision-panel"><summary>修改这一张</summary><p class="subcopy">保留原图，另存修改版。区域修改由模型执行，不保证未修改区域像素完全不变。</p><textarea data-revision-note aria-label="修改要求" maxlength="4000" placeholder="例如：保留人脸和服装，只调亮背景。"></textarea><div class="result-workbench-toolbar"><button type="button" class="secondary compact-action" data-annotate>标记修改区域（可选）</button><label><input type="checkbox" data-include-annotations> 使用已保存批注</label></div><p class="subcopy" data-revision-summary></p><button type="button" class="primary" data-revision-submit>通过 API 修改这一张</button></details>`:''}<div role="status" data-result-status></div>`;
  for(const className of openPanels){const panel=container.querySelector(`details.${className}`);if(panel)panel.open=true;}
  for(const k of ['identity','template','result'])changeImage(k);apply();
 }
 const message=text=>{const el=container.querySelector('[data-result-status]');if(el)el.textContent=text;};
 container.addEventListener('input',event=>{
  if(event.target.matches('[data-revision-note]')){draftNotes[result()?.id]=event.target.value;return;}
  const key=event.target.dataset.compareZoom;if(!key)return;const keys=container.querySelector('[data-sync-view]')?.checked?['identity','template','result']:[key];
  for(const k of keys){state(k).scale=Number(event.target.value);container.querySelector(`[data-compare-zoom="${k}"]`).value=event.target.value;}apply();
 });
 container.addEventListener('change',event=>{
  if(event.target.matches('[data-include-annotations]'))annotationChoices[result()?.id]=event.target.checked;
  if(event.target.dataset.compareSelect){const k=event.target.dataset.compareSelect;indices[k]=Number(event.target.value);changeImage(k);}
  if(event.target.matches('[data-mobile-reference]'))container.querySelector('.reference-compare-grid').dataset.mobileKind=event.target.value;
 });
 let dragging=null;
 container.addEventListener('pointerdown',event=>{const frame=event.target.closest('[data-compare-viewport]');if(!frame)return;const k=frame.dataset.compareViewport;dragging={k,x:event.clientX,y:event.clientY,original:{...state(k)},width:frame.clientWidth,height:frame.clientHeight};frame.setPointerCapture(event.pointerId);});
 container.addEventListener('pointermove',event=>{if(!dragging)return;const {k,x,y,original,width,height}=dragging;const keys=container.querySelector('[data-sync-view]')?.checked?['identity','template','result']:[k];for(const key of keys){state(key).x=original.x+(event.clientX-x)/width;state(key).y=original.y+(event.clientY-y)/height;}apply();});
 container.addEventListener('pointerup',()=>{dragging=null;});container.addEventListener('pointercancel',()=>{dragging=null;});
 container.addEventListener('click',async event=>{
  if(event.target.closest('[data-close-workbench]')){opened=false;container.hidden=true;onViewChange(false);return;}
  if(event.target.closest('[data-reset-view]')){transforms={};for(const range of container.querySelectorAll('[data-compare-zoom]'))range.value=1;apply();return;}
  if(locked)return;
  if(event.target.closest('[data-recall]')){locked=true;try{await onRecall(data);}catch(e){message(e.message);}finally{locked=false;}return;}
  if(event.target.closest('[data-annotate]')){await onAnnotate(data,result().id);return;}
  const button=event.target.closest('[data-revision-submit]');if(!button)return;
  const keyName=pendingKey(),pending=sessionStorage.getItem(keyName);const instruction=container.querySelector('[data-revision-note]').value.trim();const includeAnnotations=container.querySelector('[data-include-annotations]').checked;
  if(!pending&&!instruction&&!includeAnnotations){message('请填写修改要求或保存区域批注。');return;}
  const key=pending||crypto.randomUUID();sessionStorage.setItem(keyName,key);locked=true;button.disabled=true;message(pending?'正在恢复修改任务；不会重发。':'正在修改；请勿重复提交。');
  const epoch=viewEpoch;
  const request={runId:data.runId,artifactId:result().id,instruction,includeAnnotations,annotationSessionId:data.manifest.artifact_annotations?.[result().id]?.annotation_session_id,jobKey:key,recoverOnly:Boolean(pending),expectedApiConfig:{baseUrl:data.current_api_config?.baseUrl,model:data.current_api_config?.model}};
  try{const response=await onRevision(request);if(epoch!==viewEpoch)return;message(response.message||response.state);if(response.runId)await onOpenRun(response.runId);}
  catch(e){
    if([400,403,404,422].includes(e.status)&&!pending)sessionStorage.removeItem(keyName);
    if(e.status===409&&!pending){
      // A completed rejected POST plus a missing ledger proves no task was reserved.
      // Never apply this reset to an ambiguous network failure or an existing task.
      try{await onRevision({...request,recoverOnly:true});}catch(check){if(check.status===404)sessionStorage.removeItem(keyName);}
    }
    if(epoch===viewEpoch)message(e.message);
  }
  finally{locked=false;button.disabled=false;}
 });
 return {render,updateApiConfig(config){if(data){data={...data,current_api_config:config};revisionSummary();}},open(){if(refs?.result.length){opened=true;container.hidden=false;onViewChange(true);}},clear(){viewEpoch++;data=null;opened=false;container.hidden=true;onViewChange(false);}};
}
