// The packaged build's stage (process-split plan, step 7): every module main, the core (with its storage worker), the
// companion and the renderer pages load must be in it, by the same relative path as in the repo, and every package
// they import must be staged. Checked from the import graphs, without copying anything.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { importGraph, isBuiltin } from "../../apps/windows-shell/test-support/import-graph.js";
import { ASAR_UNPACK, ASAR_UNPACK_DIR, STAGED } from "./stage-electron-app.mjs";
import { unpackedPath } from "../../apps/windows-shell/services/asar-paths.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const rel = (file) => path.relative(repo, file).replaceAll("\\", "/");

function staged(relative) {
  return STAGED.some(({ from, skip = [] }) => {
    if (relative === from) return true;
    if (!relative.startsWith(`${from}/`)) return false;
    const first = relative.slice(from.length + 1).split("/")[0];
    return !skip.includes(first);
  });
}

function entrypoints() {
  const shell = path.join(repo, "apps", "windows-shell");
  const pages = fs.readdirSync(path.join(shell, "renderer")).filter((name) => name.endsWith(".html"))
    .flatMap((name) => [...fs.readFileSync(path.join(shell, "renderer", name), "utf8").matchAll(/<script[^>]*type="module"[^>]*src="\.\/([^"]+)"/g)]
      .map((match) => path.join(shell, "renderer", match[1])));
  return [path.join(shell, "main.js"), path.join(shell, "core", "core-process.js"),
    path.join(shell, "companion", "companion-process.js"), path.join(repo, "packages", "core", "src", "storage-worker.js"), ...pages];
}

test("the stage holds every module the packaged app loads, at its repo path, and the packages they import", () => {
  const missing = new Set();
  const packages = new Set();
  for (const entry of entrypoints()) {
    for (const [file, { imports }] of importGraph(entry)) {
      if (!staged(rel(file))) missing.add(rel(file));
      for (const item of imports) {
        // The stage links no workspace package into node_modules: such an import would not resolve when packaged.
        if (item.workspace) missing.add(`${rel(file)} imports ${item.specifier} (use a relative path)`);
        if (!item.specifier || item.resolved || isBuiltin(item.specifier) || item.specifier === "electron") continue;
        packages.add(item.specifier);
      }
    }
  }
  assert.deepEqual([...missing], [], "modules outside the stage");
  for (const name of packages) {
    const manifest = `node_modules/${name}/package.json`;
    assert.ok(staged(manifest), `${name} is not staged`);
    const main = JSON.parse(fs.readFileSync(path.join(repo, manifest), "utf8")).main ?? "index.js";
    assert.ok(staged(path.posix.join("node_modules", name, main)), `${name}'s entry ${main} is not staged`);
  }
  assert.deepEqual([...packages].sort(), ["@xterm/headless", "node-pty"]);
  assert.ok(staged("scripts/windows/codex-hook-sender.mjs"), "the Codex hook sender the core names");
  assert.ok(staged("apps/windows-shell/companion/kill-on-close-job.ps1"), "the kill-on-close job helper");
  assert.ok(staged("node_modules/node-pty/prebuilds/win32-x64/conpty.node"), "node-pty's native module");
});

// Final review (P2): node runs the Codex hook sender from app.asar.unpacked, and node cannot read app.asar, so every
// module the sender imports (and the package.json that makes a .js file a module) must be unpacked too. The packaged
// sender failed with ERR_MODULE_NOT_FOUND: codex-hook-adapter.js stayed inside the archive.
const asarRequire = createRequire(createRequire(import.meta.url).resolve("@electron/asar"));
const minimatch = asarRequire("minimatch");
// As @electron/asar decides it: the staged file's absolute path against the pattern (matchBase), or under unpackDir.
const unpacks = (relative) => minimatch(path.join(repo, "stage", relative), ASAR_UNPACK, { matchBase: true })
  || relative.startsWith(`${ASAR_UNPACK_DIR}/`);
