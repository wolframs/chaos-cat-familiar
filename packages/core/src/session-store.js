import { HookEventType } from "./event-types.js";
import { assistantLabelOf, eventTypeOf, projectNameOf } from "./models.js";

const MAX_ENDED_SESSIONS = 200;
const MAX_TOOLS_IN_FLIGHT = 32;

// Tool calls between PreToolUse and PostToolUse(Failure), keyed by toolUseId.
// Subagent tool hooks share the parent's session id; matching by id keeps them apart.
function trackToolsInFlight(session, type, event) {
  if (!Array.isArray(session.toolsInFlight)) session.toolsInFlight = [];
  const key = event.toolUseId ?? "?";
  switch (type) {
    case HookEventType.PRE_TOOL_USE:
      if (!session.toolsInFlight.includes(key)) session.toolsInFlight.push(key);
      if (session.toolsInFlight.length > MAX_TOOLS_IN_FLIGHT) session.toolsInFlight.shift();
      break;
    case HookEventType.POST_TOOL_USE:
    case HookEventType.POST_TOOL_USE_FAILURE: {
      const index = session.toolsInFlight.indexOf(key);
      if (index >= 0) session.toolsInFlight.splice(index, 1);
      break;
    }
    case HookEventType.SESSION_START:
    case HookEventType.SESSION_END:
    case HookEventType.USER_PROMPT_SUBMIT:
    case HookEventType.INTERRUPT:
    case HookEventType.STOP:
      session.toolsInFlight = [];
      break;
    default:
      break;
  }
}

export class SessionStore {
  constructor(initialSessions = []) {
    this.sessions = initialSessions.map((session) => {
      const { assistantSource, ...restored } = session;
      // In-flight tool calls belong to the previous CCF run; their Post events may be lost.
      return { ...restored, backend:restored.backend??'claude',conversationId:restored.conversationId??restored.id, assistantLabel: assistantLabelOf(restored), terminalPid: null, toolsInFlight: [] };
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

  // Claude sessions that died without SessionEnd (a killed terminal, a crash, CCF closed while the relay dropped the
  // event) stay "active" for ever otherwise: 32 of 35 on 2026-11-17, the oldest 29 days. liveIds: the session ids in
  // Claude Code's registry (~/.claude/sessions) whose process runs. A Claude session missing there and quiet for
  // quietMs is ended; Codex sessions are not in that registry and stay as they are. Returns the ended sessions.
  // inScope(session): the session belongs to the registry liveIds were read from (review 2, finding 1: a WSL or
  // other-profile session is in no registry the sweep reads). only: the candidates the registry was checked for.
  vanishCandidates({ now = Date.now(), quietMs = 120000, keepIds = new Set(), inScope = null } = {}) {
    return this.sessions.filter((session) => {
      if (session.status !== "active" || (session.backend ?? "claude") !== "claude" || session.observationOnly === true) return false;
      if (keepIds.has(session.id) || (inScope && !inScope(session))) return false;
      const last = new Date(session.lastEventAt ?? session.startedAt ?? 0).getTime() || 0;
      return now - last >= quietMs;
    });
  }

  endVanished(liveIds, { only = null, ...options } = {}) {
    const ended = [];
    for (const session of this.vanishCandidates(options)) {
      if (liveIds.has(session.id) || (only && !only.has(session.id))) continue;
      session.status = "ended";
      session.phase = "idle";
      session.isCompacting = false;
      session.phaseBeforeCompaction = null;
      session.activeSubagentCount = 0;
      session.toolsInFlight = [];
      session.endReason = "vanished";
      ended.push(session);
    }
    return ended;
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
        maintenance: (type === HookEventType.USER_PROMPT_SUBMIT && event.maintenance === true) ||
          (type === HookEventType.STOP && event.turnMaintenance === true),
        eventCount: 1,
        startedAt: new Date(),
        lastEventAt: new Date(),
        lastToolName: event.toolName ?? null,
        activeSubagentCount: 0,
        toolsInFlight: [],
        isCompacting: type === HookEventType.PRE_COMPACT,
        phaseBeforeCompaction: type === HookEventType.PRE_COMPACT ? "idle" : null,
        ...(type === HookEventType.PRE_COMPACT ? { phase: "compacting" } : {}),
        terminalPid: event.terminalPid ?? null,
        shellPid: event.shellPid ?? null,
        transcriptPath: event.transcriptPath ?? null
      };
      trackToolsInFlight(session, type, event);
      this.sessions.unshift(session);
      return session;
    }
    trackToolsInFlight(existing, type, event);

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
        // A cache-warm ping's turn stays marked until the next real prompt: its Stop and the idle_prompt after it
        // are no news (the controller drops their notifications).
        existing.maintenance = event.maintenance === true;
        existing.status = "active";
        existing.phase = "running";
        break;
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
      case HookEventType.STOP:
        // The transcript's verdict on the turn that ended (review 2, finding 4: its UserPromptSubmit may come later).
        if (typeof event.turnMaintenance === "boolean") existing.maintenance = event.turnMaintenance;
        existing.phase = "idle";
        existing.isCompacting = false;
        existing.phaseBeforeCompaction = null;
        break;
      case HookEventType.INTERRUPT:
      case HookEventType.TASK_COMPLETED:
      case HookEventType.TEAMMATE_IDLE:
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
    if (existing.status === "active") delete existing.endReason;

    return existing;
  }
}
