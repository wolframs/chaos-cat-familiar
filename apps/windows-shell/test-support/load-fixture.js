// Load fixture (process-split plan, step 1): the runtime under the load that hung the cat on 2026-11-04/05, measured
// from the main thread's point of view. 91+ retained sessions, heavy tool events at 60/min with 10x bursts, held
// permission requests answered through IPC, 25 ms synchronous file delays and rename locks under CCF's data folder
// (what the endpoint scanner does), a companion PTY streaming into a full scrollback, dashboard and diagnostics open,
// one renderer that stopped answering. Reports main event-loop delay, hook-to-visible latency, event loss, approval
// outcomes and what each window was sent. `npm test` runs it compressed (seconds); scripts/windows/load-fixture.mjs
// runs it in real time.
//
// Since step 3 the core runs in a forked child (coreMode "process", the utility-process stand-in) and gets the same
// file delays inside it, where settings, checkpoints and the log are written now; main's own file calls under the data
// folder are counted separately (files.main). coreMode "in-process" reproduces the step-1 arrangement.
//
// Since step 4 the companion runs in a forked child too (companionMode "process", Windows): real node-pty and ConPTY
// with the PowerShell fixture (never Claude) printing 1,100 lines and then 12 coloured lines every 33 ms, so main only
// relays the terminal frames it is pushed. companionMode "in-process" is the step-3 arrangement (a fake PTY in main).
//
// Since step 5 the dashboard, diagnostics and conversation windows take their state and frames on ports of their own.
// Their renderer stand-ins run on threads of their own (renderer-worker.js) and own their end of each port (a socket the
// core or companion child writes to, handed over as Electron hands a MessagePort to a utility process), so none of those
// bytes reach main's thread. Hook-to-visible is when the dashboard stand-in's mirror first held the event. The stalled
// renderer is real now: the diagnostics stand-in blocks its thread (Atomics.wait) for stallMs in the middle of the run;
// the core must hold it at its window of unacknowledged frames and catch it up with one frame afterwards. What this does
// not prove: Chromium's own cost of a MessagePort and of drawing (fake windows draw nothing), and main's IPC to the
// overlay, which still goes through main.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Worker, MessagePort } from "node:worker_threads";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createWindowsShellRuntime } from "../runtime/windows-shell-runtime.js";
import { CompanionSession } from "../services/companion-session.js";
import { createFakeElectron, FakeBrowserWindow, FakeTray, nodeUtilityProcess } from "./fake-electron.js";
import { injectFileDelays } from "./file-delays.js";
import { createCompanionFixture, isAlive, waitUntil } from "./companion-fixture.js";

export { injectFileDelays };

const absoluteNow = () => performance.timeOrigin + performance.now();

// One renderer stand-in per view, each on its own thread with a loopback server for its port end.
async function startRendererWorker(view, service) {
  const control = new SharedArrayBuffer(4);
  const worker = new Worker(new URL("./renderer-worker.js", import.meta.url), { workerData: { view, service, control } });
  const inbox = [];
  const waiters = [];
  worker.on("message", (message) => { inbox.push(message); for (const waiter of waiters.splice(0)) waiter(); });
  worker.on("error", (error) => { inbox.push({ kind: "error", error: String(error?.stack ?? error) }); for (const waiter of waiters.splice(0)) waiter(); });
  const next = async (kind, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = inbox.findIndex((message) => message.kind === kind || message.kind === "error");
      if (index >= 0) {
        const [message] = inbox.splice(index, 1);
        if (message.kind === "error") throw new Error(`renderer stand-in ${view} failed: ${message.error}`);
        return message;
      }
      if (Date.now() > deadline) throw new Error(`renderer stand-in ${view}: no ${kind}`);
      await new Promise((resolve) => { waiters.push(resolve); setTimeout(resolve, 100); });
    }
  };
  const { port } = await next("listening");
  return {
    view, service, worker, port, next,
    report: async () => { worker.postMessage({ kind: "report" }); return next("report"); },
    // The port's renderer end lives in the worker: main connects and hands its end to the service process.
    channel: async () => {
      const socket = net.connect(port, "127.0.0.1");
      await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      return { servicePort: socket, rendererPort: { inWorker: true, close() {} } };
    },
    close: async () => { worker.postMessage({ kind: "close" }); await worker.terminate(); }
  };
}

