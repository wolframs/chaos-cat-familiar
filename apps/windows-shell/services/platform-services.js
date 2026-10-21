import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "../../../packages/core/src/atomic-json.js";
import { removeCcfHookRegistrations } from "./claude-hook-cleanup.js";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_NOTIFICATION_ICON = path.resolve(__dirname, "../assets/ccf-logo.svg");
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

export class ElectronOverlayService {
  constructor(getOverlayWindow, getDiagnosticsWindow, getDashboardWindow = null, getSnapshotState = null) {
    this.getOverlayWindow = getOverlayWindow;
    this.getDiagnosticsWindow = getDiagnosticsWindow;
    this.getDashboardWindow = getDashboardWindow;
    this.getSnapshotState = getSnapshotState;
  }

  showOverlay(state) {
    const payload = this.getSnapshotState?.() ?? state;
    const window = this.getOverlayWindow();
    if (!window) {
      return;
    }

    window.showInactive();
    window.webContents.send("ccf:state", payload);
    const diagnostics = this.getDiagnosticsWindow();
    diagnostics?.webContents.send("ccf:state", payload);
    const dashboard = this.getDashboardWindow?.();
    dashboard?.webContents.send("ccf:state", payload);
  }

  updateOverlay(state) {
    const payload = this.getSnapshotState?.() ?? state;
    const window = this.getOverlayWindow();
    window?.webContents.send("ccf:state", payload);
    const diagnostics = this.getDiagnosticsWindow();
    diagnostics?.webContents.send("ccf:state", payload);
    const dashboard = this.getDashboardWindow?.();
    dashboard?.webContents.send("ccf:state", payload);
  }

  hideOverlay() {
    this.getOverlayWindow()?.hide();
  }
}

export class ElectronNotificationService {
  constructor(NotificationCtor, logger, onClick, getPreferences, options = {}) {
    this.NotificationCtor = NotificationCtor;
    this.logger = logger;
    this.onClick = onClick;
    this.getPreferences = getPreferences;
    this.iconPath = options.iconPath ?? DEFAULT_NOTIFICATION_ICON;
  }

  async notify(notification) {
    const preferences = this.getPreferences?.() ?? {
      enabled: true,
      minPriority: "high"
    };
    if (!preferences.enabled) {
      this.logger?.info("notification", "Notification suppressed by preferences", {
        title: notification.title
      });
      return;
    }
    if (priorityWeight(notification.priority) < priorityWeight(preferences.minPriority)) {
      this.logger?.info("notification", "Notification suppressed below minimum priority", {
        title: notification.title,
        priority: notification.priority,
        minPriority: preferences.minPriority
      });
      return;
    }
    if (!this.NotificationCtor?.isSupported?.()) {
      this.logger?.warn("notification", "Native notifications are not supported", {});
      return;
    }

    const toast = new this.NotificationCtor({
      title: notification.title,
      body: notification.body ?? "",
      urgency: mapUrgency(notification.priority),
      icon: this.iconPath
    });
    toast.on("click", () => {
      this.logger?.info("notification", "Notification clicked", {
        title: notification.title,
        sessionId: notification.sessionId ?? null
      });
      this.onClick?.(notification);
    });
    toast.show();
    this.logger?.info("notification", "Native notification shown", {
      title: notification.title,
      priority: notification.priority
    });
  }
}

export class ElectronActivationService {
  constructor(shell, logger, options = {}) {
    this.shell = shell;
    this.logger = logger;
    this.listRunningWindows = options.listRunningWindows ?? listRunningWindows;
    this.focusProcessWindow = options.focusProcessWindow ?? focusProcessWindow;
    this.listProcessAncestorIds = options.listProcessAncestorIds ?? listProcessAncestorIds;
    this.editorConfigs = [
      {
        id: "vscode",
        scheme: "vscode",
        processNames: ["Code"],
        executables: ["Code.exe"],
        installPaths: [
          path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe"),
          path.join(process.env["ProgramFiles"] ?? "", "Microsoft VS Code", "Code.exe"),
          path.join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft VS Code", "Code.exe")
        ]
      },
      {
        id: "cursor",
        scheme: "cursor",
        processNames: ["Cursor"],
        executables: ["Cursor.exe"],
        installPaths: [
          path.join(process.env.LOCALAPPDATA ?? "", "Programs", "cursor", "Cursor.exe"),
          path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Cursor", "Cursor.exe"),
          path.join(process.env["ProgramFiles"] ?? "", "Cursor", "Cursor.exe")
        ]
      }
    ];
    this.terminalConfig = {
      id: "windows-terminal",
      executable: path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps", "wt.exe"),
      processNames: ["WindowsTerminal", "wt"]
    };
  }

