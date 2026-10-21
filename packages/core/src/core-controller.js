import { EventEmitter } from "node:events";
import { ApprovalStore } from "./approval-store.js";
import { notificationForEvent } from "./notification-router.js";
import { SessionStore } from "./session-store.js";
import { InMemoryLogger } from "./logger.js";
import { InMemoryStateStore } from "./json-state-store.js";
import { ASSISTANT_LABEL } from "./models.js";

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
    logger
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

  async ingestEvent(event) {
    this.logger.info("hook", "Hook event ingested", {
      hookEventName: event.hookEventName,
      sessionId: event.sessionId,
      toolName: event.toolName
    });
    this.events.unshift(event);
    this.approvals.handleLifecycleEvent(event);
    this.sessions.recordEvent(event);
    this.pruneRetainedState();

    const notification = notificationForEvent(event);
    if (notification) {
      this.notifications.unshift(notification);
      this.pruneRetainedState();
      await this.notifier.notify(notification);
      this.logger.info("notification", "Notification derived from hook event", {
        notificationTitle: notification.title,
        sessionId: notification.sessionId
      });
    }

    this.persistState();
    this.publishState(event);
    return this.snapshot();
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

  publishState(lastEvent = null) {
    const state = this.snapshot();
    this.emit("change", state, lastEvent);
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
        assistantLabel: ASSISTANT_LABEL,
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
