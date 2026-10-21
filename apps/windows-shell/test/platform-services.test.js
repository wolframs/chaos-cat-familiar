import test from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ElectronActivationService,
  ElectronHookInstallationService,
  ElectronNotificationService,
  __testing
} from "../services/platform-services.js";

const execFileAsync = promisify(execFile);

test("hook ancestry finds the interactive shell above Claude, not hook wrappers", { skip: process.platform !== "win32" }, async () => {
  const cases = [
    { processes: [[99, 50, "powershell.exe"], [50, 40, "cmd.exe", "cmd /c hook"], [40, 30, "claude.exe"], [30, 20, "pwsh.exe", "pwsh -NoLogo"]], expected: 30 },
    { processes: [[99, 40, "powershell.exe"], [40, 35, "node.exe", "node C:\\npm\\@anthropic-ai\\claude-code\\cli.js"], [35, 30, "cmd.exe", "cmd /c claude"], [30, 20, "bash.exe", "bash --login"]], expected: 30 },
    { processes: [[99, 30, "powershell.exe"], [30, 20, "pwsh.exe"]], expected: null },
    { processes: [[99, 40, "powershell.exe"], [40, 30, "claude.exe"], [30, 99, "node.exe"]], expected: null },
    { processes: [[99, 40, "powershell.exe"], [40, 30, "claude.exe"], [30, 20, "cmd.exe", "cmd /c claude"]], expected: null },
    { processes: [[99, 40, "powershell.exe"], [40, 30, "claude.exe"], [30, 20, "pwsh.exe", "pwsh -NoExit -Command init"]], expected: 30 },
    { processes: [[99, 40, "powershell.exe"], [40, 30, "claude.exe"], [30, 20, "pwsh.exe", "pwsh -File hook.ps1"]], expected: null },
    { processes: [[99, 40, "powershell.exe", "powershell", "2026-10-19T10:00:00"], [40, 30, "claude.exe", "claude", "2026-10-19T11:00:00"], [30, 20, "pwsh.exe"]], expected: null },
    { processes: Array.from({ length: 30 }, (_, index) => [99 - index, 98 - index, index === 29 ? "pwsh.exe" : index === 1 ? "claude.exe" : "node.exe"]), expected: null }
  ];
  const source = __testing.buildHookProcessIdentificationScript();
  const scripts = cases.map(({ processes, expected }) => {
    const records = processes.map(([ProcessId, ParentProcessId, Name, CommandLine = Name, CreationDate = null]) => ({ ProcessId, ParentProcessId, Name, CommandLine, CreationDate }));
    return `
      $records = '${JSON.stringify(records).replace(/'/g, "''")}' | ConvertFrom-Json
      function Get-CimInstance { param($ClassName, $Filter, $Property, $ErrorAction) if ($Filter) { $targetId = [int]($Filter -replace '\\D', ''); $records | Where-Object ProcessId -eq $targetId } else { $records } }
      $actual = Find-CcfSessionShellPid -SenderPid 99
      if ($actual -ne ${expected ?? "$null"}) { throw "Expected ${expected}, got $actual" }
      $ancestorIds = & { ${__testing.buildProcessAncestorScript(99)} } | ConvertFrom-Json
      if ($ancestorIds[0] -ne 99 -or $ancestorIds.Count -gt 24) { throw 'Invalid window ancestry result' }
    `;
  });
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; ${source}\n${scripts.join("\n")}`], { windowsHide: true, timeout: 15000 });
});

test("hook installation emits only discovered session shell identity", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-hook-identity-"));
  t.after(() => {
    assert.equal(path.resolve(path.dirname(home)), path.resolve(os.tmpdir()));
    assert.equal(path.basename(home).startsWith("ccf-hook-identity-"), true);
    fs.rmSync(home, { recursive: true, force: true });
  });
  const installer = new ElectronHookInstallationService({ getHomePath: () => home }, { load: () => ({ port: 12345 }) }, null);
  // Keep installation isolated: diagnostics otherwise probes the operator's environment.
  installer.diagnose = async () => ({ registeredEvents: [] });
  const result = await installer.install();
  const script = fs.readFileSync(result.hookPath, "utf8");
  assert.doesNotMatch(script, /-NotePropertyValue \$PID/);
  assert.match(script, /Add-CcfSessionShellIdentity -Payload \$payload -SenderPid \$PID/);
  assert.match(script, /if \(\$sessionShellPid\).*shell_pid -NotePropertyValue \$sessionShellPid/);
  assert.doesNotMatch(script, /Add-Member -NotePropertyName terminal_pid/);
  if (process.platform === "win32") {
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${result.hookPath.replace(/'/g, "''")}', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { throw ($errors | Out-String) }`], { windowsHide: true, timeout: 10000 });
  }
});

