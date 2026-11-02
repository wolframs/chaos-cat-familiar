const ROLES = new Set(["user", "assistant", "system", "tool"]);
const PHASES = new Set(["idle", "working", "attention", "offline"]);

export function normalizeCompanionSnapshot(value, previous) {
  const source = value && typeof value === "object" ? value : {};
  const connected = source.connected === true;
  const messages = Array.isArray(source.messages) ? source.messages : [];
  const terminal = source.terminal && typeof source.terminal === "object" ? source.terminal : {};
  const prompt = source.pendingPrompt && typeof source.pendingPrompt === "object" ? source.pendingPrompt : null;
  const revision = Number.isSafeInteger(terminal.revision) && terminal.revision >= 0 ? terminal.revision : null;
  const reusableTerminal = revision !== null && previous?.terminal?.revision === revision ? previous.terminal : null;

  return {
    backend: source.backend === "codex" ? "codex" : "claude",
    debugUi: source.debugUi === true,
    connecting:source.phase==='connecting'||source.starting===true,
    switching:source.switching===true,
    conversationId: typeof source.conversationId === "string" ? source.conversationId : null,
    sessionRootId: typeof source.sessionRootId === "string" ? source.sessionRootId : null,
    connectionEpoch: Number.isSafeInteger(source.connectionEpoch) ? source.connectionEpoch : 0,
    error: typeof source.error === "string" ? source.error : null,
    errorInfo:source.errorInfo&&typeof source.errorInfo.code==='string'?{
      code:source.errorInfo.code,
      reason:typeof source.errorInfo.reason==='string'?source.errorInfo.reason:'Codex needs attention.',
      actions:Array.isArray(source.errorInfo.actions)?source.errorInfo.actions.filter(action=>['open-settings','start','recover-launch'].includes(action)):[]
    }:source.backend==='codex'&&typeof source.error==='string'?{
      code:'lifecycle-failed',reason:source.error,actions:['open-settings','start',...(!source.connected&&!source.conversationId?['recover-launch']:[])]
    }:null,
    historyCursor: typeof source.historyCursor === "string" ? source.historyCursor : null,
    usage: source.usage && typeof source.usage === "object" ? structuredClone(source.usage) : null,
    submission: source.submission && typeof source.submission === "object" ? {...source.submission} : null,
    pendingRequests: Array.isArray(source.pendingRequests) ? source.pendingRequests.slice(0,64).map(request => structuredClone(request)) : [],
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
        type: typeof message.type === "string" ? message.type : null,
        status: typeof message.status === "string" ? message.status : null,
        outputLimited: message.outputLimited === true,
        outputRevision:Number.isSafeInteger(message.outputRevision)?message.outputRevision:null,
        outputPreviewAvailable:message.outputPreviewAvailable===true,
        timestamp: typeof message.timestamp === "string" ? message.timestamp : null
      })),
    liveText: typeof source.liveText === "string" ? source.liveText : "",
    pendingPrompt: prompt ? {
      kind: typeof prompt.kind === "string" ? prompt.kind : "input",
      label: typeof prompt.label === "string" ? prompt.label : "The companion needs input."
    } : null,
    terminal: {
      revision,
      needed: terminal.needed === true,
      reason: typeof terminal.reason === "string" ? terminal.reason : "",
      screen: typeof terminal.screen === "string" ? terminal.screen : "",
      lines: reusableTerminal?.lines ?? (Array.isArray(terminal.lines) ? terminal.lines.map((runs) => Array.isArray(runs)
        ? runs.filter((run) => run && typeof run.text === "string").map((run) => ({ ...run })) : []) : []),
      history: reusableTerminal?.history ?? (Array.isArray(terminal.history) ? terminal.history.map((runs) => Array.isArray(runs)
        ? runs.filter((run) => run && typeof run.text === "string").map((run) => ({ ...run })) : []) : [])
    }
  };
}

export function normalizeSubmission(draft, connected, attachments = []) {
  if (!connected || typeof draft !== "string") return null;
  const text = draft.trim();
  if (!text && !attachments.length) return null;
  return attachments.length ? { action: "send", text, attachmentIds: attachments.map((image) => image.id) } : { action: "send", text };
}

export function backendSwitchGuard(snapshot,{busy=false,attaching=false}={}){
  if(busy||attaching||snapshot.connecting||snapshot.switching)return{allowed:false,reason:'Wait for the current operation to finish before switching.'};
  if(['pending','outcomeUnknown'].includes(snapshot.submission?.state))return{allowed:false,reason:'Resolve the pending or uncertain message before switching.'};
  if(snapshot.pendingRequests?.length||snapshot.pendingPrompt||['working','attention'].includes(snapshot.phase))return{allowed:false,reason:'Wait for the current turn or answer its request before switching.'};
  if(snapshot.connected&&snapshot.phase!=='idle')return{allowed:false,reason:'Wait until the companion is ready before switching.'};
  return{allowed:true,reason:''};
}

export function submissionStatusText(snapshot){
  if(snapshot.backend!=='codex')return '';
  const state=snapshot.submission?.state;
  if(state==='accepted')return snapshot.debugUi===true?'Message accepted.':'';
  const statuses={pending:'Sending… Draft retained until accepted.',rejected:'Message rejected. Your draft is retained.',outcomeUnknown:'May have been sent. Inspect the conversation before explicitly resolving or resending.'};
  return statuses[state]??(snapshot.phase==='working'?'The turn is active. You can edit your next message; Send becomes available when idle.':'');
}

export function shouldSubmitOnKeydown(event) {
  return event?.key === "Enter" && !event.shiftKey && !event.isComposing;
}

