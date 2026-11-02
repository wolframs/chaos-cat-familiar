import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

/** Newline-delimited app-server RPC, correlated by request id. */
export class CodexJsonRpc extends EventEmitter {
  constructor({readable,writable,maxLineBytes=Infinity,maxPending=64,timeoutMs=30000}) {
    super();Object.assign(this,{readable,writable,maxLineBytes,maxPending,timeoutMs});
    this.closed=false;this.pending=new Map();this.nextId=1;
    this.lines=createInterface({input:readable,crlfDelay:Infinity});
    this.lines.on('line',line=>this.frame(line));
    this.lines.on('close',()=>this.close());
    this.onError=error=>this.close(error);
    this.lines.on('error',this.onError);
    readable.on('error',this.onError);writable.on('error',this.onError);
  }
  getDiagnostics(){return{pendingRequests:this.pending.size};}
  frame(line){
      if (this.closed || !line.trim()) return;
      if (Buffer.byteLength(line)>this.maxLineBytes)return this.close(new Error('Codex protocol line limit exceeded'));
      let frame;
      try { frame = JSON.parse(line); } catch { return this.close(new Error('Malformed Codex JSONL frame')); }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return this.close(new Error('Invalid Codex RPC frame'));
      if (typeof frame.method === 'string') this.emit(Object.hasOwn(frame,'id') ? 'request' : 'notification', frame);
      else if (Object.hasOwn(frame,'id')) {
        const request = this.pending.get(frame.id); if (!request) return;
        this.pending.delete(frame.id); clearTimeout(request.timer);
        if (frame.error) { const error = new Error(frame.error.message || 'Codex rejected request'); error.code = frame.error.code; error.authoritative = true; request.reject(error); }
        else if (Object.hasOwn(frame,'result')) request.resolve(frame.result);
        else { const error = new Error('Invalid Codex response'); error.transmitted = request.transmitted; request.reject(error); }
      }
  }
  request(method, params, {withMetadata=false}={}) {
    if (this.closed) return Promise.reject(new Error('Codex connection is closed'));
    if (this.pending.size >= this.maxPending) return Promise.reject(new Error('Codex outstanding request limit exceeded'));
    const id = this.nextId++;
    const frame = {id,method,params};
    if (Buffer.byteLength(JSON.stringify(frame)) > this.maxLineBytes) { const error = new Error('Codex outgoing input limit exceeded'); error.transmitted = false; return Promise.reject(error); }
    return new Promise((resolve,reject) => {
      const entry = {resolve:value=>resolve(withMetadata?{result:value,requestId:id}:value),reject,transmitted:false};
      entry.timer = setTimeout(() => { this.pending.delete(id); const error = new Error('Codex request timed out'); error.transmitted = entry.transmitted; reject(error); }, this.timeoutMs);
      this.pending.set(id,entry);
      try { entry.transmitted = true; this.write(frame); }
      catch (error) { this.pending.delete(id); clearTimeout(entry.timer); if(error.transmitted!==false)error.transmitted = true; reject(error); }
    });
  }
  write(frame) {
    if (this.closed) throw new Error('Codex connection is closed');
    const data=JSON.stringify(frame)+'\n';
    if(Buffer.byteLength(data)-1>this.maxLineBytes){const error=new Error('Codex outgoing work limit exceeded');error.transmitted=false;throw error;}
    this.writable.write(data);
  }
  notify(method,params) { this.write({method,params}); }
  respond(id,result) { this.write({id,result}); }
  close(reason = new Error('Codex connection closed')) {
    if (this.closed) return; this.closed = true;
    this.lines.close();this.readable.off('error',this.onError);this.writable.off('error',this.onError);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); const error = new Error(reason.message); error.transmitted = entry.transmitted; entry.reject(error); }
    this.pending.clear();
    this.emit('disconnect', reason);
  }
}
