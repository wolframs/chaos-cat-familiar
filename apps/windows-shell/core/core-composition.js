import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  CcfCoreController,
  EffectOutbox,
  SettingsAuthority,
  SqliteStateStore,
  StorageClient,
  WorkerSettingsStore,
  serveCore
} from "../../../packages/core/src/index.js";
import { NotificationPolicy } from "../services/platform-services.js";
import { ElectronHookInstallationService } from "../services/claude-hook-installer.js";
import { RuntimeLogger } from "../services/runtime-logger.js";
import { ClaudeRegistryLiveness, hasPendingBackgroundWork as readPendingBackgroundWork, transcriptUnder } from "../services/claude-session-status.js";
import { lastPromptIsMaintenance } from "../services/claude-transcript.js";
import { removeCcfClaudeHooks } from "../services/windows-cleanup.js";
import { CodexHookInstaller } from "../services/codex-hook-installer.js";
import { unpackedPath } from "../services/asar-paths.js";

const SHELL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Codex runs it with node: a packaged build hands over the copy unpacked from app.asar.
const CODEX_HOOK_SENDER = unpackedPath(path.resolve(SHELL_ROOT, "../../scripts/windows/codex-hook-sender.mjs"));

// The hosted work companion idles without its watcher (the watcher is a background shell, so with it running the
// session reads "shell" and its idle alert is dropped): say that instead of "Claude is Waiting" (assessment
// 2026-11-17).
export function companionIdleNotice(notification, session, settings = {}) {
  if (notification?.category !== "idle_alert" || !session?.projectDir) return notification;
  const companion = settings.companionRepoPath;
  if (!companion || path.win32.resolve(session.projectDir).toLowerCase() !== path.win32.resolve(companion).toLowerCase()) {
    return notification;
  }
  return { ...notification, title: "Companion idle without its watcher",
    body: "A session in the work companion's folder went idle. The hosted companion does that only when its watcher is not running (no sensors, no panel updates)." };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); timer.unref?.(); })])
    .finally(() => clearTimeout(timer));
}

