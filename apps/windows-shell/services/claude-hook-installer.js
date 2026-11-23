import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeJsonAtomicAsync } from "../../../packages/core/src/atomic-json.js";
import { isCcfOwnedHook, removeCcfHookRegistrations } from "./claude-hook-cleanup.js";
import { firstExisting, listRunningWindows, rankWindowsForProject } from "./platform-services.js";

// Claude Code's hook files: the generated PowerShell sender and CCF's entries in ~/.claude/settings.json (install,
// repair, removal, the diagnosis report). The core process's work (process-split plan, step 3); main never loads this
// module (step 7, main-boundary.test.js).

const execFileAsync = promisify(execFile);
const CLAUDE_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "Notification",
  "SessionStart",
  "SessionEnd",
  "TaskCompleted",
  "PermissionRequest",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "ConfigChange",
  "TeammateIdle"
];

// Only these events go through the PowerShell sender: SessionStart accepts no http hooks, and the
// sender adds the session's shell_pid (a Win32_Process walk) to exactly these three. Every other
// event is a Claude Code http hook: no Git Bash + powershell.exe start per event (an ETW capture on
// 2026-11-02 counted 712 sender starts in 30 minutes, ~2.6 s and ~0.7 CPU-s each).
const COMMAND_HOOK_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PermissionRequest"]);

// With settings.hookRelayPort set, routine events go to ccf-hook-relay (apps/hook-relay) instead: it is always up,
// answers at once and forwards to CCF, so a closed CCF no longer puts "hook error / ECONNREFUSED" notices into every
// Claude Code session (Claude Code shows one per failed http hook and cannot hide them; 2026-11-02).
function routineHookPort(settings) {
  const relay = Number(settings.hookRelayPort);
  return Number.isInteger(relay) && relay > 0 && relay < 65536 ? relay : settings.port;
}

function buildHookRegistration(eventName, hookPath, settings = {}) {
  if (!COMMAND_HOOK_EVENTS.has(eventName)) {
    return {
      type: "http",
      url: `http://127.0.0.1:${routineHookPort(settings)}/hook`,
      headers: { "X-Ccf-Token": String(settings.hookToken ?? "") },
      timeout: 5
    };
  }
  return {
    type: "command",
    command: `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${hookPath}"`,
    ...(eventName === "PermissionRequest" ? { timeout: 130 } : { async: true })
  };
}

async function updateClaudeSettings(settingsPath, transform) {
  // Re-read immediately before merging: never reuse the install-time snapshot.
  // Atomic rename protects readers; a writer racing the rename still requires
  // cooperation from Claude Code, which does not expose a shared settings lock.
  // Rename retries wait asynchronously (process-split step 6: none blocks the core's event loop).
  const raw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : "";
  const current = raw ? JSON.parse(raw) : {};
  const updated = transform(current);
  if (JSON.stringify(updated) !== JSON.stringify(current)) {
    await writeJsonAtomicAsync(settingsPath, updated);
  }
}

function buildHookSenderScript(settings) {
  return [
    "$utf8 = New-Object System.Text.UTF8Encoding($false)",
    "[Console]::InputEncoding = $utf8",
    "[Console]::OutputEncoding = $utf8",
    "$inputJson = [Console]::In.ReadToEnd()",
    "if (-not $inputJson) { $inputJson = '{}' }",
    `$port = ${settings.port}`,
    `$headers = @{ 'X-Ccf-Token' = '${String(settings.hookToken ?? "").replace(/'/g, "''")}' }`,
    "try { Invoke-RestMethod -Method Get -Uri \"http://127.0.0.1:$port/health\" -TimeoutSec 1 | Out-Null } catch { exit 0 }",
    "$payload = $inputJson | ConvertFrom-Json",
    buildHookProcessIdentificationScript(),
    "Add-CcfSessionShellIdentity -Payload $payload -SenderPid $PID",
    "$json = $payload | ConvertTo-Json -Depth 20 -Compress",
    "$body = [Text.Encoding]::UTF8.GetBytes($json)",
    "if ($payload.hook_event_name -eq 'PermissionRequest') {",
    "  try {",
    "    $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri \"http://127.0.0.1:$port/hook\" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 120",
    "    if ($response.Content) { [Console]::Out.Write($response.Content) }",
    "  } catch { exit 0 }",
    "} else {",
    "  try { Invoke-WebRequest -UseBasicParsing -Method Post -Uri \"http://127.0.0.1:$port/hook\" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 2 | Out-Null } catch { }",
    "}",
    "exit 0"
  ].join("\n");
}

