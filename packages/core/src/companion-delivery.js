import { RowShadow } from './row-shadow.js';

const BACKENDS = new Set(['claude', 'codex']);
const STATES = new Set(['pending', 'accepted', 'rejected', 'outcomeUnknown', 'resolvedUncertain']);
const PINNING = new Set(['pending', 'outcomeUnknown']);   // submissions whose images must stay on disk
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

// The checks a persisted delivery state must pass (companion-delivery.json before step 6, its import into SQLite).
// Throws with a message that says what to do; returns the state with defaults filled in.
export function validateDeliveryState(state) {
  if (!state || typeof state !== 'object' || state.schemaVersion !== 1 || !Array.isArray(state.submissions) || !Array.isArray(state.inbox)
    || !Array.isArray(state.closedGenerations)) throw new Error('Unsupported companion delivery schema; recover with a compatible version.');
  for (const record of state.submissions) {
    conversationKey(record);
    required(record.id, 'submission ID');
    if (!STATES.has(record.state)) throw new Error('Invalid persisted submission state; recovery required.');
  }
  state.conversations ??= [];
  return state;
}

// The SQLite tables of each collection (storage-schema.js DELIVERY_TABLES) and the key of a row.
export const DELIVERY_COLLECTIONS = Object.freeze({
  submissions: { table: 'delivery_submissions', key: (item) => item.id },
  inbox: { table: 'delivery_inbox', key: (item) => item.id },
  conversations: { table: 'delivery_conversations', key: (item) => item.backend },
  closedGenerations: { table: 'delivery_closed_generations', key: (item) => item }
});

const emptyState = () => ({ schemaVersion: 1, submissions: [], inbox: [], closedGenerations: [], conversations: [] });

// Conversation identity and delivery outcomes of the work companion (Codex sends, watcher receipts). Since step 6 of the
// process split they are rows in the core's SQLite database, reached through an asynchronous repository (in the
// companion process: requests relayed by main to the core's storage worker):
//   repository.load() -> { rows: { <table>: [{id, pos, json}] } }   repository.commit(changes) -> acknowledged commit
// A transition is durable once its commit is acknowledged; only then does the store take it over. A durable send is
// transmitted only after its pending record's commit was acknowledged. When a commit fails (the core or its storage is
// down, a timeout, an outcome that cannot be known) the store blocks: reads keep the last state (uncertain submissions
// and the attachments they pin stay visible), every write is refused with the reason, nothing is replayed, and only
// resume() (an explicit user action: Start) reloads the durable state and lifts the block.
export class CompanionDeliveryStore {
  constructor({ repository, now = () => new Date() } = {}) {
    if (!repository) throw new Error('A delivery repository is required.');
    this.repository = repository;
    this.now = now;
    this.state = emptyState();
    this.shadows = Object.fromEntries(Object.entries(DELIVERY_COLLECTIONS).map(([name, { key }]) => [name, new RowShadow({ direction: 'asc', key })]));
    this.blocked = { reason: 'Companion delivery state has not been loaded yet.', code: 'not_loaded' };
    this.work = Promise.resolve();
    // Submissions that pin images but whose commit is not acknowledged (under way, or failed: storage may hold them all
    // the same). They pin from before the commit until a reload shows what storage holds (review of step 6, P2).
    this.unacknowledgedPins = [];
  }

  // Loads the durable state. A submission still pending there was interrupted mid-transmission: it becomes
  // outcomeUnknown (committed before anything else may happen). Rejects, and stays blocked, when storage is unavailable.
  open() { return this.#serial(() => this.#load()); }

  // The explicit way back after a failed commit: the durable state is reloaded (what is uncertain becomes visible as
  // such) and writes are accepted again.
  resume() { return this.#serial(() => this.#load()); }

  status() { return { blocked: this.blocked ? { ...this.blocked } : null }; }

  async #load() {
    let loaded;
    try { loaded = await this.repository.load(); }
    catch (error) { this.#block(error); throw this.#blockedError(); }
    const state = emptyState();
    for (const [name, { table }] of Object.entries(DELIVERY_COLLECTIONS)) {
      const rows = loaded?.rows?.[table] ?? [];
      state[name] = rows.map((row) => JSON.parse(row.json));
      this.shadows[name].reset(rows, state[name]);
    }
    try { validateDeliveryState(state); }
    catch (error) { this.#block(Object.assign(error, { code: 'delivery_unreadable' })); throw this.#blockedError(); }
    this.state = state;
    this.blocked = null;
    this.unacknowledgedPins = [];
    if (state.submissions.some((record) => record.state === 'pending')) {
      await this.#commit((next) => {
        for (const record of next.submissions) if (record.state === 'pending') { record.state = 'outcomeUnknown'; record.reason = 'Restart interrupted acceptance; may have been sent.'; }
      });
    }
    return this.snapshot();
  }

  #block(error) {
    this.blocked = { reason: String(error?.message ?? error), code: error?.code ?? 'storage_unavailable', at: this.now().toISOString() };
  }

