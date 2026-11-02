import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CompanionBackends } from '../services/companion-backends.js';
import { CompanionDeliveryStore } from '../../../packages/core/src/companion-delivery.js';

function switchFixture({onSelect}={}){
  const calls=[],state={connected:true,phase:'idle',conversationId:'codex-day',pendingRequests:[]};
  const codex=new EventEmitter(),claude=new EventEmitter();
  codex.getSnapshot=()=>({...state});codex.stop=async()=>{calls.push('backend-stop');state.connected=false;state.phase='offline';};codex.start=async()=>calls.push('unexpected-start');
  claude.getSnapshot=()=>({connected:false,phase:'offline',conversationId:'claude-day'});claude.stop=async()=>{};claude.start=async()=>calls.push('unexpected-start');
  const records=[];const delivery={conversation:backend=>({backend,conversationId:`${backend}-day`,generation:`${backend}-generation`}),snapshot:()=>({submissions:records}),unresolved:()=>records.filter(record=>['pending','outcomeUnknown'].includes(record.state)),closeGeneration:()=>calls.push('unexpected-day-end')};
  const habitat={close:async disposition=>calls.push(`close:${disposition}`),stop:async()=>calls.push('habitat-stop')},watcher={stop:async()=>calls.push('watcher-stop')};
  const broker=new CompanionBackends({claude,codex,backend:'codex',delivery,habitat,watcher,onSelect:onSelect??(backend=>calls.push(`select:${backend}`))});
  return {broker,codex,state,calls,records};
}

test('explicit idle switch stops while preserving the day and selects without starting the target',async()=>{
  const {broker,calls}=switchFixture();broker.habitatClaimed=true;broker.lifecycleError='Old Codex configuration error';const switchingStates=[];broker.on('change',snapshot=>switchingStates.push(snapshot.switching));
  const result=await broker.switchBackend({backend:'claude',userInitiated:true});
  assert.deepEqual(calls,['watcher-stop','backend-stop','close:stop','habitat-stop','select:claude']);
  assert.equal(result.backend,'claude');assert.equal(result.connected,false);assert.equal(result.switching,false);
  assert.equal(result.error,undefined);assert.equal(switchingStates[0],true);assert.equal(switchingStates.at(-1),false);
  assert.equal(broker.delivery.conversation('codex').conversationId,'codex-day');assert.equal(broker.generation,'claude-generation');
});

test('switch rejects unsafe or unresolved work before stopping either backend',async()=>{
  const cases=[
    fixture=>{fixture.broker.starting=true;},fixture=>{fixture.codex.starting=true;},fixture=>{fixture.broker.submitting=true;},fixture=>{fixture.broker.switching=true;},
    fixture=>{fixture.state.phase='working';},fixture=>{fixture.state.pendingRequests=[{id:'approval'}];},fixture=>{fixture.state.pendingPrompt={kind:'input'};},
    fixture=>{fixture.state.submission={state:'outcomeUnknown'};},fixture=>{fixture.records.push({backend:'claude',state:'pending'});},fixture=>{fixture.records.push({backend:'codex',state:'outcomeUnknown'});}
  ];
  for(const change of cases){const fixture=switchFixture();change(fixture);await assert.rejects(async()=>fixture.broker.switchBackend({backend:'claude',userInitiated:true}));assert.deepEqual(fixture.calls,[]);assert.equal(fixture.broker.backend,'codex');}
  const fixture=switchFixture();await assert.rejects(async()=>fixture.broker.switchBackend({backend:'claude',userInitiated:false}),/explicit/i);await assert.rejects(async()=>fixture.broker.switchBackend({backend:'other',userInitiated:true}),/unsupported/i);assert.deepEqual(fixture.calls,[]);
});

test('switch serializes start, submit, direct selection, stop and repeated switches',async()=>{
  const {broker,codex,calls,state}=switchFixture();let release;codex.stop=()=>new Promise(resolve=>{release=()=>{state.connected=false;state.phase='offline';resolve();};});
  const switching=broker.switchBackend({backend:'claude',userInitiated:true});
  await assert.rejects(broker.start({userInitiated:true}),/switch/i);await assert.rejects(broker.submit({text:'must not send'}),/switch/i);
  assert.throws(()=>broker.selectBackend('claude'),/switch/i);await assert.rejects(broker.stop(),/switch/i);await assert.rejects(broker.switchBackend({backend:'claude',userInitiated:true}),/switch/i);
  assert.equal(broker.backend,'codex');assert.deepEqual(calls,['watcher-stop']);
  release();await switching;assert.equal(broker.backend,'claude');
});

