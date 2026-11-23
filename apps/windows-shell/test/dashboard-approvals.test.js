import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { dashboardApprovalSubmission } from "../renderer/dashboard-approval-input.js";
import { composeLegacyState } from "../renderer/legacy-state.js";

// dashboard.js runs in a VM with its imports stripped. Its state comes on its own port (process-split plan, steps 5
// and 7: main sends no state); port() stands in for the subscription, push(state) delivers the core's part.
function port() {
  const stub = { onState: null };
  stub.globals = { composeLegacyState, subscribeCoreState: ({ onState }) => { stub.onState = onState;
    return { mirror: null, query: async () => ({ events: [] }) }; } };
  stub.push = (state) => stub.onState(state);
  return stub;
}
const shellOf = (state) => async () => ({ meta: {}, ui: state.ui ?? null, hostedCompanion: null, hostedSession: null });

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
  const stub=port();push=stub.push;
  vm.runInNewContext(source,{...stub.globals,document,console,window:{ccf:{getShellState:shellOf(state),onShellState(){},getSettings:async()=>({companionRepoPath:'saved',codexModel:'first'}),
    getMascotLibrary:async()=>({mascots:[]}),getLogMetadata:async()=>({}),diagnoseHooks:async()=>new Promise(()=>{}),
    async updateSettings(patch){pushSettings({companionRepoPath:'saved',codexModel:'updated',...patch});},
    onSettings(fn){pushSettings=fn;},onMascotLibrary(){},onDashboardSection(fn){selectSection=fn;}}}});
  selectSection('settings');await new Promise(resolve=>setImmediate(resolve));
  push(state);await new Promise(resolve=>setImmediate(resolve));
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
  const stub = port();
  vm.runInNewContext(source, { ...stub.globals,
    document: { getElementById: node },
    window: { ccf: {
      getLogMetadata: async () => ({ filePath: "C:/test/ccf.log" }), getShellState: shellOf(state), onShellState() {},
      getSettings: async () => ({}), getMascotLibrary: async () => ({ mascots: [] }),
      diagnoseHooks: async () => new Promise(() => {}), onSettings() {}, onMascotLibrary() {}
    } }, console
  });
  await new Promise((resolve) => setImmediate(resolve));
  stateHandler = stub.push;
  stateHandler(state);
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
  let selectSection;
  const state = { sessions: [], approvals: [], notifications: [], ui: { onboarding: { required: true } } };
  const stub = port();
  vm.runInNewContext(source, { ...stub.globals, document: { getElementById: node }, console,
    window: { ccf: {
      getShellState: shellOf(state), onShellState() {}, getSettings: async () => ({}),
      getMascotLibrary: async () => ({ mascots: [] }), getLogMetadata: async () => ({}), diagnoseHooks: async () => ({}),
      onSettings() {}, onMascotLibrary() {}, onDashboardSection(handler) { selectSection = handler; }
    } }
  });
  selectSection("settings");
  await new Promise((resolve) => setImmediate(resolve));
  stub.push(state);   // the core's state arrives after the section was chosen
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(node("viewTitle").textContent, "Settings");
  assert.match(node("viewBody").innerHTML, /Claude companion/);
  assert.match(node("viewBody").innerHTML, /id="companionRepoPath"/);
  assert.match(node("viewBody").innerHTML, /Codex companion \(optional\)/);
  assert.equal(node("onboarding").classList.visible, false, "onboarding cannot cover an explicitly opened Settings view");
  selectSection("unknown-section");
  assert.equal(node("viewTitle").textContent, "Settings");
});

// Process-split plan, step 5: with a port of its own, the dashboard takes the core's state from it (visible only, the
// newest 50 events), main's part from ccf:shell-state, and asks for the whole history on demand when it filters.
test("on its own port the dashboard renders the core's state with main's shell state and asks for history on demand", async () => {
  const source = (await readFile(new URL("../renderer/dashboard.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "");
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { id, html: "", handlers: {}, value: "", classList: { toggle(name, value) { this[name] = value; } },
      set innerHTML(value) { this.html = value; }, get innerHTML() { return this.html; },
      addEventListener(name, handler) { this.handlers[name] = handler; }, contains() { return false; }, append() {},
      querySelector(selector) { return this.html.includes(`id="${selector.slice(1)}"`) ? node(`${id}:${selector}`) : null; },
      querySelectorAll() { return []; } });
    return nodes.get(id);
  }
  let onCoreState = null;
  let options = null;
  let shellPush = null;
  const queries = [];
  const live = { query: async (method, params) => { queries.push([method, params]);
    return { events: [{ id: "h1", hookEventName: "Stop", sessionId: "old-session", message: "from the retained history" }] }; } };
  const document = { getElementById: node, activeElement: null, createElement: () => ({ addEventListener() {} }) };
  vm.runInNewContext(source, { composeLegacyState, document, console, setTimeout, clearTimeout,
    subscribeCoreState: (value) => { options = value; onCoreState = value.onState; return live; },
    window: { ccf: {
      getShellState: async () => ({ meta: { overlayMode: "mascot" }, ui: { onboarding: { required: false } }, hostedCompanion: null, hostedSession: null }),
      onShellState(handler) { shellPush = handler; },
      getSettings: async () => ({}), getMascotLibrary: async () => ({ mascots: [] }), getLogMetadata: async () => ({}),
      diagnoseHooks: async () => ({ drift: { healthy: true } }),
      onSettings() {}, onMascotLibrary() {}, onDashboardSection() {}
    } } });
  assert.deepEqual(JSON.parse(JSON.stringify({ topics: options.topics, eventLimit: options.eventLimit, whileVisible: options.whileVisible })),
    { topics: ["base", "events"], eventLimit: 50, whileVisible: true });
  await new Promise((resolve) => setImmediate(resolve));
  onCoreState({ sessions: [{ id: "s1", status: "active", phase: "running" }], approvals: [], events: [
    { id: "e1", hookEventName: "PreToolUse", toolName: "Bash", sessionId: "s1", cwd: "C:/live" }],
  notifications: [{ id: "n1", isRead: false, category: "idle_alert" }], logs: [],
  notificationSummary: { unreadCount: 1 }, summary: { eventCount: 1, latestEventAt: null } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(node("viewTitle").textContent, "Activity");
  assert.match(node("viewBody").innerHTML, /C:\/live/);
  assert.match(node("nav").innerHTML, /nav-count">1</, "the unread count composed from the core's notifications");
  assert.equal(node("onboarding").classList.visible, false, "main's shell state says onboarding is done");

  node("viewToolbar:#activityFilter").handlers.change({ target: { value: "Stop" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(JSON.parse(JSON.stringify(queries)), [["history", { hookEventName: "Stop", search: "", limit: 40 }]]);
  assert.match(node("viewBody").innerHTML, /from the retained history/);

  shellPush({ meta: {}, ui: { onboarding: { required: true, currentStep: 1 } }, hostedCompanion: null, hostedSession: null });
  assert.equal(node("onboarding").classList.visible, true, "main's shell state still reaches the view");
});
