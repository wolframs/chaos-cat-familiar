import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { spawnLoggedProcess, waitForJson, ensureGone } from "./process-supervisor.mjs";
import { runDesignReloadSmoke } from "./design-reload-smoke.mjs";
import { runSidePanelSmoke, sidePanelFixturePath, writeSidePanelFixture } from "./side-panel-smoke.mjs";
import { createCompanionFixture, isAlive } from "../../apps/windows-shell/test-support/companion-fixture.js";
import { storedState } from "../../apps/windows-shell/test-support/stored-state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const appDir = path.join(repoRoot, "apps", "windows-shell");
const electronCmd = path.join(repoRoot, "node_modules", ".bin", "electron.cmd");
// CCF_SMOKE_APP=<ChaosCatFamiliar.exe>: the same checks against a packaged build (process-split plan, step 7), still in
// test mode against temp folders.
const packagedApp = process.env.CCF_SMOKE_APP ? path.resolve(process.env.CCF_SMOKE_APP) : null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOk(url, headers = {}, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { headers });
      if (response.ok) {
        return response;
      }
    } catch {}
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function main() {
  if (packagedApp ? !fs.existsSync(packagedApp) : !fs.existsSync(electronCmd)) {
    throw new Error(packagedApp ? `No packaged app at ${packagedApp}.` : `Electron dependency missing at ${electronCmd}. Run npm install first.`);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-win-smoke-"));
  const home = path.join(tmpRoot, "home");
  const appData = path.join(tmpRoot, "appdata");
  const logFile = path.join(tmpRoot, "smoke.log");
  const token = `smoke-${Date.now()}`;
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  // Electron's test profile (main.js does no file work to create it).
  fs.mkdirSync(path.join(appData, "electron-user-data"), { recursive: true });
  // The companion's Start runs this PowerShell stand-in in test mode, never Claude (process-split plan, step 4).
  const companionFixture = createCompanionFixture(tmpRoot);
  // The side panel's file where CCF looks by default (<home>/repos/work-companion/state/panel.json), generic data.
  writeSidePanelFixture(sidePanelFixturePath(home));

  if (process.env.CCF_SMOKE_DIAGNOSTICS === "1") {
    const settingsDir = path.join(appData, "chaos-cat-familiar");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({ debugLogging: true, performanceProfiling: true }));
  }
  const runtimeMetadataPath = path.join(appData, "chaos-cat-familiar", "runtime.json");
  const designReload = process.env.CCF_SMOKE_DESIGN_RELOAD === "1";
  const launchArgs = designReload ? ["--remote-debugging-port=0"] : [];
  const supervisor = spawnLoggedProcess(packagedApp ?? electronCmd, packagedApp ? launchArgs : [".", ...launchArgs], {
    cwd: packagedApp ? path.dirname(packagedApp) : appDir,
    env: {
      ...process.env,
      CCF_HOME_OVERRIDE: home,
      CCF_APPDATA_OVERRIDE: appData,
      CCF_PORT_OVERRIDE: "0",
      CCF_TEST_MODE: "1",
      ...(designReload ? { CCF_DESIGN_RELOAD: "1" } : {}),
      CCF_TEST_DISPLAY: "rightmost",
      // The design-reload run keeps test mode's guard in view instead: without a fixture, Start is refused.
      ...(designReload ? {} : { CCF_TEST_COMPANION_FIXTURE: companionFixture.dir }),
      CCF_TEST_TOKEN: token
    },
    logFile
  });

  try {
    let metadata = await waitForJson(runtimeMetadataPath, { timeoutMs: 45000 });
    const metadataDeadline = Date.now() + 15000;
    while ((!metadata.pid || !metadata.controlPort || !metadata.hookPort) && Date.now() < metadataDeadline) {
      await delay(200);
      metadata = await waitForJson(runtimeMetadataPath, { timeoutMs: 1000, pollMs: 100 });
    }
    if (!metadata.pid || !metadata.controlPort || !metadata.hookPort) {
      throw new Error("Runtime metadata did not contain pid/hook/control ports");
    }
    supervisor.adoptPid(metadata.pid);
    await waitForOk(`http://127.0.0.1:${metadata.controlPort}/ready`, {
      "x-ccf-test-token": token
    }, 15000);
    await waitForOk(`http://127.0.0.1:${metadata.hookPort}/health`, {}, 15000);

    const controlHeaders = {
      "content-type": "application/json",
      "x-ccf-test-token": token
    };

    const hookToken = JSON.parse(fs.readFileSync(path.join(appData, "chaos-cat-familiar", "settings.json"), "utf8")).hookToken;

    // Sample settled idle renderers before injecting activity.
    await delay(Number(process.env.CCF_SMOKE_SETTLE_MS) || 5000);
    const readDiagnostics = async () => (await fetch(`http://127.0.0.1:${metadata.controlPort}/diagnostics-summary`, { headers: controlHeaders })).json();
    const baseline = await readDiagnostics();
    const sampleStart = performance.now();
    await delay(Number(process.env.CCF_SMOKE_SAMPLE_MS) || 3000);
    const idle = await readDiagnostics();
    if (process.env.CCF_SMOKE_DIAGNOSTICS === "1") {
      if (!idle.logging.debugLogging || !idle.performance.enabled || idle.performance.samples.length < 2) {
        throw new Error("Diagnostic settings or periodic performance sampling did not start");
      }
      const sample = idle.performance.samples.at(-1);
      if (!(sample.privateMemoryKiB > 0) || sample.cpuPercentOfOneCore === null) throw new Error("Performance metrics missing");
      const log = fs.readFileSync(idle.logging.filePath, "utf8");
      if (!log.includes("[performance]") || !log.includes("Request completed")) throw new Error("Diagnostic log entries missing");
      console.log("Diagnostic logging and periodic performance sampling verified");
    }
    // The core runs in its own Electron utility process (process-split plan, step 3).
    const coreProcess = idle.processes.find((item) => item.type === "Utility" && item.name === "Chaos Cat Familiar Core");
    if (idle.core?.mode !== "utility" || !coreProcess || coreProcess.pid !== idle.core.pid || idle.core.pid === metadata.pid
      || idle.core.status !== "ready" || idle.core.hookPort !== metadata.hookPort) {
      throw new Error(`The core is not running as a ready utility process: ${JSON.stringify(idle.core)}`);
    }
    console.log(packagedApp ? `Packaged build: ${packagedApp}` : "Dev run: electron apps/windows-shell");
    console.log(`Core utility process ${idle.core.pid} serves hooks on port ${idle.core.hookPort}`);
    if (packagedApp) {
      // Codex runs the hook sender with plain node from app.asar.unpacked (node cannot read app.asar); everything it
      // imports must be unpacked with it (final review of the process split: the adapter was not).
      const sender = path.join(path.dirname(packagedApp), "resources", "app.asar.unpacked", "scripts", "windows", "codex-hook-sender.mjs");
      const senderSettings = path.join(tmpRoot, "codex-sender-settings.json");
      fs.writeFileSync(senderSettings, JSON.stringify({ port: metadata.hookPort, hookToken }));
      const sent = spawnSync(process.execPath, [sender, "--settings", senderSettings], { encoding: "utf8", timeout: 20000,
        input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "packaged-codex-sender", cwd: repoRoot, source: "startup" }) });
      if (sent.status !== 0 || sent.stderr || sent.stdout.trim() !== "{}") {
        throw new Error(`The packaged Codex hook sender failed (exit ${sent.status}): ${sent.stderr || sent.stdout || sent.error}`);
      }
      const observed = await fetch(`http://127.0.0.1:${metadata.controlPort}/await-state`, { method: "POST", headers: controlHeaders,
        body: JSON.stringify({ type: "session", match: { backend: "codex" }, timeoutMs: 10000 }) });
      if (!observed.ok) throw new Error(`The packaged Codex hook sender's observation did not reach the core: ${observed.status}`);
      console.log("Packaged Codex hook sender: plain node ran it from app.asar.unpacked; its observation reached the core");
    }
    const intervalSeconds = (performance.now() - sampleStart) / 1000;
    const cpuSeconds = idle.processes.reduce((sum, item) => {
      const previous = baseline.processes.find((entry) => entry.pid === item.pid);
      return sum + (previous ? Math.max(0, item.cpu.cumulativeCPUUsage - previous.cpu.cumulativeCPUUsage) : 0);
    }, 0);
    console.log(JSON.stringify({ idle: { processes: idle.processes, displays: idle.displays,
      privateMiB: idle.processes.reduce((sum, item) => sum + item.memory.privateBytes, 0) / 1024,
      workingSetMiB: idle.processes.reduce((sum, item) => sum + item.memory.workingSetSize, 0) / 1024,
      oneCoreCpuPercent: 100 * cpuSeconds / intervalSeconds, intervalSeconds } }));
    if (process.env.CCF_SMOKE_CAPTURE_PATH) {
      const capture = await fetch(`http://127.0.0.1:${metadata.controlPort}/capture-overlay`, { headers: controlHeaders });
      if (!capture.ok) throw new Error("Overlay capture failed");
      fs.writeFileSync(process.env.CCF_SMOKE_CAPTURE_PATH, Buffer.from(await capture.arrayBuffer()));
    }

    if (process.env.CCF_SMOKE_COMPANION_CAPTURE_DIR || designReload) {
      const fixture = {
        connected: true,
        phase: "idle",
        title: "Status der drei Tickets",
        messages: [
          { id: "m1", role: "user", text: "Where are the three tickets?" },
          { id: "m2", role: "assistant", text: "#2197 is merged and #2015 is closed. #1549 still needs the branch updated, new tables, and approval before its pipeline can run." }
        ],
        terminal: { needed: false, screen: "" }
      };
      if (designReload) fixture.messages[1].text += "\n" + Array.from({length: 35}, (_, index) => `Fixture status line ${index + 1}.`).join("\n");
      const preview = await fetch(`http://127.0.0.1:${metadata.controlPort}/companion-preview`, {
        method: "POST", headers: controlHeaders, body: JSON.stringify(fixture)
      });
      if (!preview.ok) throw new Error("Companion fixture injection failed");
      const status = await fetch(`http://127.0.0.1:${metadata.hookPort}/companion/status`, {
        method: "POST", headers: { "content-type": "application/json", "x-ccf-token": hookToken },
        body: JSON.stringify({ session_id: "smoke-companion", cwd: path.join(home, "repos", "work-companion"),
          context_window: { used_percentage: 11, total_input_tokens: 109000, context_window_size: 1000000 },
          rate_limits: { five_hour: { used_percentage: 0, resets_at: Date.now() / 1000 + 12600 },
            seven_day: { used_percentage: 98, resets_at: Date.now() / 1000 + 90000 } },
          prompt_cache: { caching_observed: true, warm: true, ttl: "1h", expires_at: Date.now() / 1000 + 2280, hit_ratio: .98 },
          cost: { total_duration_ms: 9880000, total_lines_added: 15, total_lines_removed: 31, total_cost_usd: 1.54 } })
      });
      if (!status.ok) throw new Error("Companion status fixture injection failed");
      await delay(700);
      if (process.env.CCF_SMOKE_COMPANION_CAPTURE_DIR) {
        fs.mkdirSync(process.env.CCF_SMOKE_COMPANION_CAPTURE_DIR, { recursive: true });
        for (const [name, route] of [["conversation", "/capture-companion"], ["status", "/capture-companion-status"]]) {
          const image = await fetch(`http://127.0.0.1:${metadata.controlPort}${route}`, { headers: controlHeaders });
          if (!image.ok) throw new Error(`Companion ${name} capture failed`);
          fs.writeFileSync(path.join(process.env.CCF_SMOKE_COMPANION_CAPTURE_DIR, `${name}.png`), Buffer.from(await image.arrayBuffer()));
        }
        if (!designReload) {
          const terminalFixture = { ...fixture, terminal: { needed: true,
            screen: "Haiku · Work companion\nReady for input\nANSI colours survive screen repaints.",
            lines: [
              [{ text: "Haiku · Work companion", foreground: "#d670d6", bold: true }],
              [{ text: "Ready for input", foreground: "#70d5a1" }],
              [{ text: "ANSI colours survive screen repaints.", foreground: "#e5e5e5" }],
              [], [{ text: "Warning", foreground: "#ffc170" }, { text: "  dim  ", dim: true },
                { text: "highlighted", foreground: "#100d18", background: "#ce9af4" }]
            ] } };
          const terminalPreview = await fetch(`http://127.0.0.1:${metadata.controlPort}/companion-preview`, {
            method: "POST", headers: controlHeaders, body: JSON.stringify(terminalFixture)
          });
          if (!terminalPreview.ok) throw new Error("Terminal fixture injection failed");
          await delay(200);
          const terminalCapture = await fetch(`http://127.0.0.1:${metadata.controlPort}/capture-companion`, { headers: controlHeaders });
          if (!terminalCapture.ok) throw new Error("Terminal fixture capture failed");
          fs.writeFileSync(path.join(process.env.CCF_SMOKE_COMPANION_CAPTURE_DIR, "terminal.png"), Buffer.from(await terminalCapture.arrayBuffer()));
          // The cat's speech bubbles: every style once (each capture shows the stack so far), then a special one.
          const bubbleLines = ["Meow! api-1 is like \"dude, i can haz input plx?!\"",
            "Meow! Your agents are like \"dude, i can haz input plx?!\""];
          const bubbleShots = [["plum"], ["lilac"], ["neon"], ["comic"], ["flame"], ["pixel"], ["plum", true]];
          for (const [index, [style, special]] of bubbleShots.entries()) {
            const bubble = await fetch(`http://127.0.0.1:${metadata.hookPort}/companion/bubble`, {
              method: "POST", headers: { "content-type": "application/json", "x-ccf-token": hookToken },
              body: JSON.stringify({ text: bubbleLines[index % 2], style, special: Boolean(special) })
            });
            if (!bubble.ok || !(await bubble.json()).shown) throw new Error(`Bubble ${style} was not shown`);
            await delay(special ? 2900 : index === 0 ? 1200 : 450); // the first one also loads the window
            const bubbleCapture = await fetch(`http://127.0.0.1:${metadata.controlPort}/capture-companion-bubble`, { headers: controlHeaders });
            if (!bubbleCapture.ok) throw new Error(`Bubble ${style} capture failed`);
            fs.writeFileSync(path.join(process.env.CCF_SMOKE_COMPANION_CAPTURE_DIR, `bubble-${index + 1}-${style}${special ? "-special" : ""}.png`),
              Buffer.from(await bubbleCapture.arrayBuffer()));
          }
        }
      }
      if (designReload) await runDesignReloadSmoke({ repoRoot, appData, runtimeMetadataPath, metadata, controlHeaders });
    }

    const waitForValue = async (read, what, timeoutMs = 30000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await read();
        if (value) return value;
        await delay(100);
      }
      throw new Error(`Timed out waiting for ${what}`);
    };
    const injectHook = async (payload) => {
      const response = await fetch(`http://127.0.0.1:${metadata.controlPort}/inject-event`, {
        method: "POST", headers: controlHeaders, body: JSON.stringify({ kind: "hook", payload }) });
      if (!response.ok) throw new Error(`Hook injection failed: ${response.status}`);
    };

    // Process-split plan, step 5: the dashboard page subscribes itself and takes the core's state from its own port
    // (real preload, real MessagePortMain into the utility process, real page). Main sends it no ccf:state.
    const dashboardSubscription = (summary) => summary.core?.subscriptions?.find((item) =>
      String(item.id).startsWith("core-") && item.topics?.includes("events"));
    const shown = await fetch(`http://127.0.0.1:${metadata.controlPort}/capture-dashboard`, { headers: controlHeaders });
    if (!shown.ok) throw new Error("Dashboard could not be shown");
    await shown.arrayBuffer();
    const firstPort = await waitForValue(async () => dashboardSubscription(await readDiagnostics()),
      "the dashboard's own state subscription in the core");
    await injectHook({ hook_event_name: "SessionStart", session_id: "smoke-port", cwd: repoRoot, source: "startup" });
    const followed = await waitForValue(async () => {
      const current = dashboardSubscription(await readDiagnostics());
      return current && current.deltas > firstPort.deltas && current.inflight === 0 && current;
    }, "a delta on the dashboard's port, acknowledged by the page");
    console.log(`Dashboard state on its own port: ${followed.frames} frames (${followed.projections} projection), acknowledged`);
    // A core crash under real Electron, while the dashboard's first hook diagnosis runs PowerShell children in the core
    // (once, 2026-11-05, such a kill went unnoticed by main for over 20 s; the hosts now also watch the core's pid, so a
    // missing exit event costs at most a second): main restarts the utility process on the same port, same token.
    if (process.env.CCF_SMOKE_SKIP_CORE_CRASH !== "1") {
      const before = await waitForValue(async () => {
        const diagnostics = await readDiagnostics();
        return diagnostics.pendingHookOperations > 0 && diagnostics;
      }, "the dashboard's hook diagnosis running", 10000).catch(() => readDiagnostics());
      if (!before.pendingHookOperations) console.log("The dashboard's hook diagnosis had finished before the crash");
      process.kill(before.core.pid);
      const killedAt = Date.now();
      const crashDeadline = Date.now() + 20000;
      let after = before;
      while (Date.now() < crashDeadline && (after.core?.pid === before.core.pid || after.core?.status !== "ready")) {
        await delay(100);
        after = await readDiagnostics();
        if (process.env.CCF_SMOKE_DEBUG === "1") console.log("after", JSON.stringify(after.core), JSON.stringify(after.processes.map((p) => [p.pid, p.type, p.name])));
      }
      if (after.core?.pid === before.core.pid || after.core?.status !== "ready" || after.core.hookPort !== before.core.hookPort) {
        throw new Error(`The core did not come back on its port after a crash: ${JSON.stringify(after.core)}`);
      }
      const probe = await fetch(`http://127.0.0.1:${metadata.hookPort}/ready`, { headers: { "x-ccf-token": hookToken } });
      if (!probe.ok) throw new Error(`The restarted core does not accept the hook token: ${probe.status}`);
      console.log(`Core restarted after a crash${before.pendingHookOperations ? " during the hook diagnosis" : ""}: pid `
        + `${before.core.pid} -> ${after.core.pid}, port ${after.core.hookPort}, ready again after ${Date.now() - killedAt} ms`);
      // The dashboard got a new port from the new core (a newer epoch, a fresh projection).
      const reopened = await waitForValue(async () => dashboardSubscription(await readDiagnostics()),
        "the dashboard's subscription in the restarted core");
      console.log(`Dashboard re-subscribed to the restarted core: ${reopened.projections} projection, ${reopened.frames} frames`);
    }

    // The companion in its own utility process (process-split plan, step 4): started only when asked, node-pty and the
    // PowerShell fixture inside it, its child tree bound to it, a crash that leaves the core alone and needs Start.
    let companionTree = [];
    // Not in the design-reload run: it starts CCF without the fixture (above), so Start is refused there.
    if (process.env.CCF_SMOKE_SKIP_COMPANION !== "1" && !designReload) {
      const companionAction = async (payload) => {
        const response = await fetch(`http://127.0.0.1:${metadata.controlPort}/companion-action`, {
          method: "POST", headers: controlHeaders, body: JSON.stringify(payload) });
        const body = await response.json();
        if (!response.ok) throw new Error(`Companion action ${payload.action} failed: ${JSON.stringify(body)}`);
        return body;
      };
      const waitFor = async (read, what, timeoutMs = 30000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = await read();
          if (value) return value;
          await delay(100);
        }
        throw new Error(`Timed out waiting for ${what}`);
      };
      const lazy = await readDiagnostics();
      if (lazy.companion?.mode !== "utility" || lazy.companion.pid !== null) {
        throw new Error(`The companion process started before it was needed: ${JSON.stringify(lazy.companion)}`);
      }
      // The cat's cluster with its conversation window (a test-mode preview of nothing: the live companion shows).
      const cluster = await fetch(`http://127.0.0.1:${metadata.controlPort}/companion-preview`, {
        method: "POST", headers: controlHeaders, body: "null" });
      if (!cluster.ok) throw new Error("The companion cluster could not be shown");
      await companionAction({ action: "start" });
      const started = await waitFor(async () => {
        const diagnostics = await readDiagnostics();
        return diagnostics.companion?.status === "ready" && diagnostics.companion.job && diagnostics.companion.children.length
          && diagnostics;
      }, "the companion process with its PTY child");
      const companionProcess = started.processes.find((item) => item.type === "Utility" && item.name === "Chaos Cat Familiar Companion");
      if (!companionProcess || companionProcess.pid !== started.companion.pid || !started.companion.job.joined
        || started.companion.pid === started.core.pid) {
        throw new Error(`The companion is not a utility process with a joined job: ${JSON.stringify(started.companion)}`);
      }
      const firstTree = await waitFor(() => companionFixture.ptyPids().length === 2 && companionFixture.ptyPids(),
        "the PowerShell fixture and its hidden grandchild in the companion's PTY");
      await companionAction({ action: "raw-input", text: "smoke\r" });
      // Process-split plan, step 5: the terminal's frames reach the conversation page on its own port.
      const framed = await waitFor(async () => {
        const stats = (await readDiagnostics()).companionFrames;
        const port = stats?.subscriptions?.[0];
        return port && port.frames > 1 && stats;
      }, "terminal frames on the conversation window's own port (main gets slim snapshots)");
      console.log(`Conversation frames on their own port: ${framed.subscriptions[0].frames} sent, `
        + `${framed.subscriptions[0].coalesced} coalesced; main gets slim snapshots`);
      console.log(`Companion utility process ${started.companion.pid} runs node-pty with the PowerShell fixture ${firstTree.join(", ")} `
        + `(job joined in ${started.companion.job.ms} ms)`);

      const corePid = started.core.pid;
      process.kill(started.companion.pid);
      await waitFor(async () => (await readDiagnostics()).companion?.status === "crashed", "the companion crash noticed", 15000);
      await waitFor(() => firstTree.every((pid) => !isAlive(pid)), "the fixture's tree gone with the companion", 15000);
      await delay(1500);
      const afterCrash = await readDiagnostics();
      if (afterCrash.companion.status !== "crashed" || afterCrash.companion.pid !== null) {
        throw new Error(`The companion came back without Start: ${JSON.stringify(afterCrash.companion)}`);
      }
      if (afterCrash.core.pid !== corePid || afterCrash.core.status !== "ready") {
        throw new Error(`A companion crash touched the core: ${JSON.stringify(afterCrash.core)}`);
      }
      await companionAction({ action: "start" });
      const restarted = await waitFor(async () => {
        const diagnostics = await readDiagnostics();
        return diagnostics.companion?.status === "ready" && diagnostics.companion.pid !== started.companion.pid && diagnostics;
      }, "the companion restarted on Start");
      companionTree = await waitFor(() => {
        const pids = companionFixture.ptyPids().filter((pid) => !firstTree.includes(pid));
        return pids.length === 2 && pids;
      }, "the fixture after the restart");
      console.log(`Companion killed (fixture tree gone, core untouched) and restarted on Start: pid ${started.companion.pid} -> `
        + `${restarted.companion.pid}`);
      await waitFor(async () => (await readDiagnostics()).companionFrames?.subscriptions?.[0]?.frames > 0,
        "the conversation's frames port to the restarted companion");
    }

    if (process.env.CCF_SMOKE_SKIP_SIDE_PANEL !== "1") {
      await runSidePanelSmoke({ controlPort: metadata.controlPort, controlHeaders, home, delay,
        captureDir: process.env.CCF_SMOKE_COMPANION_CAPTURE_DIR || null });
    }

    const hookInjectResponse = await fetch(`http://127.0.0.1:${metadata.controlPort}/inject-event`, {
      method: "POST",
      headers: controlHeaders,
      body: JSON.stringify({
        kind: "hook",
        payload: {
          hook_event_name: "SessionStart",
          session_id: "windows-smoke-claude",
          cwd: repoRoot,
          source: "startup"
        }
      })
    });
    if (!hookInjectResponse.ok) {
      throw new Error(`Failed to inject Claude smoke event: ${hookInjectResponse.status}`);
    }

    if (process.env.CCF_SMOKE_WORKING_CAPTURE_PATH) {
      await fetch(`http://127.0.0.1:${metadata.controlPort}/inject-event`, {
        method: "POST", headers: controlHeaders,
        body: JSON.stringify({ kind: "hook", payload: { hook_event_name: "PreToolUse",
          session_id: "windows-smoke-claude", tool_name: "Read", cwd: repoRoot } })
      });
      await delay(2500);
      const capture = await fetch(`http://127.0.0.1:${metadata.controlPort}/capture-overlay`, { headers: controlHeaders });
      if (!capture.ok) throw new Error("Working overlay capture failed");
      fs.writeFileSync(process.env.CCF_SMOKE_WORKING_CAPTURE_PATH, Buffer.from(await capture.arrayBuffer()));
    }

    const approvalResponse = await fetch(`http://127.0.0.1:${metadata.controlPort}/inject-event`, {
      method: "POST",
      headers: controlHeaders,
      body: JSON.stringify({
        kind: "hook",
        payload: {
          hook_event_name: "PermissionRequest",
          session_id: "windows-smoke-claude",
          cwd: repoRoot,
          tool_name: "Edit",
          tool_input: { file_path: path.join(repoRoot, "README.md") }
        }
      })
    });
    if (!approvalResponse.ok) {
      throw new Error(`Failed to inject Claude approval: ${approvalResponse.status}`);
    }

    const awaitResponses = await Promise.all([
      fetch(`http://127.0.0.1:${metadata.controlPort}/await-state`, {
        method: "POST",
        headers: controlHeaders,
        body: JSON.stringify({
          type: "session",
          match: { id: "windows-smoke-claude", assistantLabel: "Claude" },
          timeoutMs: 15000
        })
      }),
      fetch(`http://127.0.0.1:${metadata.controlPort}/await-state`, {
        method: "POST",
        headers: controlHeaders,
        body: JSON.stringify({
          type: "approval",
          match: { assistantLabel: "Claude" },
          timeoutMs: 15000
        })
      })
    ]);
    for (const response of awaitResponses) {
      if (!response.ok) {
        throw new Error(`Timed out awaiting runtime state: ${response.status}`);
      }
    }

    const diagnosticsResponse = await waitForOk(`http://127.0.0.1:${metadata.controlPort}/diagnostics-summary`, {
      "x-ccf-test-token": token
    }, 15000);
    const diagnostics = await diagnosticsResponse.json();
    if (diagnostics.activeSessionCount < 1 || diagnostics.pendingApprovalCount < 1) {
      throw new Error("Expected a Claude session and a pending approval in diagnostics summary");
    }
    // Requests a utility process makes of main (the core's effects; the companion's delivery records) need main's
    // "ready", which Electron used to refuse right after fork (found 2026-11-05, step 6): they must arrive.
    if (!(diagnostics.effects?.delivered > 0)) {
      throw new Error(`The core's effects never reached main: ${JSON.stringify(diagnostics.effects)}`);
    }
    console.log(`Core effects acknowledged by main: ${diagnostics.effects.delivered}`);
    // Main's synchronous native work under real Electron (final review of the process split, item 5): a burst of hook
    // events, each a state broadcast with the HUD layout pass, while the liveness checks tick.
    const burst = Number(process.env.CCF_SMOKE_LATENCY_EVENTS ?? 200);
    for (let index = 0; index < burst; index++) {
      await injectHook({ hook_event_name: "PreToolUse", session_id: "windows-smoke-claude", tool_name: "Read", cwd: repoRoot,
        tool_input: { file_path: path.join(repoRoot, `latency-${index}.md`) } });
    }
    await delay(1500);
    const latency = (await readDiagnostics());
    console.log(`Main latency after ${burst} hook events: ${JSON.stringify({ ...latency.mainLatency,
      eventLoop: latency.eventLoop ? { p99Ms: latency.eventLoop.p99Ms ?? latency.eventLoop.current?.p99Ms ?? null,
        maxMs: latency.eventLoop.maxMs ?? latency.eventLoop.current?.maxMs ?? null } : null })}`);

    const snapshotResponse = await waitForOk(`http://127.0.0.1:${metadata.controlPort}/snapshot`, {
      "x-ccf-test-token": token
    }, 15000);
    const snapshot = await snapshotResponse.json();
    const rendererErrors = (snapshot.state.logs ?? []).filter((item) => item.level === "error"
      && !(designReload && item.category === "ipc" && item.message === "IPC invoke failed: ccf:companion-action"
        && item.context?.error?.includes("Claude Code start is disabled in test mode."))
      // The crashes this smoke induced on purpose, and a request the open dashboard had in flight at that moment.
      && !(item.category === "core" && item.message === "Core process exited unexpectedly")
      && !(item.category === "ipc" && /service is closed \(core exited/.test(item.context?.error ?? ""))
      && !(item.category === "companion" && item.message.startsWith("Companion process exited unexpectedly")));
    if (rendererErrors.length) throw new Error(`Renderer/runtime errors: ${JSON.stringify(rendererErrors)}`);
    if (!snapshot.state?.notifications?.some((item) => item.body?.includes("Claude wants to use Edit"))) {
      throw new Error("Expected a Claude approval notification in the runtime snapshot");
    }

    const firstId = snapshot.state.approvals[0].id;
    const allowed = await fetch(`http://127.0.0.1:${metadata.hookPort}/approvals/${firstId}/allow`, { method: "POST", headers: { "x-ccf-token": hookToken } });
    if (!allowed.ok) throw new Error("Approval action failed");

    // A second real client must be released on shutdown without an allow/deny answer.
    const pendingResponse = fetch(`http://127.0.0.1:${metadata.hookPort}/hook`, {
      method: "POST", headers: { "content-type": "application/json", "x-ccf-token": hookToken },
      body: JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "shutdown-client", cwd: repoRoot, tool_name: "Bash", tool_input: { command: "echo smoke" } }),
      signal: AbortSignal.timeout(15000)
    });
    const pendingReady = await fetch(`http://127.0.0.1:${metadata.controlPort}/await-state`, {
      method: "POST", headers: controlHeaders, body: JSON.stringify({ type: "session", match: { id: "shutdown-client" } })
    });
    if (!pendingReady.ok) throw new Error("Second session did not connect");
    if (process.env.CCF_SMOKE_CAPTURE_PATH) {
      await delay(500);
      const capture = await fetch(`http://127.0.0.1:${metadata.controlPort}/capture-overlay`, { headers: controlHeaders });
      fs.writeFileSync(process.env.CCF_SMOKE_CAPTURE_PATH.replace(/\.png$/i, "-waiting.png"), Buffer.from(await capture.arrayBuffer()));
    }
    if (process.env.CCF_SMOKE_CAPTURE_PATH) {
      for (let cycle = 0; cycle < 2; cycle += 1) {
        const capture = await fetch(`http://127.0.0.1:${metadata.controlPort}/capture-dashboard`, { headers: controlHeaders });
        if (!capture.ok) throw new Error("Dashboard capture failed");
        if (cycle === 0) fs.writeFileSync(process.env.CCF_SMOKE_CAPTURE_PATH.replace(/\.png$/i, "-dashboard.png"), Buffer.from(await capture.arrayBuffer()));
        else await capture.arrayBuffer();
        await fetch(`http://127.0.0.1:${metadata.controlPort}/close-dashboard`, { method: "POST", headers: controlHeaders });
      }
    }
    const shutdownResponse = await fetch(`http://127.0.0.1:${metadata.controlPort}/shutdown`, {
      method: "POST",
      headers: {
        "x-ccf-test-token": token
      }
    });
    if (!shutdownResponse.ok) {
      throw new Error(`Graceful shutdown failed: ${shutdownResponse.status}`);
    }

    if ((await pendingResponse).status !== 204) throw new Error("Shutdown did not defer pending permission");
    await supervisor.waitForExit(30000);
    await ensureGone(runtimeMetadataPath);
    // Process-split plan, step 6: the state is in ccf.sqlite, committed by the core's storage worker.
    const stored = await storedState(path.join(appData, "chaos-cat-familiar"));
    if (!stored?.state.sessions?.some((session) => session.id === "shutdown-client")) {
      throw new Error("Shutdown did not commit the latest state to ccf.sqlite");
    }
    console.log(`State committed to ccf.sqlite: ${stored.state.sessions.length} sessions, ${stored.state.events.length} events`);
    if (fs.existsSync(path.join(appData, "chaos-cat-familiar", "run-marker.json"))) {
      throw new Error("Successful shutdown left an unclean-run marker");
    }
    const finalLog = fs.readFileSync(path.join(appData, "chaos-cat-familiar", "logs", "chaos-cat-familiar.log"), "utf8");
    if (!finalLog.includes("Stopping Windows shell runtime")) throw new Error("Shutdown log buffer was not flushed");
    const leftovers = companionTree.filter(isAlive);
    if (leftovers.length) throw new Error(`Quit left companion children running: ${leftovers.join(", ")}`);
    if (companionTree.length) console.log("Quit ended the companion's child tree");
  } catch (error) {
    console.error(`[ccf-windows-smoke] Check failed: ${error.stack ?? error.message}`);
    await supervisor.killTree();
    try {
      const log = fs.readFileSync(path.join(appData, "chaos-cat-familiar", "logs", "chaos-cat-familiar.log"), "utf8");
      const lines = log.split(/\r?\n/);
      const notable = lines.filter((line) => /\[(warn|error)\]/.test(line)).slice(-30);
      if (notable.length) console.error(`[ccf-windows-smoke] Warnings and errors in the CCF log:\n${notable.join("\n")}`);
      console.error(`[ccf-windows-smoke] Last lines of the CCF log:\n${lines.slice(-25).join("\n")}`);
    } catch { /* no log */ }
    for (const pid of companionFixture.ptyPids()) { try { process.kill(pid); } catch {} }
    throw error;
  } finally {
    await supervisor.closeLog();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      throw new Error(`Smoke temp cleanup failed at ${tmpRoot}: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error(`[ccf-windows-smoke] ${error.message}`);
  process.exitCode = 1;
});
