import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexCompanionSession, validateCodexResponse } from '../services/codex-companion-session.js';
import { createFakeCodexServer } from '../test-support/fake-codex-server.js';

function setup(turnHandler) {
  const server = createFakeCodexServer((frame,server) => {
    if (frame.method === 'initialize') server.emit({id:frame.id,result:{userAgent:'fixture'}});
    if (frame.method === 'thread/start') server.emit({id:frame.id,result:{thread:{id:'fork-2',sessionId:'root-1'}}});
    if (frame.method === 'turn/start') return turnHandler(frame,server);
  });
  return {server, session:new CodexCompanionSession({transportFactory:async () => server})};
}

test('failed startup captures only bounded sanitized launch diagnostics before stop without exposing snapshot data',async()=>{
  const server=createFakeCodexServer((frame,server)=>{if(frame.method==='initialize')server.emit({id:frame.id,error:{code:-32000,message:'fixture initialization failed'}});});
  let stopped=false;
  server.getDiagnostics=()=>({stderr:stopped?'':'é'.repeat(10000),stderrLimited:false,closed:true,privateUnrelated:'must not copy'});
  const stop=server.stop.bind(server);server.stop=async()=>{stopped=true;await stop();};
  const session=new CodexCompanionSession({transportFactory:async()=>server});
  const published=[];session.on('change',snapshot=>published.push(snapshot));
  await assert.rejects(session.start({userInitiated:true}),error=>{
    assert.equal(error.message,'fixture initialization failed');
    assert.equal(Buffer.byteLength(error.launchDiagnostics.stderr),16384);
    assert.equal(error.launchDiagnostics.stderrLimited,true);assert.equal(error.launchDiagnostics.closed,true);
    assert.deepEqual(Object.keys(error.launchDiagnostics).sort(),['closed','stderr','stderrLimited']);return true;
  });
  assert.equal(stopped,true);assert.equal(JSON.stringify(published).includes('é'),false);
  assert.equal(Object.hasOwn(session.getSnapshot(),'launchDiagnostics'),false);
});

