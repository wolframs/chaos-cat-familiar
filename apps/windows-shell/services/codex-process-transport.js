import { spawn, execFile } from 'node:child_process';

/** Private stdio child using the operator's ordinary environment and config. */
export async function createStdioTransport({executable,args=[],cwd,env=process.env,
  spawnProcess=spawn,execFileProcess=execFile,platform=process.platform}={}) {
  const child=spawnProcess(executable,args,{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let exited=false,spawned=false,stopPromise,stderr='';
  child.once('spawn',()=>{spawned=true;});
  const closed=new Promise((resolve,reject)=>{
    child.once('close',(code,signal)=>{exited=true;resolve({code,signal});});
    child.on('error',error=>{if(!spawned){exited=true;reject(error);}else stderr=(stderr+'\n'+error.message).slice(-65536);});
  });
  closed.catch(()=>{});
  child.stdin.on('error',()=>{});
  child.stdout.on('error',()=>{});
  child.stderr.on('error',()=>{});
  child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-65536);});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  const stop=()=>stopPromise??=(async()=>{
    if(exited)return;
    if(platform==='win32') {
      await new Promise((resolve,reject)=>execFileProcess('taskkill.exe',['/PID',String(child.pid),'/T','/F'],
        {windowsHide:true,timeout:10000},error=>{if(error&&!exited)reject(error);else resolve();}));
    } else child.kill();
    let timer;
    try { await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Companion process did not stop')),10000);})]); }
    finally {clearTimeout(timer);}
  })();
  return {readable:child.stdout,writable:child.stdin,stderr:child.stderr,closed,stop,
    getDiagnostics(){
      let safe=stderr.replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]{12,}/g,'[redacted]');
      for(const[key,value]of Object.entries(env))if(/TOKEN|SECRET|PASSWORD|KEY/i.test(key)&&value?.length>=8)safe=safe.split(value).join('[redacted]');
      return{stderr:safe,stderrLimited:stderr.length>=65536,closed:exited};
    }};
}

export function createCodexProcessTransport({userInitiated,executable,cwd,env,...options}={}) {
  if(userInitiated!==true)throw new Error('Codex requires an explicit user start');
  return createStdioTransport({...options,executable,args:['app-server','--listen','stdio://'],cwd,env});
}
