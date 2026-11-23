import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeRegistryLiveness, claudeSessionStatus, hasPendingBackgroundWork, liveClaudeSessionIds, processAlive,
  transcriptUnder, windowsProcessStartTimes } from "../services/claude-session-status.js";
import { lastPromptIsMaintenance } from "../services/claude-transcript.js";
import { companionIdleNotice } from "../core/core-composition.js";
import { ElectronNotificationService } from "../services/platform-services.js";

const files = {
  "100.json": JSON.stringify({ sessionId: "orchestrator", status: "shell" }),
  "200.json": JSON.stringify({ sessionId: "waiting-on-you", status: "idle" }),
  "300.json": "{ half written"
};
const io = { dir: "X", readdir: () => Object.keys(files), readFile: (p) => files[p.split(/[\\/]/).pop()] };

test("reads the status of the matching Claude session, skipping broken files", () => {
  assert.equal(claudeSessionStatus("orchestrator", io), "shell");
  assert.equal(claudeSessionStatus("waiting-on-you", io), "idle");
  assert.equal(claudeSessionStatus("gone", io), null);
  assert.equal(claudeSessionStatus("x", { ...io, readdir: () => { throw new Error("no dir"); } }), null);
  assert.equal(hasPendingBackgroundWork("orchestrator", io), true);
  assert.equal(hasPendingBackgroundWork("waiting-on-you", io), false);
});

class FakeToast {
  static shown = [];
  static isSupported() { return true; }
  constructor(options) { this.options = options; }
  on() {}
  show() { FakeToast.shown.push(this.options.title); }
}

test("an idle alert from a session with background work shows no toast; other alerts still do", async () => {
  FakeToast.shown = [];
  const service = new ElectronNotificationService(FakeToast, null, null,
    () => ({ enabled: true, minPriority: "high" }),
    { hasPendingBackgroundWork: (id) => hasPendingBackgroundWork(id, io) });
  await service.notify({ title: "Claude is Waiting", category: "idle_alert", priority: "high", sessionId: "orchestrator" });
  await service.notify({ title: "Waiting for you", category: "idle_alert", priority: "high", sessionId: "waiting-on-you" });
  await service.notify({ title: "Permission Required", category: "permission_request", priority: "urgent", sessionId: "orchestrator" });
  assert.deepEqual(FakeToast.shown, ["Waiting for you", "Permission Required"]);
});

function fakeRegistry(registry, mtimes = {}) {
  const nameOf = (p) => p.split(/[\\/]/).pop();
  const missing = () => Object.assign(new Error("gone"), { code: "ENOENT" });
  return { readdir: async () => Object.keys(registry),
    readFile: async (p) => { const value = registry[nameOf(p)]; if (value === undefined) throw missing();
      if (value instanceof Error) throw value; return value; },
    stat: async (p) => { if (!(nameOf(p) in registry)) throw missing(); return { mtimeMs: mtimes[nameOf(p)] ?? 0 }; } };
}
const FT = (ms) => (BigInt(ms) + 11_644_473_600_000n) * 10_000n;   // epoch ms -> FILETIME

test("live session ids: registry files whose process runs", async () => {
  const registry = {
    "1.json": JSON.stringify({ sessionId: "alive", pid: 1 }),
    "2.json": JSON.stringify({ sessionId: "crashed", pid: 2 }),
    "3.d0da.key": "not a record"
  };
  const fsp = fakeRegistry(registry);
  const pidAlive = (pid) => pid === 1;
  assert.deepEqual([...await liveClaudeSessionIds({ dir: "X", fsp, pidAlive })], ["alive"]);
  assert.equal(await liveClaudeSessionIds({ dir: "X", fsp: { ...fsp, readdir: async () => { throw new Error("no dir"); } }, pidAlive }), null);
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(0), false);
  assert.equal(processAlive("12"), false);
});

