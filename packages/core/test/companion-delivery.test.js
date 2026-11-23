import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionDeliveryStore, MemoryDeliveryRepository, conversationKey } from '../src/companion-delivery.js';

// Since step 6 of the process split the store is durable through an asynchronous repository (the core's SQLite in
// production); these tests use the in-memory one with the same rows and positions. "Restart" is a new store on the
// same repository.
async function fixture({ now, repository = new MemoryDeliveryRepository() } = {}) {
  const store = new CompanionDeliveryStore({ repository, ...(now ? { now } : {}) });
  await store.open();
  return { store, repository };
}
const target = { backend: 'codex', conversationId: 'thread-a', generation: 'day-a', connectionEpoch: 'epoch-a' };
const down = (message = 'The CCF core is restarting.') => () => Object.assign(new Error(message), { code: 'storage_unavailable' });

test('explicit replaceable facts keep latest known revision and all source identities without replacing urgency', async () => {
  const { store } = await fixture({ now: () => new Date('2026-10-28T08:00:00Z') });
  const receive=(id,revision,severity='tell')=>store.receive({schemaVersion:1,type:'companion-event',event:{id,revision:String(revision),source:'fixture',key:'fact',severity,generation:target.generation,occurredAt:'2026-10-28T07:00:00Z',expiresAt:'2026-10-28T11:00:00Z',payload:{text:`fact${revision}`,replaceable:true,replacementKey:'fact',replacementRevision:revision}}},target);
  await receive('old',1);await receive('new',2);await receive('late-old',0);await receive('urgent',3,'urgent');
  assert.deepEqual((await store.nextBatch(target,{now:'2026-10-28T08:00:00Z'})).map(event=>event.id),['new','urgent']);
  assert.equal(store.snapshot().inbox.length,4);assert.equal(store.snapshot().inbox.find(e=>e.id==='old').supersededBy,'new');
  await assert.rejects(receive('collision',2),/replacement revision/i);
  await assert.rejects(store.begin({...target,id:'stale-batch',text:'stale',eventIds:['old']}),/superseded|eligible/i);
});

test('facts already referenced by pending or uncertain submissions cannot be superseded', async () => {
  const { store } = await fixture({ now: () => new Date('2026-10-28T08:00:00Z') });
  const base={source:'fixture',key:'fact',severity:'tell',generation:target.generation,occurredAt:'2026-10-28T07:00:00Z',expiresAt:'2026-10-28T11:00:00Z'};
  for(const revision of [1,2]){
    await store.receive({schemaVersion:1,type:'companion-event',event:{...base,id:`fact-${revision}`,revision:String(revision),payload:{replaceable:true,replacementKey:'fact',replacementRevision:revision,text:'synthetic'}}},target);
    if(revision===1)await store.begin({...target,id:'in-flight',text:'selected',eventIds:['fact-1']});
  }
  assert.equal(store.snapshot().inbox.find(e=>e.id==='fact-1').state,'received');
  await store.settle('in-flight',{state:'outcomeUnknown'});assert.equal(store.snapshot().inbox.find(e=>e.id==='fact-1').state,'outcomeUnknown');
  assert.equal((await store.nextBatch(target,{now:'2026-10-28T08:00:00Z'})).length,0);
});

test('a watcher event expiring after selection is never transmitted as current', async () => {
  let now=new Date('2026-10-28T08:00:00Z');
  const { store } = await fixture({ now: () => now });
  await store.receive({schemaVersion:1,type:'companion-event',event:{id:'expires',source:'fixture',key:'fact',revision:'1',severity:'tell',generation:target.generation,occurredAt:now.toISOString(),expiresAt:'2026-10-28T08:01:00Z',payload:{text:'synthetic'}}},target);
  assert.equal((await store.nextBatch(target)).length,1);now=new Date('2026-10-28T08:02:00Z');
  await assert.rejects(store.begin({...target,id:'too-late',text:'stale',eventIds:['expires']}),/expired|eligible/);
  assert.equal(store.snapshot().submissions.length,0);
});

test('acceptance is durable, delayed, scoped and never implied by an IPC write', async () => {
  const { store, repository } = await fixture();
  let finish;
  let transmitted = null;
  const sent = store.submit({ ...target, id: 'input-a', text: 'hello', draftRevision: 2, attachments: [{ id: 'image-a', path: '/synthetic/image.png' }] },
    (record) => { transmitted = repository.state().submissions.find((item) => item.id === record.id)?.state ?? null; return new Promise(resolve => { finish = resolve; }); });
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transmitted, 'pending', 'the pending record was committed before transmission');
  assert.equal(store.unresolved(target).length, 1);
  finish({ state: 'accepted', turnId: 'turn-a' });
  assert.equal((await sent).state, 'accepted');
  assert.equal(store.snapshot().submissions[0].draftRevision, 2);
  assert.equal(repository.state().submissions[0].state, 'accepted');
  assert.equal(store.unresolved(target).length, 0);
  assert.notEqual(conversationKey(target), conversationKey({ ...target, backend: 'claude' }));
});

