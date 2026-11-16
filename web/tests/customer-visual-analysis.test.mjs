import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createCustomerVisualService, createAnalysisThumbnail } from '../src/customer-visual-analysis.mjs';

const customerId = 'cust_0123456789abcdef';
const otherCustomer = 'cust_fedcba9876543210';
const bytes = Buffer.from('original-image-for-injected-thumbnail');
const hash = createHash('sha256').update(bytes).digest('hex');
const observation = {face_count:1,clarity:'good',angle:'left_45',expression:'smile',clothing:'casual',visual_style_tags:['approachable'],confidence:'reliable'};
const response = (value = observation) => new Response(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]}), {headers:{'content-type':'application/json'}});
async function fixture(t, fetchImpl = async () => response()) {
  const root = await mkdtemp(join(tmpdir(), 'visual-analysis-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  return {root, service:createCustomerVisualService({root,fetchImpl,thumbnailImpl:async () => Buffer.from('safe-thumbnail')})};
}

test('original-byte hash cache and concurrent calls send once; persisted cache survives service recreation', async t => {
  let calls=0; let payload;
  const fetchImpl=async (_url,opts) => {calls++;payload=JSON.parse(opts.body);return response();};
  const {root,service}=await fixture(t,fetchImpl);
  const results=await Promise.all(Array.from({length:4},()=>service.analyze({customerId,bytes})));
  assert.equal(calls,1); assert.equal(results[0].image_sha256,hash); assert.deepEqual(results[0].observation,observation);
  assert.equal(payload.store,false); assert.equal(payload.stream,true);
  assert.deepEqual(payload.reasoning,{effort:'low'});assert.equal(payload.max_output_tokens,2000);
  assert.equal(payload.input[1].content.find(x=>x.type==='input_image').image_url,'data:image/jpeg;base64,c2FmZS10aHVtYm5haWw=');
  assert.equal(payload.text.format.strict,true);
  const again=createCustomerVisualService({root,fetchImpl,thumbnailImpl:async()=>{throw Error('must not thumbnail cached input');}});
  assert.equal((await again.analyze({customerId,bytes})).source,'cache'); assert.equal(calls,1);
  assert.equal((await service.publicConfig()).contract.state,'ready');
  assert.equal((await service.status({customerId,imageSha256:hash})).state,'ready');
});

test('unrelated configured models receive no unsupported reasoning parameter',async t=>{
  let payload;const {service}=await fixture(t,async(_url,opts)=>{payload=JSON.parse(opts.body);return response();});
  await service.saveConfig({model:'other-vision-model'});
  await service.analyze({customerId,bytes});
  assert.equal(Object.hasOwn(payload,'reasoning'),false);
});

test('explicit reanalysis requires a unique key and replaying that key cannot spend again',async t=>{
  let calls=0;const {service}=await fixture(t,async()=>{calls++;return response();});
  await service.analyze({customerId,bytes});
  await assert.rejects(service.analyze({customerId,bytes,reanalyze:true}),/idempotency/i);
  await service.analyze({customerId,bytes,reanalyze:true,idempotencyKey:'user-reanalysis-1'});
  await service.analyze({customerId,bytes,reanalyze:true,idempotencyKey:'user-reanalysis-1'});
  assert.equal(calls,2);
});

test('reusing the initial request idempotency key cannot authorize a new reanalysis',async t=>{
  let calls=0;const {service}=await fixture(t,async()=>{calls++;return response();});
  await service.analyze({customerId,bytes,idempotencyKey:'first-selected-photo'});
  await service.analyze({customerId,bytes,reanalyze:true,idempotencyKey:'first-selected-photo'});
  assert.equal(calls,1);
});

test('network and unsupported JSON failures are durable and never automatically retried',async t=>{
  let calls=0;const {root,service}=await fixture(t,async()=>{calls++;throw Error('secret remote diagnostic');});
  assert.equal((await service.analyze({customerId,bytes})).state,'uncertain');
  assert.equal((await service.analyze({customerId,bytes})).state,'uncertain');assert.equal(calls,1);
  const second=createCustomerVisualService({root,fetchImpl:async()=>{calls++;return response({...observation,ethnicity:'forbidden'});},thumbnailImpl:async()=>Buffer.from('safe')});
  assert.equal((await second.analyze({customerId,bytes,reanalyze:true,idempotencyKey:'explicit-next'})).state,'failed');
  assert.equal((await second.analyze({customerId,bytes})).state,'failed');assert.equal(calls,2);
  assert.equal(JSON.stringify(await second.status({customerId,imageSha256:hash})).includes('secret remote'),false);
});

test('customer/config isolation, read-only evidence, config secret redaction and unsafe URL rejection',async t=>{
  let calls=0;const {root,service}=await fixture(t,async()=>{calls++;return response();});
  assert.deepEqual(await service.loadEvidence({customerId,hashes:[hash]}),[]);
  assert.deepEqual(await readdir(root),[]);
  await service.analyze({customerId,bytes});
  assert.deepEqual(await service.loadEvidence({customerId:otherCustomer,hashes:[hash]}),[]);
  await service.analyze({customerId:otherCustomer,bytes});assert.equal(calls,2);
  await service.saveConfig({apiKey:'private-test-key',model:'other-model',endpoint:'https://example.test/v1/responses'});
  assert.equal(JSON.stringify(await service.publicConfig()).includes('private-test-key'),false);
  assert.deepEqual(await service.loadEvidence({customerId,hashes:[hash]}),[]);
  await service.analyze({customerId,bytes});assert.equal(calls,3);
  for(const endpoint of ['http://example.test/v1/responses','https://u:p@example.test/a','https://example.test/a?q=1','https://example.test/a#x']) await assert.rejects(service.saveConfig({endpoint}),/endpoint/i);
  await assert.rejects(service.analyze({customerId:'../cust_0123456789abcdef',bytes}),/customer/i);
  const config=JSON.parse(await readFile(join(root,'.runtime','customer-visual-config.json'),'utf8'));
  assert.equal(config.apiKey,'private-test-key');
});

test('disabled host default prevents provider calls but explicit saved configuration overrides it',async t=>{
  let calls=0;const {root}=await fixture(t);
  const service=createCustomerVisualService({root,defaultEnabled:false,fetchImpl:async()=>{calls++;return response();},thumbnailImpl:async()=>Buffer.from('safe')});
  assert.equal((await service.publicConfig()).enabled,false);
  assert.equal((await service.analyze({customerId,bytes})).state,'disabled');assert.equal(calls,0);
  assert.deepEqual(await readdir(root),[]);
  await service.saveConfig({enabled:true});
  assert.equal((await service.analyze({customerId,bytes})).state,'ready');assert.equal(calls,1);
  const restarted=createCustomerVisualService({root,defaultEnabled:false});
  assert.equal((await restarted.publicConfig()).enabled,true);
});

test('blank or omitted secret preserves existing key only on the same endpoint origin',async t=>{
  const {root,service}=await fixture(t);
  await service.saveConfig({endpoint:'https://first.example.test/v1/responses',apiKey:'first-key'});
  await service.saveConfig({apiKey:'   ',model:'new-model'});
  const configPath=join(root,'.runtime','customer-visual-config.json');
  assert.equal(JSON.parse(await readFile(configPath,'utf8')).apiKey,'first-key');
  await service.saveConfig({endpoint:'https://first.example.test/other/responses'});
  assert.equal(JSON.parse(await readFile(configPath,'utf8')).apiKey,'first-key');
  for(const input of [{endpoint:'https://second.example.test/v1/responses'},{endpoint:'https://second.example.test/v1/responses',apiKey:' '}]){
    await assert.rejects(service.saveConfig(input),error=>error.statusCode===400&&/new API key|new key/i.test(error.message));
    const unchanged=JSON.parse(await readFile(configPath,'utf8'));assert.equal(unchanged.apiKey,'first-key');assert.equal(new URL(unchanged.endpoint).hostname,'first.example.test');
  }
  await service.saveConfig({endpoint:'https://second.example.test/v1/responses',apiKey:'second-key'});
  assert.equal(JSON.parse(await readFile(configPath,'utf8')).apiKey,'second-key');
  assert.equal(JSON.stringify(await service.publicConfig()).includes('second-key'),false);
});

test('Responses SSE completion is parsed and redirect response is never followed',async t=>{
  const sse=`event: response.output_text.delta\ndata: ${JSON.stringify({type:'response.output_text.delta',delta:JSON.stringify(observation)})}\n\nevent: response.completed\ndata: ${JSON.stringify({type:'response.completed',response:{status:'completed'}})}\n\ndata: [DONE]\n\n`;
  const {service}=await fixture(t,async(_url,opts)=>{assert.equal(opts.redirect,'error');return new Response(sse,{headers:{'content-type':'text/event-stream'}});});
  assert.deepEqual((await service.analyze({customerId,bytes})).observation,observation);
});

test('abandoned persisted pending request becomes uncertain and only explicit reanalysis resumes',async t=>{
  let calls=0;const {root,service}=await fixture(t,async()=>{calls++;return response();});
  await service.analyze({customerId,bytes});
  const dir=join(root,'data','customer-visual-analysis',customerId);
  const summary=(await readdir(dir)).find(name=>name.endsWith('.json'));
  const old=JSON.parse(await readFile(join(dir,summary),'utf8'));
  const pending={...old,state:'pending',started_at:'2020-01-01T00:00:00.000Z'};delete pending.observation;
  await writeFile(join(dir,summary),JSON.stringify(pending));
  assert.equal((await service.status({customerId,imageSha256:hash})).state,'uncertain');
  assert.equal((await service.analyze({customerId,bytes})).state,'uncertain');assert.equal(calls,1);
  assert.equal((await service.analyze({customerId,bytes,reanalyze:true,idempotencyKey:'recover-abandoned'})).state,'ready');assert.equal(calls,2);
});

test('bad schemas, incomplete streams and oversized responses never become usable observations',async t=>{
  const responses=[
    ()=>response({...observation,face_count:1.5}),
    ()=>response({...observation,visual_style_tags:['intelligent']}),
    ()=>response({...observation,angle:'primary_front'}),
    ()=>new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:JSON.stringify(observation)})+'\n\n',{headers:{'content-type':'text/event-stream'}}),
    ()=>new Response('x'.repeat(512*1024+1)),
    ()=>new Response('',{status:302,headers:{location:'https://untrusted.test/'}}),
  ];
  for(let index=0;index<responses.length;index++){
    const {service}=await fixture(t,async()=>responses[index]());
    const result=await service.analyze({customerId,bytes});assert.equal(result.state,'failed');assert.equal(result.observation,undefined);
    assert.equal((await service.publicConfig()).contract.state,'unverified');
  }
});