test('stop or target persistence failure retains the previous backend and releases switching state',async()=>{
  const stopped=switchFixture();stopped.codex.stop=async()=>{throw new Error('stop failed');};
  await assert.rejects(stopped.broker.switchBackend({backend:'claude',userInitiated:true}),/stop failed/);assert.equal(stopped.broker.backend,'codex');assert.equal(stopped.broker.switching,false);assert.ok(!stopped.calls.includes('select:claude'));
  const persisted=switchFixture({onSelect:async()=>{throw new Error('target persistence failed');}});
  await assert.rejects(persisted.broker.switchBackend({backend:'claude',userInitiated:true}),/target persistence failed/);assert.equal(persisted.broker.backend,'codex');assert.equal(persisted.broker.getSnapshot().connected,false);assert.equal(persisted.broker.generation,'codex-generation');assert.equal(persisted.broker.switching,false);
});

test('a stop that returns while still connected cannot transfer backend ownership',async()=>{
  const {broker,codex,calls}=switchFixture();codex.stop=async()=>calls.push('incomplete-stop');
  await assert.rejects(broker.switchBackend({backend:'claude',userInitiated:true}),/disconnect|connected/i);
  assert.equal(broker.backend,'codex');assert.equal(broker.getSnapshot().connected,true);assert.ok(!calls.includes('select:claude'));
});

test('switching to the selected backend is an explicit no-op',async()=>{
  const {broker,calls}=switchFixture();const result=await broker.switchBackend({backend:'codex',userInitiated:true});assert.equal(result.backend,'codex');assert.deepEqual(calls,[]);
});

test('dispose waits for an in-progress switch and then cleans up both sessions',async()=>{
  const {broker,codex,state}=switchFixture();let release,stops=0;
  codex.stop=()=>++stops===1?new Promise(resolve=>{release=()=>{state.connected=false;state.phase='offline';resolve();};}):Promise.resolve();
  const switching=broker.switchBackend({backend:'claude',userInitiated:true}),disposing=broker.dispose();
  await Promise.resolve();assert.equal(broker.backend,'codex');release();await switching;await disposing;
  assert.equal(broker.backend,'claude');assert.equal(stops,2);assert.equal(broker.switching,false);
});

test('backend publication uses the captured adapter snapshot without rereading and recloning output',()=>{
  const claude=new EventEmitter();claude.getSnapshot=()=>({connected:false,phase:'offline'});claude.stop=async()=>{};
  const codex=new EventEmitter();codex.getSnapshot=()=>{throw new Error('Unnecessary second transcript clone');};codex.stop=async()=>{};
  const backends=new CompanionBackends({claude,codex,backend:'codex'});let received;
  backends.on('change',snapshot=>{received=snapshot;});
  assert.doesNotThrow(()=>codex.emit('change',{backend:'codex',connected:true,phase:'idle',conversationId:'thread',messages:[{id:'new',text:'Captured fresh output'}]}));
  assert.equal(received.messages[0].text,'Captured fresh output');
});

test('backend selection cannot replace a running session; accepted IPC result follows durable commit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccf-backends-'));
  const store = new CompanionDeliveryStore({filePath:path.join(root,'delivery.json')});
  const claude = new EventEmitter();
  claude.getSnapshot = () => ({connected:false,phase:'offline',messages:[]}); claude.stop = async () => {};
  const codex = new EventEmitter();
  let connected = false;
  codex.getSnapshot = () => ({backend:'codex',connected,phase:connected?'idle':'offline',conversationId:'thread-a',connectionEpoch:1,messages:[]});
  codex.start = async () => { connected=true; codex.emit('change',codex.getSnapshot()); };
  codex.stop = async () => { connected=false; };
  let accept;
  codex.submit = () => new Promise(resolve => { accept=resolve; });
  const backends = new CompanionBackends({claude,codex,delivery:store});
  t.after(async () => { await backends.stop(); store.close(); fs.rmSync(root,{recursive:true,force:true}); });
  assert.equal(backends.getSnapshot().backend,'claude');
  backends.selectBackend('codex');
  await backends.start({userInitiated:true});
  assert.throws(() => backends.selectBackend('claude'), /disconnect/i);
  const result = backends.submit({id:'input-a',text:'synthetic',draftRevision:1});
  assert.equal(store.snapshot().submissions[0].state,'pending');
  accept({state:'accepted',turnId:'turn-a'});
  assert.equal((await result).state,'accepted');
  assert.equal(JSON.parse(fs.readFileSync(store.filePath)).submissions[0].state,'accepted');
});