const SENDER = path.join(repo, "scripts", "windows", "codex-hook-sender.mjs");

function senderFiles() {
  const files = new Set();
  for (const [file, { imports }] of importGraph(SENDER)) {
    files.add(rel(file));
    for (const item of imports) {
      assert.ok(item.resolved || (item.specifier && isBuiltin(item.specifier)), `the sender imports ${item.specifier}: not staged for node`);
    }
    if (file.endsWith(".js")) {
      // The nearest package.json decides whether node reads a .js file as a module.
      let dir = path.dirname(file);
      while (!fs.existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir);
      files.add(rel(path.join(dir, "package.json")));
    }
  }
  return [...files];
}

test("every module the Codex hook sender imports is unpacked next to it, with its package.json", () => {
  const files = senderFiles();
  assert.ok(files.includes("apps/windows-shell/services/codex-hook-adapter.js"));
  assert.deepEqual(files.filter((file) => !staged(file)), [], "staged");
  assert.deepEqual(files.filter((file) => !unpacks(file)), [], "unpacked from app.asar");
  assert.equal(unpacks("apps/windows-shell/main.js"), false, "the rest stays in the archive");
});

test("the sender runs with plain node from an unpacked layout and delivers an observation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-unpacked-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // What the packager puts next to app.asar for these files: only what the unpack pattern matches.
  const unpacked = path.join(root, "resources", "app.asar.unpacked");
  for (const file of senderFiles().filter(unpacks)) {
    fs.mkdirSync(path.dirname(path.join(unpacked, file)), { recursive: true });
    fs.copyFileSync(path.join(repo, file), path.join(unpacked, file));
  }
  const received = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { received.push({ url: request.url, token: request.headers["x-ccf-token"], body: JSON.parse(body) });
      response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const settingsPath = path.join(root, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ port: server.address().port, hookToken: "unpacked-token" }));
  const child = execFile(process.execPath, [path.join(unpacked, "scripts", "windows", "codex-hook-sender.mjs"), "--settings", settingsPath],
    { cwd: root, timeout: 20000 });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { output.stdout += chunk; });
  child.stderr.on("data", (chunk) => { output.stderr += chunk; });
  child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: "thread-1", cwd: "C:/fixture", source: "startup" }));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(output.stderr, "", "no diagnostics");
  assert.equal(code, 0);
  assert.equal(output.stdout.trim(), "{}");
  assert.equal(received.length, 1);
  assert.equal(received[0].url, "/codex/hook");
  assert.equal(received[0].token, "unpacked-token");
  assert.equal(received[0].body.backend, "codex");
});

test("the packaging script takes the unpack patterns from the stage script", () => {
  const script = fs.readFileSync(path.join(repo, "scripts", "windows", "package-electron-app.ps1"), "utf8");
  assert.doesNotMatch(script, /\$asarUnpack\s*=\s*"\{/, "no copy of the pattern");
  assert.match(script, /stage-electron-app\.mjs/);
});

test("paths inside app.asar become the unpacked copy's path; others stay", () => {
  assert.equal(unpackedPath("C:\\CCF\\resources\\app.asar\\apps\\windows-shell\\companion\\kill-on-close-job.ps1"),
    "C:\\CCF\\resources\\app.asar.unpacked\\apps\\windows-shell\\companion\\kill-on-close-job.ps1");
  assert.equal(unpackedPath("/opt/ccf/resources/app.asar/scripts/windows/codex-hook-sender.mjs"),
    "/opt/ccf/resources/app.asar.unpacked/scripts/windows/codex-hook-sender.mjs");
  assert.equal(unpackedPath("C:\\repos\\ccf\\apps\\windows-shell\\companion\\kill-on-close-job.ps1"),
    "C:\\repos\\ccf\\apps\\windows-shell\\companion\\kill-on-close-job.ps1");
  assert.equal(unpackedPath("C:\\x\\app.asar.unpacked\\a.ps1"), "C:\\x\\app.asar.unpacked\\a.ps1", "already unpacked");
});
