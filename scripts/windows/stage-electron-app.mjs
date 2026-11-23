#!/usr/bin/env node
// Stages what a packaged CCF runs (process-split plan, step 7): electron-packager packs one folder, but main, the core,
// the companion and the renderer pages import packages/core by relative path (../../../packages/core/src), the core
// names scripts/windows/codex-hook-sender.mjs, and npm workspaces keep node-pty and @xterm/headless in the repo's root
// node_modules. The stage mirrors the repo's layout for exactly those parts, so every relative import resolves inside
// app.asar as it does in a dev run:
//
//   <stage>/package.json                      main: apps/windows-shell/main.js, type: module, no dependencies
//   <stage>/apps/windows-shell/...            the shell without its tests
//   <stage>/packages/core/{package.json,src}  the core package
//   <stage>/scripts/windows/codex-hook-sender.mjs
//   <stage>/node_modules/node-pty             package.json, lib, prebuilds/win32-x64 (unpacked from asar by the packager)
//   <stage>/node_modules/@xterm/headless      package.json, lib-headless
//
//   node scripts/windows/stage-electron-app.mjs [--out <folder>]   (default packaging/windows/input/stage)
//   node scripts/windows/stage-electron-app.mjs --patterns         the asar unpack patterns as JSON, nothing staged
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// What goes into the package; paths relative to the repo. Directories are copied whole except what `skip` names.
export const STAGED = [
  { from: "apps/windows-shell", skip: ["test", "node_modules"] },
  { from: "packages/core/package.json" },
  { from: "packages/core/src" },
  { from: "scripts/windows/codex-hook-sender.mjs" },
  { from: "node_modules/node-pty/package.json" },
  { from: "node_modules/node-pty/LICENSE" },
  { from: "node_modules/node-pty/lib" },
  { from: "node_modules/node-pty/prebuilds/win32-x64" },
  { from: "node_modules/@xterm/headless/package.json" },
  { from: "node_modules/@xterm/headless/lib-headless" }
];

// Files that programs outside Electron open by path (PowerShell, node, conpty's agents): electron-packager unpacks them
// next to app.asar (app.asar.unpacked), and the code hands those paths over (services/asar-paths.js). node runs the
// Codex hook sender from there and cannot read app.asar, so everything the sender imports is unpacked with it, and the
// package.json that makes those .js files modules (stage-electron-app.test.mjs checks the sender's import graph).
// package-electron-app.ps1 takes both values from this script's output.
export const ASAR_UNPACK = "{**/*.ps1,**/*.node,**/*.exe,**/*.dll,**/codex-hook-sender.mjs,**/codex-hook-adapter.js,"
  + "**/apps/windows-shell/package.json}";
export const ASAR_UNPACK_DIR = "node_modules/node-pty";

function copy(source, target, skip = []) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      if (skip.includes(entry) || entry.endsWith(".pdb")) continue;   // debug symbols: most of node-pty's prebuilds
      copy(path.join(source, entry), path.join(target, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

export function stageElectronApp({ out = path.join(repo, "packaging", "windows", "input", "stage") } = {}) {
  fs.rmSync(out, { recursive: true, force: true });
  for (const item of STAGED) {
    const source = path.join(repo, item.from);
    if (!fs.existsSync(source)) throw new Error(`Missing ${item.from} (run npm install first).`);
    copy(source, path.join(out, item.from), item.skip ?? []);
  }
  const shell = JSON.parse(fs.readFileSync(path.join(repo, "apps", "windows-shell", "package.json"), "utf8"));
  // The packager takes Electron's version from devDependencies: the one installed here (its zip is in @electron/get's
  // cache since npm install), so dev runs and the package run the same Electron.
  const electron = JSON.parse(fs.readFileSync(path.join(repo, "node_modules", "electron", "package.json"), "utf8")).version;
  fs.writeFileSync(path.join(out, "package.json"), `${JSON.stringify({
    name: "chaos-cat-familiar",
    productName: shell.productName,
    version: shell.version,
    description: shell.description,
    author: "Chaos Cat Familiar",
    private: true,
    type: "module",
    main: "apps/windows-shell/main.js",
    devDependencies: { electron }
  }, null, 2)}\n`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes("--patterns")) {
    console.log(JSON.stringify({ unpack: ASAR_UNPACK, unpackDir: ASAR_UNPACK_DIR }));
    process.exit(0);
  }
  const index = process.argv.indexOf("--out");
  const out = stageElectronApp(index > 0 ? { out: path.resolve(process.argv[index + 1]) } : {});
  console.log(JSON.stringify({ stage: out, unpack: ASAR_UNPACK, unpackDir: ASAR_UNPACK_DIR }));
}
