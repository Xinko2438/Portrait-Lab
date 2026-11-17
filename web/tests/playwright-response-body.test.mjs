import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { patchPlaywrightSource, ensurePlaywrightResponseBodyPatch } from '../scripts/patch-playwright-response-body.mjs';

const require=createRequire(import.meta.url);
const source=await readFile(require.resolve('playwright-core/lib/coreBundle'),'utf8');
const start=source.indexOf('static createResponseBodyCallback(request2) {');
const end=source.indexOf('\n      constructor(options)',start);
assert.ok(start>0&&end>start,'inspect the pinned SDK native response callback');
const method=source.slice(start,end).trim().replace(/^static /,'');

async function readThroughSdk({url='https://chatgpt.com/backend-api/estuary/content?id=file-output',methodName='GET',mime='image/png',body=''}={}){
 const bytes=Buffer.from('89504e470d0a1a0a11223344','hex');const calls=[];
 const session={async send(name,args){calls.push({name,args});
  if(name==='Network.getResponseBody')return {body,base64Encoded:true};
  if(name==='Network.loadNetworkResource')return {resource:{success:true,httpStatusCode:200,stream:'original-stream'}};
  if(name==='IO.read')return {data:bytes.toString('base64'),base64Encoded:true,eof:true};
  if(name==='IO.close')return {};
  throw Error(`Unexpected native browser command ${name}`);
 }};
 const request={method:()=>methodName,url:()=>url,resourceType:()=> 'fetch',frame:()=>({_id:'original-frame'}),serviceWorker:()=>null,
  _existingResponse:()=>({headerValue:name=>name==='content-type'?mime:null})};
 const sdk=vm.runInNewContext(`({${method}})`,{Buffer,kRefetchSafeResourceTypes:new Set(['image','font','script']),_InterceptableRequest:{from:()=>({session,_requestId:'original-request'})}});
 return {actual:await sdk.createResponseBodyCallback(request)(),bytes,calls};
}

test('real SDK callback recovers an empty ChatGPT image fetch without Content-Length through native streaming',async()=>{
 const {actual,bytes,calls}=await readThroughSdk();assert.deepEqual(actual,bytes);
 assert.deepEqual(calls.map(c=>c.name),['Network.getResponseBody','Network.loadNetworkResource','IO.read','IO.close']);
 const load=calls[1].args;assert.equal(load.url,'https://chatgpt.com/backend-api/estuary/content?id=file-output');
 assert.equal(load.options.includeCredentials,true);assert.equal(load.options.disableCache,true);
 assert.equal(Object.hasOwn(load,'headers'),false,'do not extract or copy browser credentials');
});

test('real SDK callback never refetches unrelated or non-image fetch responses',async()=>{
 for(const options of [{url:'https://example.com/backend-api/estuary/content?id=x'},{url:'https://chatgpt.com/backend-api/conversation'},{mime:'application/json'},{methodName:'POST'}]){
  const {actual,calls}=await readThroughSdk(options);assert.equal(actual.length,0);assert.equal(calls.length,1);
 }
});

test('real SDK callback preserves an already available response without another request',async()=>{
 const body=Buffer.from('existing-image-bytes').toString('base64');
 const {actual,calls}=await readThroughSdk({body});assert.equal(actual.toString(),'existing-image-bytes');assert.equal(calls.length,1);
});

test('the pinned compatibility patch is repeatable and refuses unexpected SDK source',async()=>{
 assert.equal(patchPlaywrightSource(source),source);
 assert.throws(()=>patchPlaywrightSource(source+'\n// unexpected external change'),/Unexpected Playwright source/);
 const state=await ensurePlaywrightResponseBodyPatch();assert.equal(state.applied,false);assert.equal(state.version,'1.66.0-alpha-2026-11-09');
});