test("one bad registry file does not stop the sweep, and never ends a session it may belong to (review 2, finding 3)", async () => {
  const registry = { "1.json": JSON.stringify({ sessionId: "alive", pid: 1 }), "2.json": JSON.stringify({ sessionId: "busy", pid: 2 }) };
  const fsp = fakeRegistry(registry);
  const liveness = new ClaudeRegistryLiveness({ dir: "X", fsp, pidAlive: (pid) => pid !== 9, sleep: async () => {},
    processStartTimes: async () => { throw new Error("no PowerShell in this test"); } });
  assert.deepEqual([...await liveness.liveIds()].sort(), ["alive", "busy"]);
  // A crash's leftover: truncated JSON, its pid gone. Ignored; the rest is decided.
  registry["9.json"] = "{ half writ";
  assert.deepEqual([...await liveness.liveIds()].sort(), ["alive", "busy"]);
  // A live session's file caught mid-rewrite (or held by a scanner) on both tries: its last good read stands.
  registry["2.json"] = Object.assign(new Error("busy"), { code: "EBUSY" });
  assert.deepEqual([...await liveness.liveIds()].sort(), ["alive", "busy"]);
  // A transient failure: the retry reads it.
  let fails = 1;
  const flaky = { ...fsp, readFile: async (p) => (p.endsWith("2.json") && fails-- > 0
    ? Promise.reject(Object.assign(new Error("locked"), { code: "EPERM" })) : fsp.readFile(p)) };
  registry["2.json"] = JSON.stringify({ sessionId: "busy", pid: 2 });
  delete registry["9.json"];
  assert.deepEqual([...await new ClaudeRegistryLiveness({ dir: "X", fsp: flaky, pidAlive: () => true, sleep: async () => {},
    processStartTimes: async () => { throw new Error("not asked"); } }).liveIds()].sort(),
    ["alive", "busy"]);
  // A live pid's file never read since start: whose it is is unknown, so nothing is decided this round...
  const fresh = new ClaudeRegistryLiveness({ dir: "X", fsp: fakeRegistry({ ...registry, "5.json": "{ half" }, { "5.json": 1000 }),
    pidAlive: () => true, sleep: async () => {}, processStartTimes: async () => new Map([[5, FT(500)]]) });
  assert.equal(await fresh.liveIds(), null);
  // ...unless the file was last written before that process started (the pid was reused after a crash).
  const stale = new ClaudeRegistryLiveness({ dir: "X", fsp: fakeRegistry({ ...registry, "5.json": "{ half" }, { "5.json": 1000 }),
    pidAlive: () => true, sleep: async () => {}, processStartTimes: async () => new Map([[5, FT(3_600_000)]]) });
  assert.deepEqual([...await stale.liveIds()].sort(), ["alive", "busy"]);
});

test("a reused pid is not the session: procStart against the process's start (review 2, finding 2)", async () => {
  const start = FT(1_794_916_034_000);
  const registry = { "7.json": JSON.stringify({ sessionId: "s7", pid: 7, procStart: String(start) }),
    "8.json": JSON.stringify({ sessionId: "s8", pid: 8, procStart: String(start) }) };
  let now = 0;
  const asked = [];
  const times = new Map([[7, start + 10_000n], [8, start + 3600n * 10_000_000n]]);   // 7: same process, 8: another one
  const liveness = new ClaudeRegistryLiveness({ dir: "X", fsp: fakeRegistry(registry), pidAlive: () => true, now: () => now,
    processStartTimes: async (pids) => { asked.push(pids); return times; } });
  assert.deepEqual([...await liveness.liveIds({ candidates: new Set(["s7", "s8"]) })], ["s7"]);
  assert.deepEqual(asked, [[7, 8]], "one PowerShell start for all candidates");
  assert.deepEqual([...await liveness.liveIds({ candidates: new Set(["s7", "s8"]) })], ["s7"]);
  assert.equal(asked.length, 1, "a match is trusted for recheckMs, a mismatch remembered");
  now += 16 * 60_000;
  await liveness.liveIds({ candidates: new Set(["s7", "s8"]) });
  assert.deepEqual(asked.at(-1), [7], "the match is checked again after recheckMs");
  // Not a candidate: no check at all. A failed check: live.
  assert.deepEqual([...await liveness.liveIds({ candidates: new Set() })].sort(), ["s7", "s8"]);
  const failing = new ClaudeRegistryLiveness({ dir: "X", fsp: fakeRegistry(registry), pidAlive: () => true,
    processStartTimes: async () => { throw new Error("timeout"); } });
  assert.deepEqual([...await failing.liveIds({ candidates: new Set(["s7", "s8"]) })].sort(), ["s7", "s8"]);
  // A start time that could not be read (access denied): live.
  const unread = new ClaudeRegistryLiveness({ dir: "X", fsp: fakeRegistry(registry), pidAlive: () => true,
    processStartTimes: async () => new Map([[7, null], [8, null]]) });
  assert.deepEqual([...await unread.liveIds({ candidates: new Set(["s7", "s8"]) })].sort(), ["s7", "s8"]);
});