function percentiles(values) {
  if (!values.length) return { count: 0, p50Ms: null, p99Ms: null, maxMs: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)];
  const round = (value) => Math.round(value * 100) / 100;
  return { count: sorted.length, p50Ms: round(at(50)), p99Ms: round(at(99)), maxMs: round(sorted.at(-1)) };
}

class FakePty {
  constructor() { this.dataHandlers = []; this.exitHandlers = []; this.writes = 0; }
  onData(handler) { this.dataHandlers.push(handler); return { dispose: () => {} }; }
  onExit(handler) { this.exitHandlers.push(handler); return { dispose: () => {} }; }
  write() { this.writes++; }
  resize() {}
  kill() { for (const handler of this.exitHandlers) handler({ exitCode: 0 }); }
  emit(chunk) { for (const handler of this.dataHandlers) handler(chunk); }
}

function heavyEvent(index, sessionId, sizeBytes) {
  const pre = index % 2 === 0;
  return {
    hook_event_name: pre ? "PreToolUse" : "PostToolUse", session_id: sessionId, cwd: `C:/load/${sessionId}`,
    tool_name: "Bash", tool_use_id: `load-${index}`,
    tool_input: { command: `echo ${"x".repeat(sizeBytes)}`, description: `load event ${index}` },
    ...(pre ? {} : { tool_response: { stdout: "y".repeat(sizeBytes * 2), stderr: "", interrupted: false } })
  };
}

