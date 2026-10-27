import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  CompanionSession, companionLaunchSpec, findExistingCompanionSession
} from "../services/companion-session.js";

class FakePty extends EventEmitter {
  writes = [];
  sizes = [];
  killed = false;

  write(value) { this.writes.push(value); }
  onData(handler) { this.on("data", handler); return { dispose: () => this.off("data", handler) }; }
  onExit(handler) { this.on("exit", handler); return { dispose: () => this.off("exit", handler) }; }
  resize(cols, rows) { this.sizes.push([cols, rows]); }
  kill() { this.killed = true; this.emit("exit", { exitCode: 0 }); }
}

function screenWhen(session, expected) {
  if (session.getSnapshot().terminal.screen === expected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.off("change", onChange);
      reject(new Error(`Terminal screen did not become ${JSON.stringify(expected)}`));
    }, 500);
    function onChange(snapshot) {
      if (snapshot.terminal.screen !== expected) return;
      clearTimeout(timer);
      session.off("change", onChange);
      resolve();
    }
    session.on("change", onChange);
  });
}

function publicationTimers() {
  let next = 0;
  const callbacks = new Map();
  return {
    setTimeout(callback, delay) { assert.equal(delay, 33); callbacks.set(++next, callback); return next; },
    clearTimeout(id) { callbacks.delete(id); },
    get pending() { return callbacks.size; },
    flush() { const work = [...callbacks.values()]; callbacks.clear(); for (const callback of work) callback(); }
  };
}

test("a burst parses immediately but publishes one screen per frame and retains the final burst on exit", async () => {
  const pty = new FakePty();
  const timers = publicationTimers();
  const session = new CompanionSession({ repoPath: "C:\\companion", ptyFactory: async () => pty,
    existingSessionProbe: async () => null, timers });
  const snapshots = [];
  session.on("change", (snapshot) => snapshots.push(snapshot));
  await session.start({ userInitiated: true });
  snapshots.length = 0;
  for (let index = 0; index < 120; index++) pty.emit("data", `\r\x1b[2Kchunk ${index}`);
  await new Promise((resolve) => session.terminal.write("", resolve));
  assert.equal(session.terminal.buffer.active.getLine(0).translateToString(true), "chunk 119", "parser runs before publication");
  assert.equal(snapshots.length, 0);
  assert.equal(timers.pending, 1);
  timers.flush();
  assert.equal(snapshots.length, 1, "120 PTY chunks need one snapshot, not 120");
  assert.equal(snapshots[0].terminal.screen, "chunk 119");
  const revision = snapshots[0].terminal.revision;
  pty.emit("data", "\x1b[6n");
  await new Promise((resolve) => session.terminal.write("", resolve));
  assert.ok(pty.writes.some((value) => /^\x1b\[\d+;\d+R$/.test(value)), "terminal query responses never wait for a publication frame");
  session.updatePresentation({ phase: "attention", pendingPrompt: { kind: "approval", label: "Choose" } });
  assert.equal(snapshots.at(-1).pendingPrompt.label, "Choose", "attention metadata publishes immediately");
  assert.equal(snapshots.at(-1).terminal.revision, revision);
  pty.emit("data", "\r\x1b[2K\x1b[31mFinal bytes\x1b[0m");
  await session.stop();
  assert.equal(snapshots.at(-1).connected, false);
  assert.equal(snapshots.at(-1).terminal.screen, "Final bytes", "exit drains writes accepted before PTY termination");
  assert.equal(snapshots.at(-1).terminal.lines[0][0].foreground, "#cd3131");
  assert.ok(snapshots.at(-1).terminal.revision > revision);
  assert.equal(timers.pending, 0);
});

test("resize publishes reflow without another PTY chunk and stale frame callbacks cannot repaint a restarted session", async () => {
  const timers = publicationTimers();
  const first = new FakePty();
  const second = new FakePty();
  let spawns = 0;
  const session = new CompanionSession({ repoPath: "C:\\companion", ptyFactory: async () => ++spawns === 1 ? first : second,
    existingSessionProbe: async () => null, timers });
  await session.start({ userInitiated: true });
  first.emit("data", `${"A".repeat(60)}\r\n`);
  await new Promise((resolve) => session.terminal.write("", resolve));
  timers.flush();
  const before = session.getSnapshot().terminal.revision;
  session.resize(20, 5);
  assert.equal(timers.pending, 1);
  timers.flush();
  assert.equal(session.getSnapshot().terminal.lines.length, 3);
  assert.ok(session.getSnapshot().terminal.revision > before);
  first.emit("data", "OLD");
  await new Promise((resolve) => session.terminal.write("", resolve));
  assert.equal(timers.pending, 1);
  const stopping = session.stop();
  const starting = session.start({ userInitiated: true });
  await Promise.all([stopping, starting]);
  second.emit("data", "NEW");
  await new Promise((resolve) => session.terminal.write("", resolve));
  timers.flush();
  assert.equal(session.getSnapshot().terminal.screen, "NEW");
  assert.equal(session.getSnapshot().connected, true);
  await session.stop();
});

test("stop cancels a pending factory and cannot leave a newly spawned PTY alive", async () => {
  const pty = new FakePty();
  let release;
  let factoryEntered;
  const entered = new Promise((resolve) => { factoryEntered = resolve; });
  const session = new CompanionSession({ repoPath: "C:\\companion", existingSessionProbe: async () => null,
    ptyFactory: async () => { factoryEntered(); return new Promise((resolve) => { release = () => resolve(pty); }); } });
  const starting = session.start({ userInitiated: true });
  await entered;
  const stopping = session.stop();
  release();
  let timeout;
  try {
    await Promise.race([Promise.all([starting, stopping]), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("pending start did not settle after factory resolution")), 500);
    })]);
    assert.equal(pty.killed, true);
    assert.equal(session.getSnapshot().connected, false);
    assert.equal(session.terminal, null);
  } finally { clearTimeout(timeout); await session.stop(); }
});