  async activateEditor({ editor, shellPid, projectDir }) {
    const config = this.editorConfigs.find((item) => item.id === editor) ?? this.editorConfigs[0];
    this.logger?.info("activation", "Editor activation requested", {
      editor: config.id,
      shellPid: shellPid ?? null,
      projectDir: projectDir ?? null
    });
    const runningWindows = await this.listRunningWindows(config.processNames);
    const rankedWindows = rankWindowsForProject(runningWindows, projectDir);
    if (runningWindows.length > 0) {
      this.logger?.info("activation", "Detected running editor windows", {
        editor: config.id,
        windows: rankedWindows.map((item) => ({
          pid: item.id,
          title: item.mainWindowTitle,
          score: item.matchScore,
          reasons: item.matchReasons
        }))
      });
    }

    if (shellPid) {
      if (rankedWindows[0]?.id) {
        await this.focusProcessWindow(rankedWindows[0].id);
      }
      await this.shell.openExternal(`${config.scheme}://wolframs.ccf-terminal-focus/focus?pid=${shellPid}`);
      this.logger?.info("activation", "Editor activation used URI targeting", {
        editor: config.id,
        shellPid
      });
      return {
        ok: true,
        mode: "uri",
        exactTabConfirmed: false,
        detail: "helper_uri_dispatched_without_acknowledgement",
        editor: config.id,
        attempts: buildActivationAttempts("uri", rankedWindows, projectDir)
      };
    }

    if (rankedWindows[0]?.id) {
      const focused = await this.focusProcessWindow(rankedWindows[0].id);
      if (focused.ok) {
        this.logger?.info("activation", "Editor activation foregrounded existing window", {
          editor: config.id,
          pid: rankedWindows[0].id,
          title: rankedWindows[0].mainWindowTitle,
          projectDir: projectDir ?? null
        });
        return {
          ok: true,
          mode: "foreground",
          editor: config.id,
          pid: rankedWindows[0].id,
          attempts: buildActivationAttempts("foreground", rankedWindows, projectDir)
        };
      }
      this.logger?.warn("activation", "Foreground activation failed, falling back", {
        editor: config.id,
        pid: rankedWindows[0].id,
        detail: focused.detail
      });
    }

    const installPath = config.installPaths.find((candidate) => candidate && fs.existsSync(candidate));
    if (installPath) {
      await this.shell.openPath(installPath);
      this.logger?.info("activation", "Editor activation used install path", {
        editor: config.id,
        path: installPath
      });
      return {
        ok: true,
        mode: "path",
        editor: config.id,
        path: installPath,
        attempts: buildActivationAttempts("path", rankedWindows, projectDir)
      };
    }

    try {
      const command = `Start-Process "${config.executables[0]}"`;
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], { windowsHide: true });
      this.logger?.info("activation", "Editor activation used process launch fallback", {
        editor: config.id
      });
      return {
        ok: true,
        mode: "process",
        editor: config.id,
        attempts: buildActivationAttempts("process", rankedWindows, projectDir)
      };
    } catch (error) {
      this.logger?.error("activation", "Editor activation failed", {
        editor: config.id,
        error: String(error.message ?? error)
      });
      return {
        ok: false,
        editor: config.id,
        error: String(error.message ?? error),
        attempts: buildActivationAttempts("error", rankedWindows, projectDir)
      };
    }
  }

  async activateTerminal({ projectDir, shellPid } = {}) {
    this.logger?.info("activation", "Terminal activation requested", {
      terminal: this.terminalConfig.id,
      projectDir: projectDir ?? null
    });
    const processNames = [...this.terminalConfig.processNames, "Code", "Cursor", "powershell", "pwsh", "cmd"];
    const runningWindows = await this.listRunningWindows(processNames);
    let rankedWindows = rankWindowsForProject(
      runningWindows,
      projectDir,
      ["terminal", "windows terminal", "wt"]
    );
    const ancestorIds = Number.isSafeInteger(shellPid) && shellPid > 0
      ? await this.listProcessAncestorIds(shellPid)
      : [];
    const hasProjectMatch = (item) => item.matchReasons.some((reason) => reason.startsWith("basename:") || reason === "full-project-path");
    // An unrelated editor is not a useful terminal fallback. Keep editors only
    // when ancestry or the project's own name/path identifies a candidate.
    rankedWindows = rankedWindows.filter((item) => !/^(Code|Cursor)$/i.test(item.processName)
      || ancestorIds.includes(item.id) || hasProjectMatch(item));
    const ancestorWindow = ancestorIds.map((id) => rankedWindows.find((item) => item.id === id)).find(Boolean);
    if (ancestorWindow) {
      rankedWindows.splice(rankedWindows.indexOf(ancestorWindow), 1);
      rankedWindows.unshift(ancestorWindow);
    }
    const targetSource = ancestorWindow ? "shell_ancestor"
      : rankedWindows[0] && hasProjectMatch(rankedWindows[0])
        ? "project_title" : "window_fallback";
    if (rankedWindows.length > 0) {
      this.logger?.info("activation", "Detected running terminal windows", {
        terminal: this.terminalConfig.id,
        windows: rankedWindows.map((item) => ({
          pid: item.id,
          title: item.mainWindowTitle,
          score: item.matchScore,
          reasons: item.matchReasons
        }))
      });
    }
    if (rankedWindows[0]?.id) {
      const focused = await this.focusProcessWindow(rankedWindows[0].id);
      if (focused.ok) {
        this.logger?.info("activation", "Terminal activation foregrounded existing window", {
          terminal: this.terminalConfig.id,
          pid: rankedWindows[0].id,
          title: rankedWindows[0].mainWindowTitle,
          projectDir: projectDir ?? null
        });
        return {
          ok: true,
          mode: "foreground",
          targetSource,
          exactTabConfirmed: false,
          terminal: this.terminalConfig.id,
          pid: rankedWindows[0].id,
          attempts: buildActivationAttempts("foreground", rankedWindows, projectDir)
        };
      }
      this.logger?.warn("activation", "Terminal foreground activation failed, falling back", {
        terminal: this.terminalConfig.id,
        pid: rankedWindows[0].id,
        detail: focused.detail
      });
    }

    if (this.terminalConfig.executable && fs.existsSync(this.terminalConfig.executable)) {
      await this.shell.openPath(this.terminalConfig.executable);
      this.logger?.info("activation", "Terminal activation used install path", {
        terminal: this.terminalConfig.id,
        path: this.terminalConfig.executable
      });
      return {
        ok: true,
        mode: "path",
        terminal: this.terminalConfig.id,
        path: this.terminalConfig.executable,
        attempts: buildActivationAttempts("path", rankedWindows, projectDir)
      };
    }

    try {
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", "Start-Process wt.exe"], {
        windowsHide: true
      });
      this.logger?.info("activation", "Terminal activation used process fallback", {
        terminal: this.terminalConfig.id
      });
      return {
        ok: true,
        mode: "process",
        terminal: this.terminalConfig.id,
        attempts: buildActivationAttempts("process", rankedWindows, projectDir)
      };
    } catch (error) {
      this.logger?.error("activation", "Terminal activation failed", {
        terminal: this.terminalConfig.id,
        error: String(error.message ?? error)
      });
      return {
        ok: false,
        terminal: this.terminalConfig.id,
        error: String(error.message ?? error),
        attempts: buildActivationAttempts("error", rankedWindows, projectDir)
      };
    }
  }
}

