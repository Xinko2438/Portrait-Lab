// Reuse the pinned SDK's native Network.loadNetworkResource/IO.read fallback.
// No page script, credential extraction, new browser or extra image generation.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require=createRequire(import.meta.url);
const version='1.66.0-alpha-2026-11-09';
const originalSha256='9d3260b17408501ba46ca708fa870a7c95e1e3f6e9cc34d799465f17b7d78c50';
const marker='const portraitImageResponse =';
const replacements=[
 ['          const expectedLength = contentLength ? +contentLength : void 0;',
  '          const expectedLength = contentLength ? +contentLength : void 0;\n          const portraitImageResponse = request2.method() === "GET" && /^https:\\/\\/chatgpt\\.com\\/backend-api\\/estuary\\/content(?:\\?|$)/.test(request2.url()) && /^image\\/(?:png|jpeg|webp)(?:;|$)/i.test(request2._existingResponse()?.headerValue("content-type") || "");'],
 ['          if (response2.body || !expectedLength)',
  '          if (response2.body || (!expectedLength && !portraitImageResponse))'],
 ['          if (!kRefetchSafeResourceTypes.has(request2.resourceType())) {',
  '          if (!kRefetchSafeResourceTypes.has(request2.resourceType()) && !portraitImageResponse) {'],
 ['options: { disableCache: false, includeCredentials: true } });',
  'options: { disableCache: portraitImageResponse, includeCredentials: true } });'],
];
const sha=value=>createHash('sha256').update(value).digest('hex');

export function patchPlaywrightSource(source){
 const patched=source.includes(marker);
 let original=source;
 if(patched){
  for(const [before,after] of [...replacements].reverse()){
   if(original.split(after).length!==2)throw Error('Playwright response patch content conflict');
   original=original.replace(after,before);
  }
 }
 if(sha(original)!==originalSha256)throw Error('Unexpected Playwright source; review the pinned response-body patch before upgrading');
 if(patched)return source;
 let result=source;
 for(const [before,after] of replacements){
  if(result.split(before).length!==2)throw Error('Playwright response patch anchor conflict');
  result=result.replace(before,after);
 }
 return result;
}

export async function ensurePlaywrightResponseBodyPatch(){
 const installed=require('playwright-core/package.json').version;
 if(installed!==version)throw Error(`Playwright response patch requires ${version}; got ${installed}`);
 const path=require.resolve('playwright-core/lib/coreBundle');
 const source=await readFile(path,'utf8');const patched=patchPlaywrightSource(source);
 if(patched!==source){
  const temporary=`${path}.portrait-${randomUUID()}.tmp`;
  await writeFile(temporary,patched,'utf8');await rename(temporary,path);
 }
 return {applied:patched!==source,version,sha256:sha(patched)};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
 console.log(JSON.stringify(await ensurePlaywrightResponseBodyPatch()));
}