test('Claude PTY compatibility awaits writes and reports its weaker acceptance boundary', async t => {
  const claude=new EventEmitter(); claude.getSnapshot=()=>({connected:true,phase:'idle'});
  let sent; claude.send=async text=>{sent=text;}; claude.stop=async()=>{};
  const backends=new CompanionBackends({claude,codex:claude});
  t.after(()=>backends.stop());
  const result=await backends.submit({id:'claude-input',text:'hello'});
  assert.equal(sent,'hello'); assert.equal(result.state,'accepted');
  assert.equal(result.acceptanceBoundary,'pty-write');
});

test('daily ownership precedes Codex launch; accepted memory is checkpointed and watcher stops first',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccf-owner-'));const delivery=new CompanionDeliveryStore({filePath:path.join(root,'delivery.json')});
  const order=[];let connected=false;const codex=new EventEmitter();
  codex.getSnapshot=()=>({backend:'codex',connected,phase:connected?'idle':'offline',conversationId:connected?'thread-a':null,connectionEpoch:1});
  codex.start=async options=>{order.push('backend-start');assert.equal(options.developerInstructions,'synthetic core');connected=true;return{memoryAck:{revision:'ctx-a',threadId:'thread-a',acceptanceId:'thread-a',boundary:'thread-accepted'}};};
  codex.stop=async()=>{order.push('backend-stop');connected=false;};
  const habitat={claim:async()=>{order.push('claim');return{generation:'saved-day'};},prepare:async()=>({contextId:'ctx-a',revision:'ctx-a',text:'synthetic core'}),bind:async()=>{order.push('bind');return{};},acknowledge:async()=>order.push('memory-ack'),close:async()=>order.push('close'),stop:async()=>order.push('habitat-stop')};
  const watcher={start:async()=>order.push('watcher-start'),stop:async()=>order.push('watcher-stop')};
  const backends=new CompanionBackends({claude:codex,codex,backend:'codex',delivery,habitat,watcher});
  t.after(()=>{delivery.close();fs.rmSync(root,{recursive:true,force:true});});
  await backends.start({userInitiated:true});assert.deepEqual(order,['claim','backend-start','bind','memory-ack','watcher-start']);assert.equal(backends.getSnapshot().generation,'saved-day');
  await backends.stop();assert.deepEqual(order.slice(-4),['watcher-stop','backend-stop','close','habitat-stop']);
});

test('empty turn memory has no pending bridge context to reject or acknowledge and user submission proceeds durably',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccf-no-memory-'));
  const delivery=new CompanionDeliveryStore({filePath:path.join(root,'delivery.json')});
  t.after(()=>{delivery.close();fs.rmSync(root,{recursive:true,force:true});});
  const codex=new EventEmitter();codex.stop=async()=>{};
  codex.getSnapshot=()=>({backend:'codex',connected:true,phase:'idle',conversationId:'existing-thread',connectionEpoch:1});
  let sent=0;
  codex.submit=async record=>{sent++;assert.equal(delivery.snapshot().submissions[0].state,'pending');assert.equal(record.memory,undefined);return{state:'accepted',turnId:'accepted-user-turn'};};
  const habitat={prepare:async boundary=>{assert.equal(boundary,'turn');return{required:false,contextId:'empty-context',text:''};},
    reject:async()=>{throw new Error('Explicit matched backend rejection required; no empty context is pending');},
    acknowledge:async()=>{throw new Error('No empty context may be acknowledged');}};
  const backends=new CompanionBackends({claude:codex,codex,backend:'codex',delivery,habitat});backends.habitatClaimed=true;
  const result=await backends.submit({id:'first-user-turn',text:'User input with no new notes',draftRevision:3});
  assert.equal(result.state,'accepted');assert.equal(result.memoryAck,undefined);assert.equal(sent,1);
  const saved=delivery.snapshot().submissions[0];assert.equal(saved.state,'accepted');assert.equal(saved.text,'User input with no new notes');assert.equal(saved.memory,undefined);
});

test('Claude sends before hooks supply identity and keeps PTY acceptance semantics',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccf-claude-ledger-'));const delivery=new CompanionDeliveryStore({filePath:path.join(root,'delivery.json')});
  const claude=new EventEmitter();claude.getSnapshot=()=>({connected:true,phase:'idle'});claude.stop=async()=>{};let sent=[];claude.send=async text=>{sent.push(text);};
  const backends=new CompanionBackends({claude,codex:claude,delivery});t.after(()=>{delivery.close();fs.rmSync(root,{recursive:true,force:true});});
  assert.equal((await backends.submit({id:'before-id',text:'hello'})).state,'accepted');
  backends.observeConversation({backend:'claude',conversationId:'claude-real-id'});
  const result=await backends.submit({id:'after-id',text:'world'});assert.equal(result.state,'accepted');assert.equal(result.acceptanceBoundary,'pty-write');
  assert.deepEqual(sent,['hello','world']);assert.deepEqual(delivery.snapshot().submissions,[]);
});
