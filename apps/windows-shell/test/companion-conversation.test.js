import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCompanionSnapshot,
  normalizeSubmission,
  submissionStatusText,
  shouldSubmitOnKeydown
} from "../renderer/companion-conversation-model.js";
import * as conversationModel from '../renderer/companion-conversation-model.js';

test('backend switching is offered while idle and explains active or uncertain work instead of requiring disconnection',()=>{
  for(const backend of ['claude','codex']){
    const idle=normalizeCompanionSnapshot({backend,connected:true,phase:'idle'});
    assert.equal(conversationModel.backendSwitchGuard(idle).allowed,true);
    for(const changes of [{phase:'working'},{phase:'attention'},{pendingRequests:[{key:'approval'}]},{submission:{state:'pending'}},{submission:{state:'outcomeUnknown'}},{phase:'connecting'},{starting:true},{switching:true}]){
      const guard=conversationModel.backendSwitchGuard(normalizeCompanionSnapshot({...idle,...changes}));
      assert.equal(guard.allowed,false);assert.ok(guard.reason.length);
    }
    assert.equal(conversationModel.backendSwitchGuard(idle,{busy:true}).allowed,false);
    assert.equal(conversationModel.backendSwitchGuard(idle,{attaching:true}).allowed,false);
    assert.equal(conversationModel.backendSwitchGuard(normalizeCompanionSnapshot({backend,connected:false})).allowed,true);
  }
});

test('acceptance is quiet by default and visible only with the explicit debug UI flag',()=>{
  const accepted={backend:'codex',connected:true,phase:'idle',submission:{state:'accepted'}};
  assert.equal(submissionStatusText(normalizeCompanionSnapshot(accepted)),'');
  assert.equal(submissionStatusText(normalizeCompanionSnapshot({...accepted,debugUi:true})),'Message accepted.');
  assert.equal(submissionStatusText(normalizeCompanionSnapshot({...accepted,debugUi:'true'})),'');
  for(const state of ['pending','rejected','outcomeUnknown'])assert.ok(submissionStatusText(normalizeCompanionSnapshot({...accepted,submission:{state}})).length);
});

test("conversation snapshot preserves readable transcript and a separate streaming reply", () => {
  const snapshot = normalizeCompanionSnapshot({
    connected: true,
    phase: "working",
    title: "Status der drei Tickets",
    messages: [
      { id: "one", role: "user", text: "What changed?" },
      { id: "two", role: "assistant", text: "First answer" }
    ],
    liveText: "Still checking…"
  });

  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.phase, "working");
  assert.equal(snapshot.title, "Status der drei Tickets");
  assert.deepEqual(snapshot.messages.map(({ role, text }) => [role, text]), [
    ["user", "What changed?"],
    ["assistant", "First answer"]
  ]);
  assert.equal(snapshot.liveText, "Still checking…");
});

test('Codex snapshots retain identity, requests and uncertainty separately from Claude terminal', () => {
  const snapshot = normalizeCompanionSnapshot({backend:'codex',connected:true,phase:'idle',conversationId:'fork',sessionRootId:'root',connectionEpoch:3,
    submission:{id:'s1',state:'outcomeUnknown'},pendingRequests:[{key:'request',method:'unknown',supported:false}],messages:[{id:'tool',role:'tool',text:'output',status:'failed',outputLimited:true}]});
  assert.equal(snapshot.backend,'codex'); assert.equal(snapshot.conversationId,'fork');
  assert.equal(snapshot.submission.state,'outcomeUnknown'); assert.equal(snapshot.pendingRequests[0].key,'request');
  assert.equal(snapshot.messages[0].status,'failed');
});

test('structured backend errors retain actionable recovery without exposing arbitrary actions',()=>{
  const snapshot=normalizeCompanionSnapshot({backend:'codex',error:'Authentication required',errorInfo:{code:'missing-auth',reason:'Use the configured authentication source',actions:['open-settings','start','untrusted-action']}});
  assert.deepEqual(snapshot.errorInfo,{code:'missing-auth',reason:'Use the configured authentication source',actions:['open-settings','start']});
  const unbound=normalizeCompanionSnapshot({backend:'codex',connected:false,error:'An earlier unbound launch needs explicit recovery'});
  assert.ok(unbound.errorInfo.actions.includes('recover-launch'));
  const bound=normalizeCompanionSnapshot({backend:'codex',connected:false,conversationId:'known-thread',error:'Connection lost'});
  assert.equal(bound.errorInfo.actions.includes('recover-launch'),false);
});

