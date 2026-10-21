const KEY = "ccf:companion:text-size";
const DEFAULT_SIZE = 14;

export function normalizeTextSize(value) {
  const number = Number(value);
  return Number.isFinite(number) && value !== null && value !== ""
    ? Math.max(10, Math.min(28, Math.round(number))) : DEFAULT_SIZE;
}

export function fontSizeShortcut(event) {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return null;
  if (event.code === "NumpadAdd" || event.key === "+" || event.key === "=") return 1;
  if (event.code === "NumpadSubtract" || event.key === "-") return -1;
  if (event.code === "Numpad0" || event.code === "Digit0" || event.key === "0") return 0;
  return null;
}

export function installCompanionTextSize({ window = globalThis.window, document = window.document, onChange = () => {} } = {}) {
  let size = DEFAULT_SIZE;
  try { size = normalizeTextSize(window.localStorage.getItem(KEY)); } catch {}
  function apply() {
    document.documentElement.style.setProperty("--companion-text-size", `${size}px`);
    onChange(size);
  }
  function adjust(direction) {
    if (![1, -1, 0].includes(direction)) return;
    size = direction === 0 ? DEFAULT_SIZE : normalizeTextSize(size + direction);
    try { window.localStorage.setItem(KEY, String(size)); } catch {}
    apply();
  }
  function onKey(event) {
    const direction = fontSizeShortcut(event);
    if (direction === null) return;
    event.preventDefault();
    event.stopPropagation();
    adjust(direction);
  }
  apply();
  window.addEventListener("keydown", onKey, true);
  const unsubscribe = window.ccf?.onCompanionTextSize?.(adjust);
  return { getSize: () => size, dispose: () => { window.removeEventListener("keydown", onKey, true); unsubscribe?.(); } };
}
