import test from 'node:test';import assert from 'node:assert/strict';
import {resolveSmartTask,setManualParameter} from '../public/smart-task-state.js';
import {createRecommendationController} from '../public/template-library.js';
import {createSmartTaskWorkflow} from '../public/smart-task-workflow.js';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from './managed-config-fixture.mjs';import {join} from 'node:path';
import {createRunSnapshot,loadRun,reviseRunPreparation,recordRunEvent,beginRunSubmissionAttempt} from '../src/run-store.mjs';
import {resolveSmartSubmission} from '../src/smart-task-resolution.mjs';
import {preparePromptCompilation} from '../src/intelligent-workbench/prompt-recipe-runtime.mjs';
import {createImageApiService,saveImageApiConfig} from '../src/image-api.mjs';
test('image-first defaults allow unknown angle without inventing frontal coverage',()=>{
 const r=resolveSmartTask({customerId:'cust_1234567890abcdef',identityCount:1,templateCount:1});
 assert.equal(r.ready,true);assert.equal(r.task_intent.use_case,'custom');assert.equal(r.task_intent.target_face_angle,'follow_identity');assert.deepEqual(r.reference_plan.identity_angles,[]);assert.equal(r.reference_plan.target_angle,'follow_identity');
});

test('analysis reports explicit loading, success, disabled and failure states without language inference',async t=>{
 const previousDocument=globalThis.document;t.after(()=>{if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;});
 globalThis.document={addEventListener(){},querySelectorAll(){return [];},getElementById(){return null;}};
 for(const state of ['ready','idle','error']){
  const states=[];const resolution=resolveSmartTask({customerId:'cust_1234567890abcdef',identityCount:1,templateCount:1});
  const workflow=createSmartTaskWorkflow({getForm:()=>{const form=new FormData();form.set('sourceRunId','fixture');form.set('reuseReferences',JSON.stringify([{role:'identity',ordinal:0}]));return form;},isEnabled:()=>true,onResolution(){},onRecommend(){},onStatus:(_message,detail)=>states.push(detail.state),fetchImpl:async url=>url==='/api/customer-visual-analysis'?(state==='error'?Response.json({error:'fixture unavailable'},{status:503}):Response.json({entries:[{state:state==='ready'?'ready':'disabled'}]})):Response.json({resolution})});
  await workflow.resolveNow({analyze:true});assert.deepEqual(states,['analyzing',state]);workflow.clear();assert.equal(states.at(-1),'idle');
 }
});
test('template fills automatic fields while manual constraints stay locked and recommendation does not follow template',()=>{
 const manual=setManualParameter({},'targetFraming','full_body');const input={customerId:'cust_1234567890abcdef',identityCount:1,templateCount:1,manual};
 const a=resolveSmartTask({...input,template:{selection_tags:{portrait_scale:'bust',style_category:'clean_magazine'}}});
 assert.equal(a.task_intent.target_framing,'full_body');assert.equal(a.parameters.targetFraming.source,'manual');assert.ok(a.conflicts.some(c=>c.field==='targetFraming'));
 const b=resolveSmartTask({...input,template:{selection_tags:{portrait_scale:'full_body',style_category:'cinematic'}}});
 assert.deepEqual(a.recommendation_brief,b.recommendation_brief);assert.equal(b.conflicts.length,0);
 const reset=resolveSmartTask({...input,manual:setManualParameter(manual,'targetFraming',null),template:{selection_tags:{portrait_scale:'bust'}}});assert.equal(reset.task_intent.target_framing,'bust');
});
test('trusted visual observations are soft ranking cues and ambiguous faces block plainly',()=>{
 const base={customerId:'cust_1234567890abcdef',identityCount:1,templateCount:1};
 const r=resolveSmartTask({...base,observations:[{state:'ready',observation:{face_count:1,clarity:'good',angle:'unknown',visual_style_tags:['professional'],confidence:'uncertain'}}]});
 assert.equal(r.ready,true);assert.deepEqual(r.recommendation_brief.style_keywords,[]);assert.ok(r.recommendation_brief.free_text_intent.includes('professional'));
 const blocked=resolveSmartTask({...base,observations:[{state:'ready',observation:{face_count:2,clarity:'good'}}]});assert.equal(blocked.ready,false);assert.match(blocked.blocking_issues[0].message,/多人/);
});
test('human-confirmed angle remains usable when the model is uncertain without promoting its other fields',()=>{
 const r=resolveSmartTask({customerId:'cust_1234567890abcdef',identityCount:1,templateCount:1,manual:{targetFaceAngle:'left_45'},observations:[{state:'ready',human_authority:{fields:['angle']},observation:{face_count:1,clarity:'unknown',angle:'left_45',confidence:'uncertain',visual_style_tags:[]}}]});
 assert.deepEqual(r.reference_plan.identity_angles,['left_45']);assert.equal(r.ready,true);
});
test('explicit follow-template and slight-turn resolve consistently or explain missing evidence',()=>{
 const base={customerId:'cust_1234567890abcdef',identityCount:1,templateCount:1,observations:[{state:'ready',observation:{face_count:1,clarity:'good',angle:'frontal',confidence:'reliable'}}]};
 const profile=resolveSmartTask({...base,manual:{targetFaceAngle:'follow_template'},template:{selection_tags:{face_angle:'full_profile'}}});assert.equal(profile.ready,true);assert.ok(profile.conflicts.some(c=>c.field==='targetFaceAngle'));
 const slight=resolveSmartTask({...base,manual:{targetFaceAngle:'slight_turn'}});assert.equal(slight.reference_plan.target_angle,'slight_turn');assert.equal(slight.task_intent.target_face_angle,'slight_turn');
 const front=resolveSmartTask({...base,manual:{targetFaceAngle:'follow_template'},template:{selection_tags:{face_angle:'front_15_degree'}}});assert.equal(front.ready,true);assert.equal(front.reference_plan.target_angle,'frontal');
});

