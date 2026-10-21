import path from "node:path";
import { HookEventType } from "./event-types.js";

export function normalizeEvent(payload, receivedAt = new Date()) {
  return {
    id: crypto.randomUUID(),
    hookEventName: payload.hook_event_name,
    sessionId: payload.session_id ?? null,
    cwd: payload.cwd ?? null,
    permissionMode: payload.permission_mode ?? null,
    transcriptPath: payload.transcript_path ?? null,
    toolName: payload.tool_name ?? null,
    toolInput: payload.tool_input ?? null,
    toolResponse: payload.tool_response ?? null,
    toolUseId: payload.tool_use_id ?? null,
    message: payload.message ?? null,
    title: payload.title ?? null,
    notificationType: payload.notification_type ?? null,
    source: payload.source ?? null,
    reason: payload.reason ?? null,
    model: payload.model ?? null,
    stopHookActive: payload.stop_hook_active ?? null,
    lastAssistantMessage: payload.last_assistant_message ?? null,
    agentId: payload.agent_id ?? null,
    agentType: payload.agent_type ?? null,
    taskId: payload.task_id ?? null,
    taskSubject: payload.task_subject ?? null,
    permissionSuggestions: payload.permission_suggestions ?? null,
    terminalPid: payload.terminal_pid ?? null,
    shellPid: payload.shell_pid ?? null,
    receivedAt
  };
}

export function eventTypeOf(event) {
  return Object.values(HookEventType).includes(event.hookEventName)
    ? event.hookEventName
    : null;
}

export function projectNameOf(event) {
  return event.cwd ? path.basename(event.cwd) : null;
}

// Claude Code is the only assistant CCF listens to.
export const ASSISTANT_LABEL = "Claude";

export function createNotification({
  title,
  body = null,
  category,
  priority = "normal",
  sessionId = null,
  eventId = null
}) {
  return {
    id: crypto.randomUUID(),
    title,
    body,
    category,
    priority,
    isRead: false,
    readAt: null,
    resolutionOutcome: category === "permission_request" ? "pending" : "allowed",
    resolvedAt: null,
    eventId,
    sessionId,
    createdAt: new Date()
  };
}
