import test from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { HookServer } from "../src/hook-server.js";

test("hook server rejects browser hosts, missing credentials and unknown approval actions", async (t) => {
  const decisions = [];
  const events = [];
  const server = new HookServer({ port: 0, authToken: "test-secret", controller: {
    logger: { error() {} }, snapshot: () => ({ private: true }),
    async ingestEvent(event) { events.push(event); },
    resolveApproval(...args) { decisions.push(args); return true; }
  } });
  await server.start();
  t.after(() => server.stop());
  const url = `http://127.0.0.1:${server.port}`;
  assert.equal((await fetch(`${url}/health`)).status, 200);
  assert.equal((await fetch(`${url}/state`)).status, 401);
  assert.equal((await fetch(`${url}/state`, { headers: { "x-ccf-token": "test-secret" } })).status, 200);
  const reboundStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${url}/state`, { headers: { host: `attacker.example:${server.port}`, "x-ccf-token": "test-secret" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await fetch(`${url}/approvals/a/allow`, { method: "POST", headers: { origin: "https://example.com", "x-ccf-token": "test-secret" } })).status, 403);
  assert.equal((await fetch(`${url}/approvals/a/allow`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${url}/approvals/a/cancel`, { method: "POST", headers: { "x-ccf-token": "test-secret" } })).status, 400);
  assert.deepEqual(decisions, []);
  assert.equal((await fetch(`${url}/approvals/a/deny`, { method: "POST", headers: { "x-ccf-token": "test-secret" } })).status, 200);
  assert.equal(decisions[0][1], "deny");
  const response = await fetch(`${url}/hook`, { method: "POST", headers: { "content-type": "application/json", "x-ccf-token": "test-secret" },
    body: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "large-result", tool_name: "Read", tool_response: { output: "x".repeat(200_000) } }) });
  assert.equal(response.status, 200);
  assert.ok(JSON.stringify(events[0].toolResponse).length < 20_000);
});


test("transport finishes failed ingestion even when diagnostic logging fails", async (t) => {
  const server = new HookServer({ port: 0, controller: {
    logger: { error() { throw new Error("log locked"); } },
    async ingestEvent() { throw new Error("state locked"); }
  } });
  assert.equal(server.authToken.length, 64);
  await server.start();
  t.after(() => server.stop());
  const response = await fetch(`http://127.0.0.1:${server.port}/hook`, {
    method: "POST", headers: { "content-type": "application/json", "x-ccf-token": server.authToken },
    body: JSON.stringify({ hook_event_name: "Stop", session_id: "failed-write" })
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "state locked");
});


test("debug transport traces correlate completion without recording payloads or credentials", async (t) => {
  const traces = [];
  const server = new HookServer({ port: 0, authToken: "secret-token", controller: {
    logger: { debug(category, message, context) { traces.push({ category, message, context }); } },
    async ingestEvent() {}
  } });
  await server.start();
  t.after(() => server.stop());
  await fetch(`http://127.0.0.1:${server.port}/hook`, {
    method: "POST", headers: { "x-ccf-token": "secret-token" },
    body: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "trace-session", tool_name: "Read", tool_response: { output: "private-content" } })
  });
  const complete = traces.find((trace) => trace.message === "Request completed");
  assert.equal(complete.context.statusCode, 200);
  assert.equal(complete.context.sessionId, "trace-session");
  assert.equal(complete.context.hookEventName, "PostToolUse");
  assert.ok(complete.context.durationMs >= 0);
  assert.ok(complete.context.requestId);
  assert.doesNotMatch(JSON.stringify(traces), /private-content|secret-token/);
});