function buildHookRegistration(eventName, hookPath) {
  return {
    type: "command",
    command: `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${hookPath}"`,
    ...(eventName === "PermissionRequest" ? { timeout: 130 } : { async: true })
  };
}

function updateClaudeSettings(settingsPath, transform) {
  // Re-read immediately before merging: never reuse the install-time snapshot.
  // Atomic rename protects readers; a writer racing the rename still requires
  // cooperation from Claude Code, which does not expose a shared settings lock.
  const raw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : "";
  const current = raw ? JSON.parse(raw) : {};
  const updated = transform(current);
  if (JSON.stringify(updated) !== JSON.stringify(current)) {
    writeJsonAtomic(settingsPath, updated);
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

    updateClaudeSettings(claudeSettingsPath, (current) => {
      // Rebuild only CCF-owned commands, including obsolete worktree handlers.
      const next = removeCcfHookRegistrations(current, hookPath).updated;
      next.hooks ??= {};
      for (const eventName of CLAUDE_HOOK_EVENTS) {
        next.hooks[eventName] ??= [];
        next.hooks[eventName].push({ matcher: "", hooks: [buildHookRegistration(eventName, hookPath)] });
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
      updateClaudeSettings(claudeSettingsPath, (current) => {
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
    const registeredEvents = [];
    const commandMatches = [];
    if (claudeSettings?.hooks) {
      for (const [eventName, entries] of Object.entries(claudeSettings.hooks)) {
        const matchingCommands = Array.isArray(entries)
          ? entries.flatMap((entry) => entry.hooks ?? []).map((hook) => String(hook.command ?? ""))
          : [];
        const hasHook = matchingCommands.some((command) => command.includes(hookPath));
        if (hasHook) {
          registeredEvents.push(eventName);
        }
        commandMatches.push({
          eventName,
          commands: matchingCommands,
          hooks: Array.isArray(entries) ? entries.flatMap((entry) => entry.hooks ?? []) : []
        });
      }
    }

    const health = await detectHealth(settings.port);
    // Hook setup only needs local files and server health. Expensive OS discovery is on demand.
    const environments = detailed ? await detectShellEnvironments() : [];
    const editors = detailed ? detectEditors() : [];
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
      registeredEvents,
      drift: describeHookDrift({
        commandMatches,
        expectedEvents: CLAUDE_HOOK_EVENTS,
        expectedHookPath: hookPath,
        actualScript: fs.existsSync(hookPath) ? fs.readFileSync(hookPath, "utf8") : null,
        expectedScript: buildHookSenderScript(settings)
      }),
      environments,
      editors,
      claudeProcesses,
      runningWindows,
      health,
      supportTiers: {
        supportedNow: ["PowerShell hook transport", "Window activation (exact tab unconfirmed)"],
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

function detectEditors() {
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

  return candidates.map((candidate) => {
    const detectedPath = candidate.paths.find((item) => item && fs.existsSync(item)) ?? null;
    return {
      id: candidate.id,
      detected: Boolean(detectedPath),
      path: detectedPath
    };
  });
}

function mapUrgency(priority) {
  switch (priority) {
    case "urgent":
      return "critical";
    case "high":
      return "normal";
    default:
      return "low";
  }
}

function priorityWeight(priority) {
  switch (priority) {
    case "urgent":
      return 4;
    case "high":
      return 3;
    case "normal":
      return 2;
    default:
      return 1;
  }
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

async function listRunningWindows(processNames) {
  if (!Array.isArray(processNames) || processNames.length === 0) {
    return [];
  }

  const names = processNames.map((name) => `'${name.replace(/'/g, "''")}'`).join(",");
  const script = [
    `$names = @(${names})`,
    "$processes = Get-Process -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.ProcessName -and $_.MainWindowHandle -ne 0 } | Select-Object Id,ProcessName,MainWindowTitle,Path",
    "if (-not $processes) { '[]' } else { $processes | ConvertTo-Json -Compress }"
  ].join(" ");

  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      timeout: 5000
    });
    const raw = stdout.trim() || "[]";
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeWindowRecord) : [normalizeWindowRecord(parsed)];
  } catch {
    return [];
  }
}

function buildProcessAncestorScript(shellPid) {
  if (!Number.isSafeInteger(shellPid) || shellPid <= 0) {
    throw new TypeError("A positive integer process ID is required");
  }
  return String.raw`
    $currentId = ${shellPid}
    $seen = @{}
    $ancestors = @()
    $childCreated = $null
    for ($depth = 0; $depth -lt 24 -and $currentId -gt 0; $depth++) {
      if ($seen.ContainsKey($currentId)) { break }
      $seen[$currentId] = $true
      try { $item = Get-CimInstance Win32_Process -Filter "ProcessId = $currentId" -ErrorAction Stop } catch { break }
      if (-not $item) { break }
      if ($childCreated -and $item.CreationDate -and $item.CreationDate -gt $childCreated) { break }
      $childCreated = $item.CreationDate
      $ancestors += [int]$item.ProcessId
      $currentId = [int]$item.ParentProcessId
    }
    ConvertTo-Json -InputObject @($ancestors) -Compress
  `;
}

async function listProcessAncestorIds(shellPid) {
  const script = buildProcessAncestorScript(shellPid);
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 5000 });
    const parsed = JSON.parse(stdout.trim() || "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => Number.isSafeInteger(id) && id > 0) : [];
  } catch {
    return [];
  }
}

function buildFocusProcessWindowScript(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError("A positive integer process ID is required");
  }
  return [
    "Add-Type @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class FocusHelper {",
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
    "}",
    "'@",
    `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "if (-not $process -or $process.MainWindowHandle -eq 0) { '{\"ok\":false,\"detail\":\"no_main_window\"}'; exit 0 }",
    "[FocusHelper]::ShowWindowAsync($process.MainWindowHandle, 9) | Out-Null",
    "$ok = [FocusHelper]::SetForegroundWindow($process.MainWindowHandle)",
    "(@{ ok = $ok; detail = if ($ok) { 'foregrounded' } else { 'set_foreground_failed' } } | ConvertTo-Json -Compress)"
  ].join("\n");
}

async function focusProcessWindow(pid) {
  const script = buildFocusProcessWindowScript(pid);

  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      timeout: 5000
    });
    return JSON.parse(stdout.trim() || '{"ok":false,"detail":"empty_response"}');
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

function normalizeWindowRecord(record) {
  return {
    id: record.Id ?? record.id ?? null,
    processName: record.ProcessName ?? record.processName ?? "",
    mainWindowTitle: record.MainWindowTitle ?? record.mainWindowTitle ?? "",
    path: record.Path ?? record.path ?? null,
    matchScore: 0,
    matchReasons: []
  };
}

function buildActivationAttempts(mode, runningWindows, projectDir = null) {
  return {
    mode,
    projectDir,
    detectedWindows: runningWindows.map((item) => ({
      pid: item.id,
      processName: item.processName,
      title: item.mainWindowTitle,
      matchScore: item.matchScore,
      matchReasons: item.matchReasons
    })),
    bestMatch: runningWindows[0]
      ? {
          pid: runningWindows[0].id,
          title: runningWindows[0].mainWindowTitle,
          matchScore: runningWindows[0].matchScore,
          matchReasons: runningWindows[0].matchReasons
        }
      : null
  };
}

function describeHookDrift({ commandMatches, expectedEvents, expectedHookPath, actualScript, expectedScript }) {
  const missingEvents = [];
  const unexpectedCommands = [];

  for (const eventName of expectedEvents) {
    const match = commandMatches.find((item) => item.eventName === eventName);
    if (!match || match.commands.length === 0) {
      missingEvents.push(eventName);
      continue;
    }

    if (!match.commands.some((command) => command.includes(expectedHookPath))) {
      unexpectedCommands.push({
        eventName,
        commands: match.commands
      });
    }
  }

  const senderMismatch = expectedScript !== undefined && actualScript !== expectedScript;
  const obsoleteEvents = commandMatches.filter((item) =>
    !expectedEvents.includes(item.eventName) && item.commands.some((command) => command.toLowerCase().includes(expectedHookPath.toLowerCase()))
  ).map((item) => item.eventName);
  const registrationMismatch = commandMatches.filter((item) => expectedEvents.includes(item.eventName) && item.hooks &&
    !item.hooks.some((hook) => JSON.stringify(hook) === JSON.stringify(buildHookRegistration(item.eventName, expectedHookPath)))
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

function rankWindowsForProject(runningWindows, projectDir, appKeywords = []) {
  if (!projectDir) {
    return runningWindows.map((item) => ({
      ...item,
      ...scoreWindowTitle(String(item.mainWindowTitle ?? "").toLowerCase(), "", "", [], appKeywords)
    }));
  }

  const basename = path.basename(projectDir).toLowerCase();
  const normalizedProject = projectDir.toLowerCase();
  const pathTokens = normalizedProject
    .split(/[\\/]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(-4);

  return [...runningWindows]
    .map((item) => {
      const title = String(item.mainWindowTitle ?? "").toLowerCase();
      return {
        ...item,
        ...scoreWindowTitle(title, basename, normalizedProject, pathTokens, appKeywords)
      };
    })
    .sort((a, b) => b.matchScore - a.matchScore || a.id - b.id);
}

function scoreWindowTitle(title, basename, normalizedProject, pathTokens, appKeywords) {
  let matchScore = 0;
  const matchReasons = [];
  if (basename && title.includes(basename)) {
    matchScore += 10;
    matchReasons.push(`basename:${basename}`);
  }
  if (normalizedProject && title.includes(normalizedProject)) {
    matchScore += 20;
    matchReasons.push("full-project-path");
  }
  for (const token of pathTokens) {
    if (token !== basename && title.includes(token)) {
      matchScore += 4;
      matchReasons.push(`path-token:${token}`);
    }
  }
  for (const keyword of appKeywords) {
    if (title.includes(keyword)) {
      matchScore += 1;
      matchReasons.push(`app-keyword:${keyword}`);
    }
  }
  return {
    matchScore,
    matchReasons
  };
}

export const __testing = {
  buildHookSenderScript,
  buildHookProcessIdentificationScript,
  buildFocusProcessWindowScript,
  buildProcessAncestorScript,
  describeHookDrift,
  priorityWeight,
  rankWindowsForProject,
  scoreWindowTitle
};
