import test from 'node:test';import assert from 'node:assert/strict';
import {comparisonReferences,generationDetailsMarkup,initResultWorkbench}from'../public/result-workbench.js';
test('comparison maps actual transport collections and keeps result images separate',()=>{
 const data={runId:'run-test',manifest:{identity_references:[{role:'clean_original'},{role:'identity_support'},{role:'style_reference'}],template_references:[],artifacts:[{artifact_id:'artifact-one'}],run_kind:'artifact_revision'}};
 const refs=comparisonReferences(data);assert.equal(refs.identity[0].url,'/api/runs/run-test/references/identity/1/file');assert.equal(refs.template[0].url,'/api/runs/run-test/references/identity/2/file');assert.equal(refs.result[0].url,'/api/runs/run-test/artifacts/artifact-one/file');
});
test('generation details display unknown facts and escape content instead of inventing parameters',()=>{
 const html=generationDetailsMarkup({prompt:'<script>bad</script>',prompt_evidence:{label:'历史证据'},references:[]});
 assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('未记录'));assert.ok(!html.includes('<script>'));
});

test('revision recovery distinguishes missing ledger from uncertainty and stale responses cannot replace a new view',async t=>{
 const prior=globalThis.sessionStorage;t.after(()=>{if(prior===undefined)delete globalThis.sessionStorage;else globalThis.sessionStorage=prior;});
 function harness(onRevision){
  const storage=new Map();globalThis.sessionStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  const handlers={},note={value:''},checkbox={checked:false},button={disabled:false},status={textContent:''};
  const elements={'[data-revision-note]':note,'[data-include-annotations]':checkbox,'[data-revision-submit]':button,'[data-result-status]':status};
  const container={querySelectorAll:()=>[],querySelector:s=>elements[s]||null,addEventListener:(n,fn)=>{handlers[n]=fn;}};
  const opened=[];const workbench=initResultWorkbench({container,onRevision,onRecall:async()=>{},onAnnotate:async()=>{},onOpenRun:async id=>opened.push(id)});
  const render=id=>workbench.render({runId:id,manifest:{image_api:{},artifacts:[{artifact_id:'artifact-one'}]},capabilities:{api_revision:true}});
  render('run-parent');note.value='brighten';
  return {storage,opened,workbench,render,click:()=>handlers.click({target:{closest:s=>s==='[data-revision-submit]'?button:null}})};
 }
 const failure=status=>Object.assign(new Error(String(status)),{status});
 const calls=[];const missing=harness(async r=>{calls.push(r);throw failure(r.recoverOnly?404:409);});
 await missing.click();assert.equal(missing.storage.size,0);assert.deepEqual(calls.map(r=>r.recoverOnly),[false,true]);
 await missing.click();assert.deepEqual(calls.map(r=>r.recoverOnly),[false,true,false,true]);assert.notEqual(calls[0].jobKey,calls[2].jobKey);
 for(const action of ['clear','switch']){
  let finish;const pending=new Promise(resolve=>{finish=resolve;});const h=harness(()=>pending);const request=h.click();
  if(action==='clear')h.workbench.clear();else h.render('run-other');
  finish({runId:'run-child',state:'saved'});await request;assert.deepEqual(h.opened,[]);assert.equal(h.storage.size,1);
 }
 const retained=harness(async r=>{if(!r.recoverOnly)throw failure(409);return {state:'submission_uncertain',runId:'run-ledger'};});
 await retained.click();assert.equal(retained.storage.size,1);
 let count=0;const uncertain=harness(async()=>{count++;throw new Error('network uncertain');});await uncertain.click();assert.equal(count,1);assert.equal(uncertain.storage.size,1);
});
