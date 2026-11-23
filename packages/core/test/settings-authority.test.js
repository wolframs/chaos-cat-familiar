import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { FileSettingsStore, SettingsAuthority, SettingsMirror, ServiceError, mergeSettingsPatch,
  settingsPatchBetween } from "../src/index.js";

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-settings-authority-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "settings.json");
}

const DEFAULTS = { port: 49152, notifications: { enabled: true, minPriority: "high" }, hotkeys: { toggleOverlay: "A" } };

test("patches merge one level into notifications and hotkeys; the diff of two values is a patch", () => {
  const merged = mergeSettingsPatch(DEFAULTS, { notifications: { enabled: false }, hotkeys: { openDashboard: "B" }, port: 1 });
  assert.deepEqual(merged, { port: 1, notifications: { enabled: false, minPriority: "high" },
    hotkeys: { toggleOverlay: "A", openDashboard: "B" } });
  assert.deepEqual(settingsPatchBetween(DEFAULTS, merged), { port: 1, notifications: merged.notifications,
    hotkeys: merged.hotkeys });
  assert.deepEqual(settingsPatchBetween(merged, structuredClone(merged)), {});
});

test("the authority writes each patch onto the file's current value, so an edit made outside CCF survives", async (t) => {
  const file = temp(t);
  const authority = new SettingsAuthority({ store: new FileSettingsStore(file, DEFAULTS) });
  const changes = [];
  authority.on("change", (value, seq) => changes.push({ port: value.port, seq }));
  assert.equal((await authority.update({ port: 50000 }, { seq: 1 })).saved, true);
  // Another program edits the file (scripts and the relay read and write it).
  const external = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...external, hookRelayPort: 49151 }));
  const touched = new Date(Date.now() + 5000);
  fs.utimesSync(file, touched, touched);
  const result = await authority.update({ notifications: { enabled: false } }, { seq: 2 });
  assert.equal(result.value.hookRelayPort, 49151, "the patch went onto the revalidated file");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).notifications, { enabled: false, minPriority: "high" });
  assert.deepEqual(changes, [{ port: 50000, seq: 1 }, { port: 50000, seq: 2 }]);
});

test("watching pushes an outside edit once, and nothing while the file stays the same", async (t) => {
  const file = temp(t);
  fs.writeFileSync(file, JSON.stringify({ port: 1 }));
  const authority = new SettingsAuthority({ store: new FileSettingsStore(file, DEFAULTS), watchMs: 10 });
  t.after(() => authority.close());
  const pushed = [];
  authority.on("change", (value) => pushed.push(value.port));
  authority.watch();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(pushed, [], "an unchanged file is not pushed");
  fs.writeFileSync(file, JSON.stringify({ port: 2 }));
  const touched = new Date(Date.now() + 5000);
  fs.utimesSync(file, touched, touched);
  const deadline = Date.now() + 2000;
  while (!pushed.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(pushed, [2]);
});

test("a failed write keeps the value in memory, retries later and reports an unsaved close", async (t) => {
  const file = temp(t);
  let failing = true;
  const store = new FileSettingsStore(file, DEFAULTS);
  const realSave = store.save.bind(store);
  store.save = (value) => {
    if (failing) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    return realSave(value);
  };
  const scheduled = [];
  const timers = { setTimeout: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; },
    clearTimeout() {}, setInterval() {}, clearInterval() {} };
  const warnings = [];
  const authority = new SettingsAuthority({ store, timers, logger: { warn: (...args) => warnings.push(args), info() {} } });
  const result = await authority.update({ overlayVisible: false });
  assert.equal(result.saved, false);
  assert.equal(authority.load().overlayVisible, false, "reads see the unsaved value");
  assert.equal(authority.status().pending, true);
  await authority.update({ appShellMode: "mascot" });
  assert.equal(warnings.length, 1, "one warning per failure, not per write");
  assert.equal(scheduled[0].delay, 1000);
  failing = false;
  await scheduled.at(-1).callback();
  assert.equal(authority.status().pending, false);
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.overlayVisible, false);
  assert.equal(onDisk.appShellMode, "mascot");
  failing = true;
  await authority.update({ port: 1 });
  assert.equal(await authority.close(), false, "close reports settings it could not save");
});

function fakeClient() {
  const client = new EventEmitter();
  client.requests = [];
  client.request = (method, params) => new Promise((resolve, reject) => client.requests.push({ method, params, resolve, reject }));
  return client;
}

