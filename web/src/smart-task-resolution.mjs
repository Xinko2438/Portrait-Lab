import {createHash} from 'node:crypto';
import {resolveSmartTask} from '../public/smart-task-state.js';
import {templateRejectionText} from '../public/template-library.js';
import {loadTemplate} from './template-catalog.mjs';
import {assertTemplatesNotRejected,loadTemplateExclusions} from './face-tag-store.mjs';
import {normalizeTaskBrief,rankTemplateCatalog} from './template-selection.mjs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {materializeIdentitySet} from './customer-identity-store.mjs';
import {selectCustomerIdentityFiles} from './customer-photo-selection.mjs';
import {materializeReusedReferences,readVerifiedRunFile,runCustomerId} from './reference-reuse.mjs';
import {loadRun} from './run-store.mjs';
const digest=x=>createHash('sha256').update(x).digest('hex');
export function smartManualFromForm(form){
 try{const value=JSON.parse(String(form.get('smartOverrides')||'{}'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}catch{throw Object.assign(new Error('手动设置格式无效'),{status:422});}
}
export async function resolveSmartSubmission({root,customerId,manual={},identityFiles=[],templateFiles=[],catalogTemplateUids=[],identitySetId=null,visualService=null}){
 const hashes=identityFiles.map(f=>digest(f.bytes));
 const observations=visualService?await visualService.loadEvidence({customerId,hashes,identitySetId}):[];
 const catalogTemplates=[];for(const uid of catalogTemplateUids)catalogTemplates.push(await loadTemplate({root,templateUid:uid}));
 await assertTemplatesNotRejected({root,templateUids:catalogTemplateUids,imageHashes:templateFiles.map(f=>digest(f.bytes))});
 // Uploaded reference remains primary ahead of catalog refs, matching existing transport order.
 const primary=templateFiles.length?null:catalogTemplates[0]||null;
 const result=resolveSmartTask({customerId,manual,observations,identityCount:identityFiles.length,templateCount:templateFiles.length+catalogTemplates.length,template:primary});
 const exclusions=await loadTemplateExclusions({root});
 if(catalogTemplates.length){
  const catalog=JSON.parse((await readFile(join(root,'data/projections/template-catalog.json'),'utf8')).replace(/^\uFEFF/,''));
  const ranking=rankTemplateCatalog({catalog,taskBrief:result.recommendation_brief,excludedTemplateUids:exclusions.template_uids});
  for(const uid of catalogTemplateUids){const excluded=ranking.filter_results.find(e=>e.template_uid===uid&&!e.eligible);if(excluded)result.warnings.push({code:'template_recommendation_advisory',template_uid:uid,reason_codes:excluded.rejection_codes,message:templateRejectionText(excluded.rejection_codes)});}
 }
 const input={customer_id:customerId,identity_hashes:hashes,template_hashes:[...templateFiles.map(f=>digest(f.bytes)),...catalogTemplates.map(t=>t.reference_image.sha256)],manual_overrides:manual,observations,exclusions:exclusions.fingerprint};
 return {...result,customer_id:customerId,manual_overrides:structuredClone(manual),observations,resolution_hash:digest(JSON.stringify(input)),recommendation_brief:normalizeTaskBrief(result.recommendation_brief),
  reference_preflight:{...result.reference_preflight,state:result.ready?(result.warnings.length?'warning':'passed'):'blocked',blocking_issues:[...result.blocking_issues],normalized_reference_plan:result.reference_plan,normalized_customer_context:{business_domain:'',intended_use:result.task_intent.custom_use_case||result.task_intent.use_case}}};
}
export function assertSmartReady(resolution){if(!resolution.ready)throw Object.assign(new Error(resolution.blocking_issues[0]?.message||resolution.conflicts[0]?.message||'请检查本次输入'),{status:422,code:'smart_task_not_ready'});}

export async function smartInputsFromForm({root,form}){
 const files=async name=>Promise.all(form.getAll(name).filter(f=>typeof f!=='string'&&f.size).map(async f=>({name:f.name,bytes:Buffer.from(await f.arrayBuffer())})));
 const customerId=String(form.get('customerId')||'');let customerName=String(form.get('customerName')||'').trim()||'未命名客户';
 if(!/^cust_[a-f0-9]{16}$/.test(customerId))throw Object.assign(new Error('客户草稿已失效，请重新选择客户图'),{status:422});
 let identityFiles=await files('identity'),templateFiles=await files('templates');let identitySetId=String(form.get('identitySetId')||'')||null,identitySource=null;
 let catalogTemplateUids=form.getAll('catalogTemplateUids').map(String);const existingRunId=String(form.get('existingRunId')||'');
 if(existingRunId&&form.get('useStoredReferences')==='true'){
  const run=await loadRun({root,runId:existingRunId});if(runCustomerId(run.manifest)!==customerId)throw Object.assign(new Error('不能跨客户读取原任务'),{status:422});
  identityFiles=await Promise.all((run.manifest.identity_references||[]).map(f=>readVerifiedRunFile(run,f)));
  if(form.get('useStoredTemplates')==='true'){
    templateFiles=await Promise.all((run.manifest.template_references||[]).filter(f=>!f.template_uid).map(f=>readVerifiedRunFile(run,f)));
    catalogTemplateUids=(run.manifest.template_references||[]).map(f=>f.template_uid).filter(Boolean);
  }
  customerName=run.manifest.customer_name;identitySetId=run.manifest.customer_identity_source?.identity_set_id||null;identitySource=run.manifest.customer_identity_source||null;
 }else if(identitySetId&&form.getAll('identityReferenceOrdinals').length){
  const materialized=await materializeIdentitySet({root,customerId,identitySetId});
  const selected=selectCustomerIdentityFiles({customerId,identitySetId,materialized,selectedOrdinals:form.getAll('identityReferenceOrdinals').map(Number),primaryOrdinal:form.get('primaryIdentityReferenceOrdinal'),uploadedFiles:identityFiles,explicitSelection:true});
  identityFiles=selected.files;identitySource=selected.source;customerName=materialized.identitySet.display_name;
 }else if(form.get('sourceRunId')){
  const reused=await materializeReusedReferences({root,sourceRunId:String(form.get('sourceRunId')),customerId,references:JSON.parse(form.get('reuseReferences')||'[]'),identityFiles,templateFiles});identityFiles=reused.identityFiles;templateFiles=reused.templateFiles;
 }
 if(identityFiles.length>4||templateFiles.length+catalogTemplateUids.length>4)throw Object.assign(new Error('身份图和模板图各最多四张'),{status:422});
 return {customerId,customerName,identityFiles,templateFiles,catalogTemplateUids,identitySetId,identitySource};
}
