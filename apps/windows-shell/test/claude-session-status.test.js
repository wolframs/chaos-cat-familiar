import test from "node:test";
import assert from "node:assert/strict";
import { claudeSessionStatus, hasPendingBackgroundWork } from "../services/claude-session-status.js";
import { ElectronNotificationService } from "../services/platform-services.js";

const files = {
  "100.json": JSON.stringify({ sessionId: "orchestrator", status: "shell" }),
  "200.json": JSON.stringify({ sessionId: "waiting-on-you", status: "idle" }),
  "300.json": "{ half written"
};
const io = { dir: "X", readdir: () => Object.keys(files), readFile: (p) => files[p.split(/[\\/]/).pop()] };

test("reads the status of the matching Claude session, skipping broken files", () => {
  assert.equal(claudeSessionStatus("orchestrator", io), "shell");
  assert.equal(claudeSessionStatus("waiting-on-you", io), "idle");
  assert.equal(claudeSessionStatus("gone", io), null);
  assert.equal(claudeSessionStatus("x", { ...io, readdir: () => { throw new Error("no dir"); } }), null);
  assert.equal(hasPendingBackgroundWork("orchestrator", io), true);
  assert.equal(hasPendingBackgroundWork("waiting-on-you", io), false);
});

class FakeToast {
  static shown = [];
  static isSupported() { return true; }
  constructor(options) { this.options = options; }
  on() {}
  show() { FakeToast.shown.push(this.options.title); }
}

test("an idle alert from a session with background work shows no toast; other alerts still do", async () => {
  FakeToast.shown = [];
  const service = new ElectronNotificationService(FakeToast, null, null,
    () => ({ enabled: true, minPriority: "high" }),
    { hasPendingBackgroundWork: (id) => hasPendingBackgroundWork(id, io) });
  await service.notify({ title: "Claude is Waiting", category: "idle_alert", priority: "high", sessionId: "orchestrator" });
  await service.notify({ title: "Waiting for you", category: "idle_alert", priority: "high", sessionId: "waiting-on-you" });
  await service.notify({ title: "Permission Required", category: "permission_request", priority: "urgent", sessionId: "orchestrator" });
  assert.deepEqual(FakeToast.shown, ["Waiting for you", "Permission Required"]);
});