test("launch spec runs the existing companion's Inner path without a terminal tab", () => {
  const spec = companionLaunchSpec("C:\\Users\\dev\\repos\\work-companion");
  assert.equal(spec.file, "pwsh.exe");
  assert.deepEqual(spec.args, [
    "-NoLogo", "-NoProfile", "-File",
    "C:\\Users\\dev\\repos\\work-companion\\start-companion.ps1", "-Inner"
  ]);
  assert.equal(spec.cwd, "C:\\Users\\dev\\repos\\work-companion");
});

test("companion never spawns without an explicit user start and refuses an existing session", async () => {
  let spawnCount = 0;
  const session = new CompanionSession({
    repoPath: "C:\\companion",
    ptyFactory: async () => { spawnCount += 1; return new FakePty(); },
    existingSessionProbe: async () => ({ pid: 123 })
  });
  assert.equal(session.getSnapshot().connected, false);
  await assert.rejects(session.start(), /explicit user action/);
  await assert.rejects(session.start({ userInitiated: true }), /already running/);
  assert.equal(spawnCount, 0);
});

test("session probe ignores stale and unrelated Claude sessions", async () => {
  const files = {
    "stale.json": JSON.stringify({ cwd: "C:\\companion", pid: 100 }),
    "other.json": JSON.stringify({ cwd: "C:\\different", pid: 200 }),
    "active.json": JSON.stringify({ cwd: "c:\\COMPANION\\", pid: 300 }),
    "broken.json": "{"
  };
  const found = await findExistingCompanionSession("C:\\companion", {
    sessionsDirectory: "C:\\sessions",
    listFiles: async () => Object.keys(files),
    loadFile: async (filename) => files[filename.split("\\").at(-1)],
    isProcessAlive: (pid) => pid === 300
  });
  assert.deepEqual(found, { pid: 300, cwd: "c:\\COMPANION\\" });
});

test("concurrent explicit starts share one PTY and sanitize submitted controls", async () => {
  let spawns = 0;
  const pty = new FakePty();
  const session = new CompanionSession({
    repoPath: "C:\\companion",
    ptyFactory: async () => { spawns += 1; return pty; },
    existingSessionProbe: async () => null
  });
  await Promise.all([
    session.start({ userInitiated: true }),
    session.start({ userInitiated: true })
  ]);
  assert.equal(spawns, 1);
  session.send("hello\x1b[2J\r\nworld");
  assert.deepEqual(pty.writes, ["\x1b[200~hello[2J\nworld\x1b[201~", "\r"]);
  await session.stop();
});

test("terminal snapshot follows cursor-positioned screen repaints", async () => {
  const pty = new FakePty();
  const session = new CompanionSession({
    repoPath: "C:\\companion", ptyFactory: async () => pty,
    existingSessionProbe: async () => null
  });
  await session.start({ userInitiated: true });
  pty.emit("data", "Old answer");
  await screenWhen(session, "Old answer");
  pty.emit("data", "\x1b[2J\x1b[HNew answer");
  await screenWhen(session, "New answer");
  assert.equal(session.getSnapshot().terminal.screen, "New answer");
  assert.equal(session.getSnapshot().liveText, "", "TUI repaint is not an assistant reply");
  assert.deepEqual(session.getSnapshot().terminal.cursor, { row: 0, column: 10 });
  await session.stop();
});