test('diagnostic getter failure preserves the original initialization error',async()=>{
  const server=createFakeCodexServer((frame,server)=>{if(frame.method==='initialize')server.emit({id:frame.id,error:{code:-32000,message:'original failure'}});});
  server.getDiagnostics=()=>{throw new Error('diagnostics unavailable');};
  const session=new CodexCompanionSession({transportFactory:async()=>server});
  await assert.rejects(session.start({userInitiated:true}),error=>error.message==='original failure'&&error.launchDiagnostics===undefined);
  assert.equal(server.closed,true);
});
test('explicit start initializes before thread creation and acceptance requires matched turn response', async () => {
  const {server,session} = setup((frame,server) => server.emit({id:frame.id,result:{turn:{id:'turn-1',status:'inProgress'}}}));
  await assert.rejects(session.start({}), /explicit/);
  await session.start({userInitiated:true,cwd:'C:/fixture'});
  assert.deepEqual(server.frames.map(f => f.method), ['initialize','initialized','thread/start']);
  assert.equal(server.frames[0].params.capabilities.experimentalApi,true,'Pinned typed user-input requests require explicit experimental opt-in');
  assert.equal(session.getSnapshot().conversationId,'fork-2');
  assert.equal(session.getSnapshot().sessionRootId,'root-1');
  assert.equal((await session.submit({id:'s1',text:'hello'})).state,'accepted');
  assert.equal((await session.submit({id:'s2',text:'busy'})).state,'rejected');
  await session.stop();
});
test('lost acceptance response blocks automatic retry and stale approvals cannot respond', async () => {
  const {session,server} = setup((frame,server) => server.readable.end());
  await session.start({userInitiated:true});
  assert.equal((await session.submit({id:'s1',text:'hello'})).state,'outcomeUnknown');
  assert.equal((await session.submit({id:'s2',text:'again'})).state,'rejected');
  assert.equal(await session.resolveRequest({key:'codex:0:1',response:{decision:'accept'}}), false);
  await session.stop();
});
test('command approval is scoped by backend, connection and conversation; unsupported requests never grant', async () => {
  const {session,server} = setup(() => {});
  await session.start({userInitiated:true});
  session.notification({method:'turn/started',params:{threadId:'fork-2',turn:{id:'turn-1'}}});
  server.emit({id:19,method:'item/commandExecution/requestApproval',params:{threadId:'fork-2',turnId:'turn-1',itemId:'command-1',command:'echo fixture'}});
  const request = session.getSnapshot().pendingRequests[0];
  assert.equal(request.backend,'codex'); assert.equal(request.conversationId,'fork-2');
  assert.equal(await session.resolveRequest({key:request.key,response:{decision:'acceptForSession'}}),false);
  assert.equal(await session.resolveRequest({key:request.key,response:{decision:'decline'}}),true);
  assert.deepEqual(server.frames.at(-1),{id:19,result:{decision:'decline'}});
  assert.equal(await session.resolveRequest({key:request.key,response:{decision:'accept'}}),false);
  server.emit({id:20,method:'unknown/integration',params:{threadId:'fork-2'}});
  const unsupported = session.getSnapshot().pendingRequests[0];
  assert.equal(unsupported.supported,false);
  assert.equal(await session.resolveRequest({key:unsupported.key,response:{decision:'accept'}}),false);
  await session.stop();
});
test('delayed acceptance stays pending; authoritative rejection preserves the draft revision', async () => {
  let held;
  const {session,server} = setup(frame => { held = frame; });
  await session.start({userInitiated:true});
  const pending = session.submit({id:'delayed',text:'retained draft',draftRevision:4});
  assert.equal(session.getSnapshot().submission.state,'pending');
  assert.equal(session.getSnapshot().messages.length,0);
  server.emit({id:held.id,error:{code:-32000,message:'model unavailable'}});
  assert.deepEqual(await pending,{id:'delayed',state:'rejected',reason:'model unavailable',draftRevision:4});
  assert.equal(session.getSnapshot().messages.length,0);
  const accepted = session.submit({id:'accepted',text:'retained draft',draftRevision:5});
  server.emit({id:held.id,result:{turn:{id:'turn-delayed'}}});
  assert.equal((await accepted).state,'accepted'); await session.stop();
});
test('concurrent start refuses a second owner', async () => {
  let release; let launches = 0;
  const transport = createFakeCodexServer(frame => {});
  const session = new CodexCompanionSession({transportFactory:() => { launches++; return new Promise(resolve => { release = resolve; }); }});
  const starting = session.start({userInitiated:true});
  await assert.rejects(session.start({userInitiated:true}),/starting/);
  const stopped = session.stop(); release(transport);
  await assert.rejects(starting,/cancelled/); await stopped;
  assert.equal(launches,1); assert.equal(transport.closed,true);
});

test('stop waits for a child still spawning and its cleanup before permitting restart',async()=>{
  let releaseSpawn,releaseStop,stopped=false;
  const transport=createFakeCodexServer();
  const originalStop=transport.stop.bind(transport);
  const cleanup=new Promise(resolve=>{releaseStop=resolve;});
  transport.stop=async()=>{await cleanup;await originalStop();};
  const session=new CodexCompanionSession({transportFactory:()=>new Promise(resolve=>{releaseSpawn=resolve;})});
  const starting=session.start({userInitiated:true});
  const rejected=assert.rejects(starting,/cancelled/);
  const stopping=session.stop().then(()=>{stopped=true;});
  await assert.rejects(session.start({userInitiated:true}),/stopping/);
  releaseSpawn(transport);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stopped,false);assert.equal(transport.closed,false);
  releaseStop();await rejected;await stopping;
  assert.equal(transport.closed,true);assert.equal(stopped,true);
});

