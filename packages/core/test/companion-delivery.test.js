import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompanionDeliveryStore, conversationKey } from '../src/companion-delivery.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccf-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'delivery.json');
}
const target = { backend: 'codex', conversationId: 'thread-a', generation: 'day-a', connectionEpoch: 'epoch-a' };

test('explicit replaceable facts keep latest known revision and all source identities without replacing urgency',t=>{
  const store=new CompanionDeliveryStore({filePath:fixture(t),now:()=>new Date('2026-10-28T08:00:00Z')});t.after(()=>store.close());
  const receive=(id,revision,severity='tell')=>store.receive({schemaVersion:1,type:'companion-event',event:{id,revision:String(revision),source:'fixture',key:'fact',severity,generation:target.generation,occurredAt:'2026-10-28T07:00:00Z',expiresAt:'2026-10-28T11:00:00Z',payload:{text:`fact${revision}`,replaceable:true,replacementKey:'fact',replacementRevision:revision}}},target);
  receive('old',1);receive('new',2);receive('late-old',0);receive('urgent',3,'urgent');
  assert.deepEqual(store.nextBatch(target,{now:'2026-10-28T08:00:00Z'}).map(event=>event.id),['new','urgent']);
  assert.equal(store.snapshot().inbox.length,4);assert.equal(store.snapshot().inbox.find(e=>e.id==='old').supersededBy,'new');
  assert.throws(()=>receive('collision',2),/replacement revision/i);
  assert.throws(()=>store.begin({...target,id:'stale-batch',text:'stale',eventIds:['old']}),/superseded|eligible/i);
});

test('facts already referenced by pending or uncertain submissions cannot be superseded',t=>{
  const store=new CompanionDeliveryStore({filePath:fixture(t),now:()=>new Date('2026-10-28T08:00:00Z')});t.after(()=>store.close());
  const base={source:'fixture',key:'fact',severity:'tell',generation:target.generation,occurredAt:'2026-10-28T07:00:00Z',expiresAt:'2026-10-28T11:00:00Z'};
  for(const revision of [1,2]){
    store.receive({schemaVersion:1,type:'companion-event',event:{...base,id:`fact-${revision}`,revision:String(revision),payload:{replaceable:true,replacementKey:'fact',replacementRevision:revision,text:'synthetic'}}},target);
    if(revision===1)store.begin({...target,id:'in-flight',text:'selected',eventIds:['fact-1']});
  }
  assert.equal(store.snapshot().inbox.find(e=>e.id==='fact-1').state,'received');
  store.settle('in-flight',{state:'outcomeUnknown'});assert.equal(store.snapshot().inbox.find(e=>e.id==='fact-1').state,'outcomeUnknown');
  assert.equal(store.nextBatch(target,{now:'2026-10-28T08:00:00Z'}).length,0);
});

test('a watcher event expiring after selection is never transmitted as current',t=>{
  let now=new Date('2026-10-28T08:00:00Z');const store=new CompanionDeliveryStore({filePath:fixture(t),now:()=>now});t.after(()=>store.close());
  store.receive({schemaVersion:1,type:'companion-event',event:{id:'expires',source:'fixture',key:'fact',revision:'1',severity:'tell',generation:target.generation,occurredAt:now.toISOString(),expiresAt:'2026-10-28T08:01:00Z',payload:{text:'synthetic'}}},target);
  assert.equal(store.nextBatch(target).length,1);now=new Date('2026-10-28T08:02:00Z');
  assert.throws(()=>store.begin({...target,id:'too-late',text:'stale',eventIds:['expires']}),/expired|eligible/);
  assert.equal(store.snapshot().submissions.length,0);
});

test('acceptance is durable, delayed, scoped and never implied by an IPC write', async t => {
  const filename = fixture(t);
  const store = new CompanionDeliveryStore({ filePath: filename });
  t.after(() => store.close());
  let finish;
  const sent = store.submit({ ...target, id: 'input-a', text: 'hello', draftRevision: 2, attachments: [{ id: 'image-a', path: '/synthetic/image.png' }] }, () => new Promise(resolve => { finish = resolve; }));
  assert.equal(JSON.parse(fs.readFileSync(filename)).submissions[0].state, 'pending');
  assert.equal(store.unresolved(target).length, 1);
  finish({ state: 'accepted', turnId: 'turn-a' });
  assert.equal((await sent).state, 'accepted');
  assert.equal(store.snapshot().submissions[0].draftRevision, 2);
  assert.equal(store.unresolved(target).length, 0);
  assert.notEqual(conversationKey(target), conversationKey({ ...target, backend: 'claude' }));
});

