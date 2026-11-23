// The diagnostics window (process-split plan, step 5). Before: every hook event pushed the full state and re-ran hook
// diagnosis, settings, mascot and log reads. With a port of its own: the base state from the port while visible, the
// expensive reads and the log on demand.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { composeLegacyState } from "../renderer/legacy-state.js";

async function load({ live }) {
  const source = (await readFile(new URL("../renderer/diagnostics.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "");
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, value: "", textContent: "", innerHTML: "", handlers: {},
      addEventListener(name, handler) { this.handlers[name] = handler; }, querySelectorAll() { return []; } });
    return nodes.get(id);
  };
  const calls = { diagnose: 0 };
  const handlers = {};
  let subscription = null;
  const ccf = {
    diagnoseHooks: async () => { calls.diagnose += 1; return { drift: { healthy: true }, health: { ok: true } }; },
    getSettings: async () => ({ port: 1, hotkeys: {} }), getMascotLibrary: async () => ({ mascots: [] }),
    getLogMetadata: async () => ({ filePath: "C:/log" }), getShellState: async () => ({ meta: { coreStatus: "ready" }, ui: null }),
    onShellState(handler) { handlers.shell = handler; },
    onHookInstallResult(handler) { handlers.install = handler; }, onMascotLibrary() {}, log() {}
  };
  vm.runInNewContext(source, { document: { getElementById: node }, window: { ccf }, console, setTimeout, clearTimeout,
    composeLegacyState, subscribeCoreState: (options) => { subscription = options; return live; } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { node, calls, handlers, subscription: () => subscription };
}

test("on its own port: state from the port, diagnosis and the log on demand, never per hook event", async () => {
  const queries = [];
  const live = { query: async (method, params) => { queries.push([method, params]);
    return { logs: [{ id: `l${queries.length}`, category: "activation", level: "info", message: `log ${queries.length}` }] }; } };
  const { calls, handlers, node, subscription } = await load({ live });
  assert.equal(JSON.stringify(subscription().topics), JSON.stringify(["base"]));
  assert.equal(subscription().whileVisible, true);
  assert.equal(calls.diagnose, 1, "diagnosed once when the window opened");
  assert.equal(queries.length, 1, "the log once on open");
  for (let i = 0; i < 20; i++) {
    subscription().onState({ sessions: [{ id: `s${i}` }], approvals: [], notifications: [], events: [], logs: [],
      summary: { eventCount: i, latestLogId: "l1" } });
  }
  assert.equal(calls.diagnose, 1, "hook events do not re-run the diagnosis");
  assert.match(node("state").textContent, /"s19"/, "the state shown is the port's latest");
  assert.match(node("activationAttempts").innerHTML, /log 1/);
  subscription().onState({ sessions: [], approvals: [], notifications: [], events: [], logs: [], summary: { latestLogId: "l9" } });
  subscription().onState({ sessions: [], approvals: [], notifications: [], events: [], logs: [], summary: { latestLogId: "l10" } });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(queries.length, 2, "new log lines are fetched once, throttled");
  await handlers.state?.({});
  assert.equal(calls.diagnose, 1, "a ccf:state push is ignored on a port");
  await handlers.install();
  assert.equal(calls.diagnose, 2, "a hook install re-runs it on demand");
});
