import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_NOTIFICATION_ICON = path.resolve(__dirname, "../assets/ccf-logo.svg");

// The first of these files that exists, without blocking main's event loop (process-split plan, step 7).
export async function firstExisting(paths) {
  for (const candidate of paths) {
    if (!candidate) continue;
    try { await fs.access(candidate); return candidate; } catch { /* not there */ }
  }
  return null;
}

export class ElectronOverlayService {
  // publishesOnChange: the shell already broadcasts every core `change` to these windows, and the core calls
  // updateOverlay right after emitting it. A second full publication per hook event doubled the main-thread
  // serialization of the ~0.7 MB state (2026-11-05), so updateOverlay then does nothing.
  // publish: how the shell sends state to its windows (overlay-sized for the cat, history only to a detail view that
  // has it); showing the overlay then publishes that way instead of sending one full state to all three windows.
  constructor(getOverlayWindow, getDiagnosticsWindow, getDashboardWindow = null, getSnapshotState = null,
    { publishesOnChange = false, publish = null } = {}) {
    this.getOverlayWindow = getOverlayWindow;
    this.getDiagnosticsWindow = getDiagnosticsWindow;
    this.getDashboardWindow = getDashboardWindow;
    this.getSnapshotState = getSnapshotState;
    this.publishesOnChange = publishesOnChange;
    this.publish = publish;
  }

  showOverlay(state) {
    const window = this.getOverlayWindow();
    if (!window) {
      return;
    }

    window.showInactive();
    if (this.publish) {
      this.publish();
      return;
    }
    const payload = this.getSnapshotState?.() ?? state;
    window.webContents.send("ccf:state", payload);
    const diagnostics = this.getDiagnosticsWindow();
    diagnostics?.webContents.send("ccf:state", payload);
    const dashboard = this.getDashboardWindow?.();
    dashboard?.webContents.send("ccf:state", payload);
  }

  updateOverlay(state) {
    if (this.publishesOnChange) return;
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

// Whether a derived notification becomes a toast: preferences, minimum priority, idle alerts of sessions that still
// run background work. Runs in the core process (it reads settings and ~/.claude/sessions); the toast itself is main's.
export class NotificationPolicy {
  constructor({ logger = null, getPreferences = null, hasPendingBackgroundWork = null } = {}) {
    this.logger = logger;
    this.getPreferences = getPreferences;
    this.hasPendingBackgroundWork = hasPendingBackgroundWork;
  }

  allows(notification) {
    const preferences = this.getPreferences?.() ?? {
      enabled: true,
      minPriority: "high"
    };
    if (notification.category === "idle_alert" && this.hasPendingBackgroundWork?.(notification.sessionId)) {
      this.logger?.info("notification", "Idle alert suppressed: session still has background work", {
        title: notification.title,
        sessionId: notification.sessionId ?? null
      });
      return false;
    }
    if (!preferences.enabled) {
      this.logger?.info("notification", "Notification suppressed by preferences", {
        title: notification.title
      });
      return false;
    }
    if (priorityWeight(notification.priority) < priorityWeight(preferences.minPriority)) {
      this.logger?.info("notification", "Notification suppressed below minimum priority", {
        title: notification.title,
        priority: notification.priority,
        minPriority: preferences.minPriority
      });
      return false;
    }
    return true;
  }
}

export class ElectronNotificationService {
  constructor(NotificationCtor, logger, onClick, getPreferences, options = {}) {
    this.NotificationCtor = NotificationCtor;
    this.logger = logger;
    this.onClick = onClick;
    this.iconPath = options.iconPath ?? DEFAULT_NOTIFICATION_ICON;
    this.policy = new NotificationPolicy({ logger, getPreferences,
      hasPendingBackgroundWork: options.hasPendingBackgroundWork ?? null });
  }

  async notify(notification) {
    if (!this.policy.allows(notification)) return;
    this.show(notification);
  }

  // The native toast alone (main's side of a core "toast" effect: the core already applied the policy).
  show(notification) {
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

    const installPath = await firstExisting(config.installPaths);
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

  // launchFallback false: when no window can be raised, report it instead of starting a new terminal (the side panel's
  // row click: a new empty terminal is not the session he clicked).
  async activateTerminal({ projectDir, shellPid, launchFallback = true } = {}) {
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

    if (!launchFallback) {
      return { ok: false, reason: "no_terminal_window", terminal: this.terminalConfig.id,
        attempts: buildActivationAttempts("none", rankedWindows, projectDir) };
    }

    if (await firstExisting([this.terminalConfig.executable])) {
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


export async function listRunningWindows(processNames) {
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


export function rankWindowsForProject(runningWindows, projectDir, appKeywords = []) {
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
  buildFocusProcessWindowScript,
  buildProcessAncestorScript,
  priorityWeight,
  rankWindowsForProject,
  scoreWindowTitle
};
