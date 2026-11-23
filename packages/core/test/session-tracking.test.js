// Session tracking fixes from the work companion's assessment of 2026-11-17: cache-warm turns raise no toasts
// (finding 1), Claude sessions that died without SessionEnd end once they leave Claude Code's registry (finding 4).
import test from "node:test";
import assert from "node:assert/strict";
import { CcfCoreController, InMemoryStateStore, normalizeEvent } from "../src/index.js";

function controller(options = {}) {
  const notified = [];
  const core = new CcfCoreController({
    overlay: { showOverlay() {}, updateOverlay() {}, hideOverlay() {} },
    notifier: { notify: async (notification) => { notified.push(notification); } },
    stateStore: new InMemoryStateStore({ events: [], notifications: [], sessions: options.sessions ?? [], settings: {} }),
    settings: { load: () => ({}) },
    ...options.extra
  });
  return { core, notified };
}

const hook = (body) => normalizeEvent({ session_id: "s1", cwd: "C:\\repos\\project-2", ...body });
const WARM = "[Cache warm maintenance] I set /cache-warm to send this every 55 idle minutes.";

test("normalizeEvent flags a cache-warm prompt and keeps no prompt text", () => {
  const warm = hook({ hook_event_name: "UserPromptSubmit", prompt: WARM });
  assert.equal(warm.maintenance, true);
  assert.equal(JSON.stringify(warm).includes("Cache warm"), false, "the prompt itself is not stored");
  assert.equal(hook({ hook_event_name: "UserPromptSubmit", prompt: "fix it" }).maintenance, false);
  assert.equal(hook({ hook_event_name: "Stop" }).maintenance, false);
});

test("a cache-warm turn's Stop and idle_prompt make no notification; the next real turn's do", async () => {
  const { core, notified } = controller();
  await core.ingestEvent(hook({ hook_event_name: "UserPromptSubmit", prompt: "swap the components" }));
  await core.ingestEvent(hook({ hook_event_name: "Stop", last_assistant_message: "You can swap now." }));
  await core.ingestEvent(hook({ hook_event_name: "Notification", notification_type: "idle_prompt", message: "waiting" }));
  assert.deepEqual(notified.map((n) => n.category), ["session_lifecycle", "idle_alert"]);

  await core.ingestEvent(hook({ hook_event_name: "UserPromptSubmit", prompt: WARM }));
  await core.ingestEvent(hook({ hook_event_name: "Stop", last_assistant_message: "warm" }));
  await core.ingestEvent(hook({ hook_event_name: "Notification", notification_type: "idle_prompt", message: "waiting" }));
  assert.equal(notified.length, 2, "nothing new for the warm turn");
  assert.equal(core.snapshot().sessions[0].maintenance, true);
  assert.equal(core.notifications.some((n) => n.body === "warm"), false, "not even in the history");

  await core.ingestEvent(hook({ hook_event_name: "UserPromptSubmit", prompt: "back, what now?" }));
  assert.equal(core.snapshot().sessions[0].maintenance, false);
  await core.ingestEvent(hook({ hook_event_name: "Stop", last_assistant_message: "Here is the list." }));
  await core.ingestEvent(hook({ hook_event_name: "Notification", notification_type: "idle_prompt", message: "waiting" }));
  assert.deepEqual(notified.slice(2).map((n) => n.category), ["session_lifecycle", "idle_alert"]);
  // A permission prompt during a warm turn still counts.
  await core.ingestEvent(hook({ hook_event_name: "UserPromptSubmit", prompt: WARM }));
  await core.ingestEvent(hook({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "allow?" }));
  assert.equal(notified.at(-1).category, "permission_request");
});

test("hooks out of order: the transcript's last prompt decides whether a Stop is a warm turn's (review 2, finding 4)", async () => {
  // The prompt hook comes from an async PowerShell sender (seconds), Stop by http: a short turn's Stop can come first.
  let lastPrompt = null;   // what the transcript says at Stop time
  const asked = [];
  const { core, notified } = controller({ extra: { maintenanceTurn: async (event) => {
    asked.push(event.hookEventName);
    return lastPrompt === null ? null : lastPrompt === "warm";
  } } });
  // A warm turn, in order.
  lastPrompt = "warm";
  await core.ingestEvent(hook({ hook_event_name: "UserPromptSubmit", prompt: WARM }));
  await core.ingestEvent(hook({ hook_event_name: "Stop", last_assistant_message: "warm" }));
  assert.equal(notified.length, 0);
  // A short real turn right after: its Stop arrives before its prompt. Still a completion.
  lastPrompt = "real";
  await core.ingestEvent(hook({ hook_event_name: "Stop", last_assistant_message: "Fixed it." }));
  assert.deepEqual(notified.map((n) => n.category), ["session_lifecycle"], "the real turn's Stop is not dropped");
  await core.ingestEvent(hook({ hook_event_name: "UserPromptSubmit", prompt: "quick fix please" }));
  await core.ingestEvent(hook({ hook_event_name: "Notification", notification_type: "idle_prompt", message: "waiting" }));
  assert.deepEqual(notified.map((n) => n.category), ["session_lifecycle", "idle_alert"]);
  // The other way round: a warm ping's Stop before its prompt hook. Dropped, and so is the idle_prompt after it.
  lastPrompt = "warm";
  await core.ingestEvent(hook({ hook_event_name: "Stop", last_assistant_message: "warm" }));
  await core.ingestEvent(hook({ hook_event_name: "UserPromptSubmit", prompt: WARM }));
  await core.ingestEvent(hook({ hook_event_name: "Notification", notification_type: "idle_prompt", message: "waiting" }));
  assert.equal(notified.length, 2, "nothing for the warm turn");
  // No verdict (transcript unreadable): the flag decides, as before.
  lastPrompt = null;
  await core.ingestEvent(hook({ hook_event_name: "Stop", last_assistant_message: "warm" }));
  assert.equal(notified.length, 2);
  assert.deepEqual([...new Set(asked)], ["Stop"], "the transcript is read for Stop only");
  // Codex Stops are never checked against a Claude transcript.
  await core.ingestEvent(normalizeEvent({ session_id: "c1", backend: "codex", hook_event_name: "Stop" }));
  assert.equal(asked.length, 4);
});

