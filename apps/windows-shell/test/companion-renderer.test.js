import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as model from '../renderer/companion-conversation-model.js';

// Runs the real pane script against a minimal DOM stand-in.
async function renderer(initial) {
  const source = (await readFile(new URL('../renderer/companion-conversation.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  const nodes = new Map(); const calls = []; let push;
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { value:'', style:{}, dataset:{}, children:[], scrollTop:0, scrollHeight:100, clientHeight:100,
      handlers:{}, classList:{add(){},toggle(){}}, setAttribute(){}, replaceChildren(){},
      addEventListener(name, fn){this.handlers[name]=fn;}, focus(){this.focused=true;},
      getContext(){return {};}, getBoundingClientRect(){return {top:0};} });
    return nodes.get(id);
  }
  const pages = []; const replies = {};
  const window = { addEventListener(){}, ccf:{onCompanion(fn){push=fn;},async companionAction(payload){calls.push(payload);
    return payload.action==='history'?pages.shift():replies[payload.action]??{ok:true};}} };
  vm.runInNewContext(source, {...model, window, document:{getElementById:node,createElement:node,querySelector:node,body:node('body')},
    crypto:{randomUUID:()=>'send-1'},
    createStructuredConversation:()=>({update(){},suspend(){},showHistory(){}}),renderCompanionTerminal:()=>false,
    installCompanionTextSize:()=>({dispose(){}}),hideClaudePromptBox:lines=>lines,
    ResizeObserver:class{observe(){} disconnect(){}},setTimeout:()=>1,clearTimeout(){},getComputedStyle:()=>({lineHeight:'14'})
  });
  push(initial);
  return {node,push,calls,pages,replies};
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('Claude keeps its draft through hook identity changes and refocuses it after Send',async()=>{
  const ui=await renderer({backend:'claude',connected:true,phase:'idle',conversationId:'before'});
  ui.node('draft').value='Keep this';ui.node('draft').handlers.input();
  ui.push({backend:'claude',connected:true,phase:'working',conversationId:'after'});
  assert.equal(ui.node('draft').value,'Keep this');
  assert.equal(ui.node('backendReason').hidden,true,'ordinary turns show no switch warning');
  assert.equal(ui.node('shutdown').hidden,true,'Claude has no Disconnect button, as on main');
  ui.node('send').handlers.click();await settle();
  assert.equal(ui.calls.find(call=>call.action==='send').text,'Keep this');
  assert.equal(ui.node('draft').value,'');assert.equal(ui.node('draft').focused,true);
});

test('text typed while a send is in flight survives its acceptance',async()=>{
  const ui=await renderer({backend:'claude',connected:true,phase:'idle'});
  let accept;ui.replies.send=new Promise(resolve=>{accept=resolve;});
  ui.node('draft').value='Sent draft';ui.node('draft').handlers.input();ui.node('send').handlers.click();
  ui.node('draft').value='Next draft';ui.node('draft').handlers.input();
  accept({ok:true});await settle();
  assert.equal(ui.node('draft').value,'Next draft');
});

test('backend picker explains a blocked attempt and switches directly when idle',async()=>{
  const ui=await renderer({backend:'claude',connected:true,phase:'working'});
  ui.node('backend').value='codex';await ui.node('backend').handlers.change();
  assert.equal(ui.calls.length,0);assert.equal(ui.node('backendReason').hidden,false);
  ui.push({backend:'claude',connected:true,phase:'idle'});
  assert.equal(ui.node('backendReason').hidden,true);
  ui.node('backend').value='codex';await ui.node('backend').handlers.change();
  assert.equal(ui.calls[0].action,'switch-backend');assert.equal(ui.calls[0].backend,'codex');
});

test('Load older pages back from the resume cursor; Jump to latest starts over there',async()=>{
  const base={backend:'codex',connected:true,phase:'idle',conversationId:'thread'};
  const ui=await renderer(base);
  assert.equal(ui.node('loadOlder').disabled,true,'a new thread has nothing older');
  ui.push({...base,historyCursor:'resume'});
  ui.pages.push({items:[],nextCursor:'page-2'},{items:[],nextCursor:null},{items:[],nextCursor:'page-2'});
  await ui.node('loadOlder').handlers.click();assert.equal(ui.calls.at(-1).cursor,'resume');
  await ui.node('loadOlder').handlers.click();assert.equal(ui.calls.at(-1).cursor,'page-2');
  assert.equal(ui.node('loadOlder').disabled,true,'the oldest page ends paging');
  ui.node('jumpLatest').handlers.click();
  assert.equal(ui.node('loadOlder').disabled,false);
  await ui.node('loadOlder').handlers.click();assert.equal(ui.calls.at(-1).cursor,'resume');
});

test('a trimmed live window starts paging at the newest saved page',async()=>{
  const messages=Array.from({length:500},(_,id)=>({id:String(id),role:'assistant',text:String(id)}));
  const ui=await renderer({backend:'codex',connected:true,phase:'idle',conversationId:'thread',messages,historyCursor:'stale'});
  ui.pages.push({items:[],nextCursor:'older'});
  await ui.node('loadOlder').handlers.click();
  assert.equal(ui.calls[0].action,'history');assert.equal(ui.calls[0].cursor,undefined);
});

test('a history page that arrives after Jump to latest is dropped',async()=>{
  const ui=await renderer({backend:'codex',connected:true,phase:'idle',conversationId:'thread',historyCursor:'resume'});
  let resolvePage;ui.pages.push(new Promise(resolve=>{resolvePage=resolve;}));
  const request=ui.node('loadOlder').handlers.click();
  ui.node('jumpLatest').handlers.click();
  resolvePage({items:[],nextCursor:'stale-next-page'});await request;
  ui.pages.push({items:[],nextCursor:null});
  await ui.node('loadOlder').handlers.click();
  assert.equal(ui.calls[1].cursor,'resume');
});
