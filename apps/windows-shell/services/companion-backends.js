import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { composeImageMessage } from './companion-attachments.js';

// One selected owner. Selection never starts/stops/migrates a conversation.
export class CompanionBackends extends EventEmitter {
  constructor({ claude, codex, backend = 'claude', delivery, habitat, watcher, onSelect = () => {} } = {}) {
    super();
    if (!['claude', 'codex'].includes(backend)) throw new Error('Unsupported companion backend setting.');
    Object.assign(this, { sessions: { claude, codex }, backend, delivery, habitat, watcher, onSelect });
    this.switching=false;this.switchSettled=null;
    this.generation = this.delivery?.conversation(backend)?.generation ?? randomUUID();
    this.listeners = [];
    for (const [name, session] of Object.entries(this.sessions)) {
      const listener = (changeSnapshot) => { if (this.backend === name) {
        const captured=changeSnapshot??session.getSnapshot();
        if(name==='codex'&&!captured.connected)this.watcher?.stop().catch(error=>this.#fault(error));
        this.emit('change', this.getSnapshot(captured));
      }};
      session.on('change', listener); this.listeners.push(() => session.off('change', listener));
    }
  }
  get current() { return this.sessions[this.backend]; }
  getSnapshot(changeSnapshot) {
    const snapshot = { ...this.delivery?.conversation(this.backend), ...(changeSnapshot??this.current.getSnapshot()) };
    if (!snapshot.conversationId) snapshot.conversationId = this.delivery?.conversation(this.backend)?.conversationId ?? null;
    const unresolved = snapshot.conversationId && this.delivery ? this.delivery.unresolved({ backend: this.backend, conversationId: snapshot.conversationId }) : [];
    return { ...snapshot, backend: this.backend, generation: this.generation,switching:this.switching,watcher:this.watcher?.getSnapshot?.()??{state:'disabled'}, ...(this.lifecycleError?{error:this.lifecycleError}:{}),
      ...(unresolved.length ? { submission: unresolved.at(-1) } : {}) };
  }
  #assertTransitionAvailable(){if(this.switching||this.disposing)throw new Error('A companion backend switch or cleanup is already in progress.');}
  #selection(backend){return{backend,generation:this.delivery?.conversation(backend)?.generation??randomUUID()};}
  #applySelection(selection){this.backend=selection.backend;this.generation=selection.generation;this.lifecycleError=null;}
  #assertSwitchSafe(){
    const snapshot=this.current.getSnapshot();
    if(this.starting||this.current.starting||this.submitting)throw new Error('Wait for the current companion operation before switching backends.');
    if(snapshot.connected&&snapshot.phase!=='idle')throw new Error('Wait for an idle companion turn before switching backends.');
    if(snapshot.pendingPrompt||snapshot.pendingPrompts?.length||snapshot.pendingRequests?.length)throw new Error('Resolve pending companion requests before switching backends.');
    if(['pending','outcomeUnknown','unknown'].includes(snapshot.submission?.state)||(this.delivery?.snapshot().submissions??[]).some(record=>['pending','outcomeUnknown','unknown'].includes(record.state)))throw new Error('Reconcile pending or uncertain submissions before switching backends.');
  }
  selectBackend(backend) {
    this.#assertTransitionAvailable();
    if (!['claude', 'codex'].includes(backend)) throw new Error('Unsupported companion backend.');
    if (backend === this.backend) return this.getSnapshot();
    if (this.current.getSnapshot().connected || this.current.starting || this.starting || this.submitting || this.habitatClaimed) throw new Error('Disconnect the current companion before switching backends.');
    if (this.delivery?.snapshot().submissions.some(x => ['pending', 'outcomeUnknown'].includes(x.state))) throw new Error('Reconcile uncertain submissions before switching backends.');
    const selection=this.#selection(backend);this.onSelect(backend);this.#applySelection(selection);
    this.emit('change', this.getSnapshot()); return this.getSnapshot();
  }
  async switchBackend({backend,userInitiated=false}={}){
    if(!['claude','codex'].includes(backend))throw new Error('Unsupported companion backend.');
    if(userInitiated!==true)throw new Error('Switching companion backends requires an explicit user operation.');
    this.#assertTransitionAvailable();
    if(backend===this.backend)return this.getSnapshot();
    this.#assertSwitchSafe();this.switching=true;
    let settled;this.switchSettled=new Promise(resolve=>{settled=resolve;});
    try{
      this.emit('change',this.getSnapshot());
      if(this.current.getSnapshot().connected||this.habitatClaimed)await this.#stop({disposition:'stop'});
      if(this.current.getSnapshot().connected||this.habitatClaimed)throw new Error('The current companion did not disconnect; backend selection is unchanged.');
      this.#assertSwitchSafe();const selection=this.#selection(backend);
      await this.onSelect(backend);this.#applySelection(selection);
    }catch(error){this.#fault(error);throw error;}
    finally{this.switching=false;this.switchSettled=null;try{this.emit('change',this.getSnapshot());}finally{settled();}}
    return this.getSnapshot();
  }
  async start(options) {
    this.#assertTransitionAvailable();
    if(this.starting)throw new Error('Companion is already starting.');
    if(this.current.getSnapshot().connected)return this.getSnapshot();
    this.starting=true;this.lifecycleError=null;let memory,launchAttempted=false;
    try{
      let previous=this.delivery?.conversation(this.backend);
      if(this.backend==='codex'&&this.habitat){
        const owner=await this.habitat.claim({backend:this.backend,generation:this.generation,...(previous?{conversationId:previous.conversationId}:{})});
        this.habitatClaimed=true;this.generation=owner.generation;
        if(owner.conversationId)previous=owner;
        if(owner.reservationRecovered&&!previous)throw new Error('An earlier unbound launch needs explicit recovery before creating another conversation.');
        memory=await this.habitat.prepare(previous?'resume':'startup');
      }
      launchAttempted=true;
      const result=await this.current.start({...options,...(previous?{conversationId:previous.conversationId}:{}),
        ...(memory?{developerInstructions:memory.text,memoryContext:{revision:memory.contextId}}:{})});
      const snapshot=this.current.getSnapshot();
      if(snapshot.conversationId){
        this.delivery?.rememberConversation({backend:this.backend,conversationId:snapshot.conversationId,sessionRootId:snapshot.sessionRootId??null,generation:this.generation});
        this.current.setUnresolvedSubmissions?.(this.delivery?.unresolved(snapshot)??[]);
      }
      if(this.backend==='codex'&&this.habitat){
        const owner=await this.habitat.bind({conversationId:snapshot.conversationId,sessionRootId:snapshot.sessionRootId??null});
        if(memory&&result.memoryAck)await this.habitat.acknowledge(memory,result.memoryAck);
        else if(memory)throw new Error('Codex did not acknowledge the prepared memory configuration.');
        await this.watcher?.start(owner);
      }
      this.emit('change',this.getSnapshot());return result;
    }catch(error){
      await this.watcher?.stop().catch(()=>{});
      if(launchAttempted)await this.current.stop().catch(()=>{});
      // A failed launch may have created a thread before response loss. Preserve
      // its reservation/context; an explicit recovery must decide its disposition.
      await this.habitat?.stop().catch(()=>{});this.habitatClaimed=false;
      this.#fault(error);throw error;
    }finally{this.starting=false;}
  }
  #fault(error){this.lifecycleError=String(error.message??error);this.emit('change',this.getSnapshot());}
  observeConversation({backend,conversationId,sessionRootId=null}){
    if(this.switching||this.disposing)return false;
    if(backend!==this.backend||!this.current.getSnapshot().connected||!conversationId)return false;
    const previous=this.delivery?.conversation(backend);
    if(previous?.conversationId&&previous.conversationId!==conversationId&&this.delivery.unresolved(previous).length)throw new Error('Another conversation has uncertain submissions; reconcile first.');
    this.delivery?.rememberConversation({backend,conversationId,sessionRootId,generation:this.generation});return true;
  }
  async submit({ id = randomUUID(), text = '', attachments = [], draftRevision, eventIds = [], source = 'user' } = {}) {
    this.#assertTransitionAvailable();
    if (this.submitting) throw new Error('A submission is already pending.');
    this.submitting = true;
    try {
      if (this.backend === 'claude') {
        // ConPTY has no authoritative turn/input acknowledgement. This boundary
        // means only that both PTY writes returned; it cannot prove model receipt.
        const transmit=async()=>{await this.current.send(composeImageMessage(text, attachments));return{id,state:'accepted',draftRevision,acceptanceBoundary:'pty-write'};};
        return await transmit();
      }
      if (!this.delivery) throw new Error('Durable Codex submission store is unavailable.');
      const snapshot = this.current.getSnapshot();
      if (!snapshot.connected || snapshot.phase !== 'idle') return { id, state: 'rejected', reason: 'Wait until the Codex turn is idle.', draftRevision };
      let memory=this.habitatClaimed?await this.habitat.prepare(snapshot.memoryRefreshNeeded?'compaction':'turn'):null;
      if(memory&&!memory.required)memory=null;
      const result = await this.delivery.submit({ schemaVersion: 1, id, backend: this.backend, conversationId: snapshot.conversationId,
        sessionRootId: snapshot.sessionRootId ?? null, connectionEpoch: snapshot.connectionEpoch, generation: this.generation,
        text, attachments, draftRevision, eventIds, source,...(memory?.required?{memory:{revision:memory.contextId,text:memory.text}}:{}) }, record => this.current.submit(record));
      if(memory){
        if(result.state==='accepted'&&result.memoryAck){try{await this.habitat.acknowledge(memory,result.memoryAck);}catch(error){this.#fault(error);}}
        else if(result.state==='rejected')await this.habitat.reject(memory,`${id}:rejected`);
      }
      this.emit('change', this.getSnapshot()); return result;
    } finally { this.submitting = false; }
  }
  resolveUnknown({ submissionId, disposition }) {
    this.#assertTransitionAvailable();
    if (!['acknowledged', 'confirmed-not-sent'].includes(disposition)) throw new Error('Choose an explicit uncertain-submission resolution.');
    this.delivery.resolveUnknown(submissionId, { action: disposition === 'acknowledged' ? 'retain' : disposition, userInitiated: true });
    this.current.resolveUnknown?.(submissionId); this.emit('change', this.getSnapshot()); return true;
  }
  async resolveRequest(payload) { this.#assertTransitionAvailable();return this.current.resolveRequest?.(payload) ?? false; }
  history(payload) { return this.current.history?.(payload) ?? []; }
  getOutput(payload){if(this.backend!=='codex')throw new Error('Structured output is unavailable for this backend.');return this.current.getOutput(payload);}
  write(text) { this.#assertTransitionAvailable();if (this.backend !== 'claude') throw new Error('Terminal input is unavailable for Codex.'); return this.current.write(text); }
  resize(cols, rows) { if(!this.switching&&!this.disposing&&this.backend === 'claude') return this.current.resize(cols, rows); }
  interrupt() { this.#assertTransitionAvailable();return this.current.interrupt(); }
  updatePresentation(payload) { if(!this.switching&&!this.disposing&&this.backend === 'claude') return this.current.updatePresentation?.(payload); }
  recordAssistantMessage(...args) { if(!this.switching&&!this.disposing&&this.backend === 'claude') return this.current.recordAssistantMessage?.(...args); }
  async stop({disposition='stop'}={}) {
    this.#assertTransitionAvailable();return this.#stop({disposition});
  }
  async #stop({disposition='stop'}={}) {
    if(disposition!=='stop'&&(this.submitting||this.starting||this.current.getSnapshot().phase!=='idle'||this.delivery?.unresolved(this.getSnapshot()).length))throw new Error('Wait for an idle turn and resolve uncertain submissions before ending the day.');
    await this.watcher?.stop();await this.current.stop();
    if(this.habitatClaimed){
      try{await this.habitat.close(disposition);if(disposition!=='stop'){this.delivery?.closeGeneration(this.generation);this.generation=randomUUID();}}
      finally{await this.habitat.stop();this.habitatClaimed=false;}
    }
    this.emit('change',this.getSnapshot());
  }
  async recoverFailedStart({userInitiated=false,retainUnknown=false}={}){
    this.#assertTransitionAvailable();
    if(!userInitiated||!retainUnknown)throw new Error('Explicitly retain the uncertain launch evidence before releasing its reservation.');
    if(this.backend!=='codex'||this.current.getSnapshot().connected||this.starting||this.submitting)throw new Error('Disconnect the failed launch before recovery.');
    await this.watcher?.stop();await this.current.stop();
    const owner=await this.habitat.claim({backend:'codex',generation:this.generation});
    try{
      if(owner.conversationId)throw new Error('This launch has a bound conversation; resume it or end its day after inspection.');
      await this.habitat.close('day-end',{unresolvedDisposition:'retain-unknown'});
      this.delivery?.closeGeneration(owner.generation);this.generation=randomUUID();this.lifecycleError=null;
    }finally{await this.habitat.stop();this.habitatClaimed=false;}
    this.emit('change',this.getSnapshot());return true;
  }
  async dispose() { this.disposing=true;await this.switchSettled;for (const remove of this.listeners.splice(0)) remove();await this.#stop();await Promise.all(Object.values(this.sessions).map(session => session.stop())); }
}
