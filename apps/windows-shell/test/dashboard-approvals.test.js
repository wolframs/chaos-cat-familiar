import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { dashboardApprovalSubmission } from "../renderer/dashboard-approval-input.js";

test('settings re-renders keep unsaved paths and save feedback while updating clean fields', async () => {
  const source = (await readFile(new URL('../renderer/dashboard.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  const nodes = new Map(); let fields = new Map(); let push; let pushSettings; let selectSection;
  const document = {getElementById:node,activeElement:null};
  function field(id,value) { return {id,value,handlers:{},selectionStart:2,selectionEnd:5,
    addEventListener(name,fn){this.handlers[name]=fn;},focus(){document.activeElement=this;},
    setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}}; }
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {classList:{toggle(){}},addEventListener(){},
      contains(value){return [...fields.values()].includes(value);},
      set innerHTML(value){this.html=value;if(id==='viewBody') fields=new Map([...value.matchAll(/<(input|button|p|select)\b([^>]*\bid="([^"]+)"[^>]*)>/g)].map(([,kind,attrs,key])=>[key,{...field(key,attrs.match(/\bvalue="([^"]*)"/)?.[1]??''),kind}]));},
      get innerHTML(){return this.html;},querySelector(selector){return fields.get(selector.slice(1))??null;},
      querySelectorAll(selector){return id==='viewBody'&&selector.startsWith('input:')?[...fields.values()].filter(item=>(item.kind==='input'&&item.id!=='overlayOpacity'&&item.id!=='panelScale'&&item.id!=='debugLogging'&&item.id!=='performanceProfiling')||item.id==='codexAuthenticationMode'):[];}});
    return nodes.get(id);
  }
  const state={sessions:[],approvals:[],notifications:[],ui:{}};
  vm.runInNewContext(source,{document,console,window:{ccf:{getState:async()=>state,getSettings:async()=>({companionRepoPath:'saved',codexModel:'first'}),
    getMascotLibrary:async()=>({mascots:[]}),getLogMetadata:async()=>({}),diagnoseHooks:async()=>new Promise(()=>{}),
    async updateSettings(patch){pushSettings({companionRepoPath:'saved',codexModel:'updated',...patch});},
    onState(fn){push=fn;},onSettings(fn){pushSettings=fn;},onMascotLibrary(){},onDashboardSection(fn){selectSection=fn;}}}});
  selectSection('settings');await new Promise(resolve=>setImmediate(resolve));
  const draft=fields.get('companionRepoPath');draft.value='unsaved path';draft.handlers.input();
  push({...state,sessions:[{id:'activity'}]});
  assert.equal(fields.get('companionRepoPath').value,'unsaved path');
  pushSettings({companionRepoPath:'saved',codexModel:'updated'});
  assert.equal(fields.get('companionRepoPath').value,'unsaved path');
  assert.equal(fields.get('codexModel').value,'updated');
  const previousResult=fields.get('claudeCompanionSettingsResult');
  await fields.get('saveClaudeCompanionSettings').handlers.click();
  assert.notEqual(fields.get('claudeCompanionSettingsResult'),previousResult,'save publishes settings and replaces the form');
  assert.match(fields.get('claudeCompanionSettingsResult').textContent,/Saved/);
  push(state);
  assert.match(fields.get('claudeCompanionSettingsResult').textContent,/Saved/,'subsequent activity keeps the save feedback');
});

test("dashboard shows pending tool details before diagnosis and does not block with onboarding", async () => {
  const source = (await readFile(new URL("../renderer/dashboard.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "");
  const nodes = new Map();
  let stateHandler;
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { html: "", writes: 0, set innerHTML(value) { this.html = value; this.writes += 1; }, get innerHTML() { return this.html; }, classList: { toggle(name, value) { this[name] = value; } }, addEventListener() {}, querySelector() { return node("field"); }, querySelectorAll() { return []; } });
    return nodes.get(id);
  }
  const approval = { id: "p", event: { sessionId: "session-a", toolName: "Bash", cwd: "C:/project", toolInput: { command: "echo <review me>" } } };
  const state = { approvals: [approval], sessions: [], notifications: [], ui: { onboarding: { required: true } } };
  vm.runInNewContext(source, {
    document: { getElementById: node },
    window: { ccf: {
      getLogMetadata: async () => ({ filePath: "C:/test/ccf.log" }), getState: async () => state, getSettings: async () => ({}), getMascotLibrary: async () => ({ mascots: [] }),
      diagnoseHooks: async () => new Promise(() => {}), onState(fn) { stateHandler = fn; }, onSettings() {}, onMascotLibrary() {}
    } }, console
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(node("viewTitle").textContent, "Approvals");
  assert.equal(node("onboarding").classList.visible, false);
  assert.match(node("viewBody").innerHTML, /echo &lt;review me&gt;/);
  assert.match(node("viewBody").innerHTML, /session-a/);
  assert.match(node("viewBody").innerHTML, /<details/);
  assert.doesNotMatch(node("viewBody").innerHTML, /data-expand=/);
  const writes = node("viewBody").writes;
  stateHandler({ ...state, sessions: [{ id: "other-session", phase: "running" }] });
  assert.equal(node("viewBody").writes, writes, "routine activity preserves the form, focus and caret");
});

test("questions require answers and plan feedback uses supported approval actions", () => {
  const approval = { id: "question", event: { toolInput: { questions: [{ question: "Which?" }] } } };
  assert.throws(() => dashboardApprovalSubmission(approval), /Answer each question/);
  assert.deepEqual(dashboardApprovalSubmission(approval, { answers: { "Which?": "First, Second" } }), { id: "question", action: "allowWithAnswers", payload: { answers: { "Which?": "First, Second" } } });
  assert.deepEqual(dashboardApprovalSubmission({ id: "plan", event: { toolName: "ExitPlanMode" } }, { feedback: " use tests " }), { id: "plan", action: "allowWithFeedback", payload: { feedback: "use tests" } });
});

test("tray Settings navigation survives initial state loading", async () => {
  const source = (await readFile(new URL("../renderer/dashboard.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "");
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { handlers: {}, classList: { toggle(name, value) { this[name] = value; } },
      addEventListener(name, handler) { this.handlers[name] = handler; }, querySelector() { return null; }, querySelectorAll() { return []; } });
    return nodes.get(id);
  }
  let resolveState;
  let selectSection;
  const state = { sessions: [], approvals: [], notifications: [], ui: { onboarding: { required: true } } };
  vm.runInNewContext(source, { document: { getElementById: node }, console,
    window: { ccf: {
      getState: () => new Promise((resolve) => { resolveState = resolve; }), getSettings: async () => ({}),
      getMascotLibrary: async () => ({ mascots: [] }), getLogMetadata: async () => ({}), diagnoseHooks: async () => ({}),
      onState() {}, onSettings() {}, onMascotLibrary() {}, onDashboardSection(handler) { selectSection = handler; }
    } }
  });
  selectSection("settings");
  resolveState(state);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(node("viewTitle").textContent, "Settings");
  assert.match(node("viewBody").innerHTML, /Claude companion/);
  assert.match(node("viewBody").innerHTML, /id="companionRepoPath"/);
  assert.match(node("viewBody").innerHTML, /Codex companion \(optional\)/);
  assert.equal(node("onboarding").classList.visible, false, "onboarding cannot cover an explicitly opened Settings view");
  selectSection("unknown-section");
  assert.equal(node("viewTitle").textContent, "Settings");
});
