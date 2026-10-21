import test from "node:test";
import assert from "node:assert/strict";
import { createDesignReload } from "../services/design-reload.js";
import { captureDesignState, restoreDesignState, refreshDesignStyles, installDesignReload } from "../renderer/design-reload.js";

function fixture(options = {}) {
  let change;
  let closed = 0;
  let watched = 0;
  let nextTimer = 0;
  const timers = new Map();
  const sent = [];
  const watcher = { close() { closed++; }, on() {}, unref() {} };
  const service = createDesignReload({
    rendererDir: "C:/ccf/renderer",
    watch(_dir, config, listener) { watched++; assert.equal(config.recursive, true); change = listener; return watcher; },
    getWindows: () => [null, { isDestroyed: () => true }, { webContents: { send: (...args) => sent.push(args) } }],
    setTimer(callback, delay) { assert.equal(delay, 180); timers.set(++nextTimer, callback); return nextTimer; },
    clearTimer(timer) { timers.delete(timer); },
    ...options
  });
  return { service, sent, timers, change: (...args) => change?.(...args),
    flush() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    get closed() { return closed; }, get watched() { return watched; } };
}

test("design watcher batches a save burst, deduplicates paths and refreshes styles only", () => {
  const f = fixture();
  f.change("change", "conversation.css");
  f.change("rename", Buffer.from("shared\\theme.css"));
  f.change("change", "conversation.css");
  assert.equal(f.sent.length, 0);
  assert.equal(f.timers.size, 1);
  f.flush();
  assert.deepEqual(f.sent, [["ccf:design-reload", {
    kind: "styles", paths: ["conversation.css", "shared/theme.css"], revision: 1
  }]]);
  f.change("change", "conversation.js");
  f.change("change", "conversation.css");
  f.flush();
  assert.equal(f.sent[1][1].kind, "reload");
  assert.equal(f.sent[1][1].revision, 2);
  f.change("change", "conversation.html");
  f.flush();
  assert.equal(f.sent[2][1].kind, "reload");
});

test("design watcher ignores unrelated files, missing paths and paths outside renderer", () => {
  const f = fixture();
  for (const filename of [null, "notes.md", "image.png", "../secret.js", ".git/config.js", "C:/elsewhere/code.js", "theme.css.tmp"]) {
    f.change("change", filename);
  }
  f.flush();
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.sent, []);
});

test("packaged and explicitly disabled apps do not watch", () => {
  for (const options of [{ isPackaged: true }, { enabled: false }]) {
    const f = fixture(options);
    assert.equal(f.watched, 0);
    f.service.dispose();
  }
});

test("disposing a watcher cancels pending work and closes once", () => {
  const f = fixture();
  f.change("change", "overlay.js");
  f.service.dispose();
  f.service.dispose();
  f.change("change", "overlay.css");
  f.flush();
  assert.equal(f.closed, 1);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.sent, []);
});

function element(id, tagName, type, value = "") {
  return { id, tagName, type, value, scrollTop: 0, scrollLeft: 0,
    selectionStart: 1, selectionEnd: 3, selectionDirection: "forward",
    dispatchEvent() {}, focus() { this.focused = true; },
    setSelectionRange(...selection) { this.restoredSelection = selection; } };
}

test("renderer saves both drafts, caret and scrolled regions without password values", () => {
  const draft = element("draft", "TEXTAREA", "textarea", "unsent\nmessage");
  const raw = element("rawInput", "INPUT", "text", "terminal response");
  const password = element("password", "INPUT", "password", "do not store");
  const transcript = element("transcript", "DIV");
  transcript.scrollTop = 240;
  const elements = [draft, raw, password, transcript];
  const document = {
    querySelectorAll: () => elements, activeElement: raw,
    getElementById: (id) => elements.find((item) => item.id === id),
    defaultView: { Event: class {} }
  };
  const state = captureDesignState(document);
  assert.deepEqual(state.drafts, [{ id: "draft", value: "unsent\nmessage" }, { id: "rawInput", value: "terminal response" }]);
  assert.equal(JSON.stringify(state).includes("do not store"), false);
  draft.value = raw.value = "";
  transcript.scrollTop = 0;
  restoreDesignState(document, state);
  assert.equal(draft.value, "unsent\nmessage");
  assert.equal(raw.value, "terminal response");
  assert.equal(transcript.scrollTop, 240);
  assert.equal(raw.focused, true);
  assert.deepEqual(raw.restoredSelection, [1, 3, "forward"]);
});

function stylesheet(href, sheet) {
  return { href, sheet, listeners: {},
    cloneNode() { return stylesheet(this.href, this.sheet); },
    removeAttribute() {},
    addEventListener(event, callback) { this.listeners[event] = callback; },
    after(node) { this.inserted = node; },
    remove() { this.removed = true; }
  };
}