export class ElectronHookInstallationService {
  constructor(runtimeContext, settingsStore, logger) {
    this.runtimeContext = runtimeContext;
    this.settingsStore = settingsStore;
    this.logger = logger;
  }

  async install() {
    const settings = this.settingsStore.load();
    const home = this.runtimeContext.getHomePath();
    const claudeDir = path.join(home, ".claude");
    const claudeSettingsPath = path.join(claudeDir, "settings.json");
    const ccfDir = path.join(home, ".chaos-cat-familiar");
    const hookPath = path.join(ccfDir, "hooks", "hook-sender.ps1");

    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.mkdirSync(claudeDir, { recursive: true });

    const hookScript = buildHookSenderScript(settings);
    if (!fs.existsSync(hookPath) || fs.readFileSync(hookPath, "utf8") !== hookScript) {
      fs.writeFileSync(hookPath, hookScript, "utf8");
    }

    await updateClaudeSettings(claudeSettingsPath, (current) => {
      // Rebuild only CCF-owned commands, including obsolete worktree handlers.
      const next = removeCcfHookRegistrations(current, hookPath).updated;
      next.hooks ??= {};
      for (const eventName of CLAUDE_HOOK_EVENTS) {
        next.hooks[eventName] ??= [];
        next.hooks[eventName].push({ matcher: "", hooks: [buildHookRegistration(eventName, hookPath, settings)] });
      }
      return next;
    });
    const result = await this.diagnose({ detailed: false });
    this.logger?.info("hooks", "Claude hooks installed or updated", {
      claudeSettingsPath,
      hookPath,
      registeredEvents: result.registeredEvents
    });
    return {
      ok: true,
      action: "install",
      claudeSettingsPath,
      hookPath,
      registeredEvents: result.registeredEvents
    };
  }

  async repair() {
    const before = await this.diagnose({ detailed: false });
    const installResult = await this.install();
    const after = await this.diagnose({ detailed: false });
    const repaired = [];
    if (before.drift.senderMismatch && !after.drift.senderMismatch) {
      repaired.push("regenerated stale hook sender");
    }
    if (!before.hookExists && after.hookExists) {
      repaired.push("recreated hook script");
    }
    if (after.registeredEvents.length > before.registeredEvents.length) {
      repaired.push("rewrote Claude hook registration");
    }
    if (after.health.ok) {
      repaired.push("verified local hook server health");
    }
    if (before.drift.missingEvents.length > 0 && after.drift.missingEvents.length === 0) {
      repaired.push("restored missing hook event registrations");
    }
    if (before.drift.unexpectedCommands.length > 0) {
      repaired.push("replaced stale or mismatched hook commands");
    }
    if (before.drift.registrationMismatch?.length > 0 && !after.drift.registrationMismatch?.length) {
      repaired.push("rewrote hook registrations with a stale transport, port or token");
    }
    this.logger?.info("hooks", "Claude hooks repaired", {
      repaired,
      beforeDrift: before.drift,
      afterDrift: after.drift
    });
    return {
      ...installResult,
      action: "repair",
      repaired,
      health: after.health,
      driftBefore: before.drift,
      driftAfter: after.drift
    };
  }

