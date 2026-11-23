import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { SidePanelFeed, sidePanelPath } from "../services/side-panel-feed.js";
import { PANEL_SCHEMA } from "../renderer/companion-panel-model.js";

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimeout(callback, ms) { const id = next++; pending.set(id, { callback, ms }); return id; },
    clearTimeout(id) { pending.delete(id); }
  };
}

function panel(text = "#123 Example ticket", extra = {}) {
  return JSON.stringify({ schema: PANEL_SCHEMA, generatedAt: "2026-11-17T16:47:03+01:00", ...extra,
    sections: [{ id: "on-you", title: "On you", items: [{ id: "a", text }] }] });
}

function fixture(t, { clock = Date.now(), wrap = (api) => api } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-panel-feed-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state", "panel.json");
  fs.mkdirSync(path.dirname(file));
  const timers = fakeTimers();
  const updates = [];
  const reads = { stat: 0, readFile: 0 };
  const counted = { stat: (...args) => { reads.stat++; return fsp.stat(...args); },
    readFile: (...args) => { reads.readFile++; return fsp.readFile(...args); } };
  const state = { now: clock, path: file };
  const feed = new SidePanelFeed({ resolvePath: () => state.path, fsp: wrap(counted), timers, now: () => state.now,
    onUpdate: (snapshot) => updates.push(snapshot) });
  t.after(() => feed.stop());
  const tick = async () => { await feed.poll(); return feed.snapshot(); };
  // Writes with an mtime well in the past, so the young-file retry stays out of the way unless a test wants it.
  const write = (text, ageMs = 60_000) => {
    fs.writeFileSync(file, text);
    const at = new Date(state.now - ageMs);
    fs.utimesSync(file, at, at);
  };
  return { dir, file, feed, timers, updates, reads, state, tick, write };
}

test("the file lives in the companion folder's state/ unless sidePanelFile names another", () => {
  const home = path.resolve("/home/me");
  assert.equal(sidePanelPath({ companionRepoPath: path.resolve("/repos/wc") }, home), path.join(path.resolve("/repos/wc"), "state", "panel.json"));
  assert.equal(sidePanelPath({ companionRepoPath: path.resolve("/repos/wc"), companionDataPath: path.resolve("/data/wc") }, home),
    path.join(path.resolve("/data/wc"), "state", "panel.json"));
  assert.equal(sidePanelPath({}, home), path.join(home, "repos", "work-companion", "state", "panel.json"));
  assert.equal(sidePanelPath({ sidePanelFile: path.resolve("/x/p.json") }, home), path.resolve("/x/p.json"));
  assert.equal(sidePanelPath({ sidePanelFile: "relative/p.json" }, home), null);
  assert.equal(sidePanelPath({ companionRepoPath: "relative" }, home), null);
});

test("unconfigured, missing, ok and invalid", async (t) => {
  const f = fixture(t);
  f.state.path = null;
  f.feed.start();
  await f.feed.idle();
  assert.equal(f.feed.snapshot().status, "unconfigured");
  f.state.path = f.file;
  f.feed.setPath();
  assert.equal((await f.tick()).status, "missing");
  f.write(panel());
  let snapshot = await f.tick();
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.panel.sections[0].items[0].text, "#123 Example ticket");
  assert.equal(snapshot.file, f.file);
  f.write("{ not json");
  snapshot = await f.tick();
  assert.equal(snapshot.status, "invalid");
  assert.match(snapshot.error, /JSON|token|position/i);
  assert.deepEqual(f.updates.map((item) => item.status), ["unconfigured", "missing", "ok", "invalid"]);
});