test("CSS reload keeps old styles until replacement loads and ignores unrelated styles", () => {
  const own = stylesheet("file:///C:/ccf/renderer/conversation.css");
  const shared = stylesheet("file:///C:/ccf/renderer/shared.css", { cssRules: [{ type: 3, href: "file:///C:/ccf/renderer/imported.css" }] });
  const remote = stylesheet("https://example.com/font.css");
  const document = { querySelectorAll: () => [own, shared, remote] };
  refreshDesignStyles(document, { paths: ["conversation.css"], revision: 4 }, "file:///C:/ccf/renderer/design-reload.js");
  assert.equal(new URL(own.inserted.href).searchParams.get("ccf-design"), "4");
  assert.equal(own.removed, undefined);
  assert.equal(shared.inserted, undefined);
  own.inserted.listeners.load();
  assert.equal(own.removed, true);
  refreshDesignStyles(document, { paths: ["unrelated.css"], revision: 5 }, "file:///C:/ccf/renderer/design-reload.js");
  assert.equal(shared.inserted, undefined);
  refreshDesignStyles(document, { paths: ["imported.css"], revision: 5 }, "file:///C:/ccf/renderer/design-reload.js");
  assert.equal(new URL(shared.inserted.href).searchParams.get("ccf-design"), "5");
  shared.inserted.listeners.error();
  assert.equal(shared.removed, undefined);
  assert.equal(shared.inserted.removed, true);
  assert.equal(remote.href, "https://example.com/font.css");
});

test("full refresh stores state only in session storage and consumes it on installation", () => {
  const storage = new Map();
  let listener;
  let reloads = 0;
  const draft = element("draft", "TEXTAREA", "textarea", "keep this");
  const document = { querySelectorAll: () => [draft], activeElement: draft,
    getElementById: () => draft, defaultView: { Event: class {} } };
  const window = { ccf: { onDesignReload(callback) { listener = callback; } },
    sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    location: { reload() { reloads++; } }, requestAnimationFrame: (callback) => callback() };
  installDesignReload({ window, document });
  listener({ kind: "reload" });
  assert.equal(reloads, 1);
  assert.equal(storage.size, 1);
  draft.value = "";
  installDesignReload({ window, document });
  assert.equal(draft.value, "keep this");
  assert.equal(storage.size, 0);
});

function asyncRestoreFixture() {
  const draft = element("draft", "TEXTAREA", "textarea", "");
  draft.disabled = true;
  const transcript = element("transcript", "DIV");
  let mutation;
  let disconnected = false;
  let frame;
  let timeout;
  const listeners = new Map();
  const saved = { drafts: [{ id: "draft", value: "saved draft" }],
    scroll: [{ id: "transcript", top: 300, left: 0 }],
    focus: { id: "draft", start: 2, end: 4, direction: "forward" } };
  const document = { documentElement: {}, body: {}, defaultView: { Event: class {} },
    activeElement: null, getElementById: (id) => id === "draft" ? draft : transcript,
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name) };
  const window = { ccf: { onDesignReload() {} },
    sessionStorage: { getItem: () => JSON.stringify(saved), removeItem() {} },
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} disconnect() { disconnected = true; } },
    setTimeout(callback, delay) { assert.equal(delay, 2000); timeout = callback; return 1; },
    clearTimeout() { timeout = undefined; },
    requestAnimationFrame(callback) { frame = callback; return 2; }, cancelAnimationFrame() { frame = undefined; }
  };
  const dispose = installDesignReload({ window, document });
  return { draft, transcript, listeners, dispose,
    mutate: () => mutation(), paint: () => frame?.(), timeout: () => timeout?.(),
    get disconnected() { return disconnected; } };
}

test("async initial render restores enabled focus and scroll without overwriting draft again", () => {
  const f = asyncRestoreFixture();
  assert.equal(f.draft.value, "saved draft");
  assert.equal(f.draft.focused, undefined);
  f.draft.value = "newer draft";
  f.transcript.scrollTop = 0;
  f.draft.disabled = false;
  f.mutate();
  assert.equal(f.draft.value, "newer draft");
  assert.equal(f.draft.focused, true);
  assert.equal(f.transcript.scrollTop, 300);
  assert.equal(f.disconnected, false);
  f.paint();
  assert.equal(f.disconnected, true);
  assert.equal(f.listeners.size, 0);
});

test("new user input, changed focus and timeout each stop pending restoration", () => {
  for (const cancel of [
    (f) => f.listeners.get("keydown")(),
    (f) => f.listeners.get("focusin")({ target: { id: "otherInput" } }),
    (f) => f.timeout()
  ]) {
    const f = asyncRestoreFixture();
    cancel(f);
    assert.equal(f.disconnected, true);
    f.draft.disabled = false;
    f.transcript.scrollTop = 10;
    f.mutate();
    assert.equal(f.draft.focused, undefined);
    assert.equal(f.transcript.scrollTop, 10);
    f.dispose();
  }
});