  #blockedError() {
    return Object.assign(new Error(`Companion delivery storage is unavailable (${this.blocked.reason}); sends are blocked until the companion is started again.`),
      { code: 'delivery_blocked' });
  }

  // Mutations run one at a time, each against the state the previous one left.
  #serial(work) {
    const result = this.work.then(work, work);
    this.work = result.catch(() => {});
    return result;
  }

  #mutate(work) {
    return this.#serial(async () => {
      if (this.blocked) throw this.#blockedError();
      return work();
    });
  }

  // Applies change(next) to a copy, keeps retention and the quota, commits the rows that changed and only then takes
  // the copy over. A failed commit blocks the store and leaves its state as it was.
  async #commit(change) {
    const next = clone(this.state);
    const value = change(next);
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
    const diffs = Object.fromEntries(Object.keys(DELIVERY_COLLECTIONS).map((name) => [name, this.shadows[name].diff(next[name])]));
    const changes = {};
    for (const [name, diff] of Object.entries(diffs)) if (diff.change) changes[DELIVERY_COLLECTIONS[name].table] = diff.change;
    if (Object.keys(changes).length) {
      const known = new Set(this.state.submissions.map((record) => record.id));
      const newPins = next.submissions.filter((record) => !known.has(record.id) && PINNING.has(record.state));
      this.unacknowledgedPins.push(...newPins);
      try { await this.repository.commit(changes); }
      catch (error) { this.#block(error); throw this.#blockedError(); }
      this.unacknowledgedPins = this.unacknowledgedPins.filter((record) => !newPins.includes(record));
    }
    for (const diff of Object.values(diffs)) diff.commit();
    this.state = next;
    return value;
  }

  snapshot() { return clone(this.state); }
  // Read-only, uncloned: the companion projects pinned attachments on every terminal frame.
  pinnedSubmissions() {
    const pinned = this.state.submissions.filter(record => PINNING.has(record.state));
    if (!this.unacknowledgedPins.length) return pinned;
    const ids = new Set(pinned.map((record) => record.id));
    return [...pinned, ...this.unacknowledgedPins.filter((record) => !ids.has(record.id))];
  }
  conversation(backend) { return clone(this.state.conversations.find(record => record.backend === backend&&!record.closedAt) ?? null); }
  rememberConversation(record) {
    conversationKey(record); required(record.generation, 'generation');
    return this.#mutate(() => this.#commit((next) => {
      const existing=next.conversations.findIndex(item=>item.backend===record.backend);
      const value={...clone(record),schemaVersion:1,updatedAt:this.now().toISOString()};
      if(existing<0) next.conversations.push(value); else next.conversations[existing]=value;
      return clone(value);
    }));
  }
  unresolved(target) { const key = conversationKey(target); return clone(this.state.submissions.filter(x => conversationKey(x) === key && ['pending', 'outcomeUnknown'].includes(x.state))); }
  // Resolves with the pending record once its commit was acknowledged: only then may the input be transmitted.
  begin(input) {
    return this.#mutate(() => {
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
      return this.#commit((next) => { next.submissions.push(record); return clone(record); });
    });
  }
  settle(id, result) {
    return this.#mutate(() => this.#commit((next) => {
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
      return clone(record);
    }));
  }
  async submit(input, transmit) {
    const record = await this.begin(input);
    let result;
    try { result = await transmit(clone(record)); }
    catch (error) { result = { state: 'outcomeUnknown', reason: String(error.message ?? error) }; }
    try { return await this.settle(record.id, result); }
    catch (error) {
      // Keep the pending outcome even if the acceptance checkpoint failed. The durable pending record becomes unknown
      // on the next load (resume or restart). Never report uncommitted acceptance.
      const current = this.state.submissions.find(x => x.id === record.id);
      if (current) { current.state = 'outcomeUnknown'; current.reason = `Acceptance checkpoint failed: ${error.message}`; }
      return clone(current ?? { ...record, state: 'outcomeUnknown', reason: `Acceptance checkpoint failed: ${error.message}` });
    }
  }
  resolveUnknown(id, { action, userInitiated = false } = {}) {
    if (!userInitiated || !['retain', 'confirmed-not-sent'].includes(action)) throw new Error('Uncertain submission needs an explicit user resolution.');
    return this.#mutate(() => this.#commit((next) => {
      const record = next.submissions.find(x => x.id === id);
      if (!record || record.state !== 'outcomeUnknown') throw new Error('No uncertain submission with that ID.');
      record.state = 'resolvedUncertain'; record.resolution = action; record.updatedAt = this.now().toISOString();
      // Preserve the original payload and ID. A deliberate retry gets a fresh ID.
      return clone(record);
    }));
  }
  // Resolves with the receipt once the event is durable; a write failure sends no receipt, so the source keeps it.
  receive(wire, target) {
    return this.#mutate(() => {
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
      return this.#commit((next) => {
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
        return { schemaVersion: 1, type: 'receipt', id: event.id };
      });
    });
  }
  // The next batch of watcher events to wake an idle turn with (expired ones are recorded as such).
  nextBatch(target, { now = this.now().toISOString() } = {}) {
    return this.#mutate(() => {
      if (this.unresolved(target).length || this.state.closedGenerations.includes(target.generation)) return [];
      return this.#commit((next) => {
        let bytes = 0; const batch = [];
        for (const event of next.inbox) {
          if (event.state !== 'received' || conversationKey(event) !== conversationKey(target) || event.generation !== target.generation) continue;
          if (Date.parse(event.expiresAt) <= Date.parse(now)) { event.state = 'expired'; continue; }
          const size = Buffer.byteLength(JSON.stringify(event));
          if (batch.length >= 10 || bytes + size > 32 * 1024) continue;
          batch.push(clone(event)); bytes += size;
        }
        return batch;
      });
    });
  }
  closeGeneration(generation) {
    return this.#mutate(() => this.#commit((next) => {
      if (!next.closedGenerations.includes(generation)) next.closedGenerations.push(generation);
      for(const conversation of next.conversations)if(conversation.generation===generation)conversation.closedAt=this.now().toISOString();
      for (const event of next.inbox) if (event.generation === generation && event.state === 'received') event.state = 'notDelivered';
    }));
  }
  close() {}
}