test('a malformed protocol frame disconnects and stops the private child',async()=>{
  const{session,server}=setup(()=>{});await session.start({userInitiated:true});
  server.readable.write('{invalid}\n');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(session.getSnapshot().connected,false);assert.equal(server.closed,true);
  await session.stop();
});
test('permission grants are a requested subset for this turn; questions reject invented identifiers', () => {
  const permissions = {method:'item/permissions/requestApproval',params:{permissions:{network:{enabled:true},fileSystem:{read:['C:/fixture'],write:['C:/fixture/output']}}}};
  assert.equal(validateCodexResponse(permissions,{permissions:{fileSystem:{read:['C:/fixture']}},scope:'turn'}),true);
  assert.equal(validateCodexResponse(permissions,{permissions:{fileSystem:{read:['C:/secrets']}},scope:'turn'}),false);
  assert.equal(validateCodexResponse(permissions,{permissions:{network:{enabled:true}},scope:'session'}),false);
  assert.equal(validateCodexResponse(permissions,{permissions:{network:{enabled:true,extra:true}}}),false);
  const question = {method:'item/tool/requestUserInput',params:{questions:[{id:'q1',options:[{label:'One'}]}]}};
  assert.equal(validateCodexResponse(question,{answers:{q1:{answers:['One']}}}),true);
  assert.equal(validateCodexResponse(question,{answers:{q1:{answers:['Two']}}}),false);
  assert.equal(validateCodexResponse(question,{answers:{other:{answers:['One']}}}),false);
  assert.equal(validateCodexResponse({method:'mcpServer/elicitation/request',params:{}},{action:'accept'}),false);
});
test('stable completion replaces streamed content; bounded history and output remain visible', async () => {
  const {session,server} = setup(() => {}); await session.start({userInitiated:true});
  server.emit({method:'item/agentMessage/delta',params:{threadId:'fork-2',itemId:'a1',delta:'same'}});
  server.emit({method:'item/agentMessage/delta',params:{threadId:'fork-2',itemId:'a1',delta:'same'}});
  server.emit({method:'item/completed',params:{threadId:'fork-2',item:{id:'a1',type:'agentMessage',text:'authoritative'}}});
  assert.equal(session.getSnapshot().messages[0].text,'authoritative');
  for (let index = 0; index < 520; index++) session.notification({method:'item/completed',params:{threadId:'fork-2',item:{id:`tool-${index}`,type:'commandExecution',aggregatedOutput:'fixture'}}});
  assert.equal(session.getSnapshot().messages.length,500);
  session.notification({method:'item/completed',params:{threadId:'fork-2',item:{id:'oversized',type:'commandExecution',aggregatedOutput:'x'.repeat(70000)}}});
  const last = session.getSnapshot().messages.at(-1); assert.ok(Buffer.byteLength(last.text)<=2048); assert.equal(last.outputLimited,true);
  assert.equal(session.getOutput({itemId:'oversized'}).text.length,65536);
  await session.stop();
});
test('history pages use authoritative opaque cursors and remain bounded', async () => {
  const {session,server} = setup(() => {}); await session.start({userInitiated:true});
  const page = session.history({cursor:'opaque-before',limit:1000});
  const frame = server.frames.at(-1);
  assert.deepEqual(frame.params,{threadId:'fork-2',cursor:'opaque-before',limit:100,sortDirection:'desc'});
  server.emit({id:frame.id,result:{data:[{turnId:'t1',item:{id:'h1',type:'agentMessage',text:'historical'}}],nextCursor:'next'}});
  const result = await page; assert.equal(result.items[0].id,'h1'); assert.equal(result.nextCursor,'next');
  const latest=session.history({});
  server.emit({id:server.frames.at(-1).id,result:{data:[],nextCursor:'latest-older'}});
  await latest;assert.equal(session.getSnapshot().historyCursor,'latest-older');
  await session.stop(); await assert.rejects(session.history({}),/disconnected/);
});

test('normal production startup preserves server configuration and applies approval policy per thread',async()=>{
  const{session,server}=setup(()=>{});server.production=true;
  await session.start({userInitiated:true,cwd:'C:/habitat',model:'configured-model'});
  assert.deepEqual(server.frames.map(frame=>frame.method),['initialize','initialized','thread/start']);
  const thread=server.frames.at(-1).params;
  assert.equal(thread.model,'configured-model');assert.equal(thread.approvalPolicy,'on-request');
  assert.equal(thread.approvalsReviewer,'user');assert.equal(Object.hasOwn(thread,'sandbox'),false,'the user configuration chooses the sandbox');
  await session.stop();
});
test('request from another active turn cannot be answered', async () => {
  const {session,server} = setup(() => {}); await session.start({userInitiated:true});
  session.notification({method:'turn/started',params:{threadId:'fork-2',turn:{id:'current'}}});
  server.emit({id:31,method:'item/commandExecution/requestApproval',params:{threadId:'fork-2',turnId:'previous',itemId:'command-1',command:'echo fixture'}});
  const request = session.getSnapshot().pendingRequests[0];
  assert.equal(await session.resolveRequest({key:request.key,response:{decision:'accept'}}),false);
  session.notification({method:'turn/completed',params:{threadId:'fork-2',turn:{id:'current'}}});
  server.emit({id:32,method:'item/commandExecution/requestApproval',params:{threadId:'fork-2',turnId:'current',itemId:'command-2',command:'echo fixture'}});
  const late = session.getSnapshot().pendingRequests[0];
  assert.equal(await session.resolveRequest({key:late.key,response:{decision:'accept'}}),false);
  await session.stop();
});

