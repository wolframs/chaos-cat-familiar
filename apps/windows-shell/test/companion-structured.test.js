import test from 'node:test';
import assert from 'node:assert/strict';
import * as structured from '../renderer/companion-structured.js';

test('consecutive system runs share a stable group while every non-system message breaks the run',()=>{
  const messages=[
    {id:'s1',role:'system',text:'First\nline',timestamp:'2026-10-29T10:00:00Z'},
    {id:'s2',role:'system',text:'',status:'interrupted',timestamp:'2026-10-29T10:00:01Z'},
    {id:'a1',role:'assistant',text:'Response'},
    {id:'s3',role:'system',text:'After assistant'},
    {id:'t1',role:'tool',text:'Output'},
    {id:'s4',role:'system',text:'After tool'},
    {id:'u1',role:'user',text:'Input'},
    {id:'s5',role:'system',text:'After user'}
  ];
  const groups=structured.groupConsecutiveSystemMessages(messages);
  assert.deepEqual(groups.map(group=>[group.kind,group.messages.map(item=>item.id)]),[
    ['system-group',['s1','s2']],['message',['a1']],['system-group',['s3']],['message',['t1']],['system-group',['s4']],['message',['u1']],['system-group',['s5']]
  ]);
  assert.deepEqual(groups.flatMap(group=>group.messages),messages);
  assert.equal(groups[0].messages[0],messages[0]);assert.equal(groups[0].messages[1],messages[1]);
  const appended=structured.groupConsecutiveSystemMessages([...messages,{id:'s6',role:'system',text:'Later'}]);
  assert.equal(appended.at(-1).id,groups.at(-1).id);
  assert.deepEqual(appended.at(-1).messages.map(item=>item.id),['s5','s6']);
  assert.deepEqual(structured.groupConsecutiveSystemMessages([]),[]);
});
