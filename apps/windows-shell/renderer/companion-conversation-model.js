const ROLES = new Set(["user", "assistant", "system", "tool"]);
const PHASES = new Set(["idle", "working", "attention", "offline"]);

export function normalizeCompanionSnapshot(value) {
  const source = value && typeof value === "object" ? value : {};
  const connected = source.connected === true;
  const messages = Array.isArray(source.messages) ? source.messages : [];
  const terminal = source.terminal && typeof source.terminal === "object" ? source.terminal : {};
  const prompt = source.pendingPrompt && typeof source.pendingPrompt === "object" ? source.pendingPrompt : null;

  return {
    attachments: Array.isArray(source.attachments) ? source.attachments.filter((image) => image
      && typeof image.id === "string" && typeof image.name === "string" && typeof image.previewUrl === "string")
      .map((image) => ({ id: image.id, name: image.name, previewUrl: image.previewUrl })) : [],
    connected,
    phase: connected && PHASES.has(source.phase) ? source.phase : "offline",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : "Work companion",
    messages: messages.filter((message) => message && ROLES.has(message.role) && typeof message.text === "string")
      .map((message, index) => ({
        id: String(message.id ?? index),
        role: message.role,
        text: message.text,
        timestamp: typeof message.timestamp === "string" ? message.timestamp : null
      })),
    liveText: typeof source.liveText === "string" ? source.liveText : "",
    pendingPrompt: prompt ? {
      kind: typeof prompt.kind === "string" ? prompt.kind : "input",
      label: typeof prompt.label === "string" ? prompt.label : "The companion needs input."
    } : null,
    terminal: {
      needed: terminal.needed === true,
      reason: typeof terminal.reason === "string" ? terminal.reason : "",
      screen: typeof terminal.screen === "string" ? terminal.screen : "",
      lines: Array.isArray(terminal.lines) ? terminal.lines.map((runs) => Array.isArray(runs)
        ? runs.filter((run) => run && typeof run.text === "string").map((run) => ({ ...run })) : []) : [],
      history: Array.isArray(terminal.history) ? terminal.history.map((runs) => Array.isArray(runs)
        ? runs.filter((run) => run && typeof run.text === "string").map((run) => ({ ...run })) : []) : []
    }
  };
}

export function normalizeSubmission(draft, connected, attachments = []) {
  if (!connected || typeof draft !== "string") return null;
  const text = draft.trim();
  if (!text && !attachments.length) return null;
  return attachments.length ? { action: "send", text, attachmentIds: attachments.map((image) => image.id) } : { action: "send", text };
}

export function shouldSubmitOnKeydown(event) {
  return event?.key === "Enter" && !event.shiftKey && !event.isComposing;
}
