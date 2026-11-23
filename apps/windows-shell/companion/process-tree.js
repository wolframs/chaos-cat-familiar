import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { unpackedPath } from "../services/asar-paths.js";

// Child-tree ownership for the companion process (process-split plan, step 4). On Windows the companion process joins
// a kill-on-close job object before it starts any child (kill-on-close-job.ps1 hands the job's only handle to the
// process itself): when the companion process ends, by quit or crash, Windows ends everything it started, at any
// depth (Claude in its PTY and Claude's own children, codex app-server, the habitat bridge, the watcher).
// PowerShell cannot read inside app.asar: a packaged build runs the unpacked copy.
export const JOB_SCRIPT = unpackedPath(path.join(path.dirname(fileURLToPath(import.meta.url)), "kill-on-close-job.ps1"));
const SHELLS = ["pwsh.exe", "powershell.exe"];

function runHelper(shell, pid, { spawnProcess, timeoutMs }) {
  return new Promise((resolve, reject) => {
    // Not detached: a detached PowerShell (no console) exits 0 without running the script.
    const child = spawnProcess(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", JOB_SCRIPT, "-TargetPid", String(pid)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error(`${shell} did not finish within ${timeoutMs} ms`)); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const handle = Number.parseInt(stdout.trim().split(/\s+/).at(-1), 10);
      if (code === 0 && Number.isFinite(handle) && handle > 0) resolve({ handle, shell });
      else reject(new Error(`${shell} exited ${code}: ${(stderr || stdout).trim().slice(0, 500)}`));
    });
  });
}

// Resolves { joined: true, handle, shell, ms } or { joined: false, reason } (never rejects). A companion without the job
// starts no child (companion-composition.js); main's taskkill of reported roots stays as a last resort only.
export async function joinKillOnCloseJob({ pid = process.pid, platform = process.platform, spawnProcess = spawn,
  shells = SHELLS, timeoutMs = 20000 } = {}) {
  if (platform !== "win32") return { joined: false, reason: "not Windows" };
  const started = Date.now();
  const failures = [];
  for (const shell of shells) {
    try {
      const result = await runHelper(shell, pid, { spawnProcess, timeoutMs });
      return { joined: true, ...result, ms: Date.now() - started };
    } catch (error) {
      failures.push(String(error?.message ?? error));
      if (error?.code !== "ENOENT") break;   // a shell that ran and failed: the next one would fail the same way
    }
  }
  return { joined: false, reason: failures.join("; "), ms: Date.now() - started };
}