test('accepted submissions retain acceptance while failed and interrupted turns get stable visible status rows', async () => {
  const {session,server} = setup((frame,server) => server.emit({id:frame.id,result:{turn:{id:'turn-failed',status:'inProgress'}}}));
  await session.start({userInitiated:true});
  assert.equal((await session.submit({id:'accepted-before-failure',text:'fixture'})).state,'accepted');
  const failed = {id:'turn-failed',status:'failed',items:[],error:{message:'Fixture model unavailable',additionalDetails:'Synthetic diagnostic'}};
  session.notification({method:'turn/completed',params:{threadId:'fork-2',turn:failed}});
  session.notification({method:'turn/completed',params:{threadId:'fork-2',turn:failed}});
  const snapshot = session.getSnapshot();
  assert.equal(snapshot.submission.state,'accepted'); assert.equal(snapshot.phase,'idle');
  assert.equal(snapshot.lastTurn.id,'turn-failed'); assert.equal(snapshot.lastTurn.status,'failed');
  const row = snapshot.messages.find(item => item.id === 'turn-status:turn-failed');
  assert.equal(row.role,'system'); assert.equal(row.status,'failed'); assert.match(row.text,/Fixture model unavailable/);
  assert.equal(snapshot.messages.filter(item => item.id === row.id).length,1);
  session.notification({method:'turn/started',params:{threadId:'fork-2',turn:{id:'turn-interrupted'}}});
  session.notification({method:'turn/completed',params:{threadId:'fork-2',turn:{id:'turn-interrupted',status:'interrupted',items:[],error:{message:'Fixture interruption'}}}});
  assert.match(session.getSnapshot().messages.at(-1).text,/interrupted.*Fixture interruption/);
  assert.equal(server.frames.filter(frame => frame.method === 'turn/start').length,1);
  await session.stop();
});

test('resume hydrates failed and interrupted turn status from installed thread turn history', async () => {
  const server = createFakeCodexServer((frame,server) => {
    if (frame.method === 'initialize') server.emit({id:frame.id,result:{}});
    if (frame.method === 'thread/resume') server.emit({id:frame.id,result:{thread:{id:'resumed',sessionId:'root',status:{type:'idle'},turns:[
      {id:'old-failed',status:'failed',items:[],error:{message:'Historical failure'}},
      {id:'old-interrupted',status:'interrupted',items:[],error:null}
    ]}}});
    if (frame.method === 'thread/items/list') server.emit({id:frame.id,result:{data:[],nextCursor:null}});
  });
  const session = new CodexCompanionSession({transportFactory:async () => server});
  await session.start({userInitiated:true,conversationId:'resumed'});
  const snapshot = session.getSnapshot();
  assert.match(snapshot.messages.find(item => item.id === 'turn-status:old-failed').text,/Historical failure/);
  assert.match(snapshot.messages.find(item => item.id === 'turn-status:old-interrupted').text,/interrupted/);
  assert.equal(snapshot.lastTurn.id,'old-interrupted'); assert.equal(snapshot.submission,null);
  await session.stop();
});

test('tool previews bound UTF-8 bytes without splitting multibyte characters', async () => {
  const {session} = setup(() => {}); await session.start({userInitiated:true});
  session.notification({method:'item/completed',params:{threadId:'fork-2',item:{id:'unicode',type:'commandExecution',aggregatedOutput:'x'.repeat(65534)+'😸'.repeat(100)}}});
  const item = session.getOutput({itemId:'unicode'});
  assert.ok(Buffer.byteLength(item.text,'utf8') <= 65536); assert.equal(item.text.includes('\uFFFD'),false);
  assert.equal(item.outputLimited,true); assert.equal(item.text,'x'.repeat(65534));
  await session.stop();
});

