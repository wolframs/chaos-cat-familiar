function toIsoOrNull(value) {
  return value ? new Date(value).toISOString() : null;
}

function parseIso(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function sessionSort(a, b) {
  if (a.phase === "running" && b.phase !== "running") {
    return -1;
  }
  if (a.phase !== "running" && b.phase === "running") {
    return 1;
  }
  const aTime = new Date(a.lastEventAt ?? a.startedAt ?? 0).getTime();
  const bTime = new Date(b.lastEventAt ?? b.startedAt ?? 0).getTime();
  return bTime - aTime;
}

export class ShellUiState {
  constructor({ settingsStore, timers, onboardingVersion = 1 }) {
    this.settingsStore = settingsStore;
    this.timers = timers;
    this.onboardingVersion = onboardingVersion;
    this.toastTimer = null;
    this.lastToastEventId = null;
    this.state = {
      overlay: {
        toast: null,
        sessionSwitcher: {
          isOpen: false,
          selectedIndex: 0,
          sessions: []
        },
        expandedApproval: {
          approvalId: null
        },
        contextMenu: {
          isOpen: false,
          mode: "closed"
        }
      },
      onboarding: {
        required: true,
        currentStep: 0,
        completed: false,
        lastCompletedAt: null
      }
    };
    this.initializeFromSettings();
  }

  initializeFromSettings() {
    const settings = this.settingsStore.load();
    const completed = settings.onboardingVersion === this.onboardingVersion;
    const lastOnboardingStep = 6;
    this.state.onboarding = {
      required: !completed,
      currentStep: completed ? lastOnboardingStep : 0,
      completed,
      lastCompletedAt: settings.onboardingCompletedAt ?? null
    };
  }

  sync(coreState, lastEvent = null) {
    this.#syncSessionSwitcher(coreState);
    this.#syncExpandedApproval(coreState);
    this.#syncToast(coreState, lastEvent);
    this.#syncSnoozeExpiry();
  }

  snapshot() {
    return structuredClone(this.state);
  }

  async dispatch(command, payload, runtime) {
    switch (command) {
      case "open-session-switcher":
        this.openSessionSwitcher(runtime.coreState());
        return { ok: true, command };
      case "select-next-session":
        this.selectSessionOffset(1);
        return { ok: true, command };
      case "select-previous-session":
        this.selectSessionOffset(-1);
        return { ok: true, command };
      case "select-index":
        this.selectIndex(payload?.index ?? 0, runtime.coreState());
        return { ok: true, command };
      case "confirm-session-selection":
        return this.confirmSessionSelection(runtime);
      case "dismiss-toast":
        this.dismissToast();
        return { ok: true, command };
      case "toggle-expanded-approval":
        this.toggleExpandedApproval(runtime.coreState(), payload?.approvalId ?? null);
        return { ok: true, command };
      case "open-context-menu":
        this.state.overlay.contextMenu = {
          isOpen: true,
          mode: payload?.mode ?? "main"
        };
        return { ok: true, command };
      case "close-context-menu":
        this.state.overlay.contextMenu = {
          isOpen: false,
          mode: "closed"
        };
        return { ok: true, command };
      case "set-context-mode":
        this.state.overlay.contextMenu = {
          isOpen: true,
          mode: payload?.mode ?? "main"
        };
        return { ok: true, command };
      case "snooze-overlay":
        runtime.saveSettingsPatch({
          snoozeUntil: payload?.minutes === 0
            ? "manual"
            : toIsoOrNull(Date.now() + ((payload?.minutes ?? 15) * 60_000))
        });
        return { ok: true, command };
      case "resume-overlay":
        runtime.saveSettingsPatch({
          snoozeUntil: null
        });
        return { ok: true, command };
      case "advance-onboarding":
        this.advanceOnboarding();
        return { ok: true, command };
      case "set-onboarding-step":
        this.state.onboarding.currentStep = Math.max(0, Math.min(6, Number(payload?.step ?? 0)));
        return { ok: true, command };
      case "complete-onboarding":
        this.completeOnboarding();
        runtime.saveSettingsPatch({
          onboardingVersion: this.onboardingVersion,
          onboardingCompletedAt: new Date().toISOString()
        });
        return { ok: true, command };
      case "reset-onboarding":
        this.resetOnboarding();
        runtime.saveSettingsPatch({
          onboardingVersion: null,
          onboardingCompletedAt: null
        });
        return { ok: true, command };
      default:
        throw new Error(`unsupported_command:${command}`);
    }
  }

  openSessionSwitcher(coreState) {
    const sessions = this.#activeSessions(coreState);
    if (sessions.length < 2) {
      this.state.overlay.sessionSwitcher = {
        isOpen: false,
        selectedIndex: 0,
        sessions: []
      };
      return;
    }
    const selectedId = this.state.overlay.sessionSwitcher.sessions[this.state.overlay.sessionSwitcher.selectedIndex]?.id ?? null;
    const selectedIndex = Math.max(0, sessions.findIndex((item) => item.id === selectedId));
    this.state.overlay.sessionSwitcher = {
      isOpen: true,
      selectedIndex: selectedIndex === -1 ? 0 : selectedIndex,
      sessions
    };
  }

  selectSessionOffset(offset) {
    const switcher = this.state.overlay.sessionSwitcher;
    if (!switcher.isOpen || switcher.sessions.length === 0) {
      return;
    }
    switcher.selectedIndex = (switcher.selectedIndex + offset + switcher.sessions.length) % switcher.sessions.length;
  }

  selectIndex(index, coreState) {
    if (this.state.overlay.sessionSwitcher.isOpen) {
      if (index >= 0 && index < this.state.overlay.sessionSwitcher.sessions.length) {
        this.state.overlay.sessionSwitcher.selectedIndex = index;
      }
      return;
    }
    const visibleApprovals = (coreState.approvals ?? []).filter((item) => !item.collapsed);
    const target = visibleApprovals[index];
    if (target) {
      this.state.overlay.expandedApproval.approvalId = target.id;
    }
  }

  async confirmSessionSelection(runtime) {
    const switcher = this.state.overlay.sessionSwitcher;
    if (!switcher.isOpen || switcher.sessions.length === 0) {
      return { ok: false, command: "confirm-session-selection", reason: "not_open" };
    }
    const selected = switcher.sessions[switcher.selectedIndex] ?? null;
    this.state.overlay.sessionSwitcher = {
      isOpen: false,
      selectedIndex: 0,
      sessions: []
    };
    if (!selected) {
      return { ok: false, command: "confirm-session-selection", reason: "no_selection" };
    }
    await runtime.focusSession(selected);
    return {
      ok: true,
      command: "confirm-session-selection",
      sessionId: selected.id
    };
  }

  toggleExpandedApproval(coreState, approvalId = null) {
    const nextId = approvalId ?? coreState.approvals?.find((item) => !item.collapsed)?.id ?? null;
    this.state.overlay.expandedApproval.approvalId =
      this.state.overlay.expandedApproval.approvalId === nextId ? null : nextId;
  }

  dismissToast() {
    this.state.overlay.toast = null;
    if (this.toastTimer) {
      this.timers.clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
  }

  dispose() {
    this.dismissToast();
  }

  advanceOnboarding() {
    const next = this.state.onboarding.currentStep + 1;
    this.state.onboarding.currentStep = Math.min(next, 6);
  }

  completeOnboarding() {
    this.state.onboarding = {
      required: false,
      currentStep: 6,
      completed: true,
      lastCompletedAt: new Date().toISOString()
    };
  }

  resetOnboarding() {
    this.state.onboarding = {
      required: true,
      currentStep: 0,
      completed: false,
      lastCompletedAt: null
    };
  }

  #activeSessions(coreState) {
    return (coreState.sessions ?? [])
      .filter((item) => item.status === "active")
      .slice()
      .sort(sessionSort);
  }

  #syncSessionSwitcher(coreState) {
    if (!this.state.overlay.sessionSwitcher.isOpen) {
      return;
    }
    const sessions = this.#activeSessions(coreState);
    if (sessions.length < 2) {
      this.state.overlay.sessionSwitcher = {
        isOpen: false,
        selectedIndex: 0,
        sessions: []
      };
      return;
    }
    const currentId = this.state.overlay.sessionSwitcher.sessions[this.state.overlay.sessionSwitcher.selectedIndex]?.id ?? null;
    const selectedIndex = Math.max(0, sessions.findIndex((item) => item.id === currentId));
    this.state.overlay.sessionSwitcher.sessions = sessions;
    this.state.overlay.sessionSwitcher.selectedIndex = selectedIndex === -1 ? 0 : selectedIndex;
  }

  #syncExpandedApproval(coreState) {
    const approvalId = this.state.overlay.expandedApproval.approvalId;
    if (!approvalId) {
      return;
    }
    if (!(coreState.approvals ?? []).some((item) => item.id === approvalId)) {
      this.state.overlay.expandedApproval.approvalId = null;
    }
  }

  #syncToast(coreState, lastEvent) {
    const eventId = lastEvent?.id ?? null;
    const isCompletion = ["Stop", "TaskCompleted", "SessionEnd"].includes(lastEvent?.hookEventName);
    if ((coreState.approvals ?? []).length > 0) {
      if (isCompletion) this.lastToastEventId = eventId;
      this.dismissToast();
      return;
    }
    if (!isCompletion || !lastEvent?.sessionId || eventId === this.lastToastEventId) {
      return;
    }
    const session = (coreState.sessions ?? []).find((item) => item.id === lastEvent.sessionId);
    this.lastToastEventId = eventId;
    const previous = this.state.overlay.toast;
    const completedSessionIds = [...new Set([...(previous?.completedSessionIds ?? []), lastEvent.sessionId])];
    this.state.overlay.toast = {
      sessionId: lastEvent.sessionId,
      projectName: session?.projectName ?? session?.projectDir ?? "Session",
      assistantLabel: session?.assistantLabel ?? "Assistant",
      completedSessionIds,
      completedCount: completedSessionIds.length,
      visibleUntil: previous?.visibleUntil ?? Date.now() + 8_000
    };
    if (this.toastTimer) return;
    this.toastTimer = this.timers.setTimeout(() => {
      this.dismissToast();
    }, 8_000);
  }

  #syncSnoozeExpiry() {
    const settings = this.settingsStore.load();
    const snoozeUntil = settings.snoozeUntil;
    const parsed = parseIso(snoozeUntil);
    if (parsed && parsed.getTime() <= Date.now()) {
      this.settingsStore.save({
        ...settings,
        snoozeUntil: null
      });
    }
  }
}
