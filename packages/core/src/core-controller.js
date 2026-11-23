import { EventEmitter } from "node:events";
import { ApprovalStore } from "./approval-store.js";
import { notificationForEvent } from "./notification-router.js";
import { SessionStore } from "./session-store.js";
import { InMemoryLogger } from "./logger.js";
import { InMemoryStateStore } from "./json-state-store.js";
import { assistantLabelOf, eventTypeOf } from "./models.js";
import { HookEventType } from "./event-types.js";

const MAX_RETAINED_EVENTS = 200;
const MAX_RETAINED_NOTIFICATIONS = 200;

export class CcfCoreController extends EventEmitter {
  constructor({
    overlay,
    notifier,
    stateStore,
    settings,
    activation,
    terminalLocator,
    hookInstaller,
    logger,
    notificationFilter = null,
    maintenanceTurn = null
  }) {
    super();
    this.overlay = overlay;
    this.notifier = notifier;
    this.stateStore = stateStore ?? new InMemoryStateStore({
      events: [],
      notifications: [],
      sessions: [],
      settings: {}
    });
    this.settings = settings;
    this.activation = activation;
    this.terminalLocator = terminalLocator;
    this.hookInstaller = hookInstaller;
    this.logger = logger ?? new InMemoryLogger();
    // notificationFilter(notification, { event, session }) -> notification | null: the shell's last word on a derived
    // notification (it may retitle it or drop it) before it is stored and toasted.
    this.notificationFilter = notificationFilter;
    // maintenanceTurn(event) -> true | false | null: for a Claude Stop, whether the turn it ends answered a cache-warm
    // ping, read from the session's transcript (its last prompt). The prompt's own hook comes from an async PowerShell
    // sender and can arrive after the Stop (review 2, finding 4), so the session's flag alone may name the wrong turn.
    // null (or no reader): the flag decides.
    this.maintenanceTurn = maintenanceTurn;
    const persisted = this.stateStore.load();
    this.events = (persisted.events ?? []).slice(0, MAX_RETAINED_EVENTS);
    this.notifications = (persisted.notifications ?? []).slice(0, MAX_RETAINED_NOTIFICATIONS);
    this.sessions = new SessionStore(persisted.sessions ?? []);
    this.approvals = new ApprovalStore({
      onDismiss: (pending) => this.markApprovalDismissed(pending),
      onResolverError: (error) => this.warnSafely("Approval waiter response failed", {
        error: String(error.message ?? error)
      })
    });
    this.pruneRetainedState();
  }

  // admission (optional): admission(slots) returns a ticket (or a promise of one) that reserves room for everything this
  // event makes the core send main losslessly, together: its observation and its toast, if it has one. The toast and the
  // change listeners spend it; what is left is released. One reservation per event: an ingestion that held one and asked
  // for another could wait forever behind others doing the same (review of step 6, P1).
  async ingestEvent(event) {
    const duplicate = () => event.id && this.events.some((existing) => existing.id === event.id);
    if (duplicate()) return this.snapshot();
    if (this.maintenanceTurn && eventTypeOf(event) === HookEventType.STOP && event.backend !== "codex") {
      let verdict = null;
      try { verdict = await this.maintenanceTurn(event); }
      catch (error) { this.warnSafely("Cache-warm check of the transcript failed", { error: String(error?.message ?? error) }); }
      if (typeof verdict === "boolean") event.turnMaintenance = verdict;
    }
    const notification = this.filterNotification(notificationForEvent(event), event);
    let ticket = this.admission?.(notification ? 2 : 1) ?? null;
    if (typeof ticket?.then === "function") ticket = await ticket;
    try {
      if (duplicate()) return this.snapshot();
      this.logger.info("hook", "Hook event ingested", {
        hookEventName: event.hookEventName,
        sessionId: event.sessionId,
        toolName: event.toolName
      });
      this.events.unshift(event);
      this.approvals.handleLifecycleEvent(event);
      this.sessions.recordEvent(event);
      this.pruneRetainedState();

      if (notification) {
        this.notifications.unshift(notification);
        this.pruneRetainedState();
        await this.notifier.notify(notification, { ticket });
        this.logger.info("notification", "Notification derived from hook event", {
          notificationTitle: notification.title,
          sessionId: notification.sessionId
        });
      }

      this.persistState();
      this.publishState(event, ticket);
      return this.snapshot();
    } finally {
      ticket?.release?.();
    }
  }

