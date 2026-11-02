import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {CompanionWatcher} from '../services/companion-watcher.js';

test('watcher owns one transport, restarts with backoff and cancels retries on stop',async()=>{
  const backend=new EventEmitter();backend.getSnapshot=()=>({backend:'codex',connected:true,phase:'working',conversationId:'t',generation:'g'});
  const timers=[];let starts=0,stops=0;
  const factory=async()=>{starts++;return{readable:new PassThrough(),writable:new PassThrough(),stop:async()=>{stops++;}};};
  const watcher=new CompanionWatcher({delivery:{},backend,transportFactory:factory,setTimer:fn=>{timers.push(fn);return fn;},clearTimer:fn=>{const index=timers.indexOf(fn);if(index>=0)timers.splice(index,1);}});
  watcher.on('fault',()=>{});
  const owner={generation:'g',conversationId:'t',commands:{watcher:{executable:'C:/python.exe',args:['synthetic.py']}}};
  await watcher.start(owner);assert.equal(starts,1);assert.equal(watcher.getSnapshot().state,'running');
  watcher.transport.readable.end();await new Promise(setImmediate);await watcher.work;assert.equal(stops,1);assert.equal(timers.length,1);
  await timers.shift()();assert.equal(starts,2);await watcher.stop();assert.equal(stops,2);assert.equal(timers.length,0);
});
