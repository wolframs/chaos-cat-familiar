import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { companionAttention, sessionIdentity, syncCompanionPlayback, syncCompanionMedia } from "../renderer/companion-attention.js";
import { MascotStateMachine, mascotInputsFromState } from "../renderer/mascot-state-machine.js";
import { defaultMascotConfig } from "../renderer/default-mascot-config.js";
import { loadBundledMascots } from "../services/bundled-mascots.js";

test("overlay settles static waiting and hidden states before resuming working media", async () => {
  const source = (await readFile(new URL("../renderer/overlay.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "");
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      style: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {},
      getAttribute(name) { return this[name] ?? null; }, removeAttribute(name) { delete this[name]; },
      load() {}, paused: true, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); }
    });
    return nodes.get(id);
  }
  const document = { hidden: false, body: node("body"), getElementById: node, querySelector: node, addEventListener() {} };
  const context = vm.createContext({
    document, window: { ccf: { onState() {}, onSettings() {}, onMascotLibrary() {}, getState() { return new Promise(() => {}); }, getSettings() { return new Promise(() => {}); }, getMascotLibrary() { return new Promise(() => {}); } }, addEventListener() {} },
    MascotStateMachine, mascotInputsFromState, companionAttention, sessionIdentity, syncCompanionPlayback, syncCompanionMedia,
    defaultMascotConfig, setTimeout() {}, clearTimeout() {}, Date, console
  });
  vm.runInContext(source, context);
  vm.runInContext(`mascotLibrary = { mascots: [{ id: "test", name: "Test", config: defaultMascotConfig }] };`, context);
  context.working = { sessions: [{ id: "s", status: "active", phase: "running" }], approvals: [] };
  context.waiting = { ...context.working, approvals: [{ id: "a", event: { sessionId: "s" } }] };
  vm.runInContext("renderMascot(working); mascot.handleVideoEnded(); renderMascot(working); renderMascot(waiting);", context);
  assert.equal(node("mascotVideo").src, undefined);
  assert.equal(vm.runInContext("mascot.snapshot().nodeName", context), "Needs Attention");
  assert.equal(vm.runInContext("mascot.snapshot().phase", context), "loop");
  assert.equal(node("mascotFallback").src, defaultMascotConfig.nodes.find((item) => item.name === "Needs Attention").transparentThumbnailUrl);
  vm.runInContext("renderMascot(working)", context);
  assert.match(node("mascotVideo").src, /needs-attention-working-/);
  document.hidden = true;
  vm.runInContext("renderState(working)", context);
  assert.equal(node("mascotVideo").src, undefined);
  assert.equal(vm.runInContext("mascot.snapshot().nodeName", context), "Working");
  assert.equal(vm.runInContext("mascot.snapshot().phase", context), "loop");
  document.hidden = false;
  vm.runInContext("renderMascot(working)", context);
  assert.match(node("mascotVideo").src, /working-a172/);
});

test("visible Chaos Cat animates Idle and Needs Attention and releases video when hidden", async () => {
  const source = (await readFile(new URL("../renderer/overlay.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "");
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      style: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {},
      getAttribute(name) { return this[name] ?? null; }, removeAttribute(name) { delete this[name]; },
      load() {}, paused: true, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); }
    });
    return nodes.get(id);
  }
  const document = { hidden: false, body: node("body"), getElementById: node, querySelector: node, addEventListener() {} };
  const context = vm.createContext({
    document, window: { ccf: { onState() {}, onSettings() {}, onMascotLibrary() {}, getState() { return new Promise(() => {}); }, getSettings() { return new Promise(() => {}); }, getMascotLibrary() { return new Promise(() => {}); } }, addEventListener() {} },
    MascotStateMachine, mascotInputsFromState, companionAttention, sessionIdentity, syncCompanionPlayback, syncCompanionMedia,
    setTimeout() {}, clearTimeout() {}, Date, console
  });
  vm.runInContext(source, context);
  const config = loadBundledMascots().find((item) => item.slug === "chaos-cat").config;
  context.chaosConfig = config;
  vm.runInContext(`mascotLibrary = { currentMascotId: "bundled:chaos-cat", mascots: [{ id: "bundled:chaos-cat", name: "Chaos Cat Familiar", config: chaosConfig }] };`, context);
  context.idle = { sessions: [], approvals: [] };
  context.waiting = { sessions: [], approvals: [{ id: "a", collapsed: false, event: { sessionId: "s" } }] };
  vm.runInContext("renderMascot(idle)", context);
  assert.match(node("mascotVideo").src, /chaos-cat\/loops\/idle\.webm/);
  vm.runInContext("renderMascot(waiting)", context);
  assert.match(node("mascotVideo").src, /chaos-cat\/transitions\/idle-to-attention\.webm/);
  vm.runInContext("renderMascot(idle)", context);
  assert.equal(vm.runInContext("mascot.snapshot().phase", context), "loop", "resolved approval cancels its in-flight transition");
  assert.match(node("mascotVideo").src, /chaos-cat\/loops\/idle\.webm/);
  vm.runInContext("renderMascot(waiting)", context);
  document.hidden = true;
  vm.runInContext("renderState(waiting)", context);
  assert.equal(node("mascotVideo").src, undefined);
});

test("overlay uses hook updates without polling or process detection and pauses when hidden", async () => {
  const source = (await readFile(new URL("../renderer/overlay.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "");
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { style: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, getAttribute() { return null; }, append() {}, paused: true, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } });
    return nodes.get(id);
  }
  const handlers = {};
  const documentHandlers = {};
  const timers = new Set();
  const state = { sessions: [], approvals: [], events: [], ui: { overlay: {} } };
  let detections = 0;
  let settingsLoads = 0;
  const document = { hidden: false, body: node("body"), getElementById: node, querySelector: node, createElement: () => node("created"), addEventListener(name, fn) { documentHandlers[name] = fn; } };
  const ccf = {
    async getState() { return state; },
    async getSettings() { settingsLoads += 1; return { appShellMode: "mascot" }; },
    async getMascotLibrary() { return { mascots: [] }; },
    async detectClaudeRuntime() { detections += 1; return new Promise(() => {}); },
    onState(fn) { handlers.state = fn; }, onSettings() {}, onMascotLibrary() {}
  };
  vm.runInNewContext(source, {
    document, window: { ccf, addEventListener() {} }, companionAttention, sessionIdentity, syncCompanionPlayback, syncCompanionMedia,
    setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); },
    setInterval() { throw new Error("idle polling must not return"); }, Date, console
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detections, 1);
  assert.equal(settingsLoads, 1);
  assert.equal(node("mascotBubble").textContent, undefined, "the cat renders without a state/session label");
  assert.equal(timers.size, 0);
  for (let i = 0; i < 10; i += 1) await handlers.state(state);
  assert.equal(detections, 1);
  assert.equal(settingsLoads, 1);
  const video = node("mascotVideo");
  video.paused = false;
  document.hidden = true;
  documentHandlers.visibilitychange();
  assert.equal(video.paused, true);
  assert.equal(timers.size, 0);
});
