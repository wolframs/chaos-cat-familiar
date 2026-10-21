import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Windows npm scripts parse in Windows PowerShell 5.1", { skip: process.platform !== "win32" }, () => {
  const script = `
    $failed = $false
    foreach ($file in Get-ChildItem -LiteralPath $env:CCF_SCRIPT_SYNTAX_DIR -Filter *.ps1) {
      $tokens = $null; $parseErrors = $null
      $null = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
      foreach ($issue in $parseErrors) {
        Write-Output "$($file.Name):$($issue.Extent.StartLineNumber): $($issue.Message)"
        $failed = $true
      }
    }
    if ($failed) { exit 1 }
  `;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    env: { ...process.env, CCF_SCRIPT_SYNTAX_DIR: fileURLToPath(new URL("../../../scripts/windows/", import.meta.url)) },
    encoding: "utf8", timeout: 15000, windowsHide: true
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
});
