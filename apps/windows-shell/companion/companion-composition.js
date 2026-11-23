import path from "node:path";
import { CompanionDeliveryStore } from "../../../packages/core/src/index.js";
import { CompanionSession, createNodePty, findExistingCompanionSession } from "../services/companion-session.js";
import { CompanionBackends } from "../services/companion-backends.js";
import { createProductionCompanionServices } from "../services/companion-production.js";
import { CompanionAttachments } from "../services/companion-attachments.js";
import { pinnedAttachmentIds, serveCompanion } from "../services/companion-service.js";
import { joinKillOnCloseJob } from "./process-tree.js";

// Log lines go to main (which forwards them to the core's log file).
function forwardingLogger(endpoint) {
  const log = (level, category, message, context = {}) => {
    let safe;
    try { safe = JSON.parse(JSON.stringify(context ?? {})); } catch { safe = { context: String(context) }; }
    try { endpoint.emit("log", [{ level, category: String(category), message: String(message), context: safe }]); } catch { /* best effort */ }
  };
  return {
    log, debug: (...args) => log("debug", ...args), info: (...args) => log("info", ...args),
    warn: (...args) => log("warn", ...args), error: (...args) => log("error", ...args)
  };
}

const stdioKind = (options) => options.kind
  ?? (options.args?.some((arg) => /watch\.py$/i.test(String(arg))) ? "watcher" : "habitat");