async function probeReady(port, token, instance) {
  const response = await fetch(`http://127.0.0.1:${port}/ready`, {
    headers: { "x-ccf-token": token }, signal: AbortSignal.timeout(5000), redirect: "error"
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.instance !== instance) {
    throw new Error(`The hook server on port ${port} did not answer as this core (HTTP ${response.status}).`);
  }
}

// Everything that runs in the core process (process-split plan, step 3): settings as their single writer, the log
// file, the state checkpoint, the controller and the HookServer with its approval waiters, notification policy, and
// the hook-file work (Claude and Codex hook installation, repair, removal). Effects and companion intents go to main.
// The same composition runs in a utility process and, for tests with fake Electron, in-process (overrides: fakes).
//
// Since step 6 the core's file work happens in its storage worker (storage-worker.js): the state lives in ccf.sqlite
// (imported once from state.json). onStorageFailed: what to do when the worker dies (the core process exits, so main
// restarts it; nothing could be persisted any more).
//
// config: { paths: { home, root, settingsPath, statePath, dbPath, logPath }, settingsDefaults, preferredPort,
//   retryPortMs, testMode, watchSettingsMs, logToConsole }
export async function composeCore({ endpoint, config, overrides = {}, timers = globalThis, onStorageFailed = null }) {
  const { paths } = config;
  const quiet = () => {};
  // The log's lines are batched here (250 ms, warnings at once) and appended and rotated by the storage worker.
  let storage = null;
  const logger = overrides.logger ?? new RuntimeLogger({ limit: 1000, filePath: paths.logPath, flushDelayMs: 250, timers,
    sink: { append: (text) => storage.request("log.append", { text }, { timeoutMs: 30000 }) },
    ...(config.logToConsole === false ? { stdout: quiet, stderr: quiet } : {}) });
  storage = overrides.storage ?? new StorageClient({ log: { logPath: paths.logPath },
    onError: (error, context) => logger.warn("persistence", "Storage worker channel error", {
      method: context?.method ?? null, error: String(error?.message ?? error) }) });
  storage.on("warning", ({ message, context } = {}) => logger.warn("persistence", String(message), context ?? {}));
  storage.on("failed", (error) => {
    logger.error("persistence", "The storage worker stopped; the core cannot persist any more", { error: String(error?.message ?? error) });
    onStorageFailed?.(error);
  });
  // The run marker (one per CCF run: a core restarted within the run keeps it) is written by the worker too.
  const run = config.run ?? null;
  const opened = await storage.open({ dbPath: paths.dbPath ?? path.join(paths.root, "ccf.sqlite"), statePath: paths.statePath,
    settingsPath: paths.settingsPath, settingsDefaults: config.settingsDefaults ?? {}, logPath: paths.logPath,
    deliveryPath: path.join(paths.root, "companion-delivery.json"),
    markerPath: run ? paths.markerPath ?? path.join(paths.root, "run-marker.json") : null, runId: run?.runId ?? null,
    pid: run?.pid ?? null });
  const recovery = opened.recovery;
  if (recovery?.previousUncleanExit) {
    logger.warn("recovery", "Previous run ended uncleanly; loading the last committed state. Its last moments may be missing.",
      { previousRun: recovery.previousRun });
  }
  if (recovery?.lastError) logger.warn("recovery", "Run marker unavailable", { error: recovery.lastError });
  const imported = opened.imports?.state;
  if (imported?.ran) logger.info("persistence", "State imported from state.json into SQLite", { counts: imported.counts, backup: imported.backup });
  if (imported?.ignoredNow) logger.warn("persistence", "A state.json written after SQLite took over was not imported", { backup: imported.ignoredNow });
  if (imported?.status === "unreadable" && imported.movedNow) {
    logger.warn("persistence", "state.json could not be read; moved aside, CCF starts without its history", { backup: imported.backup, error: imported.error });
  }
  if (opened.quarantine) logger.warn("persistence", "The state database was unreadable and was moved aside", { quarantine: opened.quarantine });
  // settings.json stays a plain file others edit (scripts, the hook relay); the worker writes it and watches it.
  const settings = new SettingsAuthority({
    store: new WorkerSettingsStore({ storage, initial: opened.settings.value }),
    logger, timers, watchMs: config.watchSettingsMs ?? 0
  });
  // The token must be on disk before hooks name it (main installs them only after readiness).
  if (!settings.load().hookToken) await settings.update({ hookToken: randomBytes(32).toString("hex") });
  const applyDiagnostics = (value) => logger.configure?.({ debugLogging: value.debugLogging === true });
  applyDiagnostics(settings.load());
  settings.on("change", (value, seq, saved) => {
    applyDiagnostics(value);
    endpoint.emit("settings", { value, seq, saved });
  });

  // Rows that changed, committed by the worker after a 100 ms batching delay (not a bound on crash loss: a commit that
  // waits on the disk holds the next batch back).
  const stateStore = overrides.stateStore ?? new SqliteStateStore({ storage, rows: opened.stateRows, flushDelayMs: 100, timers,
    onError: (error) => logger.error("persistence", "State commit failed; latest state remains in memory", {
      error: String(error?.message ?? error)
    })
  });

  const effects = new EffectOutbox();
  const policy = new NotificationPolicy({ logger,
    getPreferences: () => config.testMode
      ? { ...settings.load().notifications, enabled: false }
      : settings.load().notifications,
    hasPendingBackgroundWork: overrides.hasPendingBackgroundWork ?? readPendingBackgroundWork });
  const controller = new CcfCoreController({
    overlay: effects.overlay,
    // context.ticket: the room the ingestion reserved for this toast; a toast the policy holds back leaves it unused.
    notifier: { notify: async (notification, context) => {
      if (policy.allows(notification)) await effects.notifier.notify(notification, context);
    } },
    stateStore, settings, logger,
    notificationFilter: (notification, { session }) => companionIdleNotice(notification, session, settings.load()),
    // At most 1.5 s per Stop (hooks are ingested in order); a slow or failed read leaves it to the session's flag.
    maintenanceTurn: overrides.maintenanceTurn ?? ((event) => withTimeout(lastPromptIsMaintenance(event.transcriptPath), 1500))
  });
  const service = serveCore({ endpoint, controller, effects, createHookServer: overrides.createHookServer, logger,
    epoch: Number.isFinite(config.epoch) ? config.epoch : Date.now() });

  // Desktop facts only main knows (Electron's notification support, login item, packaged or not), sent with each
  // hook request for the diagnosis report.
  let desktop = {};
  const hookInstaller = overrides.hookInstaller ?? new ElectronHookInstallationService({
    getHomePath: () => paths.home,
    notificationsSupported: () => desktop.notificationsSupported ?? false,
    getLoginItemSettings: () => ({ openAtLogin: desktop.openAtLogin ?? false }),
    runtimeMode: () => desktop.runtimeMode ?? { mode: "unknown", isPackaged: false, isDefaultApp: false }
  }, settings, logger);

  function codexInstaller({ codexHome, nodeExecutable }) {
    return new CodexHookInstaller({ codexHome, nodeExecutable, senderPath: CODEX_HOOK_SENDER, settingsPath: paths.settingsPath });
  }

  async function hooks({ op, options, desktop: info }) {
    if (info) desktop = info;
    switch (op) {
      case "diagnose": return hookInstaller.diagnose(options ?? undefined);
      case "install": return hookInstaller.install();
      case "repair": return hookInstaller.repair();
      case "remove": return removeCcfClaudeHooks({ home: paths.home });
      case "codex-install": return codexInstaller(options).install({ userInitiated: true });
      case "codex-remove": return codexInstaller(options).remove({ userInitiated: true });
      default: throw new Error(`Unsupported hook operation ${op}.`);
    }
  }

  // Binds, persists the port the server got, then proves the listener is this server with this token before the
  // port is reported: main installs or repairs hooks only for that.
  async function listen(port, retryDelaysMs = []) {
    const token = settings.load().hookToken;
    const result = await service.startHookServer({ port, authToken: token, retryDelaysMs });
    if (settings.load().port !== result.port) await settings.update({ port: result.port });
    logger.info("hook-server", "Hook server listening", {
      requestedPort: result.requestedPort,
      activePort: result.port,
      fallbackUsed: result.fallbackUsed
    });
    const instance = service.hookServer.instance;
    await probeReady(result.port, token, instance);
    return { ...result, instance, authenticated: true, pid: process.pid, state: service.projection(),
      revision: service.revision, epoch: service.epoch, settings: settings.load(), recovery };
  }

  // The session sweep (set up once the server listens, below); declared here because shutdown can come before that.
  let sweeping = null;
  let sweepTimer = null;
  let shutdownResult = null;
  async function shutdown() {
    if (shutdownResult) return shutdownResult;
    shutdownResult = (async () => {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      await sweeping;
      try { await service.stopHookServer(); }
      catch (error) { logger.error("shutdown", "Hook server did not stop cleanly", { error: String(error?.message ?? error) }); }
      let stateSaved = true;
      try { controller.persistState(); }
      catch (error) {
        stateSaved = false;
        logger.error("persistence", "Final state snapshot failed", { error: String(error?.message ?? error) });
      }
      try { stateSaved = (await stateStore.close?.()) !== false && stateSaved; }
      catch (error) {
        stateSaved = false;
        logger.error("persistence", "Final state flush failed", { error: String(error?.message ?? error) });
      }
      const settingsSaved = await settings.close();
      if (!(await storage.close())) logger.warn("persistence", "The state database did not close cleanly");
      const logsSaved = (await (logger.closeAsync?.() ?? logger.close?.())) !== false;
      return { stateSaved, logsSaved, settingsSaved };
    })();
    return shutdownResult;
  }

  endpoint.on("log", (entries) => {
    for (const entry of Array.isArray(entries) ? entries : []) {
      logger.log(entry.level, entry.category, entry.message, entry.context ?? {}, entry.timestamp ?? null);
    }
  });
  endpoint
    .handle("settings.get", () => settings.load())
    .handle("settings.update", ({ patch, seq }) => settings.update(patch, { seq }))
    .handle("hooks", hooks)
    .handle("rebindHookServer", async ({ port }) => {
      await service.stopHookServer();
      return listen(port);
    })
    .handle("stopIntake", () => service.stopHookServer())
    .handle("status", async () => ({ pid: process.pid, logging: logger.status?.() ?? null,
      persistence: stateStore.status?.() ?? null,
      storage: await storage.request("status", null, { timeoutMs: 2000 }).catch((error) => ({ error: String(error?.message ?? error) })),
      settings: settings.status(), hookPort: service.hookServer?.port ?? null, revision: service.revision,
      // Requests the core makes of main (toasts, show-overlay, observations; /companion/* intents).
      effects: effects.queue?.stats ?? null, intents: service.intents.queue.stats,
      subscriptions: service.subscriptions() }))
    // "Clear local data": the history goes from memory and from the database (its file stays open in the worker).
    .handle("clearHistory", () => controller.clearHistory())
    // The companion's delivery records (relayed by main): loaded as rows, committed in one transaction each.
    .handle("delivery.load", () => storage.request("delivery.load", null, { timeoutMs: 10000 }))
    .handle("delivery.commit", ({ changes } = {}) => storage.request("delivery.commit", { changes }, { timeoutMs: 10000 }))
    .handle("shutdown", shutdown)
    // After shutdown, once main judged the whole quit clean (its own writes included): the run marker goes.
    .handle("markClean", async () => (run ? storage.request("marker.clean", { runId: run.runId }, { timeoutMs: 5000 })
      : { ok: true, skipped: true }));

  const preferredPort = Number.isFinite(config.preferredPort) ? config.preferredPort : settings.load().port;
  const readiness = await listen(preferredPort, config.retryPortMs ?? []);
  settings.watch();

  // Claude sessions that died without SessionEnd end when they leave Claude Code's registry (at start, then every
  // sessionSweepMs). The registry lives under the same home the hooks are installed in, so tests and smoke runs read
  // their temporary home, never the real one. Only sessions whose transcript lies under that home's .claude are swept
  // (a WSL or other-profile session is in another registry); the registry is read only when there is a candidate.
  const claudeDir = path.join(paths.home, ".claude");
  const inScope = (session) => transcriptUnder(session.transcriptPath, claudeDir);
  const liveness = new ClaudeRegistryLiveness({ dir: path.join(claudeDir, "sessions") });
  const readLiveIds = overrides.liveClaudeSessionIds ?? ((candidates) => liveness.liveIds({ candidates }));
  const sweepRound = async () => {
    const candidates = controller.claudeSweepCandidates({ inScope });
    if (candidates.size === 0) return [];
    const ids = await readLiveIds(candidates);
    return ids ? controller.reconcileClaudeSessions(ids, { inScope, only: candidates }) : [];
  };
  const sweepSessions = () => {
    if (shutdownResult) return Promise.resolve([]);
    sweeping ??= Promise.resolve().then(sweepRound)
      .catch((error) => logger.warn("session", "Session sweep failed", { error: String(error?.message ?? error) }))
      .finally(() => { sweeping = null; });
    return sweeping;
  };
  const sweepMs = Number.isFinite(config.sessionSweepMs) ? config.sessionSweepMs : 60000;
  // Its own unref'd timer, not the injected ones (runtime tests count those).
  sweepTimer = sweepMs > 0 && !shutdownResult ? setInterval(sweepSessions, sweepMs) : null;
  sweepTimer?.unref?.();
  if (sweepTimer) void sweepSessions();
  // A window's own subscription (process-split plan, step 5): state goes straight to it, not through main.
  function attachPort(info, port) {
    if (info?.kind !== "state") throw new Error(`Unknown port kind ${info?.kind}.`);
    return service.subscribe(port, info.options ?? {});
  }

  async function flushAsync() {
    try { controller.persistState(); } catch { /* exiting */ }
    await Promise.resolve(stateStore.flush?.()).catch(() => {});
    try { logger.flush?.(); } catch { /* exiting */ }
  }

  return {
    readiness, controller, logger, settings, stateStore, storage, service, shutdown, attachPort, sweepSessions,
    // Best effort when the process is about to exit (the caller waits a moment for it); never marks a run clean.
    flushAsync,
    flushSync() { void flushAsync(); },
    // The storage worker's end (the process exit ends it too; the in-process host calls this).
    dispose: () => storage.terminate?.()
  };
}
