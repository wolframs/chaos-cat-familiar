import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-json.js';

const BACKENDS = new Set(['claude', 'codex']);
const STATES = new Set(['pending', 'accepted', 'rejected', 'outcomeUnknown', 'resolvedUncertain']);
const clone = value => structuredClone(value);
function required(value, name) { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`); return value; }
function replacementFact(event){
  if(event.severity!=='tell'||event.payload?.replaceable!==true)return null;
  const key=required(event.payload.replacementKey,'replacementKey'),revision=event.payload.replacementRevision;
  if(!Number.isSafeInteger(revision)||revision<0)throw new Error('A replaceable fact requires a nonnegative safe replacement revision.');
  return{key,revision};
}
export function conversationKey({ backend = 'claude', conversationId }) {
  if (!BACKENDS.has(backend)) throw new Error('Unsupported companion backend');
  return JSON.stringify([backend, required(conversationId, 'conversationId')]);
}

// Electron owns the single-instance lock. This file records conversation identity
// and delivery outcomes, without a second PID lock or an append-only archive.
export class CompanionDeliveryStore {
  constructor({ filePath, now = () => new Date(), write = writeJsonAtomic } = {}) {
    this.filePath = path.resolve(filePath);
    this.now = now;
    this.write = write;
    let state;
    try { state = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Companion delivery state needs recovery; evidence preserved.', { cause: error });
      state = { schemaVersion: 1, submissions: [], inbox: [], closedGenerations: [], conversations: [] };
    }
    if (state.schemaVersion !== 1 || !Array.isArray(state.submissions) || !Array.isArray(state.inbox) || !Array.isArray(state.closedGenerations)) throw new Error('Unsupported companion delivery schema; recover with a compatible version.');
    for (const record of state.submissions) {
      conversationKey(record);
      required(record.id, 'submission ID');
      if (!STATES.has(record.state)) throw new Error('Invalid persisted submission state; recovery required.');
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    state.conversations ??= [];
    this.state = state;
    let recovered = false;
    for (const record of state.submissions) if (record.state === 'pending') { record.state = 'outcomeUnknown'; record.reason = 'Restart interrupted acceptance; may have been sent.'; recovered = true; }
    if (recovered) this.#commit(state);
  }
  #commit(next) {
    const cutoff=this.now().getTime()-7*86400_000;
    const retain=(records,type)=>records.filter(record=>{
      const terminal=type==='submission' ? ['accepted','rejected','resolvedUncertain'].includes(record.state)
        : !['received','outcomeUnknown'].includes(record.state);
      if (terminal && Date.parse(record.updatedAt??record.receivedAt??record.createdAt)>=0
        && Date.parse(record.updatedAt??record.receivedAt??record.createdAt)<cutoff) {
        return false;
      }
      return true;
    });
    next.submissions=retain(next.submissions,'submission');next.inbox=retain(next.inbox,'inbox');
    if (Buffer.byteLength(JSON.stringify(next)) > 16 * 1024 * 1024) throw new Error('Companion delivery storage quota reached; preserve evidence and drain the backlog.');
    this.write(this.filePath, next); this.state = next;
  }
  snapshot() { return clone(this.state); }
  conversation(backend) { return clone(this.state.conversations.find(record => record.backend === backend&&!record.closedAt) ?? null); }
  rememberConversation(record) {
    conversationKey(record); required(record.generation, 'generation');
    const next=clone(this.state);
    const existing=next.conversations.findIndex(item=>item.backend===record.backend);
    const value={...clone(record),schemaVersion:1,updatedAt:this.now().toISOString()};
    if(existing<0) next.conversations.push(value); else next.conversations[existing]=value;
    this.#commit(next); return clone(value);
  }
  unresolved(target) { const key = conversationKey(target); return clone(this.state.submissions.filter(x => conversationKey(x) === key && ['pending', 'outcomeUnknown'].includes(x.state))); }
  begin(input) {
    const key = conversationKey(input);
    required(input.id, 'submission ID');
    required(input.generation, 'generation');
    if (this.state.submissions.some(x => x.id === input.id)) throw new Error('Submission ID already recorded; never automatically resend.');
    if (this.unresolved(input).length) throw new Error('Reconcile the pending or uncertain submission before sending again.');
    if (this.state.closedGenerations.includes(input.generation)) throw new Error('Daily generation is closed.');
    if (typeof input.text !== 'string' || (!input.text.trim() && !input.attachments?.length)) throw new Error('Submission input is empty.');
    if (Buffer.byteLength(input.text, 'utf8') > 256 * 1024) throw new Error('Submission input exceeds the configured limit.');
    if(input.eventIds!==undefined){
      if(!Array.isArray(input.eventIds)||new Set(input.eventIds).size!==input.eventIds.length)throw new Error('Invalid watcher batch identity list.');
      for(const id of input.eventIds){const event=this.state.inbox.find(item=>item.id===id);
        if(!event||event.state!=='received'||conversationKey(event)!==key||event.generation!==input.generation||Date.parse(event.expiresAt)<=this.now().getTime())throw new Error('Watcher batch is no longer eligible; a fact may have expired or been superseded before transmission.');
      }
    }
    const record = { ...clone(input), schemaVersion: 1, state: 'pending', createdAt: this.now().toISOString(), conversationKey: key };
    const next = clone(this.state); next.submissions.push(record); this.#commit(next);
    return clone(record);
  }
  settle(id, result) {
    const next = clone(this.state);
    const record = next.submissions.find(x => x.id === id);
    if (!record || record.state !== 'pending') throw new Error('Submission is no longer pending.');
    if (!['accepted', 'rejected', 'outcomeUnknown'].includes(result?.state)) throw new Error('Backend did not provide a submission outcome.');
    if (record.backend === 'codex' && result.state === 'accepted' && !result.turnId) throw new Error('Codex acceptance requires an authoritative turn ID.');
    Object.assign(record, { state: result.state, turnId: result.turnId ?? null, reason: result.reason ?? null, updatedAt: this.now().toISOString(),
      ...(result.acceptanceBoundary?{acceptanceBoundary:result.acceptanceBoundary}:{}),...(result.memoryAck?{memoryAck:clone(result.memoryAck)}:{}) });
    for (const event of next.inbox) if (record.eventIds?.includes(event.id)) {
      event.state = result.state === 'accepted' ? 'modelAccepted' : result.state === 'rejected' ? 'modelRejected' : 'outcomeUnknown';
      event.submissionId = id;event.reason=result.reason??null;event.updatedAt=this.now().toISOString();
    }
    this.#commit(next); return clone(record);
  }
  async submit(input, transmit) {
    const record = this.begin(input);
    let result;
    try { result = await transmit(clone(record)); }
    catch (error) { result = { state: 'outcomeUnknown', reason: String(error.message ?? error) }; }
    try { return this.settle(record.id, result); }
    catch (error) {
      // Keep the pending outcome even if the acceptance checkpoint failed. On restart
      // the durable pending record becomes unknown. Never report uncommitted acceptance.
      const current = this.state.submissions.find(x => x.id === record.id);
      current.state = 'outcomeUnknown'; current.reason = `Acceptance checkpoint failed: ${error.message}`;
      return clone(current);
    }
  }
  resolveUnknown(id, { action, userInitiated = false } = {}) {
    if (!userInitiated || !['retain', 'confirmed-not-sent'].includes(action)) throw new Error('Uncertain submission needs an explicit user resolution.');
    const next = clone(this.state); const record = next.submissions.find(x => x.id === id);
    if (!record || record.state !== 'outcomeUnknown') throw new Error('No uncertain submission with that ID.');
    record.state = 'resolvedUncertain'; record.resolution = action; record.updatedAt = this.now().toISOString();
    // Preserve the original payload and ID. A deliberate retry gets a fresh ID.
    this.#commit(next); return clone(record);
  }
  receive(wire, target) {
    conversationKey(target);
    const event = wire?.event;
    if (wire?.schemaVersion !== 1 || wire.type !== 'companion-event' || !event || !['info', 'tell', 'urgent'].includes(event.severity)) throw new Error('Invalid watcher event envelope.');
    for (const name of ['id', 'source', 'key', 'revision', 'generation', 'occurredAt', 'expiresAt']) required(event[name], name);
    if (![event.occurredAt, event.expiresAt].every(value => Number.isFinite(Date.parse(value)))) throw new Error('Invalid event time.');
    if (event.generation !== target.generation) throw new Error('Watcher generation mismatch; event remains in source outbox.');
    const prior = this.state.inbox.find(x => x.id === event.id);
    if (prior) {
      if (prior.source !== event.source || prior.key !== event.key || prior.revision !== event.revision || prior.generation !== event.generation
        || conversationKey(prior) !== conversationKey(target)) throw new Error('Watcher event identity collision or conversation mismatch.');
      return { schemaVersion: 1, type: 'receipt', id: event.id };
    }
    const next = clone(this.state);
    const fact=replacementFact(event);let supersededBy=null;
    if(fact){
      const priorFacts=next.inbox.filter(item=>item.source===event.source&&item.generation===event.generation&&conversationKey(item)===conversationKey(target))
        .map(item=>({item,fact:replacementFact(item)})).filter(entry=>entry.fact?.key===fact.key);
      if(priorFacts.some(entry=>entry.fact.revision===fact.revision))throw new Error('Replacement revision already has a different event identity.');
      const latest=priorFacts.reduce((best,entry)=>!best||entry.fact.revision>best.fact.revision?entry:best,null);
      if(latest&&latest.fact.revision>fact.revision)supersededBy=latest.item.id;
      else{
        const protectedIds=new Set(next.submissions.filter(record=>['pending','outcomeUnknown'].includes(record.state)).flatMap(record=>record.eventIds??[]));
        for(const entry of priorFacts)if(entry.item.state==='received'&&!protectedIds.has(entry.item.id)){
          entry.item.state='superseded';entry.item.supersededBy=event.id;entry.item.updatedAt=this.now().toISOString();
        }
      }
    }
    const pending = next.inbox.filter(x => ['received', 'outcomeUnknown'].includes(x.state));
    if (!supersededBy&&(pending.length >= 100 || Buffer.byteLength(JSON.stringify([...pending, event])) > 256 * 1024)) throw new Error('Watcher backlog full; source must retain unacknowledged events.');
    next.inbox.push({ ...clone(event), backend: target.backend, conversationId: target.conversationId, sessionRootId: target.sessionRootId ?? null,
      schemaVersion: 1, state: next.closedGenerations.includes(event.generation) ? 'notDelivered' : event.severity === 'info' ? 'journalOnly' : supersededBy?'superseded':'received', ...(supersededBy?{supersededBy}:{}), receivedAt: this.now().toISOString() });
    this.#commit(next);
    return { schemaVersion: 1, type: 'receipt', id: event.id };
  }
  nextBatch(target, { now = this.now().toISOString() } = {}) {
    if (this.unresolved(target).length || this.state.closedGenerations.includes(target.generation)) return [];
    const next = clone(this.state); let changed = false; let bytes = 0; const batch = [];
    for (const event of next.inbox) {
      if (event.state !== 'received' || conversationKey(event) !== conversationKey(target) || event.generation !== target.generation) continue;
      if (Date.parse(event.expiresAt) <= Date.parse(now)) { event.state = 'expired'; changed = true; continue; }
      const size = Buffer.byteLength(JSON.stringify(event));
      if (batch.length >= 10 || bytes + size > 32 * 1024) continue;
      batch.push(clone(event)); bytes += size;
    }
    if (changed) this.#commit(next); return batch;
  }
  closeGeneration(generation) {
    const next = clone(this.state);
    if (!next.closedGenerations.includes(generation)) next.closedGenerations.push(generation);
    for(const conversation of next.conversations)if(conversation.generation===generation)conversation.closedAt=this.now().toISOString();
    for (const event of next.inbox) if (event.generation === generation && event.state === 'received') event.state = 'notDelivered';
    this.#commit(next);
  }
  close() {}
}
