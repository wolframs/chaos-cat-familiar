import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {adaptCodexHook} from '../../apps/windows-shell/services/codex-hook-adapter.js';

export async function runCodexHookSender({payload,settings,eventId,post=fetch,onDiagnostic=()=>{}}={}){
  try{
    if(!Number.isInteger(settings?.port)||settings.port<1||settings.port>65535||typeof settings.hookToken!=='string'||!settings.hookToken)throw new Error('connection');
    const observation=adaptCodexHook(payload,eventId?{eventId}:{});
    const body=JSON.stringify(observation);
    for(let attempt=0;attempt<2;attempt++){
      try{const response=await post(`http://127.0.0.1:${settings.port}/codex/hook`,{
        method:'POST',headers:{'content-type':'application/json','x-ccf-token':settings.hookToken},body,redirect:'error',signal:AbortSignal.timeout(500)
      });if(!response.ok)onDiagnostic('CCF observation was not accepted');break;}
      catch{if(attempt===1)onDiagnostic('CCF observation could not be delivered');}
    }
  }catch{onDiagnostic('CCF observation input or connection is unavailable');}
  // Never forward HTTP response content, decisions, continuation or model context.
  return{};
}

async function main(){
  try{
    const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--settings'||!path.isAbsolute(args[1]))throw new Error('settings');
    if(fs.statSync(args[1]).size>64*1024)throw new Error('settings limit');
    const settings=JSON.parse(fs.readFileSync(args[1],'utf8').replace(/^\uFEFF/,''));
    const chunks=[];let size=0;
    for await(const chunk of process.stdin){size+=chunk.length;if(size>1024*1024)throw new Error('input limit');chunks.push(chunk);}
    const payload=JSON.parse(Buffer.concat(chunks,size).toString('utf8').replace(/^\uFEFF/,''));
    await runCodexHookSender({payload,settings,onDiagnostic:message=>process.stderr.write(`${message}\n`)});
  }catch{process.stderr.write('CCF observation was skipped; Codex remains the decision authority.\n');}
  finally{process.stdout.write('{}\n');}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
