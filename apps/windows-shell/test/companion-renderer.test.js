import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as model from '../renderer/companion-conversation-model.js';

// Runs the real pane script against a minimal DOM stand-in.
async function renderer(initial, { frames = () => null, getCompanion = null } = {}) {
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
    return payload.action==='history'?pages.shift():replies[payload.action]??{ok:true};},...(getCompanion?{getCompanion}:{})} };
  vm.runInNewContext(source, {...model, window, subscribeFrames: frames, promptKeySequence: (event) => event.raw ?? null,
    document:{getElementById:node,createElement:node,querySelector:node,body:node('body')},
    crypto:{randomUUID:()=>'send-1'},
    createStructuredConversation:()=>({update(){},suspend(){},showHistory(){}}),renderCompanionTerminal:()=>false,
    installCompanionTextSize:()=>({dispose(){}}),hideClaudePromptBox:lines=>lines,
    ResizeObserver:class{observe(){} disconnect(){}},setTimeout:()=>1,clearTimeout(){},getComputedStyle:()=>({lineHeight:'14'})
  });
  if (initial !== undefined) push(initial);
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

// Process-split plan, step 5: raw terminal input is lossless and ordered with one batch in flight.
test('raw keys typed while one batch is in flight join the next batch, in order, none dropped', async () => {
  const ui = await renderer({ backend: 'claude', connected: true, phase: 'idle' });
  const releases = [];
  const pending = () => new Promise((resolve) => releases.push(() => resolve({ ok: true })));
  ui.replies['raw-input'] = pending();
  const key = (raw) => ui.node('draft').handlers.keydown({ raw, preventDefault() {} });
  key('\x1b[A');
  ui.replies['raw-input'] = pending();
  key('\x1b[B'); key('\r'); key('y');
  const raw = () => ui.calls.filter((call) => call.action === 'raw-input').map((call) => call.text);
  assert.deepEqual(raw(), ['\x1b[A'], 'one batch in flight');
  releases.shift()(); await settle(); await settle();
  assert.deepEqual(raw(), ['\x1b[A', '\x1b[B\ry'], 'the keys typed meanwhile, joined in order');
  releases.shift()(); await settle();
  assert.equal(raw().length, 2, 'nothing left over');
});

// Review of step 5 (P2): keys typed while a batch was refused, or for a PTY that has since been replaced, were flushed
// into the next batch, so after a restart old-session keys reached the new session.
test('raw keys are bound to their PTY: refused or outdated keys are dropped visibly, never sent to another PTY', async () => {
  const ui = await renderer({ backend: 'claude', connected: true, phase: 'idle', ptyId: 'pty-1' });
  const raw = () => ui.calls.filter((call) => call.action === 'raw-input').map((call) => [call.text, call.ptyId]);
  const key = (value) => ui.node('draft').handlers.keydown({ raw: value, preventDefault() {} });
  let refuse;
  ui.replies['raw-input'] = new Promise((_resolve, reject) => { refuse = reject; });
  key('1');
  key('2');   // waits behind the batch in flight
  refuse(new Error('The terminal session changed'));
  await settle(); await settle();
  assert.deepEqual(raw(), [['1', 'pty-1']], 'keys typed behind a refused batch are not sent');
  assert.match(ui.node('prompt').textContent, /not sent/);

  ui.node('prompt').textContent = '';
  let accept;
  ui.replies['raw-input'] = new Promise((resolve) => { accept = resolve; });
  key('3');
  key('4');   // waits behind '3', typed for pty-1
  ui.push({ backend: 'claude', connected: true, phase: 'idle', ptyId: 'pty-2' });   // a restarted companion
  key('5');
  key('6');
  assert.deepEqual(raw(), [['1', 'pty-1'], ['3', 'pty-1']], 'one batch in flight');
  assert.match(ui.node('prompt').textContent, /not sent/, 'the key for the replaced PTY is dropped visibly');
  ui.replies['raw-input'] = { ok: true };
  accept({ ok: true });
  await settle(); await settle();
  assert.deepEqual(raw(), [['1', 'pty-1'], ['3', 'pty-1'], ['56', 'pty-2']], "only the new PTY's keys follow");
});

test('frames from the companion port render, with the debug flag main sent', async () => {
  let onFrame = null;
  let options = null;
  const ui = await renderer({ backend: 'claude', connected: false, phase: 'offline', debugUi: true },
    { frames: (value) => { options = value; onFrame = value.onFrame; return { close() {} }; } });
  assert.equal(options.service, 'companion');
  assert.equal(options.whileVisible, true);
  onFrame({ backend: 'claude', connected: true, phase: 'working', title: 'From the port', messages: [], terminal: { needed: false } });
  assert.equal(ui.node('title').textContent, 'From the port');
});

// Final review, item 4 (the design-reload smoke): after a reload under a test preview, the port's first frame (the live
// companion, not connected) came before getCompanion's answer, which then counted as stale: the page showed the live
// frame with a disabled draft instead of the preview. A preview from main stands until main replaces it.
test('a page reloaded under a test preview shows the preview, even when a port frame came first', async () => {
  let onFrame = null;
  let answer;
  const ui = await renderer(undefined, { frames: (value) => { onFrame = value.onFrame; return { close() {} }; },
    getCompanion: () => new Promise((resolve) => { answer = resolve; }) });
  onFrame({ backend: 'claude', connected: false, phase: 'offline', title: 'Live, offline', messages: [], terminal: { needed: false } });
  assert.equal(ui.node('title').textContent, 'Live, offline');
  answer({ backend: 'claude', connected: true, phase: 'idle', title: 'Fixture preview', preview: true, messages: [], attachments: [],
    terminal: { needed: false } });
  await settle();
  assert.equal(ui.node('title').textContent, 'Fixture preview');
  assert.equal(ui.node('draft').disabled, false);
  onFrame({ backend: 'claude', connected: false, phase: 'offline', title: 'Live again', messages: [], terminal: { needed: false } });
  assert.equal(ui.node('title').textContent, 'Fixture preview', 'port frames wait while the preview lasts');
});