  async uninstall() {
    const home = this.runtimeContext.getHomePath();
    const claudeSettingsPath = path.join(home, ".claude", "settings.json");
    const hookPath = path.join(home, ".chaos-cat-familiar", "hooks", "hook-sender.ps1");
    let changed = false;
    let removedEvents = [];

    if (fs.existsSync(claudeSettingsPath)) {
      await updateClaudeSettings(claudeSettingsPath, (current) => {
        const result = removeCcfHookRegistrations(current, hookPath);
        changed = result.changed;
        removedEvents = result.removedEvents;
        return result.updated;
      });
    }

    if (fs.existsSync(hookPath)) {
      fs.rmSync(hookPath, { force: true });
    }

    this.logger?.info("hooks", "Claude hooks removed", {
      changed,
      removedEvents,
      hookPath
    });
    return {
      ok: true,
      action: "uninstall",
      changed,
      removedEvents,
      hookPath
    };
  }

  async diagnose({ detailed = true } = {}) {
    const settings = this.settingsStore.load();
    const home = this.runtimeContext.getHomePath();
    const claudeSettingsPath = path.join(home, ".claude", "settings.json");
    const hookPath = path.join(home, ".chaos-cat-familiar", "hooks", "hook-sender.ps1");
    const claudeSettings = fs.existsSync(claudeSettingsPath)
      ? JSON.parse(fs.readFileSync(claudeSettingsPath, "utf8"))
      : null;

    const hookCommand = buildHookRegistration("PermissionRequest", hookPath).command;
    const hookUrl = buildHookRegistration("Stop", hookPath, settings).url;
    const registeredEvents = [];
    const commandMatches = [];
    if (claudeSettings?.hooks) {
      for (const [eventName, entries] of Object.entries(claudeSettings.hooks)) {
        const hooks = Array.isArray(entries) ? entries.flatMap((entry) => entry.hooks ?? []) : [];
        if (hooks.some((hook) => isCcfOwnedHook(hook, hookPath))) {
          registeredEvents.push(eventName);
        }
        commandMatches.push({
          eventName,
          commands: hooks.filter((hook) => hook.command != null).map((hook) => String(hook.command)),
          hooks
        });
      }
    }

    const health = await detectHealth(settings.port);
    // Hook setup only needs local files and server health. Expensive OS discovery is on demand.
    const environments = detailed ? await detectShellEnvironments() : [];
    const editors = detailed ? await detectEditors() : [];
    const runningWindows = detailed ? {
      vscode: rankWindowsForProject(await listRunningWindows(["Code"]), null),
      cursor: rankWindowsForProject(await listRunningWindows(["Cursor"]), null),
      windowsTerminal: rankWindowsForProject(await listRunningWindows(["WindowsTerminal", "wt"]), null, ["terminal", "windows terminal", "wt"])
    } : { vscode: [], cursor: [], windowsTerminal: [] };
    const claudeProcesses = detailed ? await detectClaudeProcesses() : [];


    return {
      ok: true,
      discoverySkipped: !detailed,
      port: settings.port,
      platform: os.platform(),
      desktop: {
        notificationsSupported: this.runtimeContext.notificationsSupported?.() ?? false,
        openAtLogin: this.runtimeContext.getLoginItemSettings?.()?.openAtLogin ?? false,
        runtimeMode: this.runtimeContext.runtimeMode?.() ?? { mode: "unknown", isPackaged: false, isDefaultApp: false }
      },
      home,
      claudeSettingsPath,
      claudeSettingsExists: fs.existsSync(claudeSettingsPath),
      hookPath,
      hookExists: fs.existsSync(hookPath),
      hookCommand,
      hookUrl,
      commandHookEvents: [...COMMAND_HOOK_EVENTS],
      registeredEvents,
      drift: describeHookDrift({
        commandMatches,
        expectedEvents: CLAUDE_HOOK_EVENTS,
        expectedHookPath: hookPath,
        actualScript: fs.existsSync(hookPath) ? fs.readFileSync(hookPath, "utf8") : null,
        expectedScript: buildHookSenderScript(settings),
        settings
      }),
      environments,
      editors,
      claudeProcesses,
      runningWindows,
      health,
      supportTiers: {
        supportedNow: [
          "Claude Code http hooks (routine events)",
          "PowerShell hook sender (SessionStart, UserPromptSubmit, PermissionRequest)",
          "Window activation (exact tab unconfirmed)"
        ],
        detectedButLimited: ["WSL", "Windows Terminal coarse activation"]
      }
    };
  }
}