test("reads only when mtime or size changed, and picks up an atomic replace", async (t) => {
  const f = fixture(t);
  f.write(panel());
  await f.tick();
  await f.tick();
  await f.tick();
  assert.equal(f.reads.readFile, 1);
  assert.equal(f.reads.stat, 3);
  assert.equal(f.updates.length, 1, "an unchanged file sends nothing");
  const temporary = `${f.file}.tmp`;
  fs.writeFileSync(temporary, panel("#456 Replaced"));
  fs.utimesSync(temporary, new Date(f.state.now - 30_000), new Date(f.state.now - 30_000));
  fs.renameSync(temporary, f.file);
  const snapshot = await f.tick();
  assert.equal(snapshot.panel.sections[0].items[0].text, "#456 Replaced");
  assert.equal(f.reads.readFile, 2);
});

test("a fresh partial file is read again once before it counts as invalid", async (t) => {
  const f = fixture(t);
  f.write(panel());
  await f.tick();
  f.write("{\"schema\":", 500);
  let snapshot = await f.tick();
  assert.equal(snapshot.status, "ok", "a writer caught mid-replace gets one more poll");
  snapshot = await f.tick();
  assert.equal(snapshot.status, "invalid");
  assert.equal(f.reads.readFile, 3);
});

test("a read that fails on a lock is retried at the next poll, though the file did not change", async (t) => {
  const lock = { on: false };
  const f = fixture(t, { wrap: (api) => ({ ...api, readFile: async (...args) => {
    if (lock.on) { throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }); }
    return api.readFile(...args);
  } }) });
  f.write(panel("#1 good"));
  await f.tick();
  f.write(panel("#2 changed"));
  lock.on = true;
  let snapshot = await f.tick();
  assert.equal(snapshot.status, "invalid");
  assert.match(snapshot.error, /EBUSY/);
  lock.on = false;
  snapshot = await f.tick();
  assert.equal(snapshot.status, "ok", "the unchanged file is read again once the lock is gone");
  assert.equal(snapshot.panel.sections[0].items[0].text, "#2 changed");
});

test("a file over 64 KiB is invalid without being read", async (t) => {
  const f = fixture(t);
  f.write(panel("x", { pad: "y".repeat(65 * 1024) }));
  const snapshot = await f.tick();
  assert.equal(snapshot.status, "invalid");
  assert.match(snapshot.error, /64 KiB/);
  assert.equal(f.reads.readFile, 0);
});

test("the last good panel stays through invalid and missing", async (t) => {
  const f = fixture(t);
  f.write(panel("#1 good"));
  await f.tick();
  f.write(JSON.stringify({ schema: "other" }));
  let snapshot = await f.tick();
  assert.equal(snapshot.status, "invalid");
  assert.match(snapshot.error, /schema/);
  assert.equal(snapshot.panel.sections[0].items[0].text, "#1 good");
  fs.rmSync(f.file);
  snapshot = await f.tick();
  assert.equal(snapshot.status, "missing");
  assert.equal(snapshot.panel.sections[0].items[0].text, "#1 good");
  f.write(panel("#2 back"));
  assert.equal((await f.tick()).panel.sections[0].items[0].text, "#2 back");
});

test("polls every intervalMs while started, and stop() leaves no timer", async (t) => {
  const f = fixture(t);
  f.write(panel());
  f.feed.start();
  f.feed.start();
  await f.feed.idle();
  assert.equal(f.timers.pending.size, 1);
  assert.equal([...f.timers.pending.values()][0].ms, 2000);
  const [[id, { callback }]] = f.timers.pending;
  f.timers.pending.delete(id);
  callback();
  f.feed.stop();
  await f.feed.idle();
  assert.equal(f.timers.pending.size, 0, "a poll that finishes after stop() schedules nothing");
  assert.equal(f.reads.stat, 2);
});

test("one poll in flight at a time", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { wrap: (api) => ({ ...api, stat: async (...args) => { await gate; return api.stat(...args); } }) });
  f.write(panel());
  const first = f.feed.poll();
  const second = f.feed.poll();
  assert.equal(first, second);
  release();
  await first;
  assert.equal(f.reads.stat, 1);
  assert.equal(f.feed.snapshot().status, "ok");
});
