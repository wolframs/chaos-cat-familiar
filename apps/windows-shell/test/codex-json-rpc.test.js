import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { CodexJsonRpc } from '../services/codex-json-rpc.js';

test('correlates split JSONL and rejects only matched server errors', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const rpc = new CodexJsonRpc({ readable: input, writable: output });
  const frames = []; output.on('data', chunk => frames.push(JSON.parse(String(chunk))));
  const first = rpc.request('one', {}); const second = rpc.request('two', {});
  input.write(JSON.stringify({id: frames[1].id, error: {message:'denied'}}) + '\n');
  await assert.rejects(second, /denied/);
  const reply = JSON.stringify({id:frames[0].id,result:{ok:true}}) + '\n';
  input.write(reply.slice(0, 8)); input.write(reply.slice(8));
  assert.deepEqual(await first, {ok:true}); rpc.close();
});

test('bounded malformed input faults and disconnect rejects pending requests', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const rpc = new CodexJsonRpc({readable:input,writable:output,maxLineBytes:32});
  const pending = rpc.request('test', {});
  input.write('x'.repeat(33)+'\n');
  await assert.rejects(pending, /limit/); assert.equal(rpc.closed, true);
});

test('disconnect after write has unknown transmission outcome and old replies cannot settle new requests', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const rpc = new CodexJsonRpc({readable:input,writable:output});
  const pending = rpc.request('turn/start', {}); rpc.close();
  await assert.rejects(pending, error => error.transmitted === true);
});
test('oversized outgoing input rejects before transmission rather than truncating model input', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const rpc = new CodexJsonRpc({readable:input,writable:output,maxLineBytes:128});
  let writes = 0; output.on('data',() => writes++);
  await assert.rejects(rpc.request('turn/start',{text:'x'.repeat(200)}),error => error.transmitted === false && /limit/.test(error.message));
  assert.equal(writes,0); rpc.close();
});

test('readline preserves split UTF-8 and processes every notification in a burst', () => {
  const input=new PassThrough(),output=new PassThrough();
  const rpc=new CodexJsonRpc({readable:input,writable:output});
  const seen=[];rpc.on('notification',frame=>seen.push(frame.params.text));
  const bytes=Buffer.from(JSON.stringify({method:'fixture',params:{text:'cat 😸'}})+'\n');
  for(const byte of bytes)input.write(Buffer.from([byte]));
  input.write(Array.from({length:100},(_,index)=>JSON.stringify({method:'fixture',params:{text:String(index)}})+'\n').join(''));
  assert.equal(seen[0],'cat 😸');assert.equal(seen.length,101);rpc.close();
});

test('malformed JSON closes the connection and rejects pending work',async()=>{
  const input=new PassThrough(),output=new PassThrough();
  const rpc=new CodexJsonRpc({readable:input,writable:output});
  const pending=rpc.request('fixture',{});input.write('{broken}\n');
  await assert.rejects(pending,/Malformed/);assert.equal(rpc.closed,true);
});

test('input stream errors reject pending requests without an uncaught readline error',async()=>{
  const input=new PassThrough(),output=new PassThrough();
  const rpc=new CodexJsonRpc({readable:input,writable:output});
  const pending=rpc.request('fixture',{});input.emit('error',new Error('fixture input failure'));
  await assert.rejects(pending,/fixture input failure/);assert.equal(rpc.closed,true);
});
