export const SMART_TASK_POLICY='image-first-task-v1';
export const SMART_FIELDS=['useCase','targetFraming','targetFaceAngle','layoutIntent','temperamentKeywords','styleCategory','userSupplement'];
const frames=new Set(['follow_template','close_up','bust','half_body','three_quarter','full_body','environmental_portrait']);
const angles=new Set(['follow_identity','follow_template','front','slight_turn','left_45','right_45','profile']);
const layouts=new Set(['follow_template','no_text','copy_left','copy_right','copy_top','copy_bottom']);
const uses=new Set(['custom','personal_ip_poster','professional_portrait','livestream_cover','social_avatar','course_promotion','company_profile','event_poster','lifestyle_portrait']);
const temperaments=new Set(['professional','trustworthy','approachable','premium','cool','energetic','calm','technological','editorial','cinematic']);
const visualWords={professional:'专业',trustworthy:'可信',approachable:'亲和',premium:'高级',cool:'酷感',energetic:'活力',calm:'沉稳',technological:'科技感',editorial:'杂志感',cinematic:'电影感'};
const rankingAngles=a=>({frontal:['front','front_15_degree','front_30_degree'],front:['front','front_15_degree','front_30_degree'],left_45:['left_45','side_45_degree'],right_45:['right_45','side_45_degree'],profile:['full_profile','profile_90_degree'],full_profile:['full_profile','profile_90_degree']})[a]||[];
const legacyAngle=a=>({frontal:'frontal',front:'frontal',left_45:'left_45',right_45:'right_45',full_profile:'full_profile',profile:'full_profile',slight_turn:'slight_turn'})[a]||null;
const catalogAngle=a=>({front_15_degree:'frontal',front_30_degree:'slight_turn',side_45_degree:'side_45_degree',extreme_side:'full_profile'})[a]||legacyAngle(a);
const templateFrame=value=>({headshot:'close_up',closeup:'close_up',chest_up:'bust'})[value]||(frames.has(value)?value:'follow_template');
export function setManualParameter(current,field,value){
 if(!SMART_FIELDS.includes(field))throw new Error('未知的可调整参数');const next={...current};
 if(value==null||value===''||(Array.isArray(value)&&!value.length))delete next[field];else next[field]=Array.isArray(value)?[...value]:String(value);return next;
}
export function resolveSmartTask({customerId,identityCount=0,templateCount=0,template=null,manual={},observations=[]}={}){
 if(!/^cust_[a-f0-9]{16}$/.test(customerId||''))throw new Error('客户草稿作用域无效');
 if(!manual||typeof manual!=='object'||Array.isArray(manual)||Object.keys(manual).some(k=>!SMART_FIELDS.includes(k)))throw new Error('手动参数格式无效');
 for(const [key,set]of [['useCase',uses],['targetFraming',frames],['targetFaceAngle',angles],['layoutIntent',layouts]])if(manual[key]!=null&&!set.has(manual[key]))throw new Error('手动参数值无效');
 if(manual.temperamentKeywords&&(!Array.isArray(manual.temperamentKeywords)||manual.temperamentKeywords.some(t=>!temperaments.has(t))))throw new Error('风格参数值无效');
 if(String(manual.userSupplement||'').length>8000||String(manual.styleCategory||'').length>100)throw new Error('补充要求过长');
 const trusted=observations.filter(x=>x.state==='ready'&&x.observation);const visual=trusted.map(x=>x.observation);
 const actual=[...new Set(trusted.filter(e=>e.observation.confidence==='reliable'||e.human_authority?.fields?.includes('angle')).map(e=>legacyAngle(e.observation.angle)).filter(Boolean))];
 const cues=[...new Set(visual.flatMap(o=>(o.visual_style_tags||[]).filter(v=>temperaments.has(v))))];
 const tags=template?.selection_tags||template||{};const frame=templateFrame(tags.portrait_scale);
 const parameters={};const choose=(key,fallback,source='default')=>{const locked=Object.hasOwn(manual,key);parameters[key]={value:locked?manual[key]:fallback,source:locked?'manual':source,manual:locked};return parameters[key].value;};
 const useCase=choose('useCase','custom');
 const targetFraming=choose('targetFraming',frame,template?'template':'default');
 const targetFaceAngle=choose('targetFaceAngle','follow_identity');
 const layoutIntent=choose('layoutIntent','follow_template',template?'template':'default');
 const temperamentKeywords=choose('temperamentKeywords',cues,cues.length?'visual':'default');
 const styleCategory=choose('styleCategory',tags.style_category||'',template?'template':'default');
 const supplement=choose('userSupplement','');
 const conflicts=[],blocking=[],warnings=[];
 if(!identityCount)blocking.push({code:'identity_required',message:'请上传或选择客户图。'});
 if(!templateCount)blocking.push({code:'template_required',message:'请选一张模板图。'});
 if(visual.some(o=>o.face_count>1))blocking.push({code:'multiple_faces',message:'客户图中有多人，请换成明确的单人照片。'});
 if(visual.some(o=>o.face_count===0||o.clarity==='poor'))blocking.push({code:'identity_unusable',message:'所选客户图未检测到清晰人脸，请换一张清晰照片。'});
 if(!actual.length)warnings.push({code:'angle_unknown',message:'没有可靠角度记录，默认保留客户图的自然朝向，不将它冒充正脸。'});
 if(manual.targetFraming&&manual.targetFraming!=='follow_template'&&frame!=='follow_template'&&manual.targetFraming!==frame)conflicts.push({field:'targetFraming',template_value:frame,message:'你指定的景别与主模板不同，将优先使用你的设置。'});
 if(manual.styleCategory&&tags.style_category&&manual.styleCategory!==tags.style_category)conflicts.push({field:'styleCategory',template_value:tags.style_category,message:'你指定的风格与主模板不同，将优先使用你的设置。'});
 const templateAngle=catalogAngle(tags.face_angle);
 const requested=targetFaceAngle==='follow_template'?templateAngle:legacyAngle(targetFaceAngle);
 const compatible=requested==='slight_turn'?actual.some(a=>['frontal','slight_turn'].includes(a)):requested==='side_45_degree'?actual.some(a=>['left_45','right_45'].includes(a)):actual.includes(requested);
 if(targetFaceAngle==='follow_identity'&&templateAngle&&!actual.includes(templateAngle))warnings.push({code:'face_follows_identity',message:'保留模板动作与风格，脸部朝向跟随客户图。'});
 if(targetFaceAngle==='follow_template'&&!templateAngle)conflicts.push({field:'targetFaceAngle',template_value:'follow_identity',message:'主模板没有可靠的角度资料，建议跟随客户图的自然朝向。'});
 else if(requested&&!compatible)conflicts.push({field:'targetFaceAngle',template_value:'follow_identity',message:'当前照片没有对应角度的可靠参考，将按你指定的角度生成，相似度可能受影响。'});
 const preferredAngles=manual.targetFaceAngle&&!manual.targetFaceAngle.startsWith('follow_')?rankingAngles(manual.targetFaceAngle):actual.flatMap(rankingAngles);
 const recommendation_brief={customer_scope_id:customerId,use_case:manual.useCase||'portrait',style_keywords:manual.styleCategory?[manual.styleCategory]:[],target_portrait_scales:manual.targetFraming&&manual.targetFraming!=='follow_template'?[manual.targetFraming]:[],target_face_angles:[...new Set(preferredAngles)],temperament_keywords:(manual.temperamentKeywords||[]).map(v=>visualWords[v]||v),free_text_intent:[manual.userSupplement||'',...cues.flatMap(v=>[v,visualWords[v]||''])].join(' ').trim()};
 if(manual.styleCategory)recommendation_brief.hard_style_categories=[manual.styleCategory];
 if(manual.targetFraming&&manual.targetFraming!=='follow_template')recommendation_brief.hard_portrait_scales=[manual.targetFraming];
 warnings.push(...conflicts.map(c=>({code:'manual_template_advisory',message:c.message})));
 return {policy_version:SMART_TASK_POLICY,parameters,conflicts,blocking_issues:blocking,warnings,ready:!blocking.length,recommendation_brief,
  task_intent:{use_case:useCase,custom_use_case:useCase==='custom'?'人物写真':'',target_framing:targetFraming,target_face_angle:targetFaceAngle,layout_intent:layoutIntent,temperament_keywords:temperamentKeywords,user_supplement:supplement},
  reference_plan:{identity_angles:actual,target_angle:requested||'follow_identity',template_angle:templateAngle||'',target_framing:targetFraming,template_framing:frame},
  style_category:styleCategory,
  reference_preflight:{policy_version:'portrait-reference-preflight-smart-v1',state:blocking.length?'blocked':warnings.length?'warning':'passed',blocking_issues:[...blocking],warnings},
 };
}
