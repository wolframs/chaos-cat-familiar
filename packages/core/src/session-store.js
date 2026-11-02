import { HookEventType } from "./event-types.js";
import { assistantLabelOf, eventTypeOf, projectNameOf } from "./models.js";

const MAX_ENDED_SESSIONS = 200;

export class SessionStore {
  constructor(initialSessions = []) {
    this.sessions = initialSessions.map((session) => {
      const { assistantSource, ...restored } = session;
      return { ...restored, backend:restored.backend??'claude',conversationId:restored.conversationId??restored.id, assistantLabel: assistantLabelOf(restored), terminalPid: null };
    });
    this.pruneEnded();
  }

  pruneEnded(limit = MAX_ENDED_SESSIONS, preserveIds = new Set()) {
    const protectedEndedCount = this.sessions.filter(
      (session) => session.status === "ended" && preserveIds.has(session.id)
    ).length;
    const eligibleEnded = this.sessions
      .filter((session) => session.status === "ended" && !preserveIds.has(session.id))
      .sort((left, right) => {
        const leftTime = Date.parse(left.lastEventAt ?? left.startedAt ?? 0) || 0;
        const rightTime = Date.parse(right.lastEventAt ?? right.startedAt ?? 0) || 0;
        return rightTime - leftTime;
      });
    const keepEndedIds = new Set(
      eligibleEnded.slice(0, Math.max(0, limit - protectedEndedCount)).map((session) => session.id)
    );
    this.sessions = this.sessions.filter(
      (session) =>
        session.status !== "ended" ||
        preserveIds.has(session.id) ||
        keepEndedIds.has(session.id)
    );
    return this.sessions;
  }

  get activeSessions() {
    return this.sessions.filter((session) => session.status === "active");
  }

  recordEvent(event) {
    if (!event.sessionId) {
      return null;
    }

    const existing = this.sessions.find((session) => session.id === event.sessionId);
    const type = eventTypeOf(event);

    if (!existing) {
      const session = {
        id: event.sessionId,
        projectDir: event.cwd ?? null,
        projectName: projectNameOf(event),
        backend:event.backend??'claude',conversationId:event.conversationId??event.sessionId,
        observationOnly:event.observationOnly===true,
        assistantLabel: assistantLabelOf(event),
        status: "active",
        phase: type === HookEventType.USER_PROMPT_SUBMIT ? "running" : "idle",
        eventCount: 1,
        startedAt: new Date(),
        lastEventAt: new Date(),
        lastToolName: event.toolName ?? null,
        activeSubagentCount: 0,
        isCompacting: type === HookEventType.PRE_COMPACT,
        phaseBeforeCompaction: type === HookEventType.PRE_COMPACT ? "idle" : null,
        ...(type === HookEventType.PRE_COMPACT ? { phase: "compacting" } : {}),
        terminalPid: event.terminalPid ?? null,
        shellPid: event.shellPid ?? null,
        transcriptPath: event.transcriptPath ?? null
      };
      this.sessions.unshift(session);
      return session;
    }

    existing.eventCount += 1;
    existing.lastEventAt = new Date();
    existing.lastToolName = event.toolName ?? existing.lastToolName;
    existing.transcriptPath ??= event.transcriptPath ?? null;
    existing.terminalPid ??= event.terminalPid ?? null;
    if (Number.isSafeInteger(event.shellPid) && event.shellPid > 0 &&
        (type === HookEventType.SESSION_START || type === HookEventType.USER_PROMPT_SUBMIT || !existing.shellPid)) {
      existing.shellPid = event.shellPid;
    }

    switch (type) {
      case HookEventType.SESSION_START:
        existing.status = "active";
        existing.phase = "idle";
        existing.isCompacting = false;
        existing.phaseBeforeCompaction = null;
        break;
      case HookEventType.USER_PROMPT_SUBMIT:
      case HookEventType.PRE_TOOL_USE:
      case HookEventType.POST_TOOL_USE:
      case HookEventType.POST_TOOL_USE_FAILURE:
      case HookEventType.PERMISSION_REQUEST:
        existing.status = "active";
        existing.phase = "running";
        break;
      case HookEventType.PRE_COMPACT:
        existing.phaseBeforeCompaction = existing.phase === "compacting" ? existing.phaseBeforeCompaction : existing.phase;
        existing.status = "active";
        existing.phase = "compacting";
        existing.isCompacting = true;
        break;
      case HookEventType.POST_COMPACT:
        if(existing.phase==="compacting")existing.phase=existing.phaseBeforeCompaction??"running";
        existing.phaseBeforeCompaction=null;
        existing.isCompacting=false;
        break;
      case HookEventType.INTERRUPT:
      case HookEventType.TASK_COMPLETED:
      case HookEventType.TEAMMATE_IDLE:
      case HookEventType.STOP:
        existing.phase = "idle";
        existing.isCompacting = false;
        existing.phaseBeforeCompaction = null;
        break;
      case HookEventType.SESSION_END:
        existing.status = "ended";
        existing.phase = "idle";
        existing.isCompacting = false;
        existing.activeSubagentCount = 0;
        existing.phaseBeforeCompaction = null;
        break;
      case HookEventType.SUBAGENT_START:
        existing.status = "active";
        existing.phase = "running";
        existing.activeSubagentCount += 1;
        break;
      case HookEventType.SUBAGENT_STOP:
        existing.activeSubagentCount = Math.max(0, existing.activeSubagentCount - 1);
        break;
      default:
        break;
    }

    return existing;
  }
}
