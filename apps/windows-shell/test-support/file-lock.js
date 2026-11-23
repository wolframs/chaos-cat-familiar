// Holds a file the way a reader without delete sharing does (a PowerShell script reading settings.json, the endpoint
// scanner): opened by another process with FileShare.None, so renaming onto it fails and reading it fails, until
// release(). Since step 6 settings.json is written by the core's storage worker on its own thread, so a lock has to be
// real: a monkeypatched fs in the test's thread would not reach it.
import { spawn } from "node:child_process";

export async function holdFileExclusively(filePath) {
  const quoted = filePath.replace(/'/g, "''");
  const script = `$f = [System.IO.File]::Open('${quoted}', 'Open', 'ReadWrite', 'None'); [Console]::Out.WriteLine('held'); `
    + "[Console]::Out.Flush(); [void][Console]::In.ReadLine(); $f.Close()";
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("held")) resolve(); });
    exited.then((code) => reject(new Error(`The lock helper exited (${code}): ${errors.trim()}`)));
  });
  return {
    async release() {
      try { child.stdin.end("\n"); } catch { /* gone already */ }
      const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000))]);
      if (code === "timeout") child.kill();
    }
  };
}
