import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { CompanionDeliveryStore } from '../../../packages/core/src/companion-delivery.js';
import { CompanionWatcherInbox } from '../services/companion-watcher-inbox.js';

test('watcher receipts follow durable inbox commit; replay deduplicates and busy turns queue', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccf-watcher-'));
  const delivery=new CompanionDeliveryStore({filePath:path.join(root,'delivery.json')});
  const readable=new PassThrough(),writable=new PassThrough();
  const receipts=[];writable.on('data',data=>receipts.push(JSON.parse(data)));
  const backend=new EventEmitter();let phase='working';const submitted=[];
  backend.getSnapshot=()=>({backend:'codex',connected:true,phase,conversationId:'thread-a',generation:'day-a'});
  backend.submit=async input=>{submitted.push(input);phase='working';return delivery.submit({...input,backend:'codex',conversationId:'thread-a',generation:'day-a'},async()=>({state:'accepted',turnId:'turn-a'}));};
  const inbox=new CompanionWatcherInbox({delivery,backend});
  t.after(async()=>{await inbox.stop();delivery.close();fs.rmSync(root,{recursive:true,force:true});});
  inbox.connect({readable,writable,stop:async()=>{readable.end();writable.end();}});
  const wire={schemaVersion:1,type:'companion-event',event:{id:'event-a',source:'synthetic',key:'k',revision:'r',severity:'tell',occurredAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),generation:'day-a',payload:{text:'synthetic event'}}};
  readable.write(JSON.stringify(wire)+'\n');readable.write(JSON.stringify(wire)+'\n');
  await inbox.idle();
  assert.equal(receipts.length,2);assert.equal(delivery.snapshot().inbox.length,1);assert.equal(submitted.length,0);
  phase='idle';backend.emit('change');await inbox.idle();
  assert.equal(submitted.length,1);assert.deepEqual(submitted[0].eventIds,['event-a']);
  assert.equal(delivery.snapshot().inbox[0].state,'modelAccepted');
});

test('inbox write failure never acknowledges the source and oversized lines stop delivery', async t => {
  const backend=new EventEmitter();backend.getSnapshot=()=>({backend:'codex',connected:true,phase:'working',conversationId:'thread-a',generation:'day-a'});
  const readable=new PassThrough(),writable=new PassThrough();let receipts=0;writable.on('data',()=>receipts++);
  const inbox=new CompanionWatcherInbox({delivery:{receive(){throw new Error('disk failed');}},backend,maxLineBytes:100});
  const faults=[];inbox.on('fault',error=>faults.push(error.message));
  t.after(()=>inbox.stop());inbox.connect({readable,writable,stop:async()=>{}});
  readable.write('{"schemaVersion":1,"event":{}}\n');await inbox.idle();assert.equal(receipts,0);
  readable.write('x'.repeat(101));await inbox.idle();assert.ok(faults.some(text=>/limit/i.test(text)));
});
