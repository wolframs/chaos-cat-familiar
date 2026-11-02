import {EventEmitter} from 'node:events';
import {CompanionWatcherInbox} from './companion-watcher-inbox.js';

// One supervised source process per bound daily owner. Reconnecting replays the
// durable source IDs; the inbox never retries an uncertain model submission.
export class CompanionWatcher extends EventEmitter {
  constructor({delivery,backend,transportFactory,setTimer=setTimeout,clearTimer=clearTimeout}={}){
    super();Object.assign(this,{delivery,backend,transportFactory,setTimer,clearTimer});
    this.work=Promise.resolve();this.state={state:'stopped',error:null,retryMs:null};this.serial=0;
  }
  getSnapshot(){return{...this.state};}
  #publish(state){this.state={...this.state,...state};this.emit('change',this.getSnapshot());}
  async start(owner){
    if(this.owner)throw new Error('Watcher already has an owner.');
    if(!owner?.conversationId||!owner?.generation||!owner.commands?.watcher)throw new Error('Watcher requires a bound daily owner.');
    this.owner=owner;this.attempts=0;this.stopped=false;await this.#connect(++this.serial);
  }
  async #connect(serial){
    if(this.stopped||serial!==this.serial)return;
    this.#publish({state:'starting',error:null,retryMs:null});
    try{
      const transport=await this.transportFactory(this.owner.commands.watcher);
      if(this.stopped||serial!==this.serial){await transport.stop();return;}
      this.transport=transport;
      const inbox=this.inbox=new CompanionWatcherInbox({delivery:this.delivery,backend:this.backend});
      // A queue/persistence fault requires an explicit retry. Process EOF alone
      // is eligible for supervised backoff; both preserve the source outbox.
      inbox.on('fault',error=>{if(/disconnected/.test(error.message))return;this.#pause(error,serial);});
      this.ended=()=>{
        if(this.stopped||serial!==this.serial)return;
        this.work=this.work.then(async()=>{
          await this.#release();
          if(this.stopped||serial!==this.serial)return;
          const retryMs=Math.min(60000,1000*2**Math.min(this.attempts++,6));
          this.#publish({state:'retrying',error:'Watcher exited; durable observations will replay.',retryMs});
          this.timer=this.setTimer(()=>{this.timer=null;return this.#connect(serial);},retryMs);
        }).catch(error=>this.#pause(error,serial));
      };
      transport.readable.once('end',this.ended);inbox.connect(transport);
      this.#publish({state:'running',error:null,retryMs:null});
    }catch(error){
      if(this.stopped||serial!==this.serial)return;
      await this.#release();
      const retryMs=Math.min(60000,1000*2**Math.min(this.attempts++,6));
      this.#publish({state:'retrying',error:String(error.message??error),retryMs});
      this.timer=this.setTimer(()=>{this.timer=null;return this.#connect(serial);},retryMs);
    }
  }
  #pause(error,serial){
    if(this.stopped||serial!==this.serial)return;
    this.stopped=true;if(this.timer)this.clearTimer(this.timer);this.timer=null;
    this.#publish({state:'paused',error:String(error.message??error),retryMs:null});
    this.emit('fault',error);
    // Never await inbox.idle from inside that inbox's own work chain.
    this.work=this.work.then(()=>this.#release()).catch(()=>{});
  }
  async #release(){
    const inbox=this.inbox,transport=this.transport;this.inbox=null;this.transport=null;
    transport?.readable.off('end',this.ended);
    if(inbox)await inbox.stop();else if(transport)await transport.stop();
  }
  async stop(){
    this.stopped=true;++this.serial;if(this.timer)this.clearTimer(this.timer);this.timer=null;
    await this.work;await this.#release();this.owner=null;
    this.#publish({state:'stopped',retryMs:null});
  }
}
