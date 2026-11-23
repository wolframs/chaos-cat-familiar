// The legacy adapter for a window with its own state port (process-split plan, step 5): the core's part comes on the
// port (a StateMirror's state), main's part from ccf:shell-state (settings-derived meta, the shell UI state, the hosted
// Codex companion's session). Together they are the payload main sent as ccf:state before step 7, so a view keeps its
// rendering code. Pure: tests compare it with main's own snapshot. at: the mirror ({revision, epoch}) the core part
// came from, which main's payload names in meta.
//
// While main says the core is not ready (it crashed and is restarting), the port's last state is from a core that is
// gone: its approvals can no longer be answered, so they are not shown (main's own state drops them the same way).
export function composeLegacyState(core, shell = null, at = null) {
  const hosted = shell?.hostedSession ?? null;
  const sessions = hosted ? [hosted, ...(core.sessions ?? []).filter((session) => session.id !== hosted.id)] : core.sessions ?? [];
  const notifications = core.notifications ?? [];
  const coreGone = Boolean(shell?.meta?.coreStatus) && shell.meta.coreStatus !== "ready";
  return {
    ...core,
    ...(coreGone ? { approvals: [] } : {}),
    sessions,
    ...(shell?.hostedCompanion ? { hostedCompanion: shell.hostedCompanion } : {}),
    meta: {
      unreadNotificationCount: notifications.filter((item) => !item.isRead).length,
      approvalHistoryCount: notifications.filter((item) =>
        item.category === "permission_request" && item.resolutionOutcome !== "pending").length,
      ...(shell?.meta ?? {}),
      ...(at ? { revision: at.revision ?? 0, epoch: at.epoch ?? null } : {})
    },
    ui: shell?.ui ?? null
  };
}