export async function detectClaudeProcesses() {
  const script = [
    "$processes = Get-Process -ErrorAction SilentlyContinue | Where-Object {",
    "  $_.ProcessName -like 'claude*' -or ($_.Path -and $_.Path -like '*claude*')",
    "} | Select-Object Id,ProcessName,Path,MainWindowTitle,StartTime",
    "if (-not $processes) { '[]' } else { $processes | ConvertTo-Json -Compress }"
  ].join(" ");

  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      timeout: 5000
    });
    const raw = stdout.trim() || "[]";
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.map((item) => ({
      id: item.Id ?? item.id ?? null,
      processName: item.ProcessName ?? item.processName ?? "",
      path: item.Path ?? item.path ?? null,
      mainWindowTitle: item.MainWindowTitle ?? item.mainWindowTitle ?? "",
      startTime: item.StartTime ?? item.startTime ?? null
    }));
  } catch {
    return [];
  }
}

async function detectShellEnvironments() {
  const checks = [
    {
      id: "powershell",
      command: "powershell.exe",
      args: ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]
    },
    {
      id: "cmd",
      command: "cmd.exe",
      args: ["/c", "ver"]
    },
    {
      id: "git-bash",
      command: "where.exe",
      args: ["bash.exe"]
    },
    {
      id: "wsl",
      command: "wsl.exe",
      args: ["--status"]
    }
  ];

  const results = [];
  for (const check of checks) {
    try {
      const { stdout } = await execFileAsync(check.command, check.args, { windowsHide: true, timeout: 5000 });
      results.push({
        id: check.id,
        available: true,
        detail: stdout.trim().split(/\r?\n/)[0] ?? ""
      });
    } catch (error) {
      results.push({
        id: check.id,
        available: false,
        detail: String(error.message ?? error)
      });
    }
  }
  return results;
}

async function detectEditors() {
  const candidates = [
    {
      id: "vscode",
      paths: [
        path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe"),
        path.join(process.env["ProgramFiles"] ?? "", "Microsoft VS Code", "Code.exe"),
        path.join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft VS Code", "Code.exe")
      ]
    },
    {
      id: "cursor",
      paths: [
        path.join(process.env.LOCALAPPDATA ?? "", "Programs", "cursor", "Cursor.exe"),
        path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Cursor", "Cursor.exe"),
        path.join(process.env["ProgramFiles"] ?? "", "Cursor", "Cursor.exe")
      ]
    }
  ];

  return Promise.all(candidates.map(async (candidate) => {
    const detectedPath = await firstExisting(candidate.paths);
    return {
      id: candidate.id,
      detected: Boolean(detectedPath),
      path: detectedPath
    };
  }));
}

async function detectHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000), redirect: "error"
    });
    const detail = (await response.text()).trim();
    return { ok: response.ok && detail === "ok", detail };

  } catch (error) {
    return {
      ok: false,
      detail: String(error.message ?? error)
    };
  }
}

