import { EventEmitter } from 'node:events';
import { CodexJsonRpc } from './codex-json-rpc.js';
import { isDeepStrictEqual } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';

const MAX_ITEMS = 500;
const PREVIEW_BYTES = 64 * 1024;
function preview(value,maxBytes=PREVIEW_BYTES) {
  const text=String(value??'');
  if(Buffer.byteLength(text,'utf8')<=maxBytes)return{text,outputLimited:false};
  const bytes=Buffer.from(text.slice(0,maxBytes),'utf8');
  return{text:new StringDecoder('utf8').write(bytes.subarray(0,maxBytes)),outputLimited:true};
}
const COMMAND_APPROVAL = 'item/commandExecution/requestApproval';
const FILE_APPROVAL = 'item/fileChange/requestApproval';
const PERMISSIONS = 'item/permissions/requestApproval';
const QUESTIONS = 'item/tool/requestUserInput';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function historyItem({item,turnId,startedAtMs}) {
  const raw = item.text ?? item.aggregatedOutput ?? item.command ?? (item.changes ? JSON.stringify(item.changes,null,2) : item.content ? item.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : item.type);
  return {id:item.id,role:item.type === 'agentMessage' ? 'assistant' : item.type === 'userMessage' ? 'user' : 'tool',...preview(raw),type:item.type,status:item.status,turnId,timestamp:Number.isFinite(startedAtMs) ? new Date(startedAtMs).toISOString() : null};
}
function subset(granted,requested) {
  if (Array.isArray(granted)) return Array.isArray(requested) && granted.every(value => requested.some(entry => isDeepStrictEqual(value,entry)));
  if (plain(granted)) return plain(requested) && Object.entries(granted).every(([key,value]) => Object.hasOwn(requested,key) && subset(value,requested[key]));
  return isDeepStrictEqual(granted,requested);
}
export function validateCodexResponse(request,response) {
  if (!plain(response)) return false;
  if ([COMMAND_APPROVAL,FILE_APPROVAL].includes(request.method)) return Object.keys(response).length === 1 && ['accept','decline','cancel'].includes(response.decision);
  if (request.method === PERMISSIONS) return Object.keys(response).every(key => ['permissions','scope','strictAutoReview'].includes(key))
    && plain(response.permissions) && (response.scope === undefined || response.scope === 'turn')
    && (response.strictAutoReview === undefined || response.strictAutoReview === true)
    && subset(response.permissions,request.params.permissions ?? {});
  if (request.method === QUESTIONS) {
    if (Object.keys(response).length !== 1 || !plain(response.answers)) return false;
    const questions = request.params.questions ?? [];
    if (questions.length !== Object.keys(response.answers).length) return false;
    return questions.every(question => {
      const value = response.answers[question.id];
      return plain(value) && Object.keys(value).length === 1 && Array.isArray(value.answers) && value.answers.length === 1
        && typeof value.answers[0] === 'string' && value.answers[0].length <= 4096
        && (!question.options?.length || question.isOther || question.options.some(option => option.label === value.answers[0]));
    });
  }
  return false;
}
/** Hosted Codex adapter. The caller owns submissions and the private child process. */
export class CodexCompanionSession extends EventEmitter {
  constructor({transportFactory,now = () => new Date(),rpcOptions = {}} = {}) {
    super(); Object.assign(this,{transportFactory,now,rpcOptions});
    this.epoch = 0; this.rpc = null; this.transport = null; this.unknown = null;
    this.compactions=new Set();
    this.toolSummaries=new Map();this.historyOutputs=new Map();this.outputRevision=0;
    this.state = {backend:'codex',connected:false,phase:'offline',connectionEpoch:0,conversationId:null,sessionRootId:null,messages:[],pendingRequests:[],submission:null,error:null,activeTurnId:null};
  }
  presentationItem(item){
    if(item.role!=='tool')return{...item};
    let summary=this.toolSummaries.get(item.id);
    if(!summary||summary.revision!==item.outputRevision){summary={text:preview(item.text,512).text,revision:item.outputRevision};this.toolSummaries.set(item.id,summary);}
    return{...item,text:summary.text,outputPreviewAvailable:true};
  }
  getSnapshot() { return structuredClone({...this.state,messages:this.state.messages.map(item=>this.presentationItem(item))}); }
  getOutput({itemId}={}){
    const live=this.state.messages.find(value=>value.id===itemId&&value.role==='tool');const historical=this.historyOutputs.get(itemId);
    const item=historical&&(!live||historical.outputRevision>live.outputRevision)?historical:live;
    if(!item)throw new Error('This tool output is no longer retained; load its authoritative history page before expanding it.');
    return{itemId:item.id,text:item.text,revision:item.outputRevision,outputLimited:item.outputLimited===true};
  }
  getDiagnostics(){return{retainedItems:this.state.messages.length,retainedToolBytes:this.state.messages.reduce((sum,item)=>sum+(item.role==='tool'?Buffer.byteLength(item.text):0),0),historicalOutputs:this.historyOutputs.size,historicalToolBytes:[...this.historyOutputs.values()].reduce((sum,item)=>sum+Buffer.byteLength(item.text),0),presentationToolBytes:[...this.toolSummaries.values()].reduce((sum,item)=>sum+Buffer.byteLength(item.text),0),parser:this.rpc?.getDiagnostics()??null};}
  publish() { this.emit('change',this.getSnapshot()); }
  schedulePublish() { if (!this.publication) this.publication = setTimeout(() => { this.publication = null; this.publish(); },34); }
  start(options={}) {
    if(this.stopping)return Promise.reject(new Error('Codex is stopping'));
    if(this.starting)return Promise.reject(new Error('Codex is already starting'));
    this.startOperation=this.startSession(options);return this.startOperation;
  }
  async startSession({userInitiated,cwd,conversationId,model,developerInstructions,memoryContext} = {}) {
    if (!userInitiated) throw new Error('Codex requires an explicit user start');
    if (this.state.connected) return this.getSnapshot();
    if (this.starting) throw new Error('Codex is already starting');
    if (!this.transportFactory) throw new Error('Codex process transport is unavailable');
    this.starting = true;
    this.state.error = null;this.state.errorInfo=null;this.state.memoryAck=null; this.state.phase = 'connecting'; this.state.connectionEpoch = ++this.epoch; this.publish();
    const epoch = this.epoch;
    this.connectionToken=randomUUID();
    try {
      this.rpc?.close(); if (this.transport) await this.transport.stop?.(); this.rpc = null; this.transport = null;
      if (epoch !== this.epoch) throw new Error('Codex start cancelled');
      this.transport = await this.transportFactory({userInitiated,cwd,model,connectionEpoch:epoch});
      if (epoch !== this.epoch) { await this.transport?.stop?.(); throw new Error('Codex start cancelled'); }
      this.rpc = new CodexJsonRpc({...this.transport,...this.rpcOptions});
      this.rpc.on('notification', frame => { if (epoch === this.epoch) this.notification(frame); });
      this.rpc.on('request', frame => { if (epoch === this.epoch) this.request(frame); });
      this.rpc.on('disconnect', error => {
        if (epoch !== this.epoch) return;
        this.state.connected = false; this.state.phase = 'offline'; this.state.pendingRequests = [];
        this.state.error = error.message;this.state.errorInfo={code:'disconnected',reason:error.message,actions:['start','open-settings']}; this.publish();
        // Losing the protocol must also stop the private process and its tools.
        this.transport?.stop?.().catch(stopError=>{this.state.error=stopError.message;this.publish();});
      });
      await this.rpc.request('initialize',{clientInfo:{name:'chaos-cat-familiar',version:'0.1.0'},capabilities:{experimentalApi:true}});
      if (epoch !== this.epoch) throw new Error('Codex start cancelled');
      this.rpc.notify('initialized',{});
      const {result,requestId} = await this.rpc.request(conversationId ? 'thread/resume' : 'thread/start',{
        ...(conversationId ? {threadId:conversationId} : {}),...(cwd ? {cwd} : {}),...(model ? {model} : {}),
        ...(typeof developerInstructions==='string'?{developerInstructions}:{}),
        approvalPolicy:'on-request',approvalsReviewer:'user'
      },{withMetadata:true});
      if (epoch !== this.epoch) throw new Error('Codex start cancelled');
      if (typeof result?.thread?.id !== 'string') throw new Error('Codex did not identify the conversation');
      if (this.state.conversationId !== result.thread.id) { this.state.messages = []; this.state.pendingRequests = []; this.state.historyCursor = null; this.state.usage = null; this.state.submission = null; this.state.lastTurn = null;this.compactions.clear();this.toolSummaries.clear();this.historyOutputs.clear(); }
      this.state.conversationId = result.thread.id; this.state.sessionRootId = result.thread.sessionId ?? null;
      this.state.appliedContext={developerInstructionsApplied:typeof developerInstructions==='string',threadId:result.thread.id,acceptanceId:`${this.connectionToken}:${requestId}`};
      const memoryRevision=memoryContext?.revision??memoryContext?.contextId;
      if(typeof developerInstructions==='string'&&typeof memoryRevision==='string'){
        this.state.memoryAck={revision:memoryRevision,threadId:result.thread.id,acceptanceId:this.state.appliedContext.acceptanceId,boundary:'thread-accepted'};
        this.state.memoryRefreshNeeded=false;
      }
      this.state.connected = true; this.state.phase = 'idle'; this.state.activeTurnId = null;
      if (conversationId) {
        const page = await this.history({}); this.state.messages = page.items.map(item=>this.historyOutputs.get(item.id)??item); this.state.historyCursor = page.nextCursor;
        if (epoch !== this.epoch) throw new Error('Codex start cancelled');
        for (const turn of (result.thread.turns ?? []).slice(-100)) this.recordTurnOutcome(turn,true);
      }
      const activeTurn = result.thread.turns?.findLast(turn => turn.status === 'inProgress');
      if (activeTurn || result.thread.status?.type === 'active') { this.state.phase = 'working'; this.state.activeTurnId = activeTurn?.id ?? this.state.activeTurnId; }
      if (result.thread.status?.type === 'systemError') { this.state.phase = 'attention'; this.state.error = 'The Codex conversation has a backend error'; }
      this.publish();
      return this.getSnapshot();
    } catch (error) {
      // The transport supplies sanitized stderr. Capture before stop clears its
      // ring, and keep this private evidence on the error rather than UI state.
      try {
        const diagnostics=this.transport?.getDiagnostics?.();
        if(diagnostics){const bounded=preview(typeof diagnostics.stderr==='string'?diagnostics.stderr:'',16*1024);
          error.launchDiagnostics={stderr:bounded.text,stderrLimited:diagnostics.stderrLimited===true||bounded.outputLimited,closed:diagnostics.closed===true};}
      } catch { /* Diagnostic collection must preserve the original failure. */ }
      this.state.connected = false; this.state.phase = 'offline'; this.rpc?.close();await this.transport?.stop?.();this.state.error=error.message;this.state.errorInfo={code:error.code??'initialization-failed',reason:error.message,actions:error.actions??['start','open-settings']}; this.publish(); throw error;
    }
    finally { this.starting = false; }
  }
  async submit({id,text = '',attachments = [],draftRevision,memory} = {}) {
    const reject = reason => ({id,state:'rejected',reason,draftRevision});
    if (!id || typeof text !== 'string') return reject('A submission ID and text are required');
    if (this.unknown) return reject('A previous message may have been sent; resolve it before sending again');
    if (!this.state.connected || this.state.phase !== 'idle') return reject('Wait for the current turn to finish before sending');
    if (!text.trim() && !attachments.length) return reject('The message is empty');
    if (attachments.some(image => typeof image.path !== 'string')) return reject('An attachment is not ready');
    this.state.phase = 'working'; this.state.submission = {id,state:'pending',draftRevision}; this.publish();
    let result;
    try {
      const input = [...(typeof memory?.text==='string'?[{type:'text',text:memory.text,text_elements:[]}]:[]),...(text.trim() ? [{type:'text',text,text_elements:[]}] : []),...attachments.map(image => ({type:'localImage',path:image.path}))];
      const {result:accepted,requestId}= await this.rpc.request('turn/start',{threadId:this.state.conversationId,input},{withMetadata:true});
      if (typeof accepted?.turn?.id !== 'string') { const error = new Error('Codex acceptance did not identify a turn'); error.transmitted = true; throw error; }
      this.upsert({id:`submission:${id}`,role:'user',text,timestamp:this.now().toISOString(),turnId:accepted.turn.id});
      const terminal = ['completed','failed','interrupted'].includes(accepted.turn.status);
      if (terminal) this.recordTurnOutcome(accepted.turn);
      const alreadyCompleted = this.state.lastTurn?.id === accepted.turn.id;
      this.state.activeTurnId = terminal || alreadyCompleted ? null : accepted.turn.id;
      if (terminal || alreadyCompleted) this.state.phase = 'idle';
      result = {id,state:'accepted',turnId:accepted.turn.id,draftRevision};
      if(typeof memory?.text==='string'&&memory.revision){
        this.state.memoryAck={revision:memory.revision,threadId:this.state.conversationId,turnId:accepted.turn.id,acceptanceId:`${this.connectionToken}:${requestId}`,boundary:'turn-accepted'};
        this.state.memoryRefreshNeeded=false;result.memoryAck={...this.state.memoryAck};
      }
    } catch (error) {
      const state = error.authoritative || !error.transmitted ? 'rejected' : 'outcomeUnknown';
      result = {id,state,reason:error.message,draftRevision};
      if (state === 'outcomeUnknown') this.unknown = id;
      this.state.phase = this.state.connected ? 'idle' : 'offline';
    }
    this.state.submission = result; this.publish(); return result;
  }
  resolveUnknown(id) { if (id !== this.unknown) return false; this.unknown = null; this.state.submission = null; this.publish(); return true; }
  setUnresolvedSubmissions(records) {
    const unknown = records.find(record => record.backend === 'codex' && record.state === 'outcomeUnknown' && (!this.state.conversationId || record.conversationId === this.state.conversationId));
    this.unknown = unknown?.id ?? null;
    if (unknown) this.state.submission = {id:unknown.id,state:'outcomeUnknown',draftRevision:unknown.draftRevision};
    this.publish();
  }
  upsert(item) {
    const index = this.state.messages.findIndex(entry => entry.id === item.id);
    const previous=index<0?null:this.state.messages[index];
    const value = {...(previous??{}),...item};
    if (typeof value.text === 'string') { const bounded=preview(value.text);value.text=bounded.text;value.outputLimited=value.outputLimited===true||bounded.outputLimited; }
    if(value.role==='tool')value.outputRevision=previous&&previous.text===value.text&&previous.status===value.status&&previous.outputLimited===value.outputLimited?previous.outputRevision:++this.outputRevision;
    if (index < 0) this.state.messages.push(value); else this.state.messages[index] = value;
    if (this.state.messages.length > MAX_ITEMS)for(const removed of this.state.messages.splice(0,this.state.messages.length-MAX_ITEMS))this.toolSummaries.delete(removed.id);
  }
  recordTurnOutcome(turn, historical = false) {
    if (typeof turn?.id !== 'string' || !['completed','failed','interrupted'].includes(turn.status)) return;
    const message = typeof turn.error?.message === 'string' ? preview(turn.error.message).text : null;
    const additionalDetails = typeof turn.error?.additionalDetails === 'string' ? preview(turn.error.additionalDetails).text : null;
    this.state.lastTurn = {id:turn.id,status:turn.status,error:message ? {message,additionalDetails} : null};
    const text = `Turn ${turn.status}${message ? `: ${message}` : '.'}${additionalDetails ? `\n${additionalDetails}` : ''}`;
    const completionDate = Number.isFinite(turn.completedAt) ? new Date(turn.completedAt*1000) : null;
    const completedAt = completionDate && Number.isFinite(completionDate.getTime()) ? completionDate.toISOString() : historical ? null : this.now().toISOString();
    this.upsert({id:`turn-status:${turn.id}`,role:'system',type:'status',status:turn.status,turnId:turn.id,text,timestamp:completedAt});
  }
  notification({method,params = {}}) {
    if (params.threadId && params.threadId !== this.state.conversationId) return;
    if (method === 'turn/started') { this.state.activeTurnId = params.turn?.id ?? null; this.state.phase = 'working'; }
    else if (method === 'turn/completed') {
      if (this.state.activeTurnId && params.turn?.id && params.turn.id !== this.state.activeTurnId) return;
      this.recordTurnOutcome(params.turn);
      this.state.activeTurnId = null; this.state.phase = 'idle'; this.state.pendingRequests = [];
    }
    else if (method === 'item/started' || method === 'item/completed') {
      const item = params.item; if (!item?.id) return;
      const text = item.text ?? item.aggregatedOutput ?? item.command ?? (item.changes ? JSON.stringify(item.changes,null,2) : item.type);
      this.upsert({id:item.id,role:item.type === 'agentMessage' ? 'assistant' : item.type === 'userMessage' ? 'user' : 'tool',text:String(text ?? ''),type:item.type,status:item.status,turnId:params.turnId,timestamp:this.now().toISOString()});
      if(method==='item/completed'&&item.type==='contextCompaction'&&!this.compactions.has(item.id)){
        this.compactions.add(item.id);if(this.compactions.size>64)this.compactions.delete(this.compactions.values().next().value);
        this.state.memoryRefreshNeeded=true;this.emit('memoryNeeded',{reason:'compaction',backend:'codex',conversationId:this.state.conversationId,turnId:params.turnId,itemId:item.id});
      }
    } else if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta') {
      const item = this.state.messages.find(entry => entry.id === params.itemId);
      this.upsert({id:params.itemId,role:method.includes('agentMessage') ? 'assistant' : 'tool',text:(item?.text ?? '') + String(params.delta ?? ''),turnId:params.turnId});
    } else if (method === 'serverRequest/resolved') this.state.pendingRequests = this.state.pendingRequests.filter(request => request.requestId !== params.requestId);
    else if (method === 'error') this.state.error = params.error?.message ?? params.message ?? 'Codex error';
    else if (method === 'thread/tokenUsage/updated') this.state.usage = {tokens:structuredClone(params.tokenUsage),cost:null};
    else if (method === 'thread/status/changed') {
      if (params.status?.type === 'active') this.state.phase = this.state.pendingRequests.length ? 'attention' : 'working';
      else if (params.status?.type === 'idle') this.state.phase = this.state.pendingRequests.length ? 'attention' : 'idle';
      else if (params.status?.type === 'systemError') { this.state.phase = 'attention'; this.state.error = 'The Codex conversation has a backend error'; }
    }
    else return;
    this.schedulePublish();
  }
  request({id,method,params = {}}) {
    const key = JSON.stringify(['codex',this.epoch,id]);
    if (this.state.pendingRequests.some(request => request.key === key)) return;
    if (this.state.pendingRequests.length >= 64) { this.state.error = 'Codex pending request limit exceeded'; this.publish(); return; }
    const oversized = Buffer.byteLength(JSON.stringify(params)) > 65536;
    const fileDetails = this.state.messages.find(item => item.id === params.itemId && item.type === 'fileChange');
    const supported = !oversized && (!params.turnId || params.turnId === this.state.activeTurnId)
      && [COMMAND_APPROVAL,FILE_APPROVAL,PERMISSIONS,QUESTIONS].includes(method) && !(method === FILE_APPROVAL && (params.grantRoot || !fileDetails || fileDetails.outputLimited));
    if (oversized) params = {threadId:params.threadId,turnId:params.turnId,itemId:params.itemId,reason:'Request detail limit exceeded; interrupt or stop to recover without granting.'};
    this.state.pendingRequests.push({key,requestId:id,backend:'codex',connectionEpoch:this.epoch,conversationId:params.threadId ?? this.state.conversationId,turnId:params.turnId,itemId:params.itemId,method,params,...(method===FILE_APPROVAL&&fileDetails?{detailsText:fileDetails.text}:{}),supported,decisions:[COMMAND_APPROVAL,FILE_APPROVAL].includes(method) && supported ? ['accept','decline','cancel'] : []});
    this.state.phase = 'attention'; this.schedulePublish();
  }
  async resolveRequest({key,response}) {
    const request = this.state.pendingRequests.find(value => value.key === key);
    if (!request || !request.supported || request.connectionEpoch !== this.epoch || !this.state.connected || request.conversationId !== this.state.conversationId) return false;
    if (request.turnId && request.turnId !== this.state.activeTurnId) return false;
    if (!validateCodexResponse(request,response)) return false;
    this.rpc.respond(request.requestId,response);
    this.state.pendingRequests = this.state.pendingRequests.filter(value => value.key !== key); this.state.phase = this.state.pendingRequests.length ? 'attention' : 'working'; this.publish(); return true;
  }
  async interrupt() {
    if (!this.state.connected || !this.state.activeTurnId) return false;
    await this.rpc.request('turn/interrupt',{threadId:this.state.conversationId,turnId:this.state.activeTurnId}); return true;
  }
  async history({cursor,limit = 100} = {}) {
    if (!this.state.connected || !this.rpc) throw new Error('Codex history is unavailable while disconnected');
    const page = await this.rpc.request('thread/items/list',{threadId:this.state.conversationId,...(cursor ? {cursor} : {}),limit:Math.max(1,Math.min(100,Number.isSafeInteger(limit) ? limit : 100)),sortDirection:'desc'});
    if (!Array.isArray(page?.data)) throw new Error('Codex returned an invalid history page');
    if (page.data.length > 100 || page.data.some(entry => typeof entry?.item?.id !== 'string')) throw new Error('Codex history page exceeds its contract');
    for(const id of this.historyOutputs.keys())if(!this.state.messages.some(item=>item.id===id))this.toolSummaries.delete(id);
    this.historyOutputs.clear();
    const items=page.data.map(historyItem).reverse();
    for(const item of items)if(item.role==='tool'){item.outputRevision=++this.outputRevision;this.historyOutputs.set(item.id,item);}
    if(!cursor)this.state.historyCursor=typeof page.nextCursor === 'string' ? page.nextCursor : null;
    return {items:items.map(item=>this.presentationItem(item)),nextCursor:typeof page.nextCursor === 'string' ? page.nextCursor : null};
  }
  stop() {
    if(this.stopping)return this.stopping;
    this.stopping=this.stopSession().finally(()=>{this.stopping=null;});return this.stopping;
  }
  async stopSession() {
    ++this.epoch;clearTimeout(this.publication);this.publication=null;this.rpc?.close();
    // A child may still be spawning. Its start path sees the changed epoch and
    // stops that late child before shutdown can report the backend stopped.
    await this.startOperation?.catch(()=>{});
    await this.transport?.stop?.();this.rpc=null;this.transport=null;
    this.state.connected=false;this.state.phase='offline';this.state.pendingRequests=[];this.publish();
  }
}