  // A cache-warm turn's Stop ("Finished: warm") and the idle_prompt a minute later are no news: he was already told
  // when the real turn ended (2026-11-17: a toast 60 s after every ping, every 55 min, per idle session).
  filterNotification(notification, event) {
    if (!notification) return null;
    const session = event.sessionId ? this.sessions.sessions.find((item) => item.id === event.sessionId) ?? null : null;
    const type = eventTypeOf(event);
    const maintenance = type === HookEventType.STOP && typeof event.turnMaintenance === "boolean"
      ? event.turnMaintenance : session?.maintenance === true;
    if (maintenance && (type === HookEventType.STOP ||
        (type === HookEventType.NOTIFICATION && event.notificationType === "idle_prompt"))) {
      this.logger.info("notification", "Notification dropped: cache-warm turn", { sessionId: event.sessionId, category: notification.category });
      return null;
    }
    return this.notificationFilter ? this.notificationFilter(notification, { event, session }) ?? null : notification;
  }

  // The Claude sessions the sweep may end if the registry does not list them live (quiet, in scope, no pending
  // approval). options: { now, quietMs, inScope }.
  claudeSweepCandidates(options = {}) {
    return new Set(this.sessions.vanishCandidates({ ...options, keepIds: this.approvalSessionIds() }).map((session) => session.id));
  }

  approvalSessionIds() {
    return new Set(this.approvals.pending.map((item) => item.event.sessionId).filter(Boolean));
  }

  // liveIds: the Claude sessions Claude Code's registry lists with a running process (see SessionStore.endVanished).
  // options: { now, quietMs, inScope, only } (only: the candidates the registry was checked for).
  reconcileClaudeSessions(liveIds, options = {}) {
    const ended = this.sessions.endVanished(liveIds, { ...options, keepIds: this.approvalSessionIds() });
    if (ended.length === 0) return ended;
    this.logger.info("session", "Sessions gone from Claude Code's registry ended", {
      count: ended.length, sessionIds: ended.slice(0, 10).map((session) => session.id)
    });
    this.persistState();
    this.publishState();
    return ended;
  }

  async enqueueApproval(event, resolver) {
    const result = this.approvals.add(event, resolver);
    const pending = result.pending;
    try {
      this.logger.info("approval", "Approval queued", {
        approvalId: pending.id,
        sessionId: event.sessionId,
        toolName: event.toolName,
        duplicate: result.isDuplicate
      });
      if (!result.isDuplicate) await this.ingestEvent(event);
      this.overlay.showOverlay(this.snapshot());
      return result;
    } catch (error) {
      // The HTTP owner will answer this failed request. Detach without calling
      // its resolver, and leave other waiters for this approval intact.
      this.approvals.detachWaiter(pending.id, result.waiterId);
      try { this.persistState(); } catch { /* Preserve the enqueue error. */ }
      try { this.publishState(); } catch { /* Cleanup must not mask the cause. */ }
      throw error;
    }
  }

  markApprovalDismissed(pending) {
    const notification = this.notifications.find((item) => item.eventId === pending.event.id);
    if (notification) {
      notification.resolutionOutcome = "dismissed";
      notification.resolvedAt = new Date();
    }
  }

  resolveApproval(id, decision, extra = {}) {
    const resolved = this.approvals.resolve(id, decision, extra);
    try {
      if (resolved) {
        const matchingNotification = this.notifications.find((item) => item.eventId === resolved.event.id);
        if (matchingNotification) {
          matchingNotification.resolutionOutcome =
            decision === "allow" ? "allowed" : decision === "deny" ? "denied" : "pending";
          matchingNotification.resolvedAt = decision === "defer" ? null : new Date();
        }
        this.logger.info("approval", "Approval state changed", {
          approvalId: id,
          decision,
          sessionId: resolved.event.sessionId,
          toolName: resolved.event.toolName
        });
      } else {
        this.logger.warn("approval", "Approval action targeted unknown id", { approvalId: id, decision });
      }
      this.persistState();
    } finally {
      // A decision has already reached the hook. Update the visible queue even
      // when saving state or the diagnostic log fails afterward.
      this.publishState();
    }
    return resolved;
  }

