// Thin Node adapter over the existing placement policy and native Windows ACLs.
import { spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function assertConfigPath(path) {
  let cursor=resolve(path);
  for (;;) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw Object.assign(new Error('Configuration path crosses a link'),{code:'EUNSAFE'}); }
    catch(error) { if(error.code!=='ENOENT')throw error; }
    const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;
  }
  return resolve(path);
}
export async function readPrivateConfig(path) {
  await assertConfigPath(path);
  return JSON.parse(await readFile(path,'utf8'));
}
export async function writePrivateConfig({path,ownerRoot,ownerId,value}) {
  if(process.platform!=='win32')throw new Error('Private configuration writer requires verified Windows ACL support');
  await assertConfigPath(path);
  const script=fileURLToPath(new URL('./Write-PrivateConfig.ps1',import.meta.url));
  await new Promise((done,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,
      '-CandidatePath',resolve(path),'-OwnerRoot',resolve(ownerRoot),'-OwnerId',ownerId],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='';let errors='';
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});
    const timeout=setTimeout(()=>{child.kill();reject(new Error('Private configuration save timed out'));},20000);
    child.on('error',error=>{clearTimeout(timeout);reject(error);});
    child.stdin.on('error',()=>{});
    child.on('close',code=>{clearTimeout(timeout);if(code===0)done();else reject(Object.assign(new Error(output.trim()||'Private configuration save refused'),{code:'ECUSTODY'}));});
    // Secrets travel only over stdin, never command arguments or diagnostic output.
    child.stdin.end(JSON.stringify(value));
  });
}
