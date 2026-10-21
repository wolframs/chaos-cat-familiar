import { mascotInputsFromState } from "./mascot-state-machine.js";

export function sessionIdentity(session) {
  return session ? `${session.projectName ?? session.projectDir ?? "Session"} · ${session.id}` : "No session connected";
}

export function companionAttention(state = {}) {
  const sessions = state.sessions ?? [];
  const approval = (state.approvals ?? []).find((item) => !item.collapsed) ?? state.approvals?.[0];
  const candidateToast = state.ui?.overlay?.toast;
  const toast = candidateToast?.visibleUntil <= Date.now() ? null : candidateToast;
  const active = sessions.filter((item) => item.status === "active");
  const working = active.find((item) => mascotInputsFromState({ sessions: [item] })["agent::isWorking"] || item.isCompacting || item.phase === "compacting");
  const session = approval
    ? sessions.find((item) => item.id === approval.event?.sessionId)
    : working ?? sessions.find((item) => item.id === toast?.sessionId) ?? active[0];
  const identity = sessionIdentity(session ?? (approval ? { id: approval.event?.sessionId ?? "unknown", projectDir: approval.event?.cwd } : null));
  if (approval) return { kind: "waiting", label: "Waiting for you", summary: `${approval.event?.toolName ?? "Request"} needs approval`, session, approval, identity };
  if (working) return { kind: "working", label: "Working", summary: working.isCompacting ? "Compacting context" : "Working", session, identity };
  if (toast) return { kind: "finished", label: "Finished", summary: toast.completedCount > 1 ? `${toast.completedCount} sessions finished` : "Finished", session, identity };
  return { kind: "idle", label: "Idle", summary: "Idle", session, identity };
}

export function syncCompanionPlayback(video, attention, hidden, animateWhenVisible = false) {
  if (hidden || (!animateWhenVisible && attention.kind !== "working")) {
    if (!video.paused) video.pause();
  } else if (video.paused) {
    video.play().catch(() => {});
  }
}

export function syncCompanionMedia(video, media, attention, hidden, animateWhenVisible = false) {
  if (hidden || (!animateWhenVisible && attention.kind !== "working") || !media?.url) {
    if (!video.paused) video.pause();
    if (video.getAttribute("src")) {
      video.removeAttribute("src");
      video.load();
    }
    return false;
  }
  if (video.getAttribute("src") !== media.url) {
    video.loop = Boolean(media.loop);
    video.src = media.url;
    video.load();
  }
  syncCompanionPlayback(video, attention, hidden, animateWhenVisible);
  return true;
}