test('memory acknowledgements follow matched thread and turn acceptance, compaction only requests refresh', async () => {
  const {session,server}=setup((frame,server)=>server.emit({id:frame.id,result:{turn:{id:'memory-turn',status:'inProgress'}}}));
  await session.start({userInitiated:true,developerInstructions:'Synthetic core memory',memoryContext:{contextId:'core-context',revision:'core-context'}});
  const started=server.frames.find(frame=>frame.method==='thread/start');
  assert.equal(started.params.developerInstructions,'Synthetic core memory');
  assert.equal(session.getSnapshot().memoryAck.boundary,'thread-accepted');
  assert.equal(session.getSnapshot().memoryAck.revision,'core-context');
  assert.equal(typeof session.getSnapshot().memoryAck.acceptanceId,'string');
  await session.submit({id:'memory-input',text:'user message',memory:{revision:'delta-context',text:'Synthetic new notes'}});
  const turn=server.frames.find(frame=>frame.method==='turn/start');
  assert.equal(turn.params.input[0].text,'Synthetic new notes');
  assert.equal(session.getSnapshot().memoryAck.boundary,'turn-accepted');
  assert.equal(session.getSnapshot().memoryAck.turnId,'memory-turn');
  let refresh;let refreshCount=0;session.on('memoryNeeded',event=>{refresh=event;refreshCount++;});
  session.notification({method:'item/completed',params:{threadId:'fork-2',turnId:'memory-turn',item:{id:'compaction-1',type:'contextCompaction'}}});
  session.notification({method:'item/completed',params:{threadId:'fork-2',turnId:'memory-turn',item:{id:'compaction-1',type:'contextCompaction'}}});
  assert.equal(refresh.reason,'compaction');assert.equal(session.getSnapshot().memoryRefreshNeeded,true);
  assert.equal(refreshCount,1);
  assert.equal(server.frames.filter(frame=>frame.method==='turn/start').length,1);
  await session.stop();
});

test('presentation snapshots do not clone or transfer retained tool previews until explicitly requested',async()=>{
  const{session}=setup(()=>{});await session.start({userInitiated:true});
  for(let index=0;index<256;index++)session.notification({method:'item/completed',params:{threadId:'fork-2',item:{id:`large-${index}`,type:'commandExecution',aggregatedOutput:'x'.repeat(65536)}}});
  const snapshot=session.getSnapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<256*1024);
  assert.ok(snapshot.messages.every(item=>Buffer.byteLength(item.text)<=512));
  assert.equal(snapshot.messages[0].outputPreviewAvailable,true);
  assert.equal(session.getOutput({itemId:'large-0'}).text.length,65536);
  assert.throws(()=>session.getOutput({itemId:'not-retained'}),/no longer retained|unavailable/);
  await session.stop();
});
test('file approvals include complete bounded details rather than the compact tool summary',async()=>{
  const{session,server}=setup(()=>{});await session.start({userInitiated:true});
  session.notification({method:'turn/started',params:{threadId:'fork-2',turn:{id:'file-turn'}}});
  session.notification({method:'item/started',params:{threadId:'fork-2',turnId:'file-turn',item:{id:'file-details',type:'fileChange',changes:[{path:'C:/fixture/file.txt',diff:'x'.repeat(8000)+'END_OF_DIFF'}]}}});
  server.emit({id:91,method:'item/fileChange/requestApproval',params:{threadId:'fork-2',turnId:'file-turn',itemId:'file-details'}});
  const snapshot=session.getSnapshot();assert.equal(snapshot.messages[0].text.includes('END_OF_DIFF'),false);
  assert.match(snapshot.pendingRequests[0].detailsText,/END_OF_DIFF/);assert.equal(snapshot.pendingRequests[0].supported,true);
  await session.stop();
});
test('historical tool previews are bounded to the current page and unavailable previews fail explicitly',async()=>{
  const{session,server}=setup(()=>{});await session.start({userInitiated:true});
  const first=session.history({});server.emit({id:server.frames.at(-1).id,result:{data:[{turnId:'past',item:{id:'past-tool',type:'commandExecution',aggregatedOutput:'y'.repeat(65000)}}],nextCursor:'older'}});
  assert.ok((await first).items[0].text.length<=2048);assert.equal(session.getOutput({itemId:'past-tool'}).text.length,65000);
  const second=session.history({cursor:'older'});server.emit({id:server.frames.at(-1).id,result:{data:[],nextCursor:null}});await second;
  assert.throws(()=>session.getOutput({itemId:'past-tool'}),/no longer retained/);await session.stop();
});
