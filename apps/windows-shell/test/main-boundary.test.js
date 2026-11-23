// Process-split plan, step 7: the boundary of Electron's main process, checked from its imports. Main keeps windows,
// tray, hotkeys, native effects and supervision; the core (stores, controller, HookServer, SQLite) and the companion
// (node-pty, xterm) run in their utility processes, and no file work in main blocks its event loop. Every module main
// can load, statically or with import(), is read here; none may be one of the core's or companion's own, import those
// packages, or call a synchronous fs or child_process function.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importGraph, importPath, stripComments } from "../test-support/import-graph.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MAIN = path.join(REPO, "apps", "windows-shell", "main.js");
const rel = (file) => path.relative(REPO, file).replaceAll("\\", "/");

// The core's and the companion's own modules: stores, controller, HookServer, storage, compositions, backends.
const SERVICE_MODULES = [
  /^packages\/core\/src\/(index|core-controller|core-service|hook-server|approval-store|session-store|json-state-store|file-settings-store|atomic-json|companion-delivery|storage-client|storage-worker|storage-schema|row-shadow)\.js$/,
  /^apps\/windows-shell\/core\/core-(composition|process)\.js$/,
  /^apps\/windows-shell\/companion\/companion-(composition|process)\.js$/,
  /^apps\/windows-shell\/services\/(companion-session|companion-backends|companion-attachments|companion-production|companion-watcher|companion-habitat|terminal-screen|codex-[\w-]+|runtime-logger|claude-hook-installer)\.js$/
];
const SERVICE_PACKAGES = [/^node-pty$/, /^@xterm\//, /^(node:)?sqlite$/, /^better-sqlite3$/];
const SYNC_CALLS = [...Object.keys(fs), ...Object.keys(childProcess)].filter((name) => /Sync$/.test(name));
const SYNC_PATTERN = new RegExp(`\\b(${SYNC_CALLS.join("|")})\\s*\\(`, "g");
// Main holds clients, never the live objects behind them (the step-2 guard, now over every module main loads).
const REACH = { controller: /\bcontroller\.(?!abort\b|signal\b)\w/, companionSession: /\bcompanionSession\./, getSnapshot: /\.getSnapshot\(/ };

function violations(entry = MAIN) {
  const graph = importGraph(entry);
  const found = new Map();
  for (const [file, { source, imports }] of graph) {
    const name = rel(file);
    if (SERVICE_MODULES.some((pattern) => pattern.test(name))) {
      found.set(`module:${name}`, importPath(graph, entry, (item) => item.resolved === file));
    }
    for (const item of imports) {
      if (!item.specifier) found.set(`dynamic:${name}`, [`import(${item.expression})`]);
      else if (!item.resolved && SERVICE_PACKAGES.some((pattern) => pattern.test(item.specifier))) {
        found.set(`package:${item.specifier}`, importPath(graph, entry, (candidate) => candidate.specifier === item.specifier));
      }
    }
    const code = stripComments(source);
    for (const match of code.matchAll(SYNC_PATTERN)) found.set(`sync:${name}:${match[1]}`, [name]);
    for (const [what, pattern] of Object.entries(REACH)) if (pattern.test(code)) found.set(`reach:${name}:${what}`, [name]);
  }
  return found;
}

test("main's import graph holds no store, no service module or package, and no synchronous file or process call", () => {
  const found = [...violations()].map(([key, chain]) =>
    `${key}\n      ${(chain ?? []).map((step) => (path.isAbsolute(step) ? rel(step) : step)).join("\n      -> ")}`);
  assert.deepEqual(found, [], "boundary violations in main (with the import chain that loads each)");
});

// The patterns catch what they are meant to catch (the graph itself is read from disk above).
test("the boundary patterns: service modules and packages, sync calls, reaching into live objects", () => {
  assert.ok(SERVICE_MODULES.some((pattern) => pattern.test("packages/core/src/session-store.js")));
  assert.ok(SERVICE_MODULES.some((pattern) => pattern.test("apps/windows-shell/core/core-composition.js")));
  assert.ok(!SERVICE_MODULES.some((pattern) => pattern.test("packages/core/src/core-client.js")));
  assert.ok(SERVICE_PACKAGES.some((pattern) => pattern.test("node:sqlite")));
  assert.ok(SERVICE_PACKAGES.some((pattern) => pattern.test("@xterm/headless")));
  assert.deepEqual([..."fs.readFileSync(x); appendFileSync (y); spawnSync(z); flushSync();".matchAll(SYNC_PATTERN)]
    .map((match) => match[1]), ["readFileSync", "appendFileSync", "spawnSync"]);
  assert.ok(REACH.controller.test("core.controller.snapshot()") && !REACH.controller.test("controller.abort()"));
});

test("the import reader sees static, re-exported and dynamic imports, and ignores comments", async () => {
  const { moduleImports } = await import("../test-support/import-graph.js");
  const source = [
    "import fs from \"node:fs\";",
    "import {\n  a,\n  b\n} from \"./multi-line.js\";",
    "export { c } from './re-export.js';",
    "export * from \"./star.js\";",
    "import \"./side-effect.js\";",
    "const lazy = await import(\"./lazy.js\");",
    "const computed = await import(name);",
    "// import x from \"./commented.js\";",
    "/* import(\"./block-commented.js\") */",
    "const url = \"http://example//not-a-comment\"; import y from \"./after-string.js\";"
  ].join("\n");
  assert.deepEqual(moduleImports(source).map((item) => item.specifier ?? `expr:${item.expression}`).sort(), [
    "./after-string.js", "./lazy.js", "./multi-line.js", "./re-export.js", "./side-effect.js", "./star.js", "expr:name",
    "node:fs"
  ]);
});

// Final review (P2): `import{X}from"..."` (no spaces, as minified or hand-packed code writes it) was not seen, and a
// bare import was a leaf, so main could import @chaos-cat-familiar/core (the core's index: controller, stores) unseen.
test("the import reader sees every ESM import and export-from form, spaced or not, and nothing in strings or templates", async () => {
  const { moduleImports } = await import("../test-support/import-graph.js");
  const source = [
    "#!/usr/bin/env node",
    "import{a}from\"./tight.js\";import*as ns from'./tight-ns.js';import d,{e as f}from\"./default-and-named.js\"",
    "export{g}from\"./tight-export.js\";export*from'./tight-star.js';export * as h from \"./star-as.js\";",
    "import\"./tight-side-effect.js\";import j from \"./with.json\" with { type: \"json\" };",
    "import { from } from \"./binding-named-from.js\";",
    "const k = await import(`./template-literal.js`); const l = await import(`./${name}.js`);",
    "const m = import.meta.url; registry.import(\"./a-method.js\"); const o = { import: \"./a-key.js\" };",
    "const quote = /\"/g; import p from \"./after-regex.js\";",
    "const q = `import r from \"./in-template.js\"`; const s = \"import t from './in-string.js'\";",
    "const u = `${ `import v from \"./nested-template.js\"` }`; import w from \"./after-nested.js\";",
    "export const x = 1; export { x as y }; export default function z() {}"
  ].join("\n");
  assert.deepEqual(moduleImports(source).map((item) => item.specifier ?? `expr:${item.expression}`).sort(), [
    "./after-nested.js", "./after-regex.js", "./binding-named-from.js", "./default-and-named.js", "./star-as.js",
    "./template-literal.js", "./tight-export.js", "./tight-ns.js", "./tight-side-effect.js", "./tight-star.js",
    "./tight.js", "./with.json", "expr:`./${name}.js`"
  ]);
});

test("a workspace package import is followed into the package and caught by the boundary", (t) => {
  const dir = fs.mkdtempSync(path.join(REPO, "apps", "windows-shell", "test", ".boundary-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entry = path.join(dir, "fake-main.js");
  fs.writeFileSync(entry, "import{CcfCoreController}from\"@chaos-cat-familiar/core\";\n"
    + "import { normalizeEvent } from \"@chaos-cat-familiar/core/src/models.js\";\n");
  const found = [...violations(entry).keys()];
  assert.ok(found.includes("module:packages/core/src/index.js"), found.join("\n"));
  assert.ok(found.includes("module:packages/core/src/core-controller.js"));
  const graph = importGraph(entry);
  assert.ok(graph.has(path.join(REPO, "packages", "core", "src", "models.js")), "a subpath resolves inside the package");
  const item = graph.get(entry).imports[0];
  assert.equal(item.workspace, "@chaos-cat-familiar/core");
});