test('restart turns uncertain pending transmission into unknown and requires explicit resolution', async () => {
  const { store, repository } = await fixture();
  await store.begin({ ...target, id: 'input-a', text: 'never silently repeat', draftRevision: 4 });
  const { store: restored } = await fixture({ repository });
  assert.equal(restored.unresolved(target)[0].state, 'outcomeUnknown');
  assert.equal(repository.state().submissions[0].state, 'outcomeUnknown', 'the recovery itself is durable');
  await assert.rejects(restored.begin({ ...target, id: 'input-b', text: 'retry' }), /reconcil/i);
  assert.throws(() => restored.resolveUnknown('input-a', { action: 'discard' }), /explicit/i);
  await restored.resolveUnknown('input-a', { action: 'retain', userInitiated: true });
  assert.equal(restored.snapshot().submissions[0].state, 'resolvedUncertain');
  assert.equal((await restored.begin({ ...target, id: 'input-b', text: 'deliberate new input' })).state, 'pending');
});

test('lost response preserves payload and duplicate ids cannot resend even after acceptance', async () => {
  const { store } = await fixture();
  const result = await store.submit({ ...target, id: 'input-a', text: 'preserve me' }, async () => { throw new Error('response lost'); });
  assert.equal(result.state, 'outcomeUnknown');
  assert.equal(store.snapshot().submissions[0].text, 'preserve me');
  await assert.rejects(store.begin({ ...target, id: 'input-a', text: 'duplicate' }), /already/i);
});

test('durable receipt deduplicates, respects generation and model acceptance is separate', async () => {
  const { store, repository } = await fixture();
  const event = { id: 'event-a', source: 'fixture', key: 'k', revision: 'r', severity: 'tell', occurredAt: '2026-10-28T07:00:00Z', expiresAt: '2026-10-28T11:00:00Z', generation: 'day-a', payload: { text: 'synthetic' } };
  assert.deepEqual(await store.receive({ schemaVersion: 1, type: 'companion-event', event }, target), { schemaVersion: 1, type: 'receipt', id: 'event-a' });
  await store.receive({ schemaVersion: 1, type: 'companion-event', event }, target);
  await assert.rejects(store.receive({ schemaVersion: 1, type: 'companion-event', event }, { ...target, conversationId: 'other-thread' }), /conversation/i);
  assert.equal(store.snapshot().inbox.length, 1);
  assert.equal(store.snapshot().inbox[0].state, 'received');
  assert.equal(repository.state().inbox[0].id, 'event-a');
  const batch = await store.nextBatch(target, { now: '2026-10-28T08:00:00Z' });
  assert.equal(batch.length, 1);
  await store.closeGeneration('day-a');
  assert.equal((await store.nextBatch(target)).length, 0);
  assert.equal(store.snapshot().inbox[0].state, 'notDelivered');
});

test('unsupported or corrupt durable state blocks the store and never resets evidence', async () => {
  const repository = MemoryDeliveryRepository.fromState({ schemaVersion: 1, submissions: [{ id: 'x', backend: 'codex', conversationId: 'c', state: 'mystery' }],
    inbox: [], closedGenerations: [] });
  const store = new CompanionDeliveryStore({ repository });
  await assert.rejects(store.open(), /unavailable.*recovery required/i);
  assert.equal(store.status().blocked.code, 'delivery_unreadable');
  await assert.rejects(store.begin({ ...target, id: 'no', text: 'blocked' }), /blocked/);
  assert.equal(repository.state().submissions[0].state, 'mystery', 'evidence untouched');
});

test('conversation identity survives a restart', async () => {
  const { store, repository } = await fixture();
  await store.rememberConversation({...target,sessionRootId:'root-a'});
  const { store: restored } = await fixture({ repository });
  assert.equal(restored.conversation('codex').conversationId,'thread-a');
  assert.equal(restored.conversation('codex').sessionRootId,'root-a');
});

test('terminal retention prunes old outcomes but keeps unknown sends; model rejection pauses an event', async () => {
  let now=new Date('2026-10-28T08:00:00Z');
  const { store, repository } = await fixture({ now: () => now });
  const event={id:'reject-event',source:'fixture',key:'key',revision:'r',severity:'tell',occurredAt:now.toISOString(),expiresAt:'2026-10-28T12:00:00Z',generation:target.generation,payload:{text:'keep rejection'}};
  await store.receive({schemaVersion:1,type:'companion-event',event},target);
  await store.begin({...target,id:'reject-input',text:'wake',eventIds:[event.id]});
  await store.settle('reject-input',{state:'rejected',reason:'model unavailable'});
  assert.equal((await store.nextBatch(target)).length,0);
  assert.equal(store.snapshot().inbox[0].reason,'model unavailable');
  await store.begin({...target,id:'unknown-input',text:'uncertain'});
  now=new Date('2026-11-06T08:00:00Z');await store.rememberConversation(target);
  assert.equal(store.snapshot().inbox.length,0);
  assert.equal(store.snapshot().submissions.length,1);
  assert.equal(store.snapshot().submissions[0].id,'unknown-input');
  assert.deepEqual(repository.state().submissions.map((record) => record.id), ['unknown-input'], 'pruned rows are removed from storage');
});

