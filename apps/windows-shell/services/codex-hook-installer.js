import fs from 'node:fs';
import path from 'node:path';
import {writeJsonAtomic} from '../../../packages/core/src/atomic-json.js';
import {CODEX_OBSERVATION_EVENTS} from './codex-hook-adapter.js';

const MARKER='CCF session observation (codex)';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function quoted(value){
  if(typeof value!=='string'||!path.isAbsolute(value)||/[\r\n"`$%!^&|<>]/.test(value))throw new Error('Hook executable and file paths must be absolute and contain no shell expansion characters');
  return `"${value}"`;
}
function validate(source){
  if(!plain(source)||source.schemaVersion!=null&&source.schemaVersion!==1||source.version!=null&&source.version!==1)throw new Error('Unsupported Codex hooks configuration schema');
  if(source.hooks!=null&&!plain(source.hooks))throw new Error('Malformed Codex hooks configuration');
  for(const groups of Object.values(source.hooks??{})){
    if(!Array.isArray(groups)||groups.some(group=>!plain(group)||!Array.isArray(group.hooks)||group.hooks.some(handler=>!plain(handler))))throw new Error('Malformed Codex hooks configuration');
  }
  return source;
}

/** Explicit installation never changes config.toml, project trust or hook trust hashes. */
export class CodexHookInstaller{
  constructor({codexHome,nodeExecutable,senderPath,settingsPath}={}){
    if(typeof codexHome!=='string'||!path.isAbsolute(codexHome))throw new Error('An explicit absolute CODEX_HOME is required');
    this.codexHome=path.resolve(codexHome);this.filePath=path.join(this.codexHome,'hooks.json');
    this.command=`${quoted(nodeExecutable)} ${quoted(senderPath)} --settings ${quoted(settingsPath)}`;
  }
  read(){
    try{if(fs.statSync(this.filePath).size>1024*1024)throw new Error('Codex hooks configuration exceeds its size limit');
      const raw=fs.readFileSync(this.filePath,'utf8');let source;
      try{source=JSON.parse(raw.replace(/^\uFEFF/,''));}catch{throw new Error('Malformed Codex hooks configuration; original file preserved');}
      return{source:validate(source),raw};
    }catch(error){if(error.code==='ENOENT')return{source:{hooks:{}},raw:null};throw error;}
  }
  withoutOwned(source){
    const next=structuredClone(source);next.hooks??={};
    for(const [event,groups]of Object.entries(next.hooks)){
      const retained=groups.flatMap(group=>{
        const hooks=group.hooks.filter(handler=>!(handler.type==='command'&&handler.statusMessage===MARKER&&(handler.command===this.command||handler.commandWindows===this.command)));
        if(hooks.length===group.hooks.length)return[group];
        return hooks.length?[{...group,hooks}]:[];
      });
      if(retained.length||groups.length===0)next.hooks[event]=retained;else delete next.hooks[event];
    }
    return next;
  }
  save(next,raw){
    const current=fs.existsSync(this.filePath)?fs.readFileSync(this.filePath,'utf8'):null;
    if(current!==raw)throw new Error('Codex hooks configuration changed during installation; original file preserved');
    const serialized=JSON.stringify(next,null,2);
    if(serialized!==raw)writeJsonAtomic(this.filePath,next);
    return serialized!==raw;
  }
  install({userInitiated}={}){
    if(userInitiated!==true)throw new Error('Codex hook installation requires an explicit user action');
    const{source,raw}=this.read();const next=this.withoutOwned(source);
    for(const event of CODEX_OBSERVATION_EVENTS){next.hooks[event]??=[];next.hooks[event].push({matcher:'',hooks:[{type:'command',command:this.command,commandWindows:this.command,statusMessage:MARKER,timeout:3,async:event!=='SessionEnd'}]});}
    const changed=this.save(next,raw);
    return{ok:true,changed,filePath:this.filePath,registeredEvents:[...CODEX_OBSERVATION_EVENTS],trustReviewRequired:true,trustStatus:'not-inspected',nextAction:'Open /hooks in Codex to review and trust these exact definitions; hooks must also be enabled in the selected configuration.'};
  }
  remove({userInitiated}={}){
    if(userInitiated!==true)throw new Error('Codex hook removal requires an explicit user action');
    const{source,raw}=this.read();if(raw===null)return{ok:true,changed:false,filePath:this.filePath};
    return{ok:true,changed:this.save(this.withoutOwned(source),raw),filePath:this.filePath};
  }
}
