import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {productionCompanionPaths} from '../services/companion-production.js';

test('production paths preserve the normal user environment and separate habitat data from source',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccf-production-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const settings={codexCompanionRepoPath:path.join(root,'source'),companionDataPath:path.join(root,'data')};
  const options={home:root,appData:path.join(root,'appdata'),parentEnv:{HOME:'normal-home',APPDATA:'normal-appdata',PATH:'fixture-path',OPENAI_API_KEY:'must-not-pass',CLAUDE_CODE_SESSION_ID:'must-not-pass',NODE_OPTIONS:'must-not-pass'}};
  assert.throws(()=>productionCompanionPaths({...settings,companionDataPath:settings.codexCompanionRepoPath},options),/non-overlapping/);
  const p=productionCompanionPaths(settings,options);
  assert.equal(p.env.COMPANION_ROOT,settings.companionDataPath);assert.equal(p.env.CODEX_HOME,undefined);assert.equal(p.env.OPENAI_API_KEY,options.parentEnv.OPENAI_API_KEY);assert.equal(p.env.CLAUDE_CODE_SESSION_ID,options.parentEnv.CLAUDE_CODE_SESSION_ID);assert.equal(p.env.NODE_OPTIONS,options.parentEnv.NODE_OPTIONS);
  assert.equal(p.env.HOME,'normal-home');assert.equal(p.env.APPDATA,'normal-appdata');
  for(const mode of ['existing-codex-home','dedicated-codex-home']){
    const selected=productionCompanionPaths({...settings,codexAuthenticationMode:mode,codexAuthenticationHome:path.join(root,'selected-auth')},options);
    assert.equal(selected.env.CODEX_HOME,path.join(root,'selected-auth'));
  }
  const inherited=productionCompanionPaths(settings,{...options,parentEnv:{CODEX_HOME:path.join(root,'normal-codex')}});
  assert.equal(inherited.env.CODEX_HOME,path.join(root,'normal-codex'));
  assert.ok(p.env.COMPANION_OPTMEM.startsWith(settings.codexCompanionRepoPath));assert.ok(p.env.COMPANION_MEMORY_DIR.startsWith(settings.companionDataPath));
  const explicitCore=path.join(settings.companionDataPath,'knowledge','existing-core.md');
  assert.equal(productionCompanionPaths({...settings,companionCorePath:explicitCore},options).env.COMPANION_CORE,explicitCore,'An existing core document can retain its compatible path without copying it.');
});

