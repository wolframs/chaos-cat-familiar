import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSpawnTarget(command) {
  if (/electron\.cmd$/i.test(command)) {
    const repoRoot = path.resolve(path.dirname(command), "..");
    const electronExe = path.join(repoRoot, "electron", "dist", "electron.exe");
    if (fs.existsSync(electronExe)) {
      return {
        command: electronExe,
        argsPrefix: []
      };
    }
  }
  return {
    command,
    argsPrefix: []
  };
}

async function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") {
      return true;
    }
    return false;
  }
}

export async function waitForFile(filePath, { timeoutMs = 30000, pollMs = 200 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) {
      return filePath;
    }
    await delay(pollMs);
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
}

export async function waitForJson(filePath, { timeoutMs = 30000, pollMs = 200 } = {}) {
  await waitForFile(filePath, { timeoutMs, pollMs });
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      await delay(pollMs);
    }
  }
  throw new Error(`Timed out waiting for valid JSON in ${filePath}`);
}

export function spawnLoggedProcess(command, args, { cwd, env, logFile }) {
  const target = resolveSpawnTarget(command);
  const child = spawn(target.command, [...target.argsPrefix, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let trackedPid = child.pid ?? null;
  let childExitResolve;
  let childExitReject;
  const childExit = new Promise((resolve, reject) => {
    childExitResolve = resolve;
    childExitReject = reject;
  });
  // The process can exit before waitForExit is called. Keep the promise handled
  // and retain its result so that the later wait still observes that exit.
  childExit.catch(() => {});
  child.once("exit", (code, signal) => {
    childExitResolve({ code, signal, pid: trackedPid ?? child.pid });
  });
  child.once("error", childExitReject);

  const logStream = logFile
    ? fs.createWriteStream(logFile, { flags: "a" })
    : null;

  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      logStream?.write(chunk);
    });
  }

  return {
    child,
    adoptPid(pid) {
      if (Number.isInteger(pid) && pid > 0) {
        trackedPid = pid;
      }
    },
    async waitForExit(timeoutMs = 30000) {
      if (trackedPid && trackedPid !== child.pid) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          if (!(await isProcessAlive(trackedPid))) {
            return { code: 0, signal: null, pid: trackedPid };
          }
          await delay(200);
        }
        throw new Error(`Timed out waiting for process ${trackedPid} to exit`);
      }
      let timer;
      try {
        return await Promise.race([
          childExit,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`Timed out waiting for process ${trackedPid ?? child.pid} to exit`));
            }, timeoutMs);
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async killTree() {
      const pid = trackedPid ?? child.pid;
      if (!pid) {
        return;
      }
      await new Promise((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true
        });
        killer.once("exit", () => resolve());
        killer.once("error", () => resolve());
      });
    },
    closeLog() {
      return new Promise((resolve) => {
        if (!logStream) {
          resolve();
          return;
        }
        logStream.end(resolve);
      });
    }
  };
}

export async function ensureGone(filePath) {
  if (fs.existsSync(filePath)) {
    throw new Error(`Expected file to be removed: ${path.normalize(filePath)}`);
  }
}
