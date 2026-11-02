import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createWindowsShellRuntime } from '../runtime/windows-shell-runtime.js';
import { createFakeElectron } from '../test-support/fake-electron.js';

test('only an explicit startup debug flag enables conversation diagnostics',async t=>{
  for(const [envFlag,argv,expected]of [[undefined,[],false],['1',[],true],[undefined,['--debug-ui'],true],['true',[],false]]){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccf-debug-ui-')),electron=createFakeElectron({home:root,appData:root});
    const session=new EventEmitter();session.getSnapshot=()=>({backend:'codex',connected:false,phase:'offline',messages:[],debugUi:true});session.stop=async()=>{};
    const runtime=createWindowsShellRuntime({electron,processLike:{env:{CCF_HOME_OVERRIDE:root,CCF_APPDATA_OVERRIDE:root,CCF_PORT_OVERRIDE:'0',CCF_TEST_MODE:'1',...(envFlag?{CCF_DEBUG_UI:envFlag}:{})},argv,execPath:process.execPath,pid:process.pid},services:{companionSession:session,
      hookInstaller:{async diagnose(){return{hookExists:true,drift:{healthy:true}};}},mascotLibrary:{list(){return{mascots:[]};},async warmBundledAssets(){}}}});
    try{await runtime.start();assert.equal((await electron.ipcMain.invoke('ccf:get-companion')).debugUi,expected);}finally{await runtime.stop();fs.rmSync(root,{recursive:true,force:true});}
  }
});

test('IPC awaits backend acceptance before marking attachments sent', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccf-ipc-'));
  const electron=createFakeElectron({home:root,appData:root});
  const session=new EventEmitter();
  session.getSnapshot=()=>({backend:'codex',connected:true,phase:'idle',messages:[],conversationId:'thread-fixture'});
  let settle; session.submit=()=>new Promise(resolve=>{settle=resolve;}); session.stop=async()=>{};
  let marked=false;
  const attachments={list:()=>[],select:()=>[{id:'image-a',path:'/synthetic/image.png'}],markSent:()=>{marked=true;}};
  const runtime=createWindowsShellRuntime({electron,processLike:{env:{CCF_HOME_OVERRIDE:root,CCF_APPDATA_OVERRIDE:root,CCF_PORT_OVERRIDE:'0',CCF_TEST_MODE:'1'},argv:[],execPath:process.execPath,pid:process.pid},services:{
    companionSession:session,companionAttachments:attachments,
    hookInstaller:{async diagnose(){return {hookExists:true,drift:{healthy:true},health:{ok:true}};}},
    mascotLibrary:{list(){return {mascots:[]};},async warmBundledAssets(){}}
  }});
  t.after(async()=>{await runtime.stop();fs.rmSync(root,{recursive:true,force:true});});
  await runtime.start();
  const sending=electron.ipcMain.invoke('ccf:companion-action',{action:'send',submissionId:'input-a',draftRevision:2,text:'synthetic',attachmentIds:['image-a']});
  await Promise.resolve(); assert.equal(marked,false);
  settle({id:'input-a',state:'outcomeUnknown',reason:'response lost'});
  assert.equal((await sending).submission.state,'outcomeUnknown'); assert.equal(marked,false);
  const accepted=electron.ipcMain.invoke('ccf:companion-action',{action:'send',submissionId:'input-b',text:'synthetic',attachmentIds:['image-a']});
  await Promise.resolve(); settle({id:'input-b',state:'accepted',turnId:'turn-b'});
  assert.equal((await accepted).submission.state,'accepted');assert.equal(marked,true);
});

test('startup failure releases an allocated delivery writer before returning', async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccf-start-fail-'));
  const electron=createFakeElectron({home:root,appData:root});
  electron.BrowserWindow=class extends electron.BrowserWindow {constructor(){throw new Error('Synthetic window failure');}};
  const runtime=createWindowsShellRuntime({electron,processLike:{env:{CCF_HOME_OVERRIDE:root,CCF_APPDATA_OVERRIDE:root,CCF_PORT_OVERRIDE:'0',CCF_TEST_MODE:'1'},argv:[],execPath:process.execPath,pid:process.pid},services:{
    mascotLibrary:{list(){return{mascots:[]};},async warmBundledAssets(){}}
  }});
  t.after(async()=>{await runtime.stop();fs.rmSync(root,{recursive:true,force:true});});
  await assert.rejects(runtime.start(),/Synthetic window failure/);
  assert.equal(fs.existsSync(path.join(root,'chaos-cat-familiar','companion-delivery.json.writer')),false);
});

test('legacy Claude HUD observations cannot overwrite the selected Codex metrics',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccf-backend-hud-')),electron=createFakeElectron({home:root,appData:root});
  const session=new EventEmitter();session.getSnapshot=()=>({backend:'codex',connected:true,phase:'idle',conversationId:'codex-thread',messages:[]});session.stop=async()=>{};
  const runtime=createWindowsShellRuntime({electron,processLike:{env:{CCF_HOME_OVERRIDE:root,CCF_APPDATA_OVERRIDE:root,CCF_PORT_OVERRIDE:'0',CCF_TEST_MODE:'1'},argv:[],execPath:process.execPath,pid:process.pid},services:{companionSession:session,
    hookInstaller:{async diagnose(){return{hookExists:true,drift:{healthy:true}};}},mascotLibrary:{list(){return{mascots:[]};},async warmBundledAssets(){}}}});
  t.after(async()=>{await runtime.stop();fs.rmSync(root,{recursive:true,force:true});});const started=await runtime.start();
  const settings=JSON.parse(fs.readFileSync(path.join(root,'chaos-cat-familiar','settings.json'),'utf8'));
  const response=await fetch(`http://127.0.0.1:${started.runtime.hookPort}/companion/status`,{method:'POST',headers:{'content-type':'application/json','x-ccf-token':settings.hookToken},body:JSON.stringify({session_id:'claude-other',cwd:path.join(root,'repos','work-companion'),cost:{total_cost_usd:10}})});
  assert.equal(response.status,200);assert.equal(await electron.ipcMain.invoke('ccf:get-companion-status'),null);
});