test("conversation snapshot rejects unsupported roles and handles offline state", () => {
  const snapshot = normalizeCompanionSnapshot({
    messages: [{ role: "developer", text: "secret" }, { role: "system", text: "Waiting" }],
    phase: "unknown"
  });

  assert.equal(snapshot.connected, false);
  assert.equal(snapshot.phase, "offline");
  assert.deepEqual(snapshot.messages.map(({ role, text }) => [role, text]), [["system", "Waiting"]]);
});

test("message submission preserves multiline content but ignores whitespace-only drafts", () => {
  assert.deepEqual(normalizeSubmission("  First line\nsecond line  ", true), {
    action: "send",
    text: "First line\nsecond line"
  });
  assert.equal(normalizeSubmission("  \n  ", true), null);
  assert.equal(normalizeSubmission("Hello", false), null);
});

test("Enter submits, Shift+Enter and composition keep editing", () => {
  assert.equal(shouldSubmitOnKeydown({ key: "Enter" }), true);
  assert.equal(shouldSubmitOnKeydown({ key: "Enter", shiftKey: true }), false);
  assert.equal(shouldSubmitOnKeydown({ key: "Enter", isComposing: true }), false);
  assert.equal(shouldSubmitOnKeydown({ key: "Tab" }), false);
});

test("conversation keeps terminal colour runs and owns its normalized copy", () => {
  const terminal = { screen: "Red", lines: [[{ text: "Red", foreground: "#cd3131", bold: true }]] };
  const snapshot = normalizeCompanionSnapshot({ connected: true, terminal });
  assert.deepEqual(snapshot.terminal.lines, terminal.lines);
  snapshot.terminal.lines[0][0].text = "changed";
  assert.equal(terminal.lines[0][0].text, "Red");
});

test("an image-only draft can be sent and carries only staged image identifiers", () => {
  const snapshot = normalizeCompanionSnapshot({ connected: true, attachments: [
    { id: "picture-1", name: "Screenshot.png", previewUrl: "file:///ccf/picture.png", path: "do not accept renderer paths" }
  ], terminal: { history: [[{ text: "Earlier output", foreground: "#123456" }]] } });
  assert.deepEqual(normalizeSubmission("", true, snapshot.attachments), { action: "send", text: "", attachmentIds: ["picture-1"] });
  assert.equal(snapshot.attachments[0].path, undefined);
  assert.equal(snapshot.terminal.history[0][0].text, "Earlier output");
});

test("a terminal revision reuses normalized rows for metadata updates but legacy snapshots still refresh", () => {
  const terminal = { revision: 7, screen: "Red", lines: [[{ text: "Red", foreground: "#cd3131" }]], history: [] };
  const first = normalizeCompanionSnapshot({ connected: true, terminal });
  const metadata = normalizeCompanionSnapshot({ connected: true, phase: "attention", terminal: structuredClone(terminal) }, first);
  assert.equal(metadata.terminal.revision, 7);
  assert.equal(metadata.terminal.lines, first.terminal.lines);
  assert.equal(metadata.terminal.history, first.terminal.history);
  assert.equal(metadata.phase, "attention");
  const fresh = normalizeCompanionSnapshot({ connected: true, terminal: { ...terminal, revision: 8, lines: [[{ text: "New" }]] } }, metadata);
  assert.notEqual(fresh.terminal.lines, metadata.terminal.lines);
  assert.equal(fresh.terminal.lines[0][0].text, "New");
  const legacy = normalizeCompanionSnapshot({ connected: true, terminal: { screen: "Old backend", lines: [[{ text: "Old backend" }]] } }, fresh);
  assert.equal(legacy.terminal.lines[0][0].text, "Old backend");
  assert.equal(legacy.terminal.revision, null);
});