// Win32_Process ancestry is best effort. A hook shell (or cmd /c wrapper) below
// Claude is not the persistent integrated terminal shell the editor helper needs.
function buildHookProcessIdentificationScript() {
  return String.raw`function Find-CcfSessionShellPid {
  param([int]$SenderPid)
  $processById = @{}
  try {
    foreach ($process in (Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate -ErrorAction Stop)) {
      $processById[[int]$process.ProcessId] = $process
    }
  } catch { return $null }
  $seen = @{}
  $currentId = $SenderPid
  $foundClaude = $false
  $childCreated = $null
  for ($depth = 0; $depth -lt 24 -and $currentId -gt 0; $depth++) {
    if ($seen.ContainsKey($currentId)) { return $null }
    $seen[$currentId] = $true
    $item = $processById[$currentId]
    if (-not $item) { return $null }
    if ($childCreated -and $item.CreationDate -and $item.CreationDate -gt $childCreated) { return $null }
    $childCreated = $item.CreationDate
    $name = [string]$item.Name
    $command = [string]$item.CommandLine
    if ($foundClaude) {
      $isShell = $name -match '^(powershell|pwsh|cmd|bash|zsh|sh)(\.exe)?$'
      $isWrapper = ($name -match '^cmd(\.exe)?$' -and $command -match '(?i)\s/[ck](?:\s|$)' -and $command -notmatch '(?i)\s/k(?:\s|$)') -or
        ($name -match '^(powershell|pwsh)(\.exe)?$' -and $command -match '(?i)\s-(command|c|file|f|encodedcommand|enc)(?:\s|$)' -and $command -notmatch '(?i)\s-noexit(?:\s|$)') -or
        ($name -match '^(bash|zsh|sh)(\.exe)?$' -and $command -match '\s-[a-z]*c(?:\s|$)')
      if ($isShell -and -not $isWrapper) { return [int]$item.ProcessId }
    }
    if ($currentId -ne $SenderPid -and ($name -match '^claude(\.exe)?$' -or
      ($name -match '^node(\.exe)?$' -and $command -match '[\\/]claude-code[\\/]'))) { $foundClaude = $true }
    $currentId = [int]$item.ParentProcessId
  }
  return $null
}

function Add-CcfSessionShellIdentity {
  param($Payload, [int]$SenderPid)
  # Never preserve a hook sender/wrapper PID. SessionStore retains the previously
  # discovered session shell when routine events omit shell_pid.
  $Payload.PSObject.Properties.Remove('terminal_pid')
  $Payload.PSObject.Properties.Remove('shell_pid')
  if ($Payload.hook_event_name -notin @('SessionStart', 'UserPromptSubmit', 'PermissionRequest')) { return }
  $sessionShellPid = Find-CcfSessionShellPid -SenderPid $SenderPid
  if ($sessionShellPid) { $Payload | Add-Member -NotePropertyName shell_pid -NotePropertyValue $sessionShellPid -Force }
}`;
}

function describeHookDrift({ commandMatches, expectedEvents, expectedHookPath, actualScript, expectedScript, settings = {} }) {
  const missingEvents = [];
  const unexpectedCommands = [];
  // Callers that pass full hook objects get both transports recognised; plain command lists
  // (older callers, tests) keep the command-only check.
  const ownsHook = (item) => item.hooks
    ? item.hooks.some((hook) => isCcfOwnedHook(hook, expectedHookPath))
    : item.commands.some((command) => command.toLowerCase().includes(expectedHookPath.toLowerCase()));

  for (const eventName of expectedEvents) {
    const match = commandMatches.find((item) => item.eventName === eventName);
    if (!match || (match.hooks ?? match.commands).length === 0) {
      missingEvents.push(eventName);
      continue;
    }

    if (!ownsHook(match)) {
      unexpectedCommands.push({
        eventName,
        commands: match.commands
      });
    }
  }

  const senderMismatch = expectedScript !== undefined && actualScript !== expectedScript;
  const obsoleteEvents = commandMatches.filter((item) => !expectedEvents.includes(item.eventName) && ownsHook(item))
    .map((item) => item.eventName);
  // A changed port or token makes the stored http hook differ from the expected one.
  const registrationMismatch = commandMatches.filter((item) => expectedEvents.includes(item.eventName) && item.hooks &&
    !item.hooks.some((hook) => JSON.stringify(hook) === JSON.stringify(buildHookRegistration(item.eventName, expectedHookPath, settings)))
  ).map((item) => item.eventName);
  return {
    healthy: missingEvents.length === 0 && unexpectedCommands.length === 0 && !senderMismatch && obsoleteEvents.length === 0 && registrationMismatch.length === 0,
    missingEvents,
    unexpectedCommands,
    senderMismatch,
    obsoleteEvents,
    registrationMismatch
  };
}

export const __testing = {
  buildHookSenderScript,
  buildHookProcessIdentificationScript,
  describeHookDrift
};