// An in-memory repository with the same rows and positions as the database (tests, and hosts without a core).
// fail: a function returning an Error to fail the next load/commit with (a core that is down), or null.
export class MemoryDeliveryRepository {
  constructor({ rows = {} } = {}) {
    this.tables = Object.fromEntries(Object.values(DELIVERY_COLLECTIONS).map(({ table }) => [table,
      new Map((rows[table] ?? []).map((row) => [String(row.id), { pos: row.pos, json: row.json }]))]));
    this.fail = null;
    this.commits = 0;
    this.onCommit = null;
  }

  static fromState(state) {
    const rows = {};
    for (const [name, { table, key }] of Object.entries(DELIVERY_COLLECTIONS)) {
      rows[table] = (state?.[name] ?? []).map((item, index) => ({ id: String(key(item)), pos: index + 1, json: JSON.stringify(item) }));
    }
    return new MemoryDeliveryRepository({ rows });
  }

  async load() {
    const error = this.fail?.('load');
    if (error) throw error;
    return { rows: Object.fromEntries(Object.entries(this.tables).map(([table, rows]) => [table,
      [...rows.entries()].map(([id, row]) => ({ id, ...row })).sort((left, right) => left.pos - right.pos)])) };
  }

  async commit(changes) {
    const error = this.fail?.('commit');
    if (error) throw error;
    await this.onCommit?.(changes);
    for (const [table, change] of Object.entries(changes)) {
      const rows = this.tables[table];
      for (const id of change.remove ?? []) rows.delete(String(id));
      for (const row of change.upsert ?? []) rows.set(String(row.id), { pos: row.pos, json: row.json });
      for (const row of change.reposition ?? []) { const known = rows.get(String(row.id)); if (known) known.pos = row.pos; }
    }
    this.commits += 1;
    return { ok: true };
  }

  state() {
    const state = { schemaVersion: 1 };
    for (const [name, { table }] of Object.entries(DELIVERY_COLLECTIONS)) {
      state[name] = [...this.tables[table].values()].sort((left, right) => left.pos - right.pos).map((row) => JSON.parse(row.json));
    }
    return state;
  }
}
