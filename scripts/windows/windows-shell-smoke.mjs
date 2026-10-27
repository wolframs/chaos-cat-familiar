import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnLoggedProcess, waitForJson, ensureGone } from "./process-supervisor.mjs";
import { runDesignReloadSmoke } from "./design-reload-smoke.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const appDir = path.join(repoRoot, "apps", "windows-shell");
const electronCmd = path.join(repoRoot, "node_modules", ".bin", "electron.cmd");

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
  if (!fs.existsSync(electronCmd)) {
    throw new Error(`Electron dependency missing at ${electronCmd}. Run npm install first.`);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-win-smoke-"));
  const home = path.join(tmpRoot, "home");
  const appData = path.join(tmpRoot, "appdata");
  const logFile = path.join(tmpRoot, "smoke.log");
  const token = `smoke-${Date.now()}`;
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });

  if (process.env.CCF_SMOKE_DIAGNOSTICS === "1") {
    const settingsDir = path.join(appData, "chaos-cat-familiar");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({ debugLogging: true, performanceProfiling: true }));
  }
  const runtimeMetadataPath = path.join(appData, "chaos-cat-familiar", "runtime.json");
  const designReload = process.env.CCF_SMOKE_DESIGN_RELOAD === "1";
  const supervisor = spawnLoggedProcess(electronCmd, designReload ? [".", "--remote-debugging-port=0"] : ["."], {
    cwd: appDir,
    env: {
      ...process.env,
      CCF_HOME_OVERRIDE: home,
      CCF_APPDATA_OVERRIDE: appData,
      CCF_PORT_OVERRIDE: "0",
      CCF_TEST_MODE: "1",
      ...(designReload ? { CCF_DESIGN_RELOAD: "1" } : {}),
      CCF_TEST_DISPLAY: "rightmost",
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
        }
      }
      if (designReload) await runDesignReloadSmoke({ repoRoot, appData, runtimeMetadataPath, metadata, controlHeaders });
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

    const snapshotResponse = await waitForOk(`http://127.0.0.1:${metadata.controlPort}/snapshot`, {
      "x-ccf-test-token": token
    }, 15000);
    const snapshot = await snapshotResponse.json();
    const rendererErrors = (snapshot.state.logs ?? []).filter((item) => item.level === "error"
      && !(designReload && item.category === "ipc" && item.message === "IPC invoke failed: ccf:companion-action"
        && item.context?.error?.includes("Claude Code start is disabled in test mode.")));
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
    const statePath = path.join(appData, "chaos-cat-familiar", "state.json");
    const checkpoint = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (!checkpoint.sessions?.some((session) => session.id === "shutdown-client")) {
      throw new Error("Shutdown did not flush the latest state checkpoint");
    }
    if (fs.existsSync(path.join(appData, "chaos-cat-familiar", "run-marker.json"))) {
      throw new Error("Successful shutdown left an unclean-run marker");
    }
    const finalLog = fs.readFileSync(path.join(appData, "chaos-cat-familiar", "logs", "chaos-cat-familiar.log"), "utf8");
    if (!finalLog.includes("Stopping Windows shell runtime")) throw new Error("Shutdown log buffer was not flushed");
  } catch (error) {
    console.error(`[ccf-windows-smoke] Check failed: ${error.stack ?? error.message}`);
    await supervisor.killTree();
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
