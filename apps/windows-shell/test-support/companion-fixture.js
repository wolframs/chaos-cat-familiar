import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "companion-fixture");

// A throwaway companion folder with the PowerShell stand-ins (never Claude or Codex): start-companion.ps1 for the PTY,
// stdio-child.ps1 for a stdio child. Each instance records its pid and its hidden grandchild's pid next to itself.
export function createCompanionFixture(root, { load = null } = {}) {
  const dir = path.join(root, "companion-fixture");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["start-companion.ps1", "stdio-child.ps1"]) fs.copyFileSync(path.join(SOURCE, name), path.join(dir, name));
  if (load) fs.writeFileSync(path.join(dir, "load.json"), JSON.stringify(load));
  const read = (prefix) => fs.readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".txt"))
    .flatMap((name) => {
      try { return fs.readFileSync(path.join(dir, name), "utf8").trim().split(/\s+/).map(Number).filter(Number.isInteger); }
      catch { return []; }
    });
  return {
    dir,
    stdioScript: path.join(dir, "stdio-child.ps1"),
    // Pids recorded so far: PTY instances (pids-*.txt) and stdio children (stdio-*.txt), each with its grandchild.
    ptyPids: () => read("pids-"),
    stdioPids: () => read("stdio-")
  };
}

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

export async function waitUntil(read, what, timeoutMs = 20000, pollMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}