// Everything that runs in the companion process (process-split plan, step 4): the Claude PTY (node-pty/ConPTY) with
// its headless xterm screen, Codex over stdio JSON-RPC, the habitat bridge and the watcher, the delivery store and the
// staged attachments. Main pushes settings in and answers "settings.patch" (a backend choice); log lines and the
// children this process starts go out as events. The same composition runs in-process for tests (overrides: fakes).
//
// config: { paths: { home, root }, settings, testMode, killOnCloseJob, testFixtures }
export async function composeCompanion({ endpoint, config, overrides = {} }) {
  const { paths } = config;
  const logger = overrides.logger ?? forwardingLogger(endpoint);
  let settings = config.settings ?? {};
  const getSettings = () => settings;
  endpoint.on("settings", (value) => { if (value && typeof value === "object") settings = value; });

  // No child before the job: whatever this process starts afterwards ends when it ends (process-tree.js). Without the
  // job nothing starts at all (review of step 4, P2): main's fallback can only end the roots it was told about, so a
  // grandchild whose root had exited, or a child started just before a crash, would outlive the companion.
  const join = overrides.joinJob ?? (() => joinKillOnCloseJob(config.testMode && config.testJobShells ? { shells: config.testJobShells } : {}));
  const job = (config.killOnCloseJob ? join() : Promise.resolve({ joined: false, reason: "disabled" }))
    .then((result) => {
      endpoint.emit("job", result);
      if (result.joined) logger.info("companion", "Companion children are bound to the companion process", { ms: result.ms, shell: result.shell });
      else if (config.killOnCloseJob) logger.error("companion", "Companion children cannot be bound to its lifetime; the companion starts none", { reason: result.reason });
      return result;
    });
  const requireJob = async () => {
    const result = await job;
    if (config.killOnCloseJob && !result.joined) {
      throw new Error(`The companion could not bind its children to its own lifetime (${result.reason}); nothing was started.`);
    }
  };
  const children = new Map();
  const track = (kind, pid, closed) => {
    if (!Number.isInteger(pid)) return;
    children.set(pid, { kind, pid });
    endpoint.emit("children", { op: "add", kind, pid });
    Promise.resolve(closed).catch(() => {}).finally(() => {
      children.delete(pid);
      endpoint.emit("children", { op: "remove", kind, pid });
    });
  };
  const ptyFactory = overrides.ptyFactory ?? (async (spec) => {
    await requireJob();
    const pty = await createNodePty(spec);
    track("claude", pty.pid, new Promise((resolve) => pty.onExit(resolve)));
    return pty;
  });
  const loadTransport = async () => {
    await requireJob();
    const native = await import("../services/codex-process-transport.js");
    const tracked = (create, kindOf) => async (options) => {
      const transport = await create(options);
      track(kindOf(options), transport.pid, transport.closed);
      return transport;
    };
    return {
      createStdioTransport: tracked(native.createStdioTransport, stdioKind),
      createCodexProcessTransport: tracked(native.createCodexProcessTransport, () => "codex")
    };
  };

  // A backend choice is a settings write, which main owns (its mirror patches the core's settings.json).
  const saveBackend = (backend) => {
    settings = { ...settings, companionBackend: backend };
    const saved = endpoint.request("settings.patch", { patch: { companionBackend: backend } });
    saved.catch((error) => logger.warn("companion", "Backend choice was not saved", { error: String(error?.message ?? error) }));
    return saved;
  };

  let session = overrides.session ?? null;
  let delivery = overrides.delivery ?? null;
  if (!session) {
    // Delivery records are rows in the core's database (process-split step 6), reached through main. They must never keep
    // the companion (or Claude) from starting: when they cannot be loaded the store blocks the sends that need them,
    // visibly, until Start reloads them.
    const repository = overrides.deliveryRepository ?? {
      load: () => endpoint.request("delivery.load", null, { timeoutMs: 10000 }),
      commit: (changes) => endpoint.request("delivery.commit", { changes }, { timeoutMs: 10000 })
    };
    delivery = new CompanionDeliveryStore({ repository });
    try { await delivery.open(); }
    catch (error) {
      logger.error("companion", "Companion delivery records are unavailable; Codex sends stay blocked until Start", { error: String(error.message) });
    }
    const production = createProductionCompanionServices({ getSettings, home: paths.home, appData: paths.root,
      parentEnv: process.env, loadTransport });
    session = new CompanionBackends({
      claude: new CompanionSession({ repoPath: settings.companionRepoPath, ptyFactory,
        existingSessionProbe: (repoPath) => findExistingCompanionSession(repoPath, {
          sessionsDirectory: path.win32.join(paths.home, ".claude", "sessions") }) }),
      codex: overrides.codexCompanionSession ?? production.codex,
      habitat: overrides.companionHabitat ?? production.habitat,
      backend: settings.companionBackend === "codex" ? "codex" : "claude", delivery,
      onSelect: saveBackend
    });
    session.watcher = production.createWatcher({ delivery, backend: session });
    session.watcher?.on("fault", (error) => logger.warn("companion", "Watcher needs attention", { error: String(error.message) }));
    production.habitat.on("fault", (error) => logger.warn("companion", "Habitat connection needs attention", { error: String(error.message) }));
  }

  const attachments = overrides.attachments ?? new CompanionAttachments({
    directory: path.join(paths.root, "companion-attachments"),
    isPinned: (id) => pinnedAttachmentIds(delivery).includes(id)
  });
  if (delivery && !overrides.attachments) {
    const unresolved = session.getSnapshot?.().submission;
    if (unresolved?.state === "outcomeUnknown" && unresolved.attachments?.length) {
      try { await attachments.restore(unresolved.attachments); }
      catch (error) { logger.error("companion", "Uncertain attachment recovery needs attention; original evidence retained", { error: String(error.message) }); }
    }
  }

  const served = serveCompanion({ endpoint, session, delivery, attachments,
    epoch: Number.isFinite(config.epoch) ? config.epoch : Date.now() });

  // The conversation window's own frames port (process-split plan, step 5): the terminal bypasses main.
  function attachPort(info, port) {
    if (info?.kind !== "frames") throw new Error(`Unknown port kind ${info?.kind}.`);
    return served.subscribeFrames(port, info.options ?? {});
  }

  // Test mode only: a stdio child through the same tracked transport Codex, the habitat and the watcher use, so the
  // real-process tests can prove those trees end with the companion (a PowerShell fixture, never Codex).
  if (config.testMode && config.testFixtures) {
    const fixtures = [];
    endpoint.handle("fixture.spawnStdio", async ({ kind, executable, args, cwd }) => {
      const transport = await (await loadTransport()).createStdioTransport({ kind, executable, args, cwd, env: process.env });
      transport.readable.resume();
      fixtures.push(transport);
      return { pid: transport.pid };
    });
  }

  return {
    readiness: { snapshot: served.snapshot(), delivery: Boolean(delivery) && !delivery.blocked, pid: process.pid },
    session, delivery, attachments, served, job, children, logger, getSettings, attachPort
  };
}