test('a slower recommendation response cannot overwrite a newer selection',async()=>{
 const pending=[];const controller=createRecommendationController({fetch:()=>new Promise(resolve=>pending.push(resolve))});
 const a=controller.requestRecommendations({use_case:'a'});const b=controller.requestRecommendations({use_case:'b'});
 pending[1](Response.json({selection:{selection_id:'sel_new',top4:[]}}));await b;
 pending[0](Response.json({selection:{selection_id:'sel_old',top4:[]}}));await assert.rejects(()=>a,/过期/);assert.equal(controller.getSelectionId(),'sel_new');
});

test('restoring a saved selection discards a recommendation requested before hydration',async()=>{
 let complete;const controller=createRecommendationController({fetch:()=>new Promise(resolve=>{complete=resolve;})});
 const pending=controller.requestRecommendations({use_case:'old'});
 const outcome=pending.then(()=>({accepted:true}),error=>({error}));
 controller.setSelectionState({selection_id:'sel_restored',task_brief:{use_case:'restored'},top4:[]});
 complete(Response.json({selection:{selection_id:'sel_old',top4:[]}}));
 const result=await outcome;assert.match(result.error?.message||'',/过期/);assert.equal(controller.getSelectionId(),'sel_restored');
});

test('workflow restore clear and reanalyze immediately discard an already pending recommendation',async t=>{
 const previousDocument=globalThis.document;t.after(()=>{if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;});
 for(const transition of ['restore','clear','reanalyze'])await t.test(transition,async()=>{
  let clickReanalyze,completeRecommendation,started,finishFreshResolution;
  const began=new Promise(resolve=>{started=resolve;});
  globalThis.document={addEventListener(){},querySelectorAll(){return [];},getElementById(id){return id==='reanalyzeCustomer'?{addEventListener(_event,handler){clickReanalyze=handler;}}:null;}};
  const controller=createRecommendationController({fetch:()=>new Promise(resolve=>{completeRecommendation=resolve;started();})});
  const resolution=resolveSmartTask({customerId:'cust_1234567890abcdef',identityCount:1,templateCount:1});let resolutions=0;
  const workflow=createSmartTaskWorkflow({getForm:()=>new FormData(),isEnabled:()=>true,onResolution(){},onStatus(){},onRevision:()=>controller.invalidatePendingRecommendations(),onRecommend:value=>controller.requestRecommendations(value.recommendation_brief),fetchImpl:async()=>{
   if(++resolutions===1)return Response.json({resolution});
   return new Promise(resolve=>{finishFreshResolution=resolve;});
  }});
  const pending=workflow.resolveNow({recommend:true}).then(()=>({accepted:true}),error=>({error}));await began;
  if(transition==='restore')workflow.restore({targetFraming:'full_body'});else if(transition==='clear')workflow.clear();else clickReanalyze();
  completeRecommendation(Response.json({selection:{selection_id:'sel_old',top4:[]}}));
  const result=await pending;workflow.clear();finishFreshResolution?.(Response.json({resolution}));
  assert.match(result.error?.message||'',/过期/);assert.equal(controller.getSelectionId(),null);
 });
});

