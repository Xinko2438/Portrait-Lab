import {loadRun,loadArtifactAnnotation} from './run-store.mjs';
import {readVerifiedRunFile,runCustomerId} from './reference-reuse.mjs';
import {assertTemplatesNotRejected} from './face-tag-store.mjs';
import {extname} from 'node:path';
const fail=message=>Object.assign(new Error(message),{status:422});
export async function prepareApiArtifactRevision({root,parentRunId,parentArtifactId,instruction='',includeAnnotations=false,annotationSessionId=null}){
 const parent=await loadRun({root,runId:parentRunId});if(!parent.manifest.image_api)throw fail('此入口仅用于 API 成品修改');
 const artifact=parent.manifest.artifacts?.find(a=>a.artifact_id===parentArtifactId);if(!artifact)throw fail('原成品不存在');
 const note=String(instruction).trim();if(note.length>4000)throw fail('修改要求过长');
 const files=[{...await readVerifiedRunFile(parent,artifact),name:`clean-original${extname(artifact.path)}`,role:'clean_original'}];
 const inherited=parent.manifest.run_kind==='artifact_revision';const identities=parent.manifest.identity_references||[];const templates=parent.manifest.template_references||[];
 const identity=inherited?identities.find(r=>r.role==='identity_support'):identities[0];const template=inherited?identities.find(r=>r.role==='style_reference'):templates[0];
 if(identity)files.push({...await readVerifiedRunFile(parent,identity),role:'identity_support'});
 if(template){await assertTemplatesNotRejected({root,templateUids:template.template_uid?[template.template_uid]:[],imageHashes:[template.sha256]});files.push({...await readVerifiedRunFile(parent,template),role:'style_reference'});}
 let annotation=null,state=null;
 if(includeAnnotations){
  const loaded=await loadArtifactAnnotation({root,runId:parentRunId,artifactId:parentArtifactId});annotation=loaded.annotation;state=loaded.state;
  if(!annotation||!state||annotation.annotation_session_id!==annotationSessionId||state.original_artifact_sha256!==artifact.sha256)throw fail('批注已变化，请重新打开并保存');
  if(state.annotations?.length)files.push({...await readVerifiedRunFile(parent,{path:annotation.preview_path,sha256:annotation.preview_sha256}),name:'marked-guide.png',role:'annotated_location_guidance'});
 }
 if(!note&&!state?.annotations?.length)throw fail('请填写修改要求或保存至少一个区域批注');
 const roles={clean_original:'干净原成品，是唯一编辑底图，未要求修改的画面以此为准',identity_support:'同一客户身份参考，仅用于保持五官身份，不改变原图构图',style_reference:'原模板，仅辅助理解修改要求涉及的姿势、服装或风格，不继承其中人物身份',annotated_location_guidance:'位置标记预览，仅用于定位，禁止把标记画入结果'};
 const regions=(state?.annotations||[]).map((a,i)=>`${i+1}. ${a.reason_code||'区域'}，相对位置 ${JSON.stringify(a.bounds)}：${String(a.note||'自然修正此区域')}`);
 const prompt=['请编辑第 1 张完整成品，只输出 1 张完整修改结果，不要拼图。',...files.map((f,i)=>`第 ${i+1} 张：${roles[f.role]}。`),'只修改明确要求的部分及必要的自然过渡；保留客户身份、其余服装、姿势、构图、背景与光影。不得添加标记或文字说明。',note?`修改要求：${note}`:'',regions.length?`标记区域：\n${regions.join('\n')}`:'',state?.overall_note?`批注补充：${state.overall_note}`:''].filter(Boolean).join('\n');
 const dimensions=`${artifact.width}x${artifact.height}`;const size=['1024x1024','1024x1536','1536x1024'].includes(dimensions)?dimensions:'auto';
 const quality=['auto','low','medium','high'].includes(parent.manifest.image_api.quality)?parent.manifest.image_api.quality:'auto';
 const source={parent_run_id:parentRunId,parent_artifact_id:parentArtifactId,parent_artifact_sha256:artifact.sha256,instruction:note,annotation_session_id:annotation?.annotation_session_id||null,annotations:state?.annotations||[],overall_note:state?.overall_note||'',input_roles:files.map(f=>f.role)};
 return {operation:'edit',prompt,customerName:parent.manifest.customer_name,n:1,size,quality,identityFiles:files,templateFiles:[],runOptions:{customerId:runCustomerId(parent.manifest),revisionSource:source},saveIdentitySet:false};
}
