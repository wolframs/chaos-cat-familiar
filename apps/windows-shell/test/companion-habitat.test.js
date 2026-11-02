import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {CompanionHabitat} from '../services/companion-habitat.js';

test('habitat reserves before launch and acknowledges only matching accepted memory',async t=>{
  const readable=new PassThrough(),writable=new PassThrough();const methods=[];
  writable.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n')){const frame=JSON.parse(line);methods.push(frame.method);const result=frame.method==='claim'?{generation:'day-a',conversationId:null}:frame.method==='prepare'?{contextId:'ctx-a',text:'synthetic memory'}:{done:true};readable.write(JSON.stringify({schemaVersion:1,id:frame.id,ok:true,result})+'\n');}});
  let stopped=0;const habitat=new CompanionHabitat({transportFactory:async()=>({readable,writable,stop:async()=>{stopped++;}})});t.after(()=>habitat.stop());
  const reservation=await habitat.claim({backend:'codex',generation:'day-a'});assert.equal(reservation.generation,'day-a');
  const memory=await habitat.prepare('startup');assert.equal(memory.contextId,'ctx-a');
  await assert.rejects(habitat.acknowledge(memory,{revision:'ctx-wrong',acceptanceId:'turn-a'}),/match/i);
  assert.deepEqual(methods,['claim','prepare']);
  await habitat.acknowledge(memory,{revision:'ctx-a',acceptanceId:'turn-a',threadId:'thread-a',boundary:'turn-accepted'});
  assert.deepEqual(methods,['claim','prepare','acknowledge']);
  await habitat.stop();assert.equal(stopped,1);
});

test('bridge bounds frames and rejects outstanding requests on disconnect without retry',async t=>{
  const readable=new PassThrough(),writable=new PassThrough();let writes=0;writable.on('data',()=>writes++);
  const habitat=new CompanionHabitat({transportFactory:async()=>({readable,writable,stop:async()=>{}}),timeoutMs:100,maxLineBytes:64});t.after(()=>habitat.stop());
  const waiting=habitat.claim({backend:'codex',generation:'day-a'});
  await new Promise(setImmediate);readable.end();await assert.rejects(waiting,/disconnect/i);assert.equal(writes,1);
  await assert.rejects(habitat.prepare('resume'),/connect|start/i);
});