test('workflow restore and clear discard a resolution that arrives after the transition',async t=>{
 const previousDocument=globalThis.document;t.after(()=>{if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;});
 globalThis.document={addEventListener(){},getElementById(){return null;},querySelectorAll(){return [];}};
 for(const transition of ['restore','clear']){
  let complete;const applied=[];let recommendations=0;
  const workflow=createSmartTaskWorkflow({getForm:()=>new FormData(),isEnabled:()=>true,onResolution:r=>applied.push(r),onRecommend(){recommendations++;},onStatus(){},fetchImpl:()=>new Promise(resolve=>{complete=resolve;})});
  const pending=workflow.resolveNow({recommend:true});
  if(transition==='restore')workflow.restore({targetFraming:'full_body'});else workflow.clear();
  complete(Response.json({resolution:resolveSmartTask({customerId:'cust_1234567890abcdef',identityCount:1,templateCount:1})}));
  assert.equal(await pending,null);assert.equal(workflow.resolution,null);assert.deepEqual(applied,[]);assert.equal(recommendations,0);workflow.clear();
 }
});

test('a Run creation key cannot replay different taskResolution evidence',async t=>{
 const root=await mkdtemp(join(tmpdir(),'smart-create-idempotency-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const input={root,customerId:'cust_1234567890abcdef',customerName:'fixture',prompt:'unchanged prompt',identityFiles:[{name:'face.png',bytes:Buffer.from('identity')}],templateFiles:[{name:'template.png',bytes:Buffer.from('template')}],runCreationIdempotencyKey:'same-smart-create-key'};
 const firstResolution=await resolveSmartSubmission(input);
 const created=await createRunSnapshot({...input,taskResolution:firstResolution});
 const replay=await createRunSnapshot({...input,taskResolution:firstResolution});assert.equal(replay.runId,created.runId);
 const changedResolution=await resolveSmartSubmission({...input,manual:{targetFraming:'full_body'}});
 assert.notEqual(changedResolution.resolution_hash,firstResolution.resolution_hash);
 await assert.rejects(()=>createRunSnapshot({...input,taskResolution:changedResolution}),error=>error.code==='run_creation_idempotency_conflict');
 assert.equal((await readdir(join(root,'data','runs'))).length,1);
});
test('history-only identity references trigger analysis and participate in the local input key',async t=>{
 const previousDocument=globalThis.document;t.after(()=>{if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;});globalThis.document={addEventListener(){},getElementById(){return null;},querySelectorAll(){return [];}};
 let source='run-source-a',calls=0;const resolution=resolveSmartTask({customerId:'cust_1234567890abcdef',identityCount:1,templateCount:1});
 const workflow=createSmartTaskWorkflow({getForm:()=>{const f=new FormData();f.set('customerId','cust_1234567890abcdef');f.set('sourceRunId',source);f.set('reuseReferences',JSON.stringify([{role:'identity',ordinal:0,sha256:'a'.repeat(64)}]));return f;},isEnabled:()=>true,onResolution(){},onRecommend(){},onStatus(){},fetchImpl:async url=>{if(url==='/api/customer-visual-analysis'){calls++;return Response.json({entries:[]});}return Response.json({resolution});}});
 await workflow.resolveNow({analyze:true});await workflow.resolveNow({analyze:true});assert.equal(calls,1);source='run-source-b';await workflow.resolveNow({analyze:true});assert.equal(calls,2);workflow.clear();
});

test('blocked unknown-angle Run is revised append-only with same id and cannot change after an attempt',async t=>{
 const root=await mkdtemp(join(tmpdir(),'smart-reprepare-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const files=[{name:'face.png',bytes:Buffer.from('identity')}],templates=[{name:'template.png',bytes:Buffer.from('template')}];
 const created=await createRunSnapshot({root,customerName:'customer',customerId:'cust_1234567890abcdef',prompt:'original',identityFiles:files,templateFiles:templates,referencePlan:{identityAngles:[],targetAngle:'frontal',targetFraming:'follow_template'},customerContext:{intendedUse:'portrait'}});
 assert.equal(created.manifest.reference_preflight.state,'blocked');
 const original=await readFile(join(created.runDir,'prompt.txt'),'utf8');
 const resolution=await resolveSmartSubmission({root,customerId:'cust_1234567890abcdef',identityFiles:files,templateFiles:templates});
 const compilation={compiled_prompt:'resolved prompt',compiler_id:'test',prompt_sha256:'a'.repeat(64)};
 const revised=await reviseRunPreparation({root,runId:created.runId,resolution,promptCompilation:compilation,identityFiles:files,templateFiles:templates});
 assert.equal(revised.runId,created.runId);assert.notEqual(revised.manifest.reference_preflight.state,'blocked');assert.equal(revised.manifest.reference_plan.target_angle,'follow_identity');
 assert.equal(await readFile(join(created.runDir,'prompt.txt'),'utf8'),original);assert.equal((await readdir(join(root,'data','runs'))).length,1);
 await reviseRunPreparation({root,runId:created.runId,resolution,promptCompilation:compilation});assert.equal((await loadRun({root,runId:created.runId})).events.filter(e=>e.type==='RunPreparationRevised').length,1);
 await recordRunEvent({root,runId:created.runId,type:'RunStaged'});await beginRunSubmissionAttempt({root,runId:created.runId});
 await assert.rejects(()=>reviseRunPreparation({root,runId:created.runId,resolution,promptCompilation:compilation}),/已经尝试发送/);
});

test('API output edits change preparation identity and concurrent prepared sends keep one Run and one request',async t=>{
 const root=await mkdtemp(join(tmpdir(),'smart-api-existing-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
 await saveImageApiConfig(root,{baseUrl:'https://example.com/v1',model:'fixture-model',apiKey:'test-only'});
 const files=[{name:'face.png',bytes:png}],templates=[{name:'template.png',bytes:png}];
 const created=await createRunSnapshot({root,customerId:'cust_1234567890abcdef',customerName:'fixture',prompt:'original',identityFiles:files,templateFiles:templates,imageApi:{operation:'edit',n:1,size:'1024x1536',quality:'auto'}});
 const resolution=await resolveSmartSubmission({root,customerId:'cust_1234567890abcdef',identityFiles:files,templateFiles:templates});const promptCompilation={compiled_prompt:'prepared exact prompt',compiler_id:'fixture'};
 const first=await reviseRunPreparation({root,runId:created.runId,resolution,promptCompilation,apiParameters:{n:1,size:'1024x1536',quality:'auto'}});
 const second=await reviseRunPreparation({root,runId:created.runId,resolution,promptCompilation,apiParameters:{n:4,size:'1024x1024',quality:'high'}});
 assert.notEqual(second.manifest.preparation_revision_id,first.manifest.preparation_revision_id);assert.equal(second.manifest.image_api.n,4);
 let calls=0;const fetchImpl=async(_url,req)=>{calls++;assert.equal(req.body.get('n'),'4');assert.equal(req.body.get('prompt'),'prepared exact prompt');return Response.json({data:[{b64_json:png.toString('base64')}]});};
 const a=createImageApiService({root,fetchImpl}),b=createImageApiService({root,fetchImpl});
 const results=await Promise.all([a.submitPrepared('prepared-key-first',created.runId),b.submitPrepared('prepared-key-second',created.runId)]);
 assert.equal(calls,1);assert.ok(results.every(r=>r.runId===created.runId));assert.equal((await readdir(join(root,'data','runs'))).length,1);
 const after=await loadRun({root,runId:created.runId});assert.equal(after.manifest.submission_attempt_count,1);assert.equal(after.manifest.image_api.job_key,'prepared-key-first');
});