test("routine hooks skip CIM ancestry while session and permission hooks resolve a shell", { skip: process.platform !== "win32" }, async () => {
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    $script:cimCalls = 0
    function Get-CimInstance {
      param($ClassName, $Filter, $Property, $ErrorAction)
      $script:cimCalls++
      [pscustomobject]@{ ProcessId = 99; ParentProcessId = 40; Name = 'powershell.exe' }
      [pscustomobject]@{ ProcessId = 40; ParentProcessId = 30; Name = 'claude.exe' }
      [pscustomobject]@{ ProcessId = 30; ParentProcessId = 20; Name = 'pwsh.exe'; CommandLine = 'pwsh' }
    }
    ${__testing.buildHookProcessIdentificationScript()}
    foreach ($eventName in @('PostToolUse', 'PreToolUse', 'Stop', 'Notification')) {
      $payload = [pscustomobject]@{ hook_event_name = $eventName; shell_pid = 99; terminal_pid = 99 }
      Add-CcfSessionShellIdentity -Payload $payload -SenderPid 99
      if ($script:cimCalls -ne 0 -or $payload.shell_pid -or $payload.terminal_pid) { throw "Routine event $eventName performed ancestry work or retained a sender PID" }
    }
    foreach ($eventName in @('SessionStart', 'UserPromptSubmit', 'PermissionRequest')) {
      $script:cimCalls = 0
      $payload = [pscustomobject]@{ hook_event_name = $eventName }
      Add-CcfSessionShellIdentity -Payload $payload -SenderPid 99
      if ($script:cimCalls -ne 1 -or $payload.shell_pid -ne 30) { throw "Identity event $eventName did not resolve the session shell" }
    }
  `;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 10000 });
});

test("foreground activation script parses as PowerShell without focusing a window", { skip: process.platform !== "win32" }, async () => {
  const source = __testing.buildFocusProcessWindowScript(123);
  const script = `$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseInput('${source.replace(/'/g, "''")}', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { throw ($errors | Out-String) }`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 10000 });
});

test("editor helper dispatch does not claim confirmed terminal focus", async () => {
  const uris = [];
  const service = new ElectronActivationService({ openExternal: async (uri) => uris.push(uri) }, null, {
    listRunningWindows: async () => [],
    focusProcessWindow: async () => { throw new Error("Unexpected focus"); }
  });
  const result = await service.activateEditor({ editor: "vscode", shellPid: 123, projectDir: "C:\\repo" });
  assert.deepEqual(uris, ["vscode://wolframs.ccf-terminal-focus/focus?pid=123"]);
  assert.equal(result.exactTabConfirmed, false);
  assert.equal(result.detail, "helper_uri_dispatched_without_acknowledgement");
});