  restoreApproval(id) {
    this.approvals.expand(id);
    this.logger.info("approval", "Deferred approval restored", {
      approvalId: id
    });
    this.persistState();
    this.publishState();
    return this.snapshot();
  }

  detachApprovalWaiter(id, waiterId) {
    const result = this.approvals.detachWaiter(id, waiterId);
    this.pruneRetainedState();
    try {
      this.persistState();
    } catch (error) {
      this.warnSafely("Disconnected approval state could not be saved", {
        error: String(error.message ?? error)
      });
    }
    try {
      this.publishState();
    } catch (error) {
      this.warnSafely("Disconnected approval state could not be published", {
        error: String(error.message ?? error)
      });
    }
    return result;
  }

  warnSafely(message, details) {
    try {
      this.logger.warn("approval", message, details);
    } catch { /* Diagnostics must not break waiter cleanup or response delivery. */ }
  }

  // ticket: the admission of the ingestion this change finishes (see ingestEvent), for the listener that sends main the
  // event's observation.
  publishState(lastEvent = null, ticket = null) {
    const state = this.snapshot();
    this.emit("change", state, lastEvent, { ticket });
    this.overlay.updateOverlay(state);
  }

  markNotificationRead(id) {
    const notification = this.notifications.find((item) => item.id === id);
    if (!notification) {
      return false;
    }
    notification.isRead = true;
    notification.readAt = notification.readAt ?? new Date();
    this.persistState();
    this.publishState();
    return true;
  }

  markAllNotificationsRead() {
    let changed = false;
    for (const notification of this.notifications) {
      if (!notification.isRead) {
        notification.isRead = true;
        notification.readAt = notification.readAt ?? new Date();
        changed = true;
      }
    }
    if (changed) {
      this.persistState();
      this.publishState();
    }
    return changed;
  }

  dismissNotification(id) {
    const before = this.notifications.length;
    this.notifications = this.notifications.filter((item) => item.id !== id);
    const changed = this.notifications.length !== before;
    if (changed) {
      this.persistState();
      this.publishState();
    }
    return changed;
  }

  // "Clear local data": the event history, the notifications and every session no pending approval still needs.
  clearHistory() {
    const needed = new Set(this.approvals.pending.map((item) => item.event.sessionId).filter(Boolean));
    this.events = [];
    this.notifications = [];
    this.sessions.sessions = this.sessions.sessions.filter((session) => needed.has(session.id));
    this.logger.info("persistence", "Local history cleared");
    this.persistState();
    this.publishState();
    return true;
  }

  persistState() {
    this.pruneRetainedState();
    this.stateStore.save({
      events: this.events,
      notifications: this.notifications,
      sessions: this.sessions.sessions,
      settings: typeof this.settings?.load === "function" ? this.settings.load() : {}
    });
  }

  pruneRetainedState() {
    this.events.length = Math.min(this.events.length, MAX_RETAINED_EVENTS);
    this.notifications.length = Math.min(this.notifications.length, MAX_RETAINED_NOTIFICATIONS);
    const pendingSessionIds = new Set(
      this.approvals?.pending.map((item) => item.event.sessionId).filter(Boolean) ?? []
    );
    this.sessions.pruneEnded(200, pendingSessionIds);
  }

  snapshot() {
    return {
      approvals: this.approvals.pending.map((item) => ({
        id: item.id,
        event: item.event,
        assistantLabel: assistantLabelOf(item.event),
        collapsed: this.approvals.collapsedIds.has(item.id),
        resolvedToolUseId: item.resolvedToolUseId
      })),
      sessions: this.sessions.sessions,
      notifications: this.notifications.slice(0, 50),
      notificationSummary: {
        unreadCount: this.notifications.filter((item) => !item.isRead).length,
        pendingApprovalHistoryCount: this.notifications.filter((item) =>
          item.category === "permission_request" && item.resolutionOutcome !== "pending"
        ).length
      },
      events: this.events.slice(0, 200),
      logs: this.logger.entries?.slice(0, 200) ?? []
    };
  }
}