test("the mirror shows a patch at once, keeps it over older pushes and drops it once acknowledged", async () => {
  const client = fakeClient();
  const mirror = new SettingsMirror({ client, initial: { ...DEFAULTS } });
  const updating = mirror.update({ port: 2 });
  assert.equal(mirror.load().port, 2, "optimistic");
  assert.deepEqual(client.requests[0].params, { patch: { port: 2 }, seq: 1 });
  client.emit("settings", { value: { ...DEFAULTS, hookRelayPort: 9 }, seq: 0 });
  assert.equal(mirror.load().port, 2, "an older push does not undo a pending patch");
  assert.equal(mirror.load().hookRelayPort, 9, "and an outside edit still shows");
  client.requests[0].resolve({ saved: true, seq: 1, value: { ...DEFAULTS, hookRelayPort: 9, port: 2 } });
  await updating;
  assert.equal(mirror.pending.length, 0);
  client.emit("settings", { value: { ...DEFAULTS, port: 3 }, seq: 1 });
  assert.equal(mirror.load().port, 3);
  const copy = mirror.load();
  copy.port = 99;
  assert.equal(mirror.load().port, 3, "callers get a copy");
});

test("save(value) sends only what changed; a core that went away gets unacknowledged patches again", async () => {
  const client = fakeClient();
  const mirror = new SettingsMirror({ client, initial: { ...DEFAULTS } });
  assert.equal(await mirror.save({ ...DEFAULTS }), null, "nothing changed, nothing sent");
  const saving = mirror.save({ ...DEFAULTS, snoozeUntil: null, port: 7 });
  assert.deepEqual(client.requests[0].params.patch, { snoozeUntil: null, port: 7 });
  client.requests[0].reject(new ServiceError("The core service is closed (core exited).", "service_closed"));
  await assert.rejects(saving, /closed/);
  assert.equal(mirror.load().port, 7, "still shown while the core restarts");
  mirror.reset({ ...DEFAULTS, port: 49152 });
  assert.deepEqual(client.requests[1].params.patch, { snoozeUntil: null, port: 7 }, "sent again to the new core");
  assert.equal(mirror.load().port, 7);
  client.requests[1].resolve({ saved: false, seq: 2, error: "EPERM", value: { ...DEFAULTS, port: 7 } });
  assert.equal(await mirror.drain(), false, "drain reports the unsaved write");
});

// Review 2026-11-05 (P2): the core keeps an unsaved value and retries; once a retry lands, the mirror must stop reporting
// the old failure, or every quit after one held settings file looks unclean.
test("a write the core saved on retry no longer counts as unsaved in the mirror", async () => {
  const client = fakeClient();
  const mirror = new SettingsMirror({ client, initial: { ...DEFAULTS } });
  const updating = mirror.update({ port: 8 });
  client.requests[0].resolve({ saved: false, seq: 1, error: "EPERM", value: { ...DEFAULTS, port: 8 } });
  await updating;
  assert.equal(await mirror.drain(), false);
  client.emit("settings", { value: { ...DEFAULTS, port: 8 }, seq: 1, saved: true });
  assert.equal(await mirror.drain(), true, "the retry saved it");
  // A patch that never reached the core stays a failure, whatever the file's state.
  const failing = mirror.update({ port: 9 });
  client.requests[1].reject(new Error("settings.update: boom"));
  await assert.rejects(failing, /boom/);
  client.emit("settings", { value: { ...DEFAULTS, port: 8 }, seq: 1, saved: true });
  assert.equal(await mirror.drain(), false);
});

test("the authority pushes the saved state once a retry lands", async (t) => {
  const file = temp(t);
  let failing = true;
  const store = new FileSettingsStore(file, DEFAULTS);
  const realSave = store.save.bind(store);
  store.save = (value) => { if (failing) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); return realSave(value); };
  const scheduled = [];
  const timers = { setTimeout: (callback) => { scheduled.push(callback); return scheduled.length; }, clearTimeout() {} };
  const authority = new SettingsAuthority({ store, timers, logger: { warn() {}, info() {} } });
  const pushes = [];
  authority.on("change", (value, seq, saved) => pushes.push({ port: value.port, saved }));
  await authority.update({ port: 5 }, { seq: 1 });
  assert.deepEqual(pushes, [{ port: 5, saved: false }]);
  failing = false;
  await scheduled.at(-1)();
  assert.deepEqual(pushes.at(-1), { port: 5, saved: true }, "the retry's success is pushed even though the value is the same");
});