// Process-split plan, step 6 (review P1 arrangement): a send is transmitted only after its pending record's commit is
// acknowledged; storage that is down blocks sends visibly, keeps uncertain outcomes and their pins, replays nothing.
test('storage down before transmission: nothing is transmitted, the store blocks, and only resume() lifts it', async () => {
  const { store, repository } = await fixture();
  repository.fail = down();
  let transmitted = 0;
  await assert.rejects(store.submit({ ...target, id: 'input-a', text: 'not yet' }, async () => { transmitted++; return { state: 'accepted', turnId: 't' }; }),
    /blocked until the companion is started again/);
  assert.equal(transmitted, 0, 'never transmitted without a durable pending record');
  assert.equal(store.status().blocked.code, 'storage_unavailable');
  repository.fail = null;
  await assert.rejects(store.rememberConversation(target), /blocked/, 'storage back is not enough: no write resumes by itself');
  await store.resume();
  assert.equal(store.status().blocked, null);
  assert.equal((await store.submit({ ...target, id: 'input-b', text: 'now' }, async () => ({ state: 'accepted', turnId: 't' }))).state, 'accepted');
});

test('storage lost during transmission: the outcome is uncertain, its pins stay, nothing is resent, resume shows it as unknown', async () => {
  const { store, repository } = await fixture();
  const attachments = [{ id: 'image-1', path: '/tmp/i.png' }];
  const result = await store.submit({ ...target, id: 'input-a', text: 'maybe', attachments }, async () => {
    repository.fail = down();   // the core dies while Codex accepts
    return { state: 'accepted', turnId: 'turn-1' };
  });
  assert.equal(result.state, 'outcomeUnknown');
  assert.match(result.reason, /Acceptance checkpoint failed/);
  assert.deepEqual(store.pinnedSubmissions().flatMap((record) => record.attachments.map((image) => image.id)), ['image-1'], 'pins kept');
  assert.equal(repository.state().submissions[0].state, 'pending', 'storage still says pending');
  await assert.rejects(store.begin({ ...target, id: 'input-b', text: 'again' }), /blocked/);
  repository.fail = null;
  await store.resume();
  assert.equal(store.unresolved(target)[0].state, 'outcomeUnknown', 'the reload shows the interrupted send as uncertain');
  assert.equal(repository.state().submissions.length, 1, 'nothing was resent');
});

// Review of step 6 (P2): the pending record reached the store's state only after its commit was acknowledged. Until
// then its images were not pinned (an attachment removal could delete one before transmission), and after a commit
// whose acknowledgement was lost they stayed unpinned although storage held the pending record.
test('a send pins its images from before its commit until a reload settles what storage holds', async () => {
  const { store, repository } = await fixture();
  const attachments = [{ id: 'image-1', path: '/tmp/i.png' }];
  const pinned = () => store.pinnedSubmissions().flatMap((record) => (record.attachments ?? []).map((image) => image.id));
  let commit = null;
  repository.onCommit = () => new Promise((resolve, reject) => { commit = { resolve, reject }; });
  const begun = store.begin({ ...target, id: 'input-a', text: 'with an image', attachments });
  for (let i = 0; i < 5 && !commit; i++) await Promise.resolve();
  assert.ok(commit, 'the commit is under way');
  assert.deepEqual(pinned(), ['image-1'], 'pinned while its commit is under way');
  commit.resolve();
  await begun;
  assert.deepEqual(pinned(), ['image-1']);

  // The commit lands in storage, but its acknowledgement is lost.
  const lost = await fixture();
  lost.repository.onCommit = async (changes) => { lost.repository.onCommit = null; await lost.repository.commit(changes); throw new Error('ack lost'); };
  await assert.rejects(lost.store.begin({ ...target, id: 'input-b', text: 'lost ack', attachments }), /blocked/);
  assert.deepEqual(lost.store.pinnedSubmissions().map((record) => record.id), ['input-b'], 'kept pinned while blocked');
  assert.equal(lost.repository.state().submissions[0].state, 'pending', 'storage holds the pending record');
  await lost.store.resume();
  assert.deepEqual(lost.store.pinnedSubmissions().map((record) => [record.id, record.state]), [['input-b', 'outcomeUnknown']]);

  // A commit that failed without reaching storage: pinned until the reload shows there is nothing.
  const failed = await fixture();
  failed.repository.fail = down();
  await assert.rejects(failed.store.begin({ ...target, id: 'input-c', text: 'not stored', attachments }), /blocked/);
  assert.deepEqual(failed.store.pinnedSubmissions().map((record) => record.id), ['input-c']);
  failed.repository.fail = null;
  await failed.store.resume();
  assert.deepEqual(failed.store.pinnedSubmissions(), []);
});
