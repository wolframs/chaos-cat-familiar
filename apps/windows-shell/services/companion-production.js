import fs from 'node:fs';
import path from 'node:path';
import {CompanionHabitat} from './companion-habitat.js';
import {CodexCompanionSession} from './codex-companion-session.js';
import {CompanionWatcher} from './companion-watcher.js';

function absolute(value,label){if(typeof value!=='string'||!path.isAbsolute(value))throw new Error(`Configure an absolute ${label} in companion settings.`);return path.resolve(value);}
export function productionCompanionPaths(settings,{home,appData,parentEnv=process.env}){
  const source=absolute(settings.codexCompanionRepoPath,'Codex companion source path');
  const data=absolute(settings.companionDataPath,'companion data path');
  const under=(root,target)=>{const relative=path.relative(root,target);return !relative||relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};
  if(under(source,data)||under(data,source))throw new Error('Companion data and executable source must use separate, non-overlapping roots.');
  const authHome=settings.codexAuthenticationHome ? absolute(settings.codexAuthenticationHome,'Codex home') : (parentEnv.CODEX_HOME??path.join(home,'.codex'));
  const core=absolute(settings.companionCorePath??path.join(data,'habitat','CORE.md'),'shared companion core path');
  if(!under(data,core)||core===data)throw new Error('The shared core document must remain inside the selected companion data root.');
  if(settings.codexAuthenticationMode==='dedicated-codex-home'&&(path.resolve(authHome).toLowerCase()===path.resolve(home,'.codex').toLowerCase()||(parentEnv.CODEX_HOME&&path.resolve(authHome).toLowerCase()===path.resolve(parentEnv.CODEX_HOME).toLowerCase())))throw new Error('A separate Codex home must differ from the existing authentication home.');
  const executable=absolute(settings.codexExecutable??path.join(home,'AppData','Roaming','npm','node_modules','@openai','codex','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe'),'Codex executable');
  const python=absolute(settings.companionPythonExecutable??'C:/Program Files/Python312/python.exe','Python executable');
  const env={...parentEnv,
    COMPANION_ROOT:data,COMPANION_CONFIG:path.join(data,'config'),COMPANION_STATE:path.join(data,'state'),COMPANION_MEMORY_DIR:path.join(data,'memory'),COMPANION_JOURNAL:path.join(data,'journal'),
    COMPANION_CORE:core,COMPANION_OPTMEM:path.join(source,'vendor','optmem','memo'),COMPANION_PREV:path.join(data,'state','sensor-prev.json')};
  if(settings.codexAuthenticationHome)env.CODEX_HOME=authHome;
  return{source,data,authHome,executable,python,env};
}

export function createProductionCompanionServices({getSettings,home,appData,parentEnv=process.env,loadTransport=()=>import('./codex-process-transport.js')}={}){
  let activePaths;
  const habitat=new CompanionHabitat({transportFactory:async()=>{
    activePaths=productionCompanionPaths(getSettings(),{home,appData,parentEnv});const native=await loadTransport();
    return native.createStdioTransport({executable:activePaths.python,args:['-B','-X','utf8','-I',path.join(activePaths.source,'tools','companion_bridge.py'),'--stdio'],cwd:activePaths.data,env:activePaths.env});
  }});
  const codex=new CodexCompanionSession({transportFactory:async options=>{
    const p=activePaths;if(!p)throw new Error('Claim the companion habitat before launching Codex.');
    const native=await loadTransport();
    const transport=await native.createCodexProcessTransport({userInitiated:options.userInitiated,executable:p.executable,cwd:p.data,env:{...p.env,COMPANION_BACKEND:'codex',COMPANION_GENERATION:habitat.reservation?.generation}});
    return transport;
  }});
  // Keep the shared habitat persona and its data-root working directory.
  const originalStart=codex.start.bind(codex);
  codex.start=async options=>{
    const p=activePaths;if(!p)throw new Error('Companion habitat is not reserved.');
    const personaPath=path.join(p.source,'habitat','PERSONA.md');
    const persona=fs.readFileSync(personaPath,'utf8');if(Buffer.byteLength(persona)>65536)throw new Error('Shared companion persona exceeds64KiB.');
    return originalStart({...options,model:options.model??getSettings().codexModel,cwd:p.data,developerInstructions:`${persona}\n\nHabitat tool source: ${p.source}\nData root: ${p.data}\n\n${options.developerInstructions??''}`});
  };
  return{codex,habitat,createWatcher:({delivery,backend})=>{
    if(getSettings().companionSensorsEnabled!==true)return undefined;
    return new CompanionWatcher({delivery,backend,transportFactory:async command=>{
      const native=await loadTransport(),p=activePaths;
      if(!p)throw new Error('Watcher has no claimed habitat.');
      if(command.executable!==p.python||!command.args.includes(path.join(p.source,'tools','watch.py')))throw new Error('Watcher command differs from the owned habitat source.');
      return native.createStdioTransport({executable:command.executable,args:command.args,cwd:p.data,env:{...p.env,...command.environment}});
    }});
  }};
}
