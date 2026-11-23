// Review of step 5 (P2): the overlay reported a revision as drawn even when it had returned early (a hidden window) or
// failed, so "show the overlay" could show a window that never drew the approval it was shown for. The real overlay
// script runs here against a permissive DOM stand-in; what matters is the order of drawing and reporting.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import * as mascotStateMachine from "../renderer/mascot-state-machine.js";
import * as companionAttention from "../renderer/companion-attention.js";
import * as sessionActivation from "../renderer/session-activation.js";
import * as mascotDrag from "../renderer/mascot-drag.js";

// Every unknown property is a callable that returns another stand-in, so the script runs without a browser.
function standIn(name, log) {
  const target = function () {};
  const values = { style: {}, dataset: {}, children: [] };
  return new Proxy(target, {
    get(_target, key) {
      if (key === Symbol.toPrimitive) return () => "";
      if (typeof key === "symbol") return undefined;
      if (key in values) return values[key];
      if (key === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (["append", "appendChild", "prepend", "replaceChildren"].includes(key)) {
        return (...items) => { log.push({ node: name, op: key, count: items.length }); values.children.push(...items); };
      }
      if (key === "querySelectorAll" || key === "getElementsByClassName") return () => [];
      if (key === "then") return undefined;
      return (..._args) => standIn(`${name}.${key}`, log);
    },
    set(_target, key, value) {
      if (key === "innerHTML") log.push({ node: name, op: "innerHTML" });
      values[key] = value;
      return true;
    },
    apply() { return standIn(`${name}()`, log); }
  });
}

async function overlay({ hidden }) {
  const source = (await readFile(new URL("../renderer/overlay.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "");
  const log = [];
  const reports = [];
  let push = null;
  const document = { hidden, getElementById: (id) => standIn(id, log), querySelector: (selector) => standIn(selector, log),
    createElement: (tag) => standIn(`new ${tag}`, log), addEventListener() {}, body: standIn("body", log) };
  const window = { addEventListener() {}, devicePixelRatio: 1, ccf: {
    onShellState() {}, getShellState: async () => ({ meta: {}, ui: { overlay: {} } }), onSettings() {}, onMascotLibrary() {},
    getSettings: async () => ({}), getMascotLibrary: async () => ({ mascots: [] }),
    detectClaudeRuntime: async () => ({}), log() {},
    reportViewRevision: (payload) => { reports.push({ ...payload, after: log.length }); }
  } };
  // The overlay's port (step 7): what the test pushes is the composed state the page draws.
  const subscribeCoreState = ({ onState }) => { push = onState; return { mirror: null }; };
  vm.runInNewContext(source, { ...mascotStateMachine, ...companionAttention, ...sessionActivation, ...mascotDrag,
    subscribeCoreState, OVERLAY_TOPICS: [], composeOverlayState: (core) => core,
    window, document, console, setTimeout, clearTimeout, setInterval, clearInterval, performance, structuredClone,
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout, URL, Date, Math, JSON });
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  return { log, reports, push: (state) => push(state) };
}

const approvalState = (revision) => ({
  approvals: [{ id: "a-1", collapsed: false, assistantLabel: "Claude",
    event: { id: "e-1", sessionId: "s-1", toolName: "Bash", toolInput: { command: "dir" }, hookEventName: "PermissionRequest" } }],
  sessions: [{ id: "s-1", status: "active", phase: "running", projectName: "p", assistantLabel: "Claude" }],
  notifications: [], events: [], ui: { overlay: {} }, meta: { revision, epoch: 3, eventCount: 1 }
});

test("a hidden overlay draws the approval before it reports the revision", async () => {
  const view = await overlay({ hidden: true });
  const before = view.log.length;
  await view.push(approvalState(7));
  const report = view.reports.find((item) => item.revision === 7);
  assert.ok(report, "the revision is reported");
  const drawn = view.log.slice(before, report.after).filter((entry) => entry.node === "approvals");
  assert.ok(drawn.some((entry) => entry.op === "append"), "the approval card was in the window before the report");
});

test("a draw that fails reports nothing", async () => {
  const view = await overlay({ hidden: false });
  const broken = approvalState(9);
  Object.defineProperty(broken, "approvals", { get() { throw new Error("draw failed"); } });
  await assert.rejects(Promise.resolve().then(() => view.push(broken)), /draw failed/);
  assert.equal(view.reports.some((item) => item.revision === 9), false);
});
