import util from "node:util";

// How a log entry becomes a line, shared by the core's RuntimeLogger and main's MainLogger (which must not load the
// former: it writes files; process-split plan, step 7).

const SENSITIVE_KEY = /token|auth|password|passwd|secret|toolinput|toolresponse|prompt|answers/;

export function boundedText(value, maxLength = 2048) {
  try {
    const text = String(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  } catch {
    return "[Unreadable]";
  }
}

// Copy only bounded, plain data. Never retain caller objects or invoke custom inspectors.
export function normalizeContext(context) {
  const seen = new WeakSet();
  let remaining = 8192;
  let nodes = 150;
  function copy(value, depth) {
    if (--nodes < 0 || remaining <= 0) return "[Truncated]";
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value !== "object") {
      const text = boundedText(value, Math.min(1024, remaining));
      remaining -= text.length;
      return text;
    }
    if (seen.has(value)) return "[Circular]";
    if (depth >= 4) return "[Truncated]";
    seen.add(value);
    const result = Array.isArray(value) ? [] : Object.create(null);
    let count = 0;
    try {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (count++ >= 40 || nodes <= 0 || remaining <= 0) break;
        const safeKey = boundedText(key, 128);
        remaining -= safeKey.length;
        let item;
        if (SENSITIVE_KEY.test(key.toLowerCase().replace(/[^a-z]/g, ""))) {
          item = "[REDACTED]";
        } else {
          try { item = copy(value[key], depth + 1); } catch { item = "[Unreadable]"; }
        }
        if (Array.isArray(result)) result.push(item);
        else result[safeKey] = item;
      }
    } catch {
      return "[Unreadable]";
    }
    return result;
  }
  return context && typeof context === "object" ? copy(context, 0) : {};
}

export function formatLine(entry) {
  const context = Object.keys(entry.context ?? {}).length > 0
    ? ` ${util.inspect(entry.context, { depth: 4, breakLength: 120, compact: true })}`
    : "";
  return `${entry.timestamp.toISOString()} [${entry.level}] [${entry.category}] ${entry.message}${context}`;
}