test("the shell's notificationFilter may retitle or drop a notification", async () => {
  const seen = [];
  const { core, notified } = controller({ extra: { notificationFilter: (notification, { session }) => {
    seen.push(session?.id ?? null);
    return notification.category === "idle_alert" ? { ...notification, title: "renamed" } : null;
  } } });
  await core.ingestEvent(hook({ hook_event_name: "UserPromptSubmit", prompt: "go" }));
  await core.ingestEvent(hook({ hook_event_name: "Stop" }));
  await core.ingestEvent(hook({ hook_event_name: "Notification", notification_type: "idle_prompt" }));
  assert.deepEqual(notified.map((n) => n.title), ["renamed"]);
  assert.deepEqual(core.notifications.map((n) => n.title), ["renamed"]);
  assert.deepEqual(seen, ["s1", "s1"], "the session is known from the first event on");
});

test("Claude sessions gone from the registry and quiet for 2 min end; live, recent, Codex and approval ones stay", async () => {
  const old = new Date(Date.now() - 29 * 24 * 3600 * 1000).toISOString();
  const session = (id, extra = {}) => ({ id, status: "active", phase: "running", backend: "claude", lastEventAt: old,
    activeSubagentCount: 1, eventCount: 3, ...extra });
  const { core } = controller({ sessions: [
    session("dead"), session("live"), session("recent", { lastEventAt: new Date().toISOString() }),
    session("codex", { backend: "codex" }), session("ended", { status: "ended" })] });
  const changes = [];
  core.on("change", () => changes.push(1));
  const ended = core.reconcileClaudeSessions(new Set(["live"]));
  assert.deepEqual(ended.map((s) => s.id), ["dead"]);
  const byId = Object.fromEntries(core.snapshot().sessions.map((s) => [s.id, s]));
  assert.equal(byId.dead.status, "ended");
  assert.equal(byId.dead.phase, "idle");
  assert.equal(byId.dead.activeSubagentCount, 0);
  assert.equal(byId.dead.endReason, "vanished");
  for (const id of ["live", "recent", "codex"]) assert.equal(byId[id].status, "active", id);
  assert.equal(changes.length, 1, "published once");
  assert.deepEqual(core.reconcileClaudeSessions(new Set(["live"])), [], "nothing more to end");
  assert.equal(changes.length, 1, "no publication without a change");

  // A session that comes back to life (a hook after all) is active again and loses the end reason.
  await core.ingestEvent(normalizeEvent({ session_id: "dead", hook_event_name: "PreToolUse", tool_name: "Bash" }));
  const revived = core.snapshot().sessions.find((s) => s.id === "dead");
  assert.equal(revived.status, "active");
  assert.equal("endReason" in revived, false);
});

test("the sweep's candidates: quiet active Claude sessions in scope, no pending approval; only those end", () => {
  const old = new Date(Date.now() - 3600 * 1000).toISOString();
  const session = (id, transcriptPath) => ({ id, status: "active", backend: "claude", lastEventAt: old, eventCount: 1, transcriptPath });
  const { core } = controller({ sessions: [session("mine", "C:/h/.claude/projects/p/mine.jsonl"),
    session("wsl", "/home/dev/.claude/projects/p/wsl.jsonl"), session("late", "C:/h/.claude/projects/p/late.jsonl")] });
  const inScope = (s) => String(s.transcriptPath).startsWith("C:/h/.claude/");
  assert.deepEqual([...core.claudeSweepCandidates({ inScope })], ["mine", "late"]);
  // "late" became a candidate after the registry was read for "mine" only: it is not ended on that read.
  const ended = core.reconcileClaudeSessions(new Set(), { inScope, only: new Set(["mine"]) });
  assert.deepEqual(ended.map((s) => s.id), ["mine"]);
  assert.equal(core.snapshot().sessions.find((s) => s.id === "wsl").status, "active");
});

test("a session with a pending approval is never ended by the sweep", async () => {
  const { core } = controller();
  const request = normalizeEvent({ session_id: "asking", hook_event_name: "PermissionRequest", tool_name: "Bash" });
  await core.enqueueApproval(request, () => {});
  core.sessions.sessions[0].lastEventAt = new Date(Date.now() - 3600 * 1000);
  assert.deepEqual(core.reconcileClaudeSessions(new Set()), []);
});