test("fake PTY styled screen survives repaint and snapshots cannot mutate terminal styles", async () => {
  const pty = new FakePty();
  const session = new CompanionSession({
    repoPath: "C:\\companion", ptyFactory: async () => pty,
    existingSessionProbe: async () => null
  });
  await session.start({ userInitiated: true });
  try {
    pty.emit("data", "\x1b[31mRed\x1b[0m \x1b[38;5;196m256\x1b[0m \x1b[38;2;12;34;56mRGB\x1b[0m");
    await screenWhen(session, "Red 256 RGB");
    const first = session.getSnapshot();
    assert.deepEqual(first.terminal.lines[0].filter((run) => run.foreground).map((run) => run.foreground),
      ["#cd3131", "#ff0000", "#0c2238"]);
    first.terminal.lines[0][0].foreground = "#ffffff";
    first.terminal.lines[0].push({ text: "mutated" });
    first.terminal.lines.push([]);
    assert.equal(session.getSnapshot().terminal.lines.length, 1);
    assert.equal(session.getSnapshot().terminal.lines[0][0].foreground, "#cd3131");
    assert.equal(session.getSnapshot().terminal.lines[0].at(-1).text, "RGB");
    pty.emit("data", "\x1b[H\x1b[38;5;46mNew\x1b[0m");
    await screenWhen(session, "New 256 RGB");
    assert.equal(session.getSnapshot().terminal.lines[0][0].foreground, "#00ff00");
    assert.equal(session.getSnapshot().terminal.lines[0][0].text, "New");
  } finally { await session.stop(); }
});

test("Stop-hook assistant text enters bounded conversation once per event", async () => {
  const session = new CompanionSession({
    repoPath: "C:\\companion", ptyFactory: async () => new FakePty(),
    existingSessionProbe: async () => null,
    now: () => new Date("2026-10-20T12:00:00Z")
  });
  await session.start({ userInitiated: true });
  session.send("What changed?");
  assert.equal(session.recordAssistantMessage(" First reply ", { eventId: "stop-1" }), true);
  assert.equal(session.recordAssistantMessage(" First reply ", { eventId: "stop-1" }), false);
  assert.equal(session.recordAssistantMessage("First reply"), false);
  assert.deepEqual(session.getSnapshot().messages.map(({ role, text }) => [role, text]), [
    ["user", "What changed?"], ["assistant", "First reply"]
  ]);
  assert.equal(session.getSnapshot().phase, "idle");
  assert.equal(session.getSnapshot().liveText, "");
  session.send("Again?");
  assert.equal(session.recordAssistantMessage("First reply", { eventId: "stop-2" }), true,
    "identical answer after a new user turn is valid");
  assert.equal(session.recordAssistantMessage("  ", { eventId: "empty" }), false);
  for (let index = 0; index < 210; index += 1) session.send(`Question ${index}`);
  assert.equal(session.getSnapshot().messages.length, 200);
  assert.equal(session.getSnapshot().messages.at(-1).text, "Question 209");
  await session.stop();
});

test("hook-derived phase and title can refine the PTY presentation", async () => {
  const session = new CompanionSession({
    repoPath: "C:\\companion", ptyFactory: async () => new FakePty(),
    existingSessionProbe: async () => null
  });
  await session.start({ userInitiated: true });
  session.updatePresentation({ phase: "idle", title: "Status der drei Tickets" });
  assert.equal(session.getSnapshot().phase, "idle");
  assert.equal(session.getSnapshot().title, "Status der drei Tickets");
  session.updatePresentation({ phase: "attention", pendingPrompt: { kind: "question", label: "Choose one" } });
  assert.deepEqual(session.getSnapshot().pendingPrompt, { kind: "question", label: "Choose one" });
  assert.throws(() => session.updatePresentation({ phase: "unknown" }), /invalid companion phase/i);
  await session.stop();
});

test("user-started companion streams data, sends multiline input and interrupts through PTY", async () => {
  const pty = new FakePty();
  const session = new CompanionSession({
    repoPath: "C:\\companion",
    ptyFactory: async () => pty,
    existingSessionProbe: async () => null,
    now: () => new Date("2026-10-20T12:00:00Z")
  });
  const chunks = [];
  session.on("data", (chunk) => chunks.push(chunk));
  await session.start({ userInitiated: true });
  assert.equal(session.getSnapshot().connected, true);
  pty.emit("data", "Thinking…");
  await screenWhen(session, "Thinking…");
  assert.deepEqual(chunks, ["Thinking…"]);
  assert.equal(session.getSnapshot().liveText, "");
  session.send("First line\nsecond line");
  assert.deepEqual(pty.writes, ["\x1b[200~First line\nsecond line\x1b[201~", "\r"]);
  session.interrupt();
  assert.equal(pty.writes.at(-1), "\x03");
  session.resize(100, 35);
  assert.deepEqual(pty.sizes, [[100, 35]]);
  await session.stop();
  assert.equal(pty.killed, true);
  assert.equal(session.getSnapshot().connected, false);
});
