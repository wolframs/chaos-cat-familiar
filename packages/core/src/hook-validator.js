const stringFields = [
  "hook_event_name",
  "session_id",
  "cwd",
  "permission_mode",
  "transcript_path",
  "tool_name",
  "tool_use_id",
  "message",
  "title",
  "notification_type",
  "source",
  "reason",
  "model",
  "last_assistant_message",
  "agent_id",
  "agent_type",
  "task_id",
  "task_subject"
];

const integerFields = ["terminal_pid", "shell_pid"];

export function validateHookPayload(payload) {
  const issues = [];

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      issues: ["payload must be a JSON object"]
    };
  }

  if (typeof payload.hook_event_name !== "string" || payload.hook_event_name.trim() === "") {
    issues.push("hook_event_name is required");
  }

  for (const field of stringFields) {
    const value = payload[field];
    if (value != null && typeof value !== "string") {
      issues.push(`${field} must be a string or null`);
    }
  }

  for (const field of integerFields) {
    const value = payload[field];
    if (value != null && !Number.isInteger(value)) {
      issues.push(`${field} must be an integer or null`);
    }
  }

  if (payload.stop_hook_active != null && typeof payload.stop_hook_active !== "boolean") {
    issues.push("stop_hook_active must be a boolean or null");
  }

  if (payload.tool_input != null && (typeof payload.tool_input !== "object" || Array.isArray(payload.tool_input))) {
    issues.push("tool_input must be an object or null");
  }

  if (payload.tool_response != null && (typeof payload.tool_response !== "object" || Array.isArray(payload.tool_response))) {
    issues.push("tool_response must be an object or null");
  }

  if (payload.permission_suggestions != null && !Array.isArray(payload.permission_suggestions)) {
    issues.push("permission_suggestions must be an array or null");
  }

  return {
    ok: issues.length === 0,
    issues
  };
}
