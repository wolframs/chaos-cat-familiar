import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CodexHookInstaller} from '../services/codex-hook-installer.js';

function cleanup(root){
  const resolved=path.resolve(root);const temp=path.resolve(os.tmpdir())+path.sep;
  assert.ok(resolved.startsWith(temp)&&path.basename(resolved).startsWith('ccf-codex-hooks-'));
  const pending=[resolved];
  while(pending.length){const directory=pending.pop();for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const child=path.join(directory,entry.name);
    if(fs.lstatSync(child).isSymbolicLink())fs.unlinkSync(child);
    else if(entry.isDirectory())pending.push(child);
  }}
  fs.rmSync(resolved,{recursive:true,force:true});
}

test('explicit Codex hook installation/removal is idempotent and preserves unrelated handlers and trust',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccf-codex-hooks-'));
  try{
    const home=path.join(root,'codex-home');fs.mkdirSync(home);
    const hooksPath=path.join(home,'hooks.json');
    const unrelated={type:'command',command:'echo unrelated'};
    fs.writeFileSync(hooksPath,JSON.stringify({description:'Keep this',hooks:{Stop:[{matcher:'',hooks:[unrelated]}],OtherEmpty:[]}}));
    fs.writeFileSync(path.join(home,'config.toml'),'[features]\nhooks = false\n');
    fs.writeFileSync(path.join(home,'hook-trust.json'),'synthetic trust sentinel');
    const installer=new CodexHookInstaller({codexHome:home,nodeExecutable:process.execPath,senderPath:path.join(root,'codex-hook-sender.mjs'),settingsPath:path.join(root,'settings.json')});
    assert.throws(()=>installer.install({}),/explicit/);
    const result=installer.install({userInitiated:true});const once=fs.readFileSync(hooksPath,'utf8');
    assert.equal(result.trustReviewRequired,true);assert.match(result.nextAction,/\/hooks/);
    installer.install({userInitiated:true});assert.equal(fs.readFileSync(hooksPath,'utf8'),once);
    const installed=JSON.parse(once);assert.equal(installed.description,'Keep this');assert.deepEqual(installed.hooks.Stop[0].hooks,[unrelated]);
    assert.equal(installed.hooks.PermissionRequest.at(-1).hooks[0].async,true);
    installer.remove({userInitiated:true});const removed=JSON.parse(fs.readFileSync(hooksPath,'utf8'));
    assert.deepEqual(removed.hooks.Stop,[{matcher:'',hooks:[unrelated]}]);
    assert.deepEqual(removed.hooks.OtherEmpty,[]);
    assert.equal(fs.readFileSync(path.join(home,'config.toml'),'utf8'),'[features]\nhooks = false\n');
    assert.equal(fs.readFileSync(path.join(home,'hook-trust.json'),'utf8'),'synthetic trust sentinel');
  }finally{cleanup(root);}
});
test('malformed or newer hooks configuration is preserved and refused',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccf-codex-hooks-'));
  try{
    const installer=new CodexHookInstaller({codexHome:root,nodeExecutable:process.execPath,senderPath:path.join(root,'sender.mjs'),settingsPath:path.join(root,'settings.json')});
    for(const source of ['{broken',JSON.stringify({schemaVersion:99,hooks:{}})]){
      fs.writeFileSync(path.join(root,'hooks.json'),source);
      assert.throws(()=>installer.install({userInitiated:true}),/configuration|schema/);
      assert.equal(fs.readFileSync(path.join(root,'hooks.json'),'utf8'),source);
    }
  }finally{cleanup(root);}
});