test("session return prefers the shell ancestor window over another project's terminal", async () => {
  const focused = [];
  const service = new ElectronActivationService({}, null, {
    listRunningWindows: async () => [
      { id: 1, processName: "WindowsTerminal", mainWindowTitle: "repo - Terminal" },
      { id: 2, processName: "Code", mainWindowTitle: "repo - Visual Studio Code" }
    ],
    listProcessAncestorIds: async (pid) => { assert.equal(pid, 123); return [123, 5, 2]; },
    focusProcessWindow: async (pid) => { focused.push(pid); return { ok: true }; }
  });
  const result = await service.activateTerminal({ shellPid: 123, projectDir: "C:\\repo" });
  assert.deepEqual(focused, [2]);
  assert.equal(result.targetSource, "shell_ancestor");
  assert.equal(result.exactTabConfirmed, false);
  assert.equal(result.pid, 2);
});

test("session return falls back to project ranking when ancestry is unavailable", async () => {
  const focused = [];
  const service = new ElectronActivationService({}, null, {
    listRunningWindows: async () => [
      { id: 1, processName: "WindowsTerminal", mainWindowTitle: "other - Terminal" },
      { id: 2, processName: "Code", mainWindowTitle: "repo - Visual Studio Code" }
    ],
    listProcessAncestorIds: async () => [],
    focusProcessWindow: async (pid) => { focused.push(pid); return { ok: true }; }
  });
  const result = await service.activateTerminal({ shellPid: 123, projectDir: "C:\\repo" });
  assert.deepEqual(focused, [2]);
  assert.equal(result.targetSource, "project_title");
  assert.equal(result.exactTabConfirmed, false);
});

test("window fallback excludes unrelated editor windows", async () => {
  const focused = [];
  const service = new ElectronActivationService({}, null, {
    listRunningWindows: async () => [
      { id: 1, processName: "Code", mainWindowTitle: "repos - Visual Studio Code" },
      { id: 2, processName: "WindowsTerminal", mainWindowTitle: "Terminal" }
    ],
    listProcessAncestorIds: async () => [],
    focusProcessWindow: async (pid) => { focused.push(pid); return { ok: true }; }
  });
  const result = await service.activateTerminal({ projectDir: "C:\\repos\\project" });
  assert.deepEqual(focused, [2]);
  assert.equal(result.targetSource, "window_fallback");
});

class FakeLogger {
  constructor() {
    this.entries = [];
  }

  info(category, message, context) {
    this.entries.push({ level: "info", category, message, context });
  }

  warn(category, message, context) {
    this.entries.push({ level: "warn", category, message, context });
  }

  error(category, message, context) {
    this.entries.push({ level: "error", category, message, context });
  }
}

class FakeNotification {
  static isSupported() {
    return true;
  }

  constructor(payload) {
    this.payload = payload;
    FakeNotification.created.push(this);
  }

  on(eventName, handler) {
    this.handlers ??= {};
    this.handlers[eventName] = handler;
  }

  show() {
    FakeNotification.shown.push(this.payload);
  }
}

FakeNotification.created = [];
FakeNotification.shown = [];

test("notification service suppresses disabled notifications", async () => {
  const logger = new FakeLogger();
  const service = new ElectronNotificationService(
    FakeNotification,
    logger,
    () => {},
    () => ({ enabled: false, minPriority: "high" })
  );

  await service.notify({
    title: "Permission required",
    body: "Approve edit access",
    priority: "urgent"
  });

  assert.equal(FakeNotification.shown.length, 0);
  assert.equal(
    logger.entries.some((entry) => entry.message === "Notification suppressed by preferences"),
    true
  );
});

test("notification service suppresses events below the configured minimum priority", async () => {
  const logger = new FakeLogger();
  FakeNotification.created = [];
  FakeNotification.shown = [];
  const service = new ElectronNotificationService(
    FakeNotification,
    logger,
    () => {},
    () => ({ enabled: true, minPriority: "urgent" })
  );

  await service.notify({
    title: "Task completed",
    body: "Background step finished",
    priority: "high"
  });

  assert.equal(FakeNotification.shown.length, 0);
  assert.equal(
    logger.entries.some((entry) => entry.message === "Notification suppressed below minimum priority"),
    true
  );
});

