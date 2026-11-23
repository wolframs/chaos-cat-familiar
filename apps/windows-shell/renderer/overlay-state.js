// The cat's overlay state (process-split plan, step 7): the core's sessions and approvals arrive on the overlay's own
// port (topics "sessions" and "approvals"), main's part (settings-derived meta, the shell UI state, the hosted Codex
// companion) as ccf:shell-state. The overlay draws live sessions only (an ended one stays while the toast, an approval
// or the hosted companion names it) and shows counts, never the notification list or the event history. Pure, so
// tests compose exactly what the page draws.
import { composeLegacyState } from "./legacy-state.js";

export const OVERLAY_TOPICS = Object.freeze(["sessions", "approvals"]);

export function composeOverlayState(core, shell = null, at = null) {
  const payload = composeLegacyState(core, shell, at);
  const named = new Set([...(payload.approvals ?? []).map((item) => item.event?.sessionId),
    payload.ui?.overlay?.toast?.sessionId, payload.hostedCompanion?.sessionId].filter(Boolean));
  const summary = core?.notificationSummary ?? {};
  return {
    ...payload,
    events: [],
    logs: [],
    notifications: [],
    sessions: (payload.sessions ?? []).filter((session) => session.status !== "ended" || named.has(session.id)),
    meta: {
      ...payload.meta,
      // The notification list is not on this port: its counts come from the core's summary.
      unreadNotificationCount: summary.unreadCount ?? 0,
      approvalHistoryCount: summary.pendingApprovalHistoryCount ?? 0,
      eventCount: core?.summary?.eventCount ?? 0,
      sessionCount: payload.sessions?.length ?? 0
    }
  };
}
