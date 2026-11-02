import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptCodexHook,CODEX_OBSERVATION_EVENTS} from '../services/codex-hook-adapter.js';
import {runCodexHookSender} from '../../../scripts/windows/codex-hook-sender.mjs';
import {HookServer} from '../../../packages/core/src/hook-server.js';
import {CcfCoreController} from '../../../packages/core/src/core-controller.js';

test('every installed Codex hook event travels from the real sender through the real server into core',async t=>{
  const controller=new CcfCoreController({overlay:{showOverlay(){},updateOverlay(){}},notifier:{notify:async()=>{}}});
  const server=new HookServer({controller,port:0,authToken:'fixture-token'});await server.start();t.after(()=>server.stop());
  const settings={port:server.port,hookToken:'fixture-token'};
  const diagnostics=[];
  const send=(payload,eventId)=>runCodexHookSender({payload,eventId,settings,onDiagnostic:message=>diagnostics.push(`${payload.hook_event_name}: ${message}`)});
  const base={session_id:'thread-1',cwd:'C:/fixture',turn_id:'turn-1'};
  const extra={SessionStart:{source:'startup'},PreToolUse:{tool_name:'shell',tool_input:{command:'ls'}},
    PermissionRequest:{tool_name:'shell',tool_input:{command:'ls'}},PostToolUse:{tool_name:'shell',tool_response:['out']},
    UserPromptSubmit:{prompt:'hi'},Stop:{last_assistant_message:'done',stop_hook_active:false},SessionEnd:{reason:'other'}};
  const order=['SessionStart',...CODEX_OBSERVATION_EVENTS.filter(name=>!['SessionStart','SessionEnd'].includes(name)),'SessionEnd'];
  for(const name of order)await send({hook_event_name:name,...base,...extra[name]},`event-${name}`);
  await send({hook_event_name:'SessionStart',...base,source:'startup'},'event-SessionStart');
  assert.deepEqual(diagnostics,[]);
  assert.equal(controller.events.length,CODEX_OBSERVATION_EVENTS.length,'each event once; a replayed id is ignored');
  assert.equal(controller.approvals.pending.length,0,'observation never takes the approval decision');
  assert.equal(controller.events.find(event=>event.hookEventName==='SessionStart').source,'startup','Codex keeps its own source field');
  const [session]=controller.sessions.sessions;
  assert.equal(session.backend,'codex');assert.equal(session.assistantLabel,'Codex');assert.equal(session.status,'ended');
});

test('adapter drops decision fields and rejects malformed or oversized events',()=>{
  const event=adaptCodexHook({hook_event_name:'PermissionRequest',session_id:'s',tool_input:['echo'],decision:'allow',observation_only:false});
  assert.equal(event.observation_only,true);assert.equal(event.decision,undefined);assert.deepEqual(event.tool_input,{value:['echo']});
  assert.throws(()=>adaptCodexHook({hook_event_name:'Stop',session_id:''}),/session/);
  assert.throws(()=>adaptCodexHook({hook_event_name:'unknown',session_id:'s'}),/event/);
  assert.throws(()=>adaptCodexHook({hook_event_name:'Stop',session_id:'s',last_assistant_message:'x'.repeat(1024*1024)}),/limit/);
});
