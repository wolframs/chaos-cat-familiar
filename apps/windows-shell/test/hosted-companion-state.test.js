import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeHostedCompanion} from '../services/hosted-companion-state.js';
import {companionAttention} from '../renderer/companion-attention.js';
import {mascotInputsFromState} from '../renderer/mascot-state-machine.js';

test('hosted Codex activity drives the mascot while approvals keep their native owner',()=>{
  const state={sessions:[{id:'claude-a',backend:'claude',status:'active',phase:'idle'}],approvals:[]};
  const merged=mergeHostedCompanion(state,{backend:'codex',conversationId:'thread-a',connected:true,phase:'attention',pendingRequests:[{key:'native-a'}]},'C:/fixture');
  assert.equal(merged.sessions.length,2);assert.equal(merged.approvals.length,0);assert.equal(companionAttention(merged).kind,'waiting');assert.equal(mascotInputsFromState(merged)['agent::isAlert'],true);
  const working=mergeHostedCompanion(state,{backend:'codex',conversationId:'thread-a',connected:true,phase:'working'},'C:/fixture');working.sessions[0].lastEventAt='2020-01-01';
  assert.equal(mascotInputsFromState(working)['agent::isWorking'],true);
  assert.equal(mergeHostedCompanion(state,{backend:'codex',connected:false},'C:/fixture'),state);
});
