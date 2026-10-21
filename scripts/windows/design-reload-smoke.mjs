import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { waitForFile } from "./process-supervisor.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ""}`);
}

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  async function command(method, params) {
    return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP evaluation timeout")); }, 5000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
  }
  return {
    command,
    async evaluate(expression) {
      const response = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
      return response.result?.value;
    },
    close() {
      socket.close();
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("CDP closed")); }
      pending.clear();
    }
  };
}

export async function runDesignReloadSmoke({ repoRoot, appData, runtimeMetadataPath, metadata, controlHeaders }) {
  const devtoolsFile = path.join(appData, "electron-user-data", "DevToolsActivePort");
  await waitForFile(devtoolsFile, { timeoutMs: 15000 });
  const port = Number(fs.readFileSync(devtoolsFile, "utf8").split(/\r?\n/)[0]);
  assert.ok(port > 0, "isolated debugging port available");
  const targets = () => fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const conversationTarget = await until(async () => (await targets()).find((target) => target.url.endsWith("/companion-conversation.html")), "conversation renderer");
  const overlayTarget = await until(async () => (await targets()).find((target) => target.url.endsWith("/overlay.html")), "overlay renderer");
  const statusTarget = await until(async () => (await targets()).find((target) => target.url.endsWith("/companion-status.html")), "status renderer");
  const conversation = await connect(conversationTarget);
  const overlay = await connect(overlayTarget);
  const status = await connect(statusTarget);
  const cssPath = path.join(repoRoot, "apps/windows-shell/renderer/companion-conversation.css");
  const jsPath = path.join(repoRoot, "apps/windows-shell/renderer/companion-conversation.js");
  const originalCss = fs.readFileSync(cssPath);
  const originalJs = fs.readFileSync(jsPath);
  let cssChanged = false;
  let jsChanged = false;
  const draftText = "Unsent design reload draft\nsecond line";
  try {
    await until(() => conversation.evaluate(`Boolean(document.getElementById('draft') && !document.getElementById('draft').disabled && document.getElementById('consoleScreen').textContent.includes('#2197'))`), "fixture initial render");
    assert.equal(await conversation.evaluate(`document.querySelectorAll('input, textarea').length`), 1, "exactly one input field");
    assert.equal(await conversation.evaluate(`getComputedStyle(document.getElementById('consoleScreen')).fontSize`), "14px");
    for (const [code, key, virtualKeyCode, size] of [["NumpadAdd", "+", 107, "15px"], ["NumpadSubtract", "-", 109, "14px"], ["NumpadAdd", "+", 107, "15px"]]) {
      await conversation.command("Input.dispatchKeyEvent", { type: "keyDown", code, key, modifiers: 2, windowsVirtualKeyCode: virtualKeyCode });
      await conversation.command("Input.dispatchKeyEvent", { type: "keyUp", code, key, modifiers: 2, windowsVirtualKeyCode: virtualKeyCode });
      await until(() => conversation.evaluate(`getComputedStyle(document.getElementById('consoleScreen')).fontSize === '${size}'`), `real ${code} key input`);
    }
    const catGeometry = await overlay.evaluate(`(() => {
      const r = document.querySelector('.mascot-shell').getBoundingClientRect();
      return { x:screenX+r.left, right:screenX+r.right, centerY:screenY+r.top+r.height/2,
        viewport:[innerWidth,innerHeight], window:[screenX,screenY], dpr:devicePixelRatio };
    })()`);
    const readChipGeometry = () => status.evaluate(`(() => {
      const rows = document.querySelectorAll('.gauge-row');
      const first = rows[0].getBoundingClientRect(), last = rows[rows.length-1].getBoundingClientRect();
      return { x:screenX+first.left, centerY:screenY+(first.top+last.bottom)/2,
        viewport:[innerWidth,innerHeight], window:[screenX,screenY], dpr:devicePixelRatio };
    })()`);
    const chipGeometry = await until(async () => {
      const geometry = await readChipGeometry();
      return Math.abs(catGeometry.centerY - geometry.centerY) <= 2 ? geometry : false;
    }, "status window reaches its anchored position");
    console.log(JSON.stringify({ visibleFooterAlignment: { cat: catGeometry, chips: chipGeometry } }));
    assert.ok(Math.abs(catGeometry.centerY-chipGeometry.centerY) <= 2, "visible cat and complete chip stack share a horizontal centreline");
    assert.ok(chipGeometry.x-catGeometry.right >= 24 && chipGeometry.x-catGeometry.right <= 80, "modest gap between cat and chips");
    const appearance = await conversation.evaluate(`(() => {
      const surface = getComputedStyle(document.querySelector('.surface'));
      return { background: surface.backgroundColor, border: surface.borderTopWidth, shadow: surface.boxShadow,
        bodyBackground: getComputedStyle(document.body).backgroundColor, header: Boolean(document.querySelector('header')) };
    })()`);
    assert.equal(appearance.background, "rgba(0, 0, 0, 0)");
    assert.equal(appearance.border, "0px");
    assert.equal(appearance.shadow, "none");
    assert.equal(appearance.bodyBackground, "rgba(0, 0, 0, 0)");
    assert.equal(appearance.header, false);
    const startError = await conversation.evaluate(`window.ccf.companionAction({action:'start'}).then(() => 'unexpected start', error => error.message)`);
    assert.match(startError, /disabled in test mode/);
    const overlayState = await overlay.evaluate(`(() => {
      const event = new MouseEvent('contextmenu', {bubbles:true,cancelable:true,button:2});
      document.querySelector('.overlay').dispatchEvent(event);
      return { prevented:event.defaultPrevented, bubble:Boolean(document.getElementById('mascotBubble')) };
    })()`);
    assert.equal(overlayState.prevented, true);
    assert.equal(overlayState.bubble, false);
    const uiState = await overlay.evaluate(`window.ccf.getState()`);
    assert.notEqual(uiState.ui?.overlay?.contextMenu?.isOpen, true);

    const stagedImage = await conversation.evaluate(`(() => {
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VVcAAAAASUVORK5CYII=';
      const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'Pasted screenshot.png', {type:'image/png'}));
      const event = new ClipboardEvent('paste', {clipboardData:transfer,bubbles:true,cancelable:true});
      document.getElementById('draft').dispatchEvent(event);
      return event.defaultPrevented;
    })()`);
    assert.equal(stagedImage, true, "pasting an image stages it instead of pasting text");
    await until(() => conversation.evaluate(`document.querySelectorAll('.attachment').length === 1 && !document.getElementById('send').disabled`), "image-only draft ready to send");
    const attached = await conversation.evaluate(`window.ccf.getCompanion().then(snapshot => snapshot.attachments[0])`);
    assert.ok(fs.existsSync(attached.path), "pasted image saved in isolated CCF data");
    await until(() => conversation.evaluate(`document.querySelector('.attachment img')?.naturalWidth > 0`), "pasted image thumbnail decoded");

    // Appending output while scrolled up must not jump back to the prompt.
    await conversation.evaluate(`document.getElementById('consoleScreen').scrollTop = 80`);
    const beforeAppend = await conversation.evaluate(`document.getElementById('consoleScreen').scrollTop`);
    const fixture = await conversation.evaluate(`window.ccf.getCompanion()`);
    fixture.messages.at(-1).text += "\nA new line arrived while reading history.";
    const appendResponse = await fetch(`http://127.0.0.1:${metadata.controlPort}/companion-preview`, {
      method: "POST", headers: controlHeaders, body: JSON.stringify(fixture)
    });
    assert.equal(appendResponse.ok, true);
    await until(() => conversation.evaluate(`document.getElementById('consoleScreen').textContent.includes('A new line arrived')`), "new output while scrolling");
    assert.equal(await conversation.evaluate(`document.getElementById('consoleScreen').scrollTop`), beforeAppend, "new output preserves reading position");

    const before = await conversation.evaluate(`(() => {
      window.__ccfDesignSentinel = 'alive';
      const draft = document.getElementById('draft');
      draft.value = ${JSON.stringify(draftText)};
      draft.dispatchEvent(new Event('input', {bubbles:true}));
      draft.focus(); draft.setSelectionRange(3, 9, 'forward');
      const transcript = document.getElementById('consoleScreen');
      transcript.scrollTop = 80;
      return { scroll:transcript.scrollTop, transcript:transcript.textContent };
    })()`);
    assert.ok(before.scroll > 0, "fixture provides actual scroll state");
    fs.writeFileSync(cssPath, Buffer.concat([originalCss, Buffer.from("\n.surface { --ccf-design-smoke: hot-reloaded; }\n")]));
    cssChanged = true;
    await until(() => conversation.evaluate(`getComputedStyle(document.querySelector('.surface')).getPropertyValue('--ccf-design-smoke').trim() === 'hot-reloaded'`), "CSS file-save refresh");
    assert.equal(await conversation.evaluate(`window.__ccfDesignSentinel`), "alive", "CSS saves retain the document");
    assert.equal(await conversation.evaluate(`document.getElementById('draft').value`), draftText);
    fs.writeFileSync(cssPath, originalCss);
    cssChanged = false;
    await until(() => conversation.evaluate(`getComputedStyle(document.querySelector('.surface')).getPropertyValue('--ccf-design-smoke').trim() === ''`), "CSS restoration refresh");

    fs.writeFileSync(jsPath, Buffer.concat([originalJs, Buffer.from("\n// Isolated design-reload smoke save.\n")]));
    jsChanged = true;
    await until(() => conversation.evaluate(`window.__ccfDesignSentinel === undefined && document.getElementById('draft')?.value === ${JSON.stringify(draftText)} && !document.getElementById('draft').disabled`), "JS file-save reload and draft recovery");
    const restored = await conversation.evaluate(`(() => {
      const draft = document.getElementById('draft');
      return { draft:draft.value, focus:document.activeElement.id,
        start:draft.selectionStart, end:draft.selectionEnd, scroll:document.getElementById('consoleScreen').scrollTop,
        transcript:document.getElementById('consoleScreen').textContent };
    })()`);
    assert.equal(restored.focus, "draft");
    assert.equal(restored.start, 3);
    assert.equal(restored.end, 9);
    assert.equal(restored.scroll, before.scroll);
    assert.equal(restored.transcript, before.transcript);
    assert.equal(await conversation.evaluate(`document.querySelectorAll('.attachment').length`), 1, "staged image survives design reload");
    await conversation.evaluate(`document.querySelector('.attachment-remove').click()`);
    await until(() => conversation.evaluate(`document.querySelectorAll('.attachment').length === 0`), "pending image removal");
    assert.equal(fs.existsSync(attached.path), false, "removing unsent image deletes its saved copy");
    assert.equal(await conversation.evaluate(`getComputedStyle(document.getElementById('consoleScreen')).fontSize`), "15px", "chosen text size survives a renderer reload");
    assert.equal(JSON.parse(fs.readFileSync(runtimeMetadataPath, "utf8")).pid, metadata.pid, "main process survives design saves");
    const ready = await fetch(`http://127.0.0.1:${metadata.controlPort}/ready`, { headers: controlHeaders });
    assert.equal(ready.ok, true);
    console.log("Design hot reload verified: real CSS/JS saves, drafts, caret, focus, scroll, fixture, unchanged main PID, transparent surfaces and disabled cat context menu; Claude start blocked.");
  } finally {
    if (cssChanged) fs.writeFileSync(cssPath, originalCss);
    if (jsChanged) fs.writeFileSync(jsPath, originalJs);
    conversation.close();
    overlay.close();
    status.close();
  }
}