test("notification service shows notifications that meet the configured threshold", async () => {
  const logger = new FakeLogger();
  FakeNotification.created = [];
  FakeNotification.shown = [];
  let clicked = false;
  const service = new ElectronNotificationService(
    FakeNotification,
    logger,
    () => {
      clicked = true;
    },
    () => ({ enabled: true, minPriority: "normal" })
  );

  await service.notify({
    title: "Permission required",
    body: "Approve edit access",
    priority: "urgent",
    sessionId: "session-1"
  });

  assert.equal(FakeNotification.shown.length, 1);
  assert.equal(FakeNotification.shown[0].urgency, "critical");
  assert.match(FakeNotification.shown[0].icon, /apps[\\/]windows-shell[\\/]assets[\\/]ccf-logo\.svg$/);
  FakeNotification.created[0].handlers.click();
  assert.equal(clicked, true);
});

test("hook drift reports missing events and mismatched commands independently", () => {
  const drift = __testing.describeHookDrift({
    commandMatches: [
      {
        eventName: "PreToolUse",
        commands: ["powershell -ExecutionPolicy Bypass -File \"C:/wrong/path.ps1\""]
      },
      {
        eventName: "PostToolUse",
        commands: []
      }
    ],
    expectedEvents: ["PreToolUse", "PostToolUse", "Notification"],
    expectedHookPath: "C:/expected/hook-sender.ps1"
  });

  assert.equal(drift.healthy, false);
  assert.deepEqual(drift.missingEvents, ["PostToolUse", "Notification"]);
  assert.equal(drift.unexpectedCommands.length, 1);
  assert.equal(drift.unexpectedCommands[0].eventName, "PreToolUse");
});

test("project-aware window ranking prefers full project path and basename matches", () => {
  const ranked = __testing.rankWindowsForProject(
    [
      {
        id: 2,
        processName: "WindowsTerminal",
        mainWindowTitle: "Windows Terminal"
      },
      {
        id: 1,
        processName: "WindowsTerminal",
        mainWindowTitle: "api-service - C:\\Users\\dev\\repos\\chaos-cat-familiar - Windows Terminal"
      }
    ],
    "C:\\Users\\dev\\repos\\chaos-cat-familiar",
    ["terminal", "windows terminal", "wt"]
  );

  assert.equal(ranked[0].id, 1);
  assert.equal(ranked[0].matchScore > ranked[1].matchScore, true);
  assert.equal(ranked[0].matchReasons.includes("basename:chaos-cat-familiar"), true);
});

test("hook drift stays healthy when expected commands are present", () => {
  const drift = __testing.describeHookDrift({
    commandMatches: [
      {
        eventName: "PreToolUse",
        commands: ["powershell -ExecutionPolicy Bypass -File \"C:/expected/hook-sender.ps1\""]
      },
      {
        eventName: "Notification",
        commands: ["powershell -ExecutionPolicy Bypass -File \"C:/expected/hook-sender.ps1\""]
      }
    ],
    expectedEvents: ["PreToolUse", "Notification"],
    expectedHookPath: "C:/expected/hook-sender.ps1"
  });

  assert.equal(drift.healthy, true);
  assert.deepEqual(drift.missingEvents, []);
  assert.deepEqual(drift.unexpectedCommands, []);
});


test("lightweight hook diagnosis checks local registration and health without environment discovery", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-light-diagnose-"));
  const server = http.createServer((_req, res) => res.end("ok"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const installer = new ElectronHookInstallationService({ getHomePath: () => home },
    { load: () => ({ port: server.address().port }) }, null);
  const diagnosis = await installer.diagnose({ detailed: false });
  assert.equal(diagnosis.health.ok, true);
  assert.equal(diagnosis.discoverySkipped, true);
  assert.deepEqual(diagnosis.environments, []);
  assert.deepEqual(diagnosis.claudeProcesses, []);
  assert.equal(diagnosis.hookExists, false);
  assert.equal(diagnosis.drift.healthy, false);
});
