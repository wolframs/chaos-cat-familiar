import { EventEmitter } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import headless from "@xterm/headless";
import { readTerminalScreen } from "./terminal-screen.js";

const { Terminal } = headless;

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 35;
const PHASES = new Set(["idle", "working", "attention", "offline"]);
const MAX_MESSAGES = 200;
const MAX_ASSISTANT_CHARS = 100_000;
const MAX_SEEN_EVENTS = 256;

export function companionLaunchSpec(repoPath) {
  if (typeof repoPath !== "string" || !repoPath.trim()) {
    throw new TypeError("A work-companion repository path is required.");
  }
  const cwd = path.win32.resolve(repoPath);
  return {
    file: "pwsh.exe",
    args: ["-NoLogo", "-NoProfile", "-File", path.win32.join(cwd, "start-companion.ps1"), "-Inner"],
    cwd,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS
  };
}

function sameWindowsPath(left, right) {
  return typeof left === "string" && typeof right === "string"
    && path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function findExistingCompanionSession(repoPath, {
  sessionsDirectory = path.win32.join(homedir(), ".claude", "sessions"),
  listFiles = readdir,
  loadFile = readFile,
  isProcessAlive = processIsAlive
} = {}) {
  let filenames;
  try {
    filenames = await listFiles(sessionsDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  for (const filename of filenames) {
    if (!filename.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(await loadFile(path.win32.join(sessionsDirectory, filename), "utf8"));
      if (!sameWindowsPath(entry.cwd, repoPath)) continue;
      if (!Number.isInteger(entry.pid) || entry.pid <= 0) continue;
      if (isProcessAlive(entry.pid)) return { pid: entry.pid, cwd: entry.cwd };
    } catch (error) {
      if (error?.code === "EACCES" || error?.code === "EPERM") throw error;
      // Stale or concurrently replaced Claude session metadata is harmless.
    }
  }
  return null;
}

export async function createNodePty(spec) {
  let module;
  try {
    module = await import("node-pty");
  } catch (error) {
    throw new Error("Interactive companion transport requires node-pty.", { cause: error });
  }
  const pty = module.default ?? module;
  return pty.spawn(spec.file, spec.args, {
    cwd: spec.cwd,
    cols: spec.cols,
    rows: spec.rows,
    name: "xterm-256color",
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", CCF_HOSTED_COMPANION: "1" },
    useConpty: true
  });
}

function sanitizeSubmission(text) {
  if (typeof text !== "string") throw new TypeError("Companion input must be text.");
  const cleaned = text.replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
  if (!cleaned.trim()) throw new Error("Companion input is empty.");
  return cleaned;
}

export class CompanionSession extends EventEmitter {
  constructor({ repoPath, ptyFactory = createNodePty,
    existingSessionProbe = findExistingCompanionSession, now = () => new Date(),
    timers = { setTimeout, clearTimeout } } = {}) {
    super();
    this.spec = companionLaunchSpec(repoPath);
    this.ptyFactory = ptyFactory;
    this.existingSessionProbe = existingSessionProbe;
    this.now = now;
    this.timers = timers;
    this.publicationTimer = null;
    this.closing = null;
    this.terminalRevision = 0;
    this.pty = null;
    this.terminal = null;
    this.starting = null;
    this.startAttempt = null;
    this.messageNumber = 0;
    this.seenAssistantEvents = new Set();
    this.disposables = [];
    this.snapshot = {
      connected: false,
      phase: "offline",
      title: "Work companion",
      messages: [],
      liveText: "",
      pendingPrompt: null,
      terminal: { needed: false, reason: "", screen: "", lines: [], history: [], cursor: { row: 0, column: 0 } }
    };
  }

  getSnapshot() {
    return {
      ...this.snapshot,
      messages: this.snapshot.messages.map((message) => ({ ...message })),
      terminal: {
        ...this.snapshot.terminal, cursor: { ...this.snapshot.terminal.cursor },
        lines: this.snapshot.terminal.lines.map((line) => line.map((run) => ({ ...run }))),
        history: this.snapshot.terminal.history.map((line) => line.map((run) => ({ ...run })))
      },
      pendingPrompt: this.snapshot.pendingPrompt && { ...this.snapshot.pendingPrompt }
    };
  }

  #changed() { this.emit("change", this.getSnapshot()); }

  async start({ userInitiated = false } = {}) {
    if (!userInitiated) throw new Error("Starting Claude Code requires an explicit user action.");
    if (this.pty) return this.getSnapshot();
    if (this.starting) return this.starting;
    const attempt = { cancelled: false };
    this.startAttempt = attempt;
    this.starting = this.#start(attempt);
    try { return await this.starting; }
    finally { this.starting = null; this.startAttempt = null; }
  }

  async #start(attempt) {
    if (this.closing) await this.closing;
    if (attempt.cancelled) return this.getSnapshot();
    const existing = await this.existingSessionProbe(this.spec.cwd);
    if (attempt.cancelled) return this.getSnapshot();
    if (existing) throw new Error(`Work companion is already running (PID ${existing.pid}).`);
    const pty = await this.ptyFactory(this.spec);
    if (!pty || typeof pty.write !== "function" || typeof pty.onData !== "function"
      || typeof pty.onExit !== "function") {
      throw new TypeError("The companion PTY adapter is invalid.");
    }
    if (attempt.cancelled) { pty.kill(); return this.getSnapshot(); }
    this.pty = pty;
    this.terminal = new Terminal({
      cols: this.spec.cols, rows: this.spec.rows, scrollback: 1000,
      allowProposedApi: true
    });
    this.snapshot.connected = true;
    this.snapshot.phase = "working";
    this.snapshot.liveText = "";
    this.snapshot.terminal = {
      needed: true, reason: "Interactive Claude Code session", screen: "", lines: [], history: [],
      cursor: { row: 0, column: 0 }, revision: ++this.terminalRevision
    };
    this.disposables = [
      pty.onData((chunk) => this.#onData(chunk)),
      pty.onExit((event) => this.#onExit(event, pty)),
      this.terminal.onData((response) => pty.write(response))
    ];
    this.#changed();
    return this.getSnapshot();
  }

  #onData(chunk) {
    if (!this.pty) return;
    const raw = String(chunk);
    const pty = this.pty;
    const terminal = this.terminal;
    terminal.write(raw, () => {
      if (this.pty !== pty) return;
      this.#schedulePublication(terminal, pty);
    });
    this.emit("data", raw);
  }

  #captureTerminal(terminal) {
    Object.assign(this.snapshot.terminal, readTerminalScreen(terminal), { revision: ++this.terminalRevision });
  }

  #schedulePublication(terminal = this.terminal, pty = this.pty) {
    if (this.publicationTimer !== null || !terminal || !pty) return;
    this.publicationTimer = this.timers.setTimeout(() => {
      if (this.terminal !== terminal || this.pty !== pty) return;
      this.publicationTimer = null;
      this.#captureTerminal(terminal);
      this.#changed();
    }, 33);
  }

  #onExit(event, pty = this.pty) {
    if (!pty || this.pty !== pty) return this.closing;
    this.pty = null;
    if (this.publicationTimer !== null) this.timers.clearTimeout(this.publicationTimer);
    this.publicationTimer = null;
    for (const disposable of this.disposables) disposable?.dispose?.();
    this.disposables = [];
    const terminal = this.terminal;
    // xterm writes are asynchronous. The barrier drains bytes accepted before
    // exit, including callbacks not yet reached when ConPTY reported shutdown.
    this.closing = new Promise((resolve) => terminal.write("", () => {
      try {
        this.#captureTerminal(terminal);
        this.snapshot.connected = false;
        this.snapshot.phase = "offline";
        this.snapshot.pendingPrompt = null;
        this.snapshot.terminal.needed = false;
        this.emit("exit", event);
        this.#changed();
      } finally {
        try { terminal.dispose(); }
        finally { this.terminal = null; resolve(); }
      }
    }));
    return this.closing;
  }

  #requirePty() {
    if (!this.pty) throw new Error("Work companion is not connected.");
    return this.pty;
  }

  updatePresentation({ phase, title, pendingPrompt } = {}) {
    if (phase !== undefined) {
      if (!PHASES.has(phase)) throw new TypeError("Invalid companion phase.");
      this.snapshot.phase = this.pty ? phase : "offline";
    }
    if (typeof title === "string" && title.trim()) this.snapshot.title = title.trim();
    if (pendingPrompt !== undefined) {
      this.snapshot.pendingPrompt = pendingPrompt && typeof pendingPrompt === "object"
        ? { kind: String(pendingPrompt.kind ?? "input"), label: String(pendingPrompt.label ?? "") }
        : null;
    }
    this.#changed();
  }

  #appendMessage(message) {
    this.snapshot.messages.push(message);
    if (this.snapshot.messages.length > MAX_MESSAGES) {
      this.snapshot.messages.splice(0, this.snapshot.messages.length - MAX_MESSAGES);
    }
  }

  recordAssistantMessage(text, { eventId } = {}) {
    if (typeof text !== "string" || !text.trim()) return false;
    const clean = text.trim().slice(0, MAX_ASSISTANT_CHARS);
    const key = eventId == null ? null : String(eventId);
    if (key && this.seenAssistantEvents.has(key)) return false;
    const last = this.snapshot.messages.at(-1);
    if (last?.role === "assistant" && last.text === clean) return false;
    if (key) {
      this.seenAssistantEvents.add(key);
      if (this.seenAssistantEvents.size > MAX_SEEN_EVENTS) {
        this.seenAssistantEvents.delete(this.seenAssistantEvents.values().next().value);
      }
    }
    this.#appendMessage({
      id: `assistant-${++this.messageNumber}`, role: "assistant", text: clean,
      timestamp: this.now().toISOString()
    });
    this.snapshot.liveText = "";
    this.snapshot.pendingPrompt = null;
    this.snapshot.phase = this.pty ? "idle" : "offline";
    this.#changed();
    return true;
  }

  send(text) {
    const pty = this.#requirePty();
    const clean = sanitizeSubmission(text);
    pty.write(`\x1b[200~${clean}\x1b[201~`);
    pty.write("\r");
    this.#appendMessage({
      id: `user-${++this.messageNumber}`, role: "user", text: clean,
      timestamp: this.now().toISOString()
    });
    this.snapshot.liveText = "";
    this.snapshot.phase = "working";
    this.#changed();
  }

  write(data) {
    if (typeof data !== "string" || !data) throw new TypeError("Terminal input must be nonempty text.");
    this.#requirePty().write(data);
  }

  interrupt() { this.#requirePty().write("\x03"); }

  resize(cols, rows) {
    if (!Number.isInteger(cols) || cols < 20 || !Number.isInteger(rows) || rows < 5) {
      throw new RangeError("Terminal dimensions are invalid.");
    }
    this.#requirePty().resize(cols, rows);
    this.terminal?.resize(cols, rows);
    this.spec.cols = cols;
    this.spec.rows = rows;
    this.#schedulePublication();
  }

  async stop() {
    if (this.starting) {
      this.startAttempt.cancelled = true;
      try { await this.starting; } catch { /* A failed start leaves no PTY to stop. */ }
    }
    if (!this.pty) return this.closing;
    const pty = this.pty;
    pty.kill();
    if (this.pty === pty) this.#onExit({ exitCode: null, signal: "stopped" }, pty);
    await this.closing;
  }
}