test("the process start reader parses PowerShell's lines; the real one finds this process", async () => {
  const fake = async () => ({ stdout: "7|134393896307375697\r\n8|?\r\nnoise\r\n" });
  const times = await windowsProcessStartTimes([7, 8, 9], { execFile: fake });
  assert.deepEqual([...times], [[7, 134393896307375697n], [8, null]]);
  assert.deepEqual([...await windowsProcessStartTimes([0, -1, "x"])], [], "no valid pid: no process start");
  if (process.platform === "win32") {
    const mine = (await windowsProcessStartTimes([process.pid])).get(process.pid);
    const startedMs = Number(mine / 10_000n) - 11_644_473_600_000;
    assert.ok(Math.abs(startedMs - (Date.now() - process.uptime() * 1000)) < 10_000, "within seconds of this process's start");
  }
});

test("a session belongs to the registry of the config dir its transcript lies under (review 2, finding 1)", () => {
  const home = path.join(os.tmpdir(), "home");
  const claude = path.join(home, ".claude");
  assert.equal(transcriptUnder(path.join(claude, "projects", "p", "s.jsonl"), claude), true);
  assert.equal(transcriptUnder("/home/dev/.claude/projects/p/s.jsonl", claude), false, "WSL");
  assert.equal(transcriptUnder(path.join(home, "other-profile", "projects", "p", "s.jsonl"), claude), false);
  assert.equal(transcriptUnder(path.join(claude, "projects-old", "s.jsonl"), claude), false);
  assert.equal(transcriptUnder(null, claude), false);
  if (process.platform === "win32") assert.equal(transcriptUnder(path.join(claude, "projects", "p", "s.jsonl").toUpperCase(), claude), true);
});

test("the transcript's last prompt tells a cache-warm turn from a real one (review 2, finding 4)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-transcript-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "s.jsonl");
  const line = (entry) => JSON.stringify(entry);
  const user = (content, extra = {}) => line({ type: "user", message: { role: "user", content }, ...extra });
  const assistant = (text) => line({ type: "assistant", message: { content: [{ type: "text", text }] } });
  const write = (...lines) => fs.writeFileSync(file, lines.join("\n") + "\n");
  write(user("fix it"), assistant("done"),
    user("[Cache warm maintenance] keep the cache", { origin: { kind: "plugin", name: "cache-warm" } }), assistant("warm"));
  assert.equal(await lastPromptIsMaintenance(file), true);
  write(user("[Cache warm maintenance] x"), assistant("warm"), user("what now?"),
    assistant("Running."), user([{ type: "tool_result", tool_use_id: "t", content: "ok" }]),
    user("<system-reminder>hook context</system-reminder>"), user("meta", { isMeta: true }),
    user("side", { isSidechain: true }), assistant("Here."));
  assert.equal(await lastPromptIsMaintenance(file), false);
  write(user("[Cache warm maintenance] x"), user("<task-notification><tool-use-id>t</tool-use-id>"), assistant("Agent done."));
  assert.equal(await lastPromptIsMaintenance(file), false, "a background task's report starts a real turn");
  write(assistant("no prompt in the tail"));
  assert.equal(await lastPromptIsMaintenance(file), null);
  assert.equal(await lastPromptIsMaintenance(path.join(dir, "missing.jsonl")), null);
  write(user("x".repeat(400)), user("[Cache warm maintenance] y"), assistant("warm"));
  assert.equal(await lastPromptIsMaintenance(file, { tailBytes: 200 }), true, "the tail's cut first line is skipped");
});

test("the hosted companion's idle alert says it has no watcher; others stay as they are", () => {
  const alert = { category: "idle_alert", title: "Claude is Waiting", body: "idle" };
  const settings = { companionRepoPath: "C:/Users/x/repos/work-companion" };
  const companion = companionIdleNotice(alert, { projectDir: "c:/users/x/repos/work-companion" }, settings);
  assert.equal(companion.title, "Companion idle without its watcher");
  assert.equal(alert.title, "Claude is Waiting", "the original stays untouched");
  assert.equal(companionIdleNotice(alert, { projectDir: "C:/Users/x/repos/project-1" }, settings), alert);
  const stop = { category: "session_lifecycle", title: "Claude Finished" };
  assert.equal(companionIdleNotice(stop, { projectDir: "C:/Users/x/repos/work-companion" }, settings), stop);
  assert.equal(companionIdleNotice(alert, null, settings), alert);
});