test('human angle overlays one model analysis while model count, clothing and style remain usable',async t=>{
  let calls=0;
  const {root,service}=await fixture(t,async()=>{calls++;return response({...observation,face_count:2,clothing:'formal',visual_style_tags:['editorial']});});
  const identitySetId='ids_0123456789abcdef01234567';
  const dir=join(root,'data','customers',customerId,'identity-sets',identitySetId);await mkdir(dir,{recursive:true});
  await writeFile(join(dir,'identity-set.json'),JSON.stringify({customer_id:customerId,identity_set_id:identitySetId,references:[{sha256:hash,role:'primary_front'}]}));
  assert.deepEqual(await service.loadEvidence({customerId,identitySetId,hashes:[hash]}),[]);
  const event={event_type:'FaceTagConfirmed',event_id:'confirmed-a',subject_kind:'identity',subject_id:hash,image_sha256:hash,customer_id:customerId,identity_set_id:identitySetId,tag:{horizontal:'image_right_profile',usability:'clear',mouth:'closed'}};
  await writeFile(join(dir,'face-tag-events.jsonl'),JSON.stringify(event)+'\n');
  const result=await service.analyze({customerId,identitySetId,bytes});
  assert.equal(result.source,'model');assert.equal(result.observation.angle,'full_profile');assert.equal(result.observation.clarity,'good');
  assert.equal(result.observation.face_count,2);assert.equal(result.observation.clothing,'formal');assert.deepEqual(result.observation.visual_style_tags,['editorial']);assert.equal(calls,1);
  assert.equal(result.visual_analysis_state,'ready');assert.equal(result.human_authority.event_id,'confirmed-a');
  const cached=await service.analyze({customerId,identitySetId,bytes});assert.equal(cached.source,'cache');assert.equal(calls,1);
  const evidence=await service.loadEvidence({customerId,identitySetId,hashes:[hash]});
  assert.equal(evidence[0].observation.angle,'full_profile');assert.deepEqual(evidence[0].observation.visual_style_tags,['editorial']);
  const raw=await service.status({customerId,imageSha256:hash});assert.equal(raw.observation.angle,'left_45');
  await service.saveConfig({enabled:false,model:'another-model'});
  const humanOnly=await service.analyze({customerId,identitySetId,bytes});
  assert.equal(humanOnly.source,'human');assert.equal(humanOnly.state,'ready');assert.equal(humanOnly.visual_analysis_state,'disabled');assert.equal(humanOnly.observation.face_count,undefined);assert.equal(calls,1);
  await service.saveConfig({enabled:true});
  const failed=createCustomerVisualService({root,fetchImpl:async()=>{throw Error('offline');},thumbnailImpl:async()=>Buffer.from('safe')});
  const failedHuman=await failed.analyze({customerId,identitySetId,bytes});
  assert.equal(failedHuman.state,'ready');assert.equal(failedHuman.visual_analysis_state,'uncertain');assert.equal(failedHuman.observation.face_count,undefined);
});