test('restart turns uncertain pending transmission into unknown and requires explicit resolution', async t => {
  const filename = fixture(t);
  const store = new CompanionDeliveryStore({ filePath: filename });
  store.begin({ ...target, id: 'input-a', text: 'never silently repeat', draftRevision: 4 });
  store.close();
  const restored = new CompanionDeliveryStore({ filePath: filename });
  t.after(() => restored.close());
  assert.equal(restored.unresolved(target)[0].state, 'outcomeUnknown');
  assert.throws(() => restored.begin({ ...target, id: 'input-b', text: 'retry' }), /reconcil/i);
  assert.throws(() => restored.resolveUnknown('input-a', { action: 'discard' }), /explicit/i);
  restored.resolveUnknown('input-a', { action: 'retain', userInitiated: true });
  assert.equal(restored.snapshot().submissions[0].state, 'resolvedUncertain');
  assert.equal(restored.begin({ ...target, id: 'input-b', text: 'deliberate new input' }).state, 'pending');
});

test('lost response preserves payload and duplicate ids cannot resend even after acceptance', async t => {
  const store = new CompanionDeliveryStore({ filePath: fixture(t) });
  t.after(() => store.close());
  const result = await store.submit({ ...target, id: 'input-a', text: 'preserve me' }, async () => { throw new Error('response lost'); });
  assert.equal(result.state, 'outcomeUnknown');
  assert.equal(store.snapshot().submissions[0].text, 'preserve me');
  assert.throws(() => store.begin({ ...target, id: 'input-a', text: 'duplicate' }), /already/i);
});

test('durable receipt deduplicates, respects generation and model acceptance is separate', t => {
  const filename = fixture(t);
  const store = new CompanionDeliveryStore({ filePath: filename });
  const event = { id: 'event-a', source: 'fixture', key: 'k', revision: 'r', severity: 'tell', occurredAt: '2026-10-28T07:00:00Z', expiresAt: '2026-10-28T11:00:00Z', generation: 'day-a', payload: { text: 'synthetic' } };
  assert.deepEqual(store.receive({ schemaVersion: 1, type: 'companion-event', event }, target), { schemaVersion: 1, type: 'receipt', id: 'event-a' });
  store.receive({ schemaVersion: 1, type: 'companion-event', event }, target);
  assert.throws(() => store.receive({ schemaVersion: 1, type: 'companion-event', event }, { ...target, conversationId: 'other-thread' }), /conversation/i);
  assert.equal(store.snapshot().inbox.length, 1);
  assert.equal(store.snapshot().inbox[0].state, 'received');
  assert.equal(JSON.parse(fs.readFileSync(filename)).inbox[0].id, 'event-a');
  const batch = store.nextBatch(target, { now: '2026-10-28T08:00:00Z' });
  assert.equal(batch.length, 1);
  store.closeGeneration('day-a');
  assert.equal(store.nextBatch(target).length, 0);
  assert.equal(store.snapshot().inbox[0].state, 'notDelivered');
  store.close();
});

test('unsupported schemas and corrupt data never reset evidence', t => {
  const filename = fixture(t);
  fs.writeFileSync(filename, JSON.stringify({ schemaVersion: 99 }));
  assert.throws(() => new CompanionDeliveryStore({ filePath: filename }), /schema/i);
  fs.writeFileSync(filename, '{broken');
  assert.throws(() => new CompanionDeliveryStore({ filePath: filename }), /recover/i);
  fs.unlinkSync(filename);
  const store = new CompanionDeliveryStore({ filePath: filename });
  t.after(() => store.close());
});

test('stale PID locks never block startup or alter conversation identity', t => {
  const filename=fixture(t);
  fs.writeFileSync(`${filename}.writer`, JSON.stringify({pid:process.pid,token:'reused-pid',startedAt:'2026-10-28T00:00:00Z'}));
  const store=new CompanionDeliveryStore({filePath:filename});
  store.rememberConversation({...target,sessionRootId:'root-a'});
  store.close();
  const restored=new CompanionDeliveryStore({filePath:filename});
  t.after(()=>restored.close());
  assert.equal(restored.conversation('codex').conversationId,'thread-a');
  assert.equal(restored.conversation('codex').sessionRootId,'root-a');
});

test('terminal retention prunes old outcomes but keeps unknown sends; model rejection pauses an event', t => {
  let now=new Date('2026-10-28T08:00:00Z');
  const store=new CompanionDeliveryStore({filePath:fixture(t),now:()=>now});t.after(()=>store.close());
  const event={id:'reject-event',source:'fixture',key:'key',revision:'r',severity:'tell',occurredAt:now.toISOString(),expiresAt:'2026-10-28T12:00:00Z',generation:target.generation,payload:{text:'keep rejection'}};
  store.receive({schemaVersion:1,type:'companion-event',event},target);
  store.begin({...target,id:'reject-input',text:'wake',eventIds:[event.id]});
  store.settle('reject-input',{state:'rejected',reason:'model unavailable'});
  assert.equal(store.nextBatch(target).length,0);
  assert.equal(store.snapshot().inbox[0].reason,'model unavailable');
  store.begin({...target,id:'unknown-input',text:'uncertain'});
  now=new Date('2026-11-06T08:00:00Z');store.rememberConversation(target);
  assert.equal(store.snapshot().inbox.length,0);
  assert.equal(store.snapshot().submissions.length,1);
  assert.equal(store.snapshot().submissions[0].id,'unknown-input');
  assert.equal(fs.existsSync(`${store.filePath}.journal.jsonl`),false);
});
