export const HookEventType = Object.freeze({
  SESSION_START: "SessionStart",
  SESSION_END: "SessionEnd",
  USER_PROMPT_SUBMIT: "UserPromptSubmit",
  PRE_TOOL_USE: "PreToolUse",
  POST_TOOL_USE: "PostToolUse",
  POST_TOOL_USE_FAILURE: "PostToolUseFailure",
  PERMISSION_REQUEST: "PermissionRequest",
  STOP: "Stop",
  SUBAGENT_START: "SubagentStart",
  SUBAGENT_STOP: "SubagentStop",
  NOTIFICATION: "Notification",
  PRE_COMPACT: "PreCompact",
  TASK_COMPLETED: "TaskCompleted",
  TEAMMATE_IDLE: "TeammateIdle",
  CONFIG_CHANGE: "ConfigChange",
  WORKTREE_CREATE: "WorktreeCreate",
  WORKTREE_REMOVE: "WorktreeRemove"
});
