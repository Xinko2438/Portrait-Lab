import {readFile,realpath} from 'node:fs/promises';
import {relative,isAbsolute,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {loadRun} from './run-store.mjs';
import {customerIdFromName} from '../public/task-intent.js';
import {assertTemplatesNotRejected} from './face-tag-store.mjs';
const fail=message=>Object.assign(new Error(message),{status:422});
export function runCustomerId(manifest){return manifest.customer_id || manifest.customer_scope?.customer_id || manifest.customer_identity_source?.customer_id || customerIdFromName(manifest.customer_name);}
export async function readVerifiedRunFile(run,file){
 if(!file?.path || !/^[a-f0-9]{64}$/i.test(file.sha256||''))throw fail('原图片引用不完整');
 let path,base;try{[path,base]=await Promise.all([realpath(file.path),realpath(run.runDir)]);}catch{throw fail('原图片不存在，请重新选择');}
 const rel=relative(base,path);if(rel.startsWith('..')||isAbsolute(rel))throw fail('图片引用超出原任务');
 const bytes=await readFile(path);if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw fail('原图片校验失败，请重新选择');
 return {bytes,name:file.filename || file.name || basename(file.path),role:file.role,face_angle:file.face_angle};
}
export function buildReuseDescriptor(run){
 const m=run.manifest;const references=[];
 // Revision transport files are not a new customer's identity pool.
 if(m.run_kind!=='artifact_revision')for(const role of ['identity','template'])for(const [i,r]of(m[`${role}_references`]||[]).entries())references.push({role,ordinal:i+1,sha256:r.sha256,name:r.filename || r.template_name || `${role}-${i+1}`,template_uid:r.template_uid || null,url:`/api/runs/${run.runId}/references/${role}/${i}/file`});
 return {source_run_id:run.runId,customer_id:runCustomerId(m),customer_name:m.customer_name||'',references,task_intent:m.task_intent||null,manual_overrides:m.task_resolution?.manual_overrides||null,channel:m.image_api?'api':'web',api_settings:m.image_api?{operation:m.image_api.operation,n:m.image_api.n,size:m.image_api.size,quality:m.image_api.quality,model:m.image_api.model,provider:m.image_api.provider}:null,available:m.run_kind!=='artifact_revision'};
}
export async function materializeReusedReferences({root,sourceRunId,customerId,references=[],identityFiles=[],templateFiles=[]}){
 if(!/^run-[a-zA-Z0-9-]+$/.test(sourceRunId||''))throw fail('原任务引用无效');
 const run=await loadRun({root,runId:sourceRunId});if(customerId!==runCustomerId(run.manifest))throw fail('不能跨客户沿用身份参考图');
 if(!Array.isArray(references)||references.length>8)throw fail('图片引用过多');
 const output={identityFiles,templateFiles,sourceRunId};
 const seen=new Set();
 for(const r of references){
  if(!r||Object.keys(r).some(k=>!['role','ordinal','sha256','position'].includes(k))||!['identity','template'].includes(r.role)||!Number.isInteger(r.ordinal)||r.ordinal<1||!Number.isInteger(r.position)||r.position<0||r.position>3)throw fail('图片引用无效');
  const key=`${r.role}:${r.ordinal}`;if(seen.has(key))throw fail('图片引用重复');seen.add(key);
 }
 for(const role of ['identity','template']){
  const refs=references.filter(r=>r.role===role);const uploads=output[`${role}Files`];const count=refs.length+uploads.length;if(count>4)throw fail('每种参考图最多四张');
  const ordered=Array(count);for(const ref of refs){
   if(ref.position>=count||ordered[ref.position])throw fail('图片引用位置无效');
   const file=run.manifest[`${role}_references`]?.[ref.ordinal-1];if(!file||file.sha256!==ref.sha256)throw fail('图片引用校验失败');
   if(role==='template'&&file.template_uid)throw fail('目录模板须从当前推荐重新校验，不能作为上传图片绕过');
   const material=await readVerifiedRunFile(run,file);
   if(role==='template')await assertTemplatesNotRejected({root,imageHashes:[file.sha256]});
   ordered[ref.position]=material;
  }
  let next=0;for(let i=0;i<count;i++)if(!ordered[i])ordered[i]=uploads[next++];output[`${role}Files`]=ordered;
 }
 return output;
}
