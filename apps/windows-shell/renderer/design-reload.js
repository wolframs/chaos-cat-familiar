const STORAGE_KEY = "ccf:design-reload:view:v1";
const TEXT_TYPES = new Set(["text", "search", "email", "url", "tel", "number"]);

function isDraft(element) {
  return element.tagName === "TEXTAREA" || (element.tagName === "INPUT" && TEXT_TYPES.has(element.type));
}

export function captureDesignState(document) {
  const drafts = [];
  const scroll = [];
  for (const element of document.querySelectorAll("[id]")) {
    if (isDraft(element)) drafts.push({ id: element.id, value: element.value });
    if (element.scrollTop || element.scrollLeft) {
      scroll.push({ id: element.id, top: element.scrollTop, left: element.scrollLeft });
    }
  }
  const active = document.activeElement;
  const focus = active?.id ? {
    id: active.id,
    start: isDraft(active) ? active.selectionStart : null,
    end: isDraft(active) ? active.selectionEnd : null,
    direction: isDraft(active) ? active.selectionDirection : null
  } : null;
  return { drafts, scroll, focus };
}

export function restoreDesignState(document, state) {
  if (!state || !Array.isArray(state.drafts) || !Array.isArray(state.scroll)) return;
  for (const { id, value } of state.drafts) {
    const element = document.getElementById(id);
    if (!element || !isDraft(element) || typeof value !== "string") continue;
    element.value = value;
    element.dispatchEvent(new document.defaultView.Event("input", { bubbles: true }));
  }
  restoreView(document, state);
}

function restoreView(document, state) {
  for (const { id, top, left } of state.scroll) {
    const element = document.getElementById(id);
    if (element) { element.scrollTop = top; element.scrollLeft = left; }
  }
  const active = state.focus && document.getElementById(state.focus.id);
  if (active && !active.disabled) {
    active.focus({ preventScroll: true });
    if (isDraft(active) && Number.isInteger(state.focus.start)) {
      try { active.setSelectionRange(state.focus.start, state.focus.end, state.focus.direction ?? "none"); }
      catch { /* Number inputs do not expose a text selection. */ }
    }
  }
}

function importsChanged(sheet, changed, seen = new Set()) {
  if (!sheet || seen.has(sheet)) return false;
  seen.add(sheet);
  try {
    for (const rule of sheet.cssRules ?? []) {
      if (rule.type !== 3) continue;
      if (rule.href && changed.has(new URL(rule.href, sheet.href).pathname)) return true;
      if (importsChanged(rule.styleSheet, changed, seen)) return true;
    }
  } catch { /* Cross-origin stylesheets cannot be inspected. */ }
  return false;
}

export function refreshDesignStyles(document, payload, rendererUrl = import.meta.url) {
  const changed = new Set((payload.paths ?? []).map((filename) => new URL(filename, rendererUrl).pathname));
  const links = [...document.querySelectorAll('link[rel="stylesheet"]')]
    .filter((link) => !link.ccfDesignPending && new URL(link.href).protocol === "file:");
  const matching = links.filter((link) => changed.has(new URL(link.href).pathname) || importsChanged(link.sheet, changed));
  for (const link of matching) {
    link.ccfDesignReplacement?.remove();
    const href = new URL(link.href);
    href.searchParams.set("ccf-design", String(payload.revision));
    const replacement = link.cloneNode();
    replacement.ccfDesignPending = true;
    replacement.removeAttribute("id");
    replacement.href = href.href;
    link.ccfDesignReplacement = replacement;
    replacement.addEventListener("load", () => {
      if (link.ccfDesignReplacement !== replacement) return;
      replacement.ccfDesignPending = false;
      if (link.id) replacement.id = link.id;
      link.remove();
    }, { once: true });
    replacement.addEventListener("error", () => {
      if (link.ccfDesignReplacement === replacement) delete link.ccfDesignReplacement;
      replacement.remove();
    }, { once: true });
    link.after(replacement);
  }
}

function finishAsyncRestore(window, document, saved) {
  let stopped = false;
  let observer;
  let timer;
  let frame;
  const events = ["keydown", "pointerdown", "wheel", "touchstart"];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    observer?.disconnect();
    if (timer !== undefined) window.clearTimeout?.(timer);
    if (frame !== undefined) window.cancelAnimationFrame?.(frame);
    for (const event of events) document.removeEventListener?.(event, stop, true);
    document.removeEventListener?.("focusin", changedFocus, true);
  };
  const changedFocus = (event) => {
    if (event.target?.id !== saved.focus?.id && event.target !== document.body) stop();
  };
  const targetReady = () => {
    if (!saved.focus?.id) return true;
    const target = document.getElementById(saved.focus.id);
    return target && !target.disabled;
  };
  const afterRender = () => {
    if (stopped) return;
    // Retry only the view. Draft values are restored exactly once so typing
    // while startup snapshots arrive can never be overwritten.
    restoreView(document, saved);
    if (targetReady() && frame === undefined) {
      frame = window.requestAnimationFrame(() => {
        if (stopped) return;
        restoreView(document, saved);
        stop();
      });
    }
  };
  for (const event of events) document.addEventListener?.(event, stop, true);
  document.addEventListener?.("focusin", changedFocus, true);
  if (window.MutationObserver && document.documentElement) {
    observer = new window.MutationObserver(afterRender);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled"] });
  }
  timer = window.setTimeout?.(stop, 2000);
  afterRender();
  return stop;
}

export function installDesignReload({ window = globalThis.window, document = window?.document } = {}) {
  if (!window?.ccf?.onDesignReload || !document) return () => {};
  let saved;
  try {
    saved = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null");
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch { /* Storage may be unavailable or from an interrupted edit. */ }
  if (!Array.isArray(saved?.drafts) || !Array.isArray(saved?.scroll)) saved = null;
  restoreDesignState(document, saved);
  const stopRestore = saved ? finishAsyncRestore(window, document, saved) : () => {};
  const unsubscribe = window.ccf.onDesignReload((payload) => {
    if (payload?.kind === "styles") return refreshDesignStyles(document, payload);
    if (payload?.kind !== "reload") return;
    try { window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(captureDesignState(document))); }
    catch { /* A renderer reload still works when session storage is disabled. */ }
    window.location.reload();
  });
  return () => { stopRestore(); unsubscribe?.(); };
}

if (typeof window !== "undefined") installDesignReload();
