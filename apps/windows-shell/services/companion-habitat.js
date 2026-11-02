import {EventEmitter} from 'node:events';

// Private parent-owned stdio only. This service starts no children itself:
// the production factory supplies the ordinary child-process transport.
export class CompanionHabitat extends EventEmitter {
  constructor({transportFactory,timeoutMs=15000,maxLineBytes=256*1024}={}) {
    super();Object.assign(this,{transportFactory,timeoutMs,maxLineBytes});
    this.pending=new Map();this.sequence=0;this.buffer=Buffer.alloc(0);this.transport=null;
  }
  async claim(params) {
    if(this.transport||this.starting)throw new Error('Habitat is already connected or starting.');
    this.starting=true;
    try {
      this.transport=await this.transportFactory();
      this.onData=chunk=>this.#data(chunk);
      this.onEnd=()=>this.#failed(new Error('Habitat disconnected; daily ownership must be recovered before restart.'));
      this.onError=error=>this.#failed(error);
      this.transport.readable.on('data',this.onData);this.transport.readable.on('end',this.onEnd);
      this.transport.readable.on('error',this.onError);this.transport.writable.on('error',this.onError);
      this.reservation=await this.request('claim',params);return this.reservation;
    }catch(error){await this.stop();throw error;}finally{this.starting=false;}
  }
  #failed(error){
    this.failed=error;
    for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(error);}
    this.pending.clear();this.buffer=Buffer.alloc(0);this.emit('fault',error);
  }
  #data(chunk){
    try {
      this.buffer=Buffer.concat([this.buffer,Buffer.from(chunk)]);
      if(this.buffer.length>this.maxLineBytes*2)throw new Error('Habitat response byte limit exceeded.');
      let end;
      while((end=this.buffer.indexOf(10))>=0){
        if(end>this.maxLineBytes)throw new Error('Habitat response line limit exceeded.');
        const line=this.buffer.subarray(0,end).toString('utf8');this.buffer=this.buffer.subarray(end+1);
        if(!line.trim())continue;
        const frame=JSON.parse(line),entry=this.pending.get(frame.id);
        if(frame.schemaVersion!==1)throw new Error('Unsupported habitat bridge schema.');
        if(!entry)continue;
        this.pending.delete(frame.id);clearTimeout(entry.timer);
        if(frame.ok===true)entry.resolve(frame.result);
        else entry.reject(new Error(typeof frame.error==='string'?frame.error:frame.error?.message??'Habitat request rejected.'));
      }
      if(this.buffer.length>this.maxLineBytes)throw new Error('Habitat response line limit exceeded.');
    }catch(error){this.#failed(error);this.transport?.readable.pause();}
  }
  request(method,params={}){
    if(!this.transport||this.failed)return Promise.reject(this.failed??new Error('Habitat is not connected; start explicitly.'));
    if(this.pending.size>=8)return Promise.reject(new Error('Habitat request limit exceeded.'));
    const id=++this.sequence,line=JSON.stringify({schemaVersion:1,id,method,params})+'\n';
    if(Buffer.byteLength(line)>65536)return Promise.reject(new Error('Habitat request exceeds64KiB.'));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Habitat ${method} timed out; no automatic retry.`));},this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try{this.transport.writable.write(line);}catch(error){this.pending.delete(id);clearTimeout(timer);reject(error);}
    });
  }
  bind(identity){return this.request('bind',identity);}
  prepare(boundary){return this.request('prepare',{boundary});}
  acknowledge(context,evidence){
    if(!context?.contextId||evidence?.revision!==context.contextId||!evidence.acceptanceId)return Promise.reject(new Error('Memory acceptance must match its prepared context.'));
    return this.request('acknowledge',{contextId:context.contextId,...evidence,conversationId:evidence.threadId});
  }
  reject(context,rejectionId){return this.request('reject',{contextId:context.contextId,rejectionId});}
  close(disposition,extra={}){return this.request('close',{...extra,disposition,backendStopped:true,watcherStopped:true});}
  async stop(){
    const transport=this.transport;if(!transport)return;
    this.transport=null;
    transport.readable.off('data',this.onData);transport.readable.off('end',this.onEnd);transport.readable.off('error',this.onError);transport.writable.off('error',this.onError);
    for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(new Error('Habitat stopped.'));}this.pending.clear();
    this.buffer=Buffer.alloc(0);await transport.stop();this.failed=null;this.reservation=null;
  }
}
