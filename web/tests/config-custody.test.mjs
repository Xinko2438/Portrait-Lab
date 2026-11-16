import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { imageApiConfig, saveImageApiConfig } from '../src/image-api.mjs';
import { writePrivateConfig } from '../src/private-config.mjs';

const base = fileURLToPath(new URL('../../_work/config-tests/', import.meta.url));
const fake = {baseUrl:'https://example.com/v1',model:'fixture',apiKey:'fake-key-only'};
function aclInfo(path) {
  const command=`$ErrorActionPreference='Stop';Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -Force;Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -Force;$a=Get-Acl -LiteralPath '${path.replaceAll("'","''")}';@{protected=$a.AreAccessRulesProtected;user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;ids=@($a.Access|ForEach-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value})}|ConvertTo-Json -Compress`;
  const probe=spawnSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true});
  assert.equal(probe.status,0,probe.stderr);const result=JSON.parse(probe.stdout);
  assert.ok(result.ids.length>=2);return result;
}
async function fixture(t) {
  await mkdir(base,{recursive:true});
  const root=await mkdtemp(join(base,'case-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return root;
}
test('real configuration save uses durable storage, reads back and retains private ACL on overwrite',async t=>{
  const root=await fixture(t);
  await saveImageApiConfig(root,fake);
  const path=join(root,'data/private-config/image-api-config.json');
  assert.equal(JSON.parse(await readFile(path,'utf8')).apiKey,fake.apiKey);
  await assert.rejects(()=>access(join(root,'.runtime/image-api-config.json')),{code:'ENOENT'});
  await saveImageApiConfig(root,{...fake,apiKey:'',model:'replacement'});
  assert.equal((await imageApiConfig(root,{secret:true})).apiKey,fake.apiKey);
  assert.equal((await imageApiConfig(root)).model,'replacement');
  assert.equal(JSON.stringify(await imageApiConfig(root)).includes(fake.apiKey),false);
  const result=aclInfo(path);
  assert.equal(result.ids.every(id=>[result.user,'S-1-5-18'].includes(id)),true);
});
test('an existing legacy configuration remains readable and is not silently moved or overwritten',async t=>{
  const root=await fixture(t),legacy=join(root,'.runtime/image-api-config.json');
  await mkdir(join(root,'.runtime'));
  const bytes=JSON.stringify(fake);await writeFile(legacy,bytes);
  assert.equal((await imageApiConfig(root,{secret:true})).apiKey,fake.apiKey);
  await assert.rejects(()=>saveImageApiConfig(root,{...fake,model:'changed'}),/迁移|migration/i);
  assert.equal(await readFile(legacy,'utf8'),bytes);
  await assert.rejects(()=>access(join(root,'data/private-config/image-api-config.json')),{code:'ENOENT'});
});
test('bad runtime placement writes no bytes or directories',async t=>{
  const root=await fixture(t),path=join(root,'.runtime/private-config/config.json');
  await assert.rejects(()=>writePrivateConfig({path,ownerRoot:root,ownerId:'project.ai-img-gen',value:fake}),/refused/);
  await assert.rejects(()=>access(join(root,'.runtime')),{code:'ENOENT'});
});
test('two possible configuration sources produce a conflict instead of selecting one silently',async t=>{
  const root=await fixture(t);await saveImageApiConfig(root,fake);
  await mkdir(join(root,'.runtime'));await writeFile(join(root,'.runtime/image-api-config.json'),JSON.stringify({...fake,model:'legacy'}));
  await assert.rejects(()=>imageApiConfig(root),/冲突|conflict/i);
});
test('private directory permissions exist before the writer accepts the first secret byte',async t=>{
  const root=await fixture(t),parent=join(root,'data/private-config'),path=join(parent,'probe.json');
  const script=fileURLToPath(new URL('../src/Write-PrivateConfig.ps1',import.meta.url));
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-CandidatePath',path,'-OwnerRoot',root,'-OwnerId','project.ai-img-gen'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const stopped=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  try {
    let ready=false;
    for(let i=0;i<80;i++) {try{await access(parent);ready=true;break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
    assert.equal(ready,true);
    await assert.rejects(()=>access(path),{code:'ENOENT'});
    const acl=aclInfo(parent);
    assert.equal(acl.protected,true);assert.equal(acl.ids.every(id=>[acl.user,'S-1-5-18'].includes(id)),true);
    child.stdin.end(JSON.stringify(fake));assert.equal(await stopped,0);
  } finally { child.stdin.end();if(child.exitCode===null)child.kill();await stopped; }
});