test('real Pillow helper removes EXIF, keeps all image content, limits dimensions, and rejects non-images',async()=>{
  const executable=process.env.AI_IMG_GEN_PYTHON||'python';
  const fixture=spawnSync(executable,['-c',"from PIL import Image; import sys; im=Image.new('RGB',(1800,600),'red'); exif=Image.Exif(); exif[270]='private marker'; im.save(sys.stdout.buffer,format='JPEG',exif=exif)"],{maxBuffer:1024*1024});
  assert.equal(fixture.status,0,fixture.stderr.toString());
  const original=Buffer.from(fixture.stdout);const thumbnail=await createAnalysisThumbnail(original);
  assert.equal(original.equals(fixture.stdout),true);
  const check=spawnSync(executable,['-c',"from PIL import Image; import sys,json,io; im=Image.open(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({'size':im.size,'exif':dict(im.getexif()),'format':im.format}))"],{input:thumbnail});
  assert.equal(check.status,0);const info=JSON.parse(check.stdout.toString());
  assert.deepEqual(info.size,[1024,341]);assert.deepEqual(info.exif,{});assert.equal(info.format,'JPEG');
  assert.equal(thumbnail.includes(Buffer.from('private marker')),false);
  await assert.rejects(createAnalysisThumbnail(Buffer.from('not an image')),/image|thumbnail/i);
});
