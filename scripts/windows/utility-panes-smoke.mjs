import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnLoggedProcess, waitForJson, waitForFile } from "./process-supervisor.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-utility-smoke-"));
const appData = path.join(root, "appdata");
const home = path.join(root, "home");
fs.mkdirSync(home);
fs.mkdirSync(path.join(appData, "chaos-cat-familiar"), { recursive: true });
fs.writeFileSync(path.join(appData, "chaos-cat-familiar/settings.json"), JSON.stringify({ onboardingCompleted: true }));
const token = `utility-${Date.now()}`;
const supervisor = spawnLoggedProcess(path.join(repo, "node_modules/.bin/electron.cmd"), [".", "--remote-debugging-port=0"], {
  cwd: path.join(repo, "apps/windows-shell"), logFile: path.join(root, "electron.log"),
  env: { ...process.env, CCF_HOME_OVERRIDE: home, CCF_APPDATA_OVERRIDE: appData,
    CCF_TEST_MODE: "1", CCF_PORT_OVERRIDE: "0", CCF_TEST_TOKEN: token, CCF_DESIGN_RELOAD: "0" }
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(150);
  }
  throw new Error(`Timed out: ${label}`);
}
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let next = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (!pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(timer);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { command, close: () => socket.close(), async evaluate(expression) {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  } };
}
let metadata;
const clients = [];
try {
  metadata = await waitForJson(path.join(appData, "chaos-cat-familiar/runtime.json"), { timeoutMs: 45000 });
  const devtools = path.join(appData, "electron-user-data/DevToolsActivePort");
  await waitForFile(devtools);
  const port = Number(fs.readFileSync(devtools, "utf8").split(/\r?\n/)[0]);
  const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  const control = (route) => fetch(`http://127.0.0.1:${metadata.controlPort}${route}`, { headers: { "x-ccf-test-token": token }, signal: AbortSignal.timeout(15000) });
  assert.equal((await control("/capture-dashboard")).ok, true);
  const dashboard = await connect(await until(async () => (await targets()).find((t) => t.url.endsWith("/dashboard.html")), "dashboard"));
  clients.push(dashboard);
  await dashboard.evaluate(`Promise.all([window.ccf.openMascotManager(), window.ccf.openDiagnostics(), window.ccf.openMascotPreview()])`);
  const outputDir = process.env.CCF_UI_CAPTURE_DIR;
  if (outputDir) fs.mkdirSync(outputDir, { recursive: true });
  for (const name of ["dashboard", "mascots", "diagnostics", "mascot-preview"]) {
    const target = await until(async () => (await targets()).find((t) => t.url.endsWith(`/${name}.html`)), name);
    const client = name === "dashboard" ? dashboard : await connect(target);
    if (client !== dashboard) clients.push(client);
    await until(() => client.evaluate(`document.readyState === 'complete' && !!document.querySelector('[data-window-action="close"]')`), `${name} loaded`);
    await client.evaluate(`document.fonts.ready`);
    if (name === "diagnostics") await until(() => client.evaluate(`Boolean(document.querySelector('#port').value)`), "diagnostics data loaded");
    if (name === "dashboard") {
      await client.evaluate(`window.ccf.dispatchCommand('complete-onboarding')`);
      await client.evaluate(`document.querySelector('#nav [data-section="settings"]')?.click()`);
    }
    await delay(700);
    const inspect = () => client.evaluate(`(() => {
      const bar = document.querySelector('.window-titlebar');
      const close = bar.querySelector('[data-window-action="close"]');
      const rect = close.getBoundingClientRect();
      return { top: bar.getBoundingClientRect().top, hit: document.elementFromPoint(rect.x + rect.width/2, rect.y + rect.height/2) === close,
        count: bar.querySelectorAll('button').length, drag: getComputedStyle(bar).webkitAppRegion,
        noDrag: getComputedStyle(close.parentElement).webkitAppRegion, background: getComputedStyle(document.body).backgroundColor,
        overflow: document.documentElement.scrollWidth > innerWidth };
    })()`);
    const first = await inspect();
    assert.equal(first.top, 0, `${name} titlebar at top`);
    assert.equal(first.hit, true, `${name} close is clickable`);
    assert.equal(first.count, 3);
    assert.equal(first.drag, "drag");
    assert.equal(first.noDrag, "no-drag");
    assert.equal(first.background, "rgb(16, 13, 24)");
    assert.equal(first.overflow, false, `${name} fits viewport`);
    if (outputDir) {
      const { data } = await client.command("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(outputDir, `${name}.png`), Buffer.from(data, "base64"));
    }
    await client.evaluate(`scrollTo(0, document.body.scrollHeight)`);
    assert.equal((await inspect()).hit, true, `${name} close remains reachable after scrolling`);
    await client.evaluate(`scrollTo(0, 0)`);
    await client.command("Emulation.setDeviceMetricsOverride", { width: 600, height: 720, deviceScaleFactor: 1, mobile: false });
    assert.equal((await inspect()).overflow, false, `${name} fits a narrow window`);
    assert.equal((await inspect()).hit, true, `${name} narrow-window close remains reachable`);
    await client.command("Emulation.clearDeviceMetricsOverride");
    // Exercise actual renderer wiring; close is tested last so its CDP target may disappear.
    await client.evaluate(`document.querySelector('[data-window-action="toggle-maximize"]').click()`);
    await delay(100);
    await client.evaluate(`document.querySelector('[data-window-action="toggle-maximize"]').click()`);
    await client.evaluate(`document.querySelector('[data-window-action="minimize"]').click()`);
    if (name !== "dashboard") {
      await client.command("Runtime.evaluate", { expression: `document.querySelector('[data-window-action="close"]').click()` }).catch(() => {});
      await until(async () => !(await targets()).some((t) => t.id === target.id), `${name} closed`);
    }
    console.log(`${name}: theme, layout, scrolling and window controls passed`);
  }
  console.log("Isolated utility pane smoke passed; no Claude session started.");
} catch (error) {
  console.error(fs.readFileSync(path.join(root, "electron.log"), "utf8").slice(-4000));
  throw error;
} finally {
  for (const client of clients) client.close();
  if (metadata) await fetch(`http://127.0.0.1:${metadata.controlPort}/shutdown`, { method: "POST", headers: { "x-ccf-test-token": token }, signal: AbortSignal.timeout(5000) }).catch(() => {});
  await supervisor.waitForExit(10000).catch(async () => { await supervisor.killTree(); await supervisor.waitForExit(10000); });
  await supervisor.closeLog();
  // Only remove our freshly created disposable profile, after checking for links.
  function checkLinks(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const item = path.join(folder, entry.name);
      if (fs.lstatSync(item).isSymbolicLink()) throw new Error(`Unexpected profile link: ${item}`);
      if (entry.isDirectory()) checkLinks(item);
    }
  }
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  checkLinks(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
