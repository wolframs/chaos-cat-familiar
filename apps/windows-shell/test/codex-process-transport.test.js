import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline';
import {createStdioTransport,createCodexProcessTransport} from '../services/codex-process-transport.js';

test('real hidden Node transport preserves duplex UTF-8 and stops its Windows child tree', {skip:process.platform!=='win32',timeout:20000},async t=>{
  const fixture="const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});child.once('spawn',()=>process.stdout.write(JSON.stringify({pid:child.pid,text:'Dúplex 🐈',env:process.env.CCF_TRANSPORT_FIXTURE})+'\\n'));process.stdin.on('data',chunk=>process.stdout.write(chunk));setInterval(()=>{},1000);";
  const transport=await createStdioTransport({executable:process.execPath,args:['-e',fixture],env:{...process.env,CCF_TRANSPORT_FIXTURE:'inherited'}});
  t.after(()=>transport.stop());
  const lines=createInterface({input:transport.readable}),iterator=lines[Symbol.asyncIterator]();
  const first=JSON.parse((await iterator.next()).value);
  assert.equal(first.text,'Dúplex 🐈');assert.equal(first.env,'inherited');
  transport.writable.write('echo café 🐈\n');assert.equal((await iterator.next()).value,'echo café 🐈');
  await transport.stop();await transport.closed;lines.close();
  assert.throws(()=>process.kill(first.pid,0),/ESRCH|no such process/i);
});

function fakeChild({fail=false}={}) {
  const child=new EventEmitter();Object.assign(child,{pid:54321,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
  child.kill=()=>child.emit('close',null,'SIGTERM');
  const calls=[];
  const spawnProcess=(...args)=>{calls.push(args);queueMicrotask(()=>child.emit(fail?'error':'spawn',...(fail?[new Error('fixture spawn failure')]:[])));return child;};
  return{child,calls,spawnProcess};
}

test('Codex starts a private hidden app-server with the normal environment and no configuration overrides',async()=>{
  const f=fakeChild();
  const transport=await createCodexProcessTransport({userInitiated:true,executable:'codex.exe',cwd:'C:/habitat',spawnProcess:f.spawnProcess,platform:'linux'});
  assert.deepEqual(f.calls[0],['codex.exe',['app-server','--listen','stdio://'],{cwd:'C:/habitat',env:process.env,windowsHide:true,stdio:['pipe','pipe','pipe']}]);
  assert.equal(transport.readable,f.child.stdout);assert.equal(transport.writable,f.child.stdin);
  await transport.stop();await transport.closed;
});

test('Codex cannot start without an explicit user action',()=>{
  assert.throws(()=>createCodexProcessTransport({spawnProcess(){throw new Error('must not spawn');}}),/explicit user start/);
});

test('explicit Windows stop kills the owned process tree once using a hidden taskkill',async()=>{
  const f=fakeChild(),kills=[];
  const transport=await createStdioTransport({executable:'fixture.exe',spawnProcess:f.spawnProcess,platform:'win32',execFileProcess:(...args)=>{
    kills.push(args.slice(0,3));f.child.emit('close',1,null);args[3](null);
  }});
  await Promise.all([transport.stop(),transport.stop()]);
  assert.deepEqual(kills,[['taskkill.exe',['/PID','54321','/T','/F'],{windowsHide:true,timeout:10000}]]);
  assert.deepEqual(await transport.closed,{code:1,signal:null});
});

test('spawn errors reach the caller without starting any helper process',async()=>{
  const f=fakeChild({fail:true});
  await assert.rejects(createStdioTransport({executable:'missing.exe',spawnProcess:f.spawnProcess}),/fixture spawn failure/);
  assert.equal(f.calls.length,1);
});

test('an error after spawn does not falsely mark a live child exited or skip tree cleanup',async()=>{
  const f=fakeChild();let killed=false;
  const transport=await createStdioTransport({executable:'fixture.exe',spawnProcess:f.spawnProcess,platform:'win32',execFileProcess:(_exe,_args,_options,callback)=>{
    killed=true;f.child.emit('close',1,null);callback(null);
  }});
  f.child.emit('error',new Error('fixture runtime error'));
  assert.equal(transport.getDiagnostics().closed,false);
  await transport.stop();assert.equal(killed,true);
});

test('diagnostics redact inherited secrets without removing them from the child environment',async()=>{
  const f=fakeChild(),env={HOME:'normal-home',OPENAI_API_KEY:'synthetic-secret-key'};
  const transport=await createStdioTransport({executable:'fixture.exe',env,spawnProcess:f.spawnProcess,platform:'linux'});
  assert.equal(f.calls[0][2].env,env);f.child.stderr.write('failed synthetic-secret-key Bearer private-value');
  assert.equal(transport.getDiagnostics().stderr,'failed [redacted] [redacted]');
  await transport.stop();
});