export async function runLoadFixture({
  sessions = 91, events = 200, ratePerMinute = 60, burstFactor = 10, burstEvery = 40, burstLength = 10,
  speedup = 1, eventBytes = 8192, approvalEvery = 25, approvalDelayMs = 50,
  fileDelayMs = 25, renameLockEvery = 3, companionChunkMs = 33, companionLinesPerChunk = 12, stalledRenderer = true, stallMs = 3000,
  coreMode = "process", companionMode = process.platform === "win32" ? "process" : "in-process", onProgress = null
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-load-"));
  const statsBase = path.join(os.tmpdir(), `ccf-load-stats-${process.pid}-${Date.now()}.json`);
  const statsFor = (kind) => statsBase.replace(/\.json$/, `-${kind}.json`);
  const companionRepo = path.join(root, "repos", "work-companion");
  const inProcessCompanion = companionMode !== "process";
  const pty = inProcessCompanion ? new FakePty() : null;
  const companion = inProcessCompanion ? new CompanionSession({ repoPath: companionRepo, ptyFactory: async () => pty,
    existingSessionProbe: async () => null }) : null;
  const companionFixture = inProcessCompanion ? null : createCompanionFixture(root, {
    load: { prefillLines: 1100, chunkLines: companionLinesPerChunk, chunkMs: companionChunkMs } });
  const electron = createFakeElectron({ home: root, appData: root });
  if (coreMode === "process" || !inProcessCompanion) {
    electron.utilityProcess = nodeUtilityProcess({
      execArgv: ["--import", new URL("./core-file-delays.mjs", import.meta.url).href],
      env: { ...process.env, CCF_TEST_FILE_DELAYS: JSON.stringify({ root, delayMs: fileDelayMs, lockEvery: renameLockEvery,
        statsPath: statsBase }) }
    });
  }
  let tray = null;
  electron.Tray = class extends FakeTray { constructor(icon) { super(icon); tray = this; } };
  const stand = {
    dashboard: await startRendererWorker("dashboard", "core"),
    diagnostics: await startRendererWorker("diagnostics", "core"),
    conversation: await startRendererWorker("conversation", "companion")
  };
  const standFor = (id) => Object.values(stand).find((item) => id === `load-${item.view}`);
  const runtime = createWindowsShellRuntime({ electron,
    processLike: { env: { CCF_HOME_OVERRIDE: root, CCF_APPDATA_OVERRIDE: root, CCF_PORT_OVERRIDE: "0", CCF_TEST_MODE: "1",
      CCF_APP_MODE_OVERRIDE: "mascot", ...(companionFixture ? { CCF_TEST_COMPANION_FIXTURE: companionFixture.dir } : {}) },
    argv: [], execPath: process.execPath, pid: process.pid },
    services: {
      ...(companion ? { companionSession: companion } : {}),
      coreInProcess: coreMode !== "process",
      // In-process only; a forked core installs real hooks into the temp home.
      hookInstaller: { async diagnose() { return { hookExists: true, drift: { healthy: true }, registeredEvents: [] }; } },
      mascotLibrary: { list() { return { mascots: [] }; }, async warmBundledAssets() {} },
      coreLogToConsole: false,
      // A service process's port end goes to the stand-in's thread (in-process hosts use worker MessagePorts instead).
      viewChannel: async ({ options }) => {
        const target = standFor(options?.id);
        if (!target) throw new Error(`No renderer stand-in for ${options?.id}.`);
        return target.channel();
      }
    }
  });
  const result = { options: { sessions, events, ratePerMinute, burstFactor, speedup, eventBytes, fileDelayMs, coreMode,
    companionMode: inProcessCompanion ? "in-process" : "process" } };
  let files = null;
  let companionTimer = null;
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  try {
    const started = await runtime.start();
    const port = started.runtime.hookPort;
    const headers = { "content-type": "application/json", "x-ccf-token": started.settings.hookToken };
    const post = (body, signal) => fetch(`http://127.0.0.1:${port}/hook`, { method: "POST", headers, body: JSON.stringify(body), signal });

    // Retained sessions first (not measured): 91 on the operator's machine on 2026-11-05.
    for (let i = 0; i < sessions; i++) {
      const response = await post({ hook_event_name: "SessionStart", session_id: `load-s-${i}`, cwd: `C:/load/load-s-${i}` });
      await response.text();
    }

    // Windows: the cat's companion cluster (tray), dashboard and diagnostics open, one stalled renderer.
    const showCompanion = (items) => items.flatMap((item) => [item, ...(item.submenu ?? [])]).find((item) => item.id === "show-companion");
    await showCompanion(tray.menu.template).click();
    await electron.ipcMain.invoke("ccf:open-dashboard");
    await electron.ipcMain.invoke("ccf:open-diagnostics");
    const windows = () => [...FakeBrowserWindow.windowsByWebContents.values()].filter((window) => !window.destroyed);
    const byFile = (name) => windows().find((window) => String(window.loadedFile ?? "").endsWith(name));
    const dashboard = byFile("dashboard.html");
    const diagnostics = byFile("diagnostics.html");
    const conversation = byFile("companion-conversation.html");
    // The windows subscribe as their pages do. In-process hosts post a worker MessagePort, which moves to the stand-in.
    const subscribe = async (window, target, request) => {
      window.webContents.on("test:posted", (entry) => {
        const port = entry.ports?.[0];
        if (entry.channel === "ccf:port" && entry.message?.id === `load-${target.view}` && port instanceof MessagePort) {
          target.worker.postMessage({ kind: "port", port }, [port]);
        }
      });
      await electron.ipcMain.invokeFrom(window.webContents, "ccf:subscribe", { id: `load-${target.view}`, ...request });
    };
    await subscribe(dashboard, stand.dashboard, { service: "core", topics: ["base", "events"], eventLimit: 50 });
    await subscribe(diagnostics, stand.diagnostics, { service: "core", topics: ["base"] });

    // Hook-to-visible: when the dashboard stand-in's mirror first held the event (absolute times across threads).
    const postedAt = new Map();
    const visibleAt = new Map();
    const collectVisible = async () => {
      const report = await stand.dashboard.report();
      for (const [id, at] of report.visibleAt) if (postedAt.has(id) && !visibleAt.has(id)) visibleAt.set(id, at);
      return report;
    };
    // Companion PTY output into a full scrollback, at the terminal's own cadence.
    let chunks = 0;
    const companionFrames = () => conversation.webContents.sent.filter((message) => message.channel === "ccf:companion");
    await subscribe(conversation, stand.conversation, { service: "companion" });
    if (inProcessCompanion) {
      await companion.start({ userInitiated: true });
      // Full scrollback (1,000 rows) before measuring, so every frame serializes all of it.
      pty.emit(Array.from({ length: 1100 }, (_, line) => `prefill ${line} ${"dolor sit amet ".repeat(5)}\r\n`).join(""));
      companionTimer = setInterval(() => {
        chunks++;
        const lines = Array.from({ length: companionLinesPerChunk },
          (_, line) => `\x1b[3${line % 7 + 1}m${chunks}:${line} ${"lorem ipsum ".repeat(6)}\x1b[0m\r\n`).join("");
        pty.emit(lines);
      }, companionChunkMs);
    } else {
      // The companion process, then the fixture in its PTY (test mode's Start), then a full scrollback before measuring.
      await electron.ipcMain.invoke("ccf:companion-action", { action: "start" });
      await stand.conversation.next("scrollback", 60000);
    }
    const sentBefore = new Map(windows().map((window) => [window, window.webContents.sent.length]));
    const framesBefore = companionFrames().length;
    const conversationBefore = (await stand.conversation.report()).stats.frames;
    const diagnosticsSubscription = (summary) => summary.core?.subscriptions?.find((item) => item.id === "load-diagnostics") ?? null;
    const stallAt = Math.floor(events / 3);
    let stallSubscription = null;

    files = injectFileDelays({ root, delayMs: fileDelayMs, lockEvery: renameLockEvery });
    histogram.enable();
    const startedAt = performance.now();
    const approvals = [];
    const baseInterval = 60000 / ratePerMinute / speedup;
    for (let index = 0; index < events; index++) {
      const inBurst = index % burstEvery >= burstEvery - burstLength;
      const sessionId = `load-s-${index % sessions}`;
      if (approvalEvery && index % approvalEvery === approvalEvery - 1) {
        const id = `load-approval-${index}`;
        postedAt.set(id, absoluteNow());
        const abort = new AbortController();
        const response = post({ hook_event_name: "PermissionRequest", session_id: sessionId, cwd: `C:/load/${sessionId}`,
          tool_name: "Bash", tool_use_id: id, tool_input: { command: `approve ${index}` } }, abort.signal)
          .then((reply) => reply.json(), (error) => ({ error: error.name }));
        approvals.push({ id, abort, response, decided: (async () => {
          // A person clicks once the approval shows, approvalDelayMs later; it may take a moment to arrive under load.
          await new Promise((resolve) => setTimeout(resolve, approvalDelayMs));
          const find = () => runtime.snapshot().state.approvals.find((item) => item.event.toolUseId === id);
          const deadline = Date.now() + 15000;
          while (!find() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
          const approval = find();
          if (approval) await electron.ipcMain.invoke("ccf:approval-action", { id: approval.id, action: "allow" });
          else abort.abort();   // never leave the request hanging
          return Boolean(approval);
        })() });
      } else {
        const event = heavyEvent(index, sessionId, eventBytes);
        postedAt.set(event.tool_use_id, absoluteNow());
        const response = await post(event);
        await response.text();
      }
      onProgress?.(index + 1, events);
      if (stalledRenderer && index === stallAt) {
        // The diagnostics renderer stops for real; the core must not queue for it.
        stand.diagnostics.worker.postMessage({ kind: "stall", ms: stallMs });
        await stand.diagnostics.next("stalling");
        stallSubscription = { before: diagnosticsSubscription(await runtime.diagnosticsSummary()), startedAt: absoluteNow() };
        // Shortly before the stall ends: what the core sent the stopped renderer meanwhile.
        setTimeout(async () => {
          stallSubscription.atEnd = diagnosticsSubscription(await runtime.diagnosticsSummary().catch(() => ({})));
        }, Math.max(0, stallMs - 300));
      }
      // Windows timers round short waits up to ~15 ms: below 4 ms only yield, so a compressed run stays compressed.
      const pause = inBurst ? baseInterval / burstFactor : baseInterval;
      await new Promise((resolve) => pause >= 4 ? setTimeout(resolve, pause) : setImmediate(resolve));
    }
    const decided = await Promise.all(approvals.map((item) => item.decided));
    const answered = await Promise.all(approvals.map((item) => item.response));
    // Let the serial ingestion chain and the last publications finish.
    const deadline = Date.now() + 10000;
    while (visibleAt.size < postedAt.size && Date.now() < deadline) {
      await collectVisible();
      if (visibleAt.size < postedAt.size) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const durationMs = performance.now() - startedAt;
    histogram.disable();
    clearInterval(companionTimer);
    companionTimer = null;
    files.restore();

    const latencies = [...visibleAt].map(([id, at]) => at - postedAt.get(id));
    const sentDuring = Object.fromEntries(windows().map((window) => [
      String(window.loadedFile ?? window.getTitle()).split(/[\\/]/).at(-1),
      window.webContents.sent.length - (sentBefore.get(window) ?? 0)]));
    const relayed = companionFrames().slice(framesBefore);
    const conversationReport = await stand.conversation.report();
    const framesOnPort = conversationReport.stats.frames - conversationBefore;
    const companionResult = {
      ...(inProcessCompanion ? { chunks, ptyWrites: pty.writes } : { process: runtime.snapshot().runtime.companion }),
      frames: framesOnPort,
      framesPerSecond: Math.round(framesOnPort / (durationMs / 1000) * 10) / 10,
      scrollbackRows: conversationReport.stats.maxScrollback,
      relayedByMain: relayed.length,
      relayedTerminalRows: relayed.reduce((sum, message) => sum + (message.payload?.terminal?.history?.length ?? 0), 0)
    };
    // The stalled renderer: what the core sent it during the stall, and whether one frame caught it up.
    // A thread that just resumed reads its parent's messages before its socket: give it a moment to catch up.
    const plain = (value) => JSON.parse(JSON.stringify(value));
    const matches = (report) => ["sessions", "approvals", "notifications"].every((name) =>
      JSON.stringify(plain(report.state?.[name] ?? [])) === JSON.stringify(plain(runtime.snapshot().state[name] ?? [])));
    let diagnosticsReport = await stand.diagnostics.report();
    const catchUpDeadline = Date.now() + 5000;
    while (stalledRenderer && !matches(diagnosticsReport) && Date.now() < catchUpDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      diagnosticsReport = await stand.diagnostics.report();
    }
    const caughtUp = matches(diagnosticsReport);
    const summaryAfter = await runtime.diagnosticsSummary();
    const stalled = diagnosticsSubscription(summaryAfter);
    Object.assign(result, {
      durationMs: Math.round(durationMs),
      eventLoop: { count: histogram.count, p50Ms: histogram.percentile(50) / 1e6, p99Ms: histogram.percentile(99) / 1e6,
        maxMs: histogram.max / 1e6, meanMs: histogram.mean / 1e6 },
      hookToVisible: percentiles(latencies),
      posted: postedAt.size,
      visible: visibleAt.size,
      lost: [...postedAt.keys()].filter((id) => !visibleAt.has(id)),
      approvals: { requested: approvals.length, decidedInApp: decided.filter(Boolean).length,
        allowed: answered.filter((body) => body?.hookSpecificOutput?.decision?.behavior === "allow").length },
      sessions: runtime.snapshot().state.sessions.length,
      sentPerWindow: sentDuring,
      stalledRenderer: stalledRenderer ? { window: "diagnostics", stallMs: diagnosticsReport.stats.stalls[0]?.ms ?? null,
        sentByMain: sentDuring["diagnostics.html"] ?? 0, framesBeforeStall: stallSubscription?.before?.frames ?? null,
        framesTotal: stalled?.frames ?? null, coalesced: stalled?.coalesced ?? null, maxInflight: stalled?.maxInflight ?? null,
        creditWindow: 2, framesDuringStall: stallSubscription?.atEnd && stallSubscription?.before
          ? stallSubscription.atEnd.frames - stallSubscription.before.frames : null, resyncs: diagnosticsReport.mirrorStats?.resyncs ?? null, caughtUp,
        revision: diagnosticsReport.revision, messages: diagnosticsReport.stats.messages } : null,
      subscriptions: summaryAfter.core?.subscriptions ?? null,
      dashboardStandIn: { states: (await stand.dashboard.report()).stats.states },
      files: { main: { ...files.stats }, core: null, storage: null, companion: null },
      companion: companionResult
    });
    for (const item of approvals) item.abort.abort();
  } finally {
    for (const item of Object.values(stand)) await item.close().catch(() => {});
    if (companionTimer) clearInterval(companionTimer);
    histogram.disable();
    files?.restore();
    await runtime.stop();
    for (const child of electron.utilityProcess?.children ?? []) child.kill();
    // Since step 6 the core's file work happens in its storage worker, which counts its own delays (storage-worker.js).
    for (const [kind, key] of [["core-process", "core"], ["storage-worker", "storage"], ["companion-process", "companion"]]) {
      try { result.files && (result.files[key] = JSON.parse(fs.readFileSync(statsFor(kind), "utf8"))); } catch { /* in-process */ }
      fs.rmSync(statsFor(kind), { force: true });
    }
    if (companionFixture) {
      // Quit ends the fixture's tree with the companion process; a dying process may hold its folder for a moment.
      const pids = companionFixture.ptyPids();
      await waitUntil(() => pids.every((pid) => !isAlive(pid)), "the companion fixture gone", 10000).catch(() => {
        for (const pid of pids) { try { process.kill(pid); } catch {} }
      });
      if (result.companion) result.companion.leftAfterQuit = pids.filter(isAlive).length;
    }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* temp folder */ }
  }
  return result;
}
