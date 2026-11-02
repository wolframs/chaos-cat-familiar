import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEvent} from '../src/models.js';
import {SessionStore} from '../src/session-store.js';
import {ApprovalStore} from '../src/approval-store.js';

test('identical external conversation and tool IDs stay separate across backends',()=>{
  const claude=normalizeEvent({hook_event_name:'PermissionRequest',session_id:'same',tool_name:'Bash',tool_use_id:'same-tool'});
  const codex=normalizeEvent({backend:'codex',hook_event_name:'PermissionRequest',session_id:'same',tool_name:'Bash',tool_use_id:'same-tool',observation_authority:'hook'});
  assert.notEqual(claude.sessionId,codex.sessionId);assert.equal(codex.conversationId,'same');
  const sessions=new SessionStore();sessions.recordEvent(claude);sessions.recordEvent(codex);
  assert.equal(sessions.sessions.length,2);assert.equal(sessions.sessions.find(s=>s.backend==='codex').assistantLabel,'Codex');
  const approvals=new ApprovalStore();approvals.add(claude,()=>{});approvals.add(codex,()=>{});assert.equal(approvals.pending.length,2);
  const restored=new SessionStore(sessions.sessions);assert.equal(restored.sessions.find(s=>s.backend==='codex').assistantLabel,'Codex');
});

