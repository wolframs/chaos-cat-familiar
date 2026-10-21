import test from "node:test";
import assert from "node:assert/strict";
import { companionAttention, syncCompanionPlayback, syncCompanionMedia } from "../renderer/companion-attention.js";

const session = { id: "session-one", status: "active", phase: "running", projectName: "Project", projectDir: "C:\\Project" };

test("companion exposes working, waiting, finished and idle with the relevant session", () => {
  assert.equal(companionAttention({ sessions: [session] }).kind, "working");
  const waiting = companionAttention({ sessions: [session], approvals: [{ id: "p", collapsed: true, event: { sessionId: session.id, toolName: "Bash" } }], ui: { overlay: { toast: { sessionId: "other" } } } });
  assert.equal(waiting.kind, "waiting");
  assert.equal(waiting.session.id, session.id);
  assert.match(waiting.summary, /Bash/);
  assert.match(waiting.identity, /Project.*session-one/);
  assert.equal(companionAttention({ sessions: [{ ...session, phase: "idle" }], ui: { overlay: { toast: { sessionId: session.id } } } }).kind, "finished");
  assert.equal(companionAttention({ sessions: [] }).kind, "idle");
});

test("working identity follows the working session and same-project sessions remain distinguishable", () => {
  const idle = { ...session, id: "session-two", phase: "idle" };
  assert.equal(companionAttention({ sessions: [idle, session] }).session.id, session.id);
  assert.notEqual(companionAttention({ sessions: [idle] }).identity, companionAttention({ sessions: [{ ...session, phase: "idle" }] }).identity);
});

test("idle and hidden companions pause media, visible working companions resume it", () => {
  const calls = [];
  const video = { paused: false, pause() { calls.push("pause"); this.paused = true; }, play() { calls.push("play"); this.paused = false; return Promise.resolve(); } };
  syncCompanionPlayback(video, { kind: "idle" }, false);
  syncCompanionPlayback(video, { kind: "working" }, true);
  syncCompanionPlayback(video, { kind: "working" }, false);
  syncCompanionPlayback(video, { kind: "working" }, false);
  assert.deepEqual(calls, ["pause", "play"]);
});

test("only working loads video; leaving working releases its decoder and working resumes", () => {
  const calls = [];
  const video = {
    paused: true, src: "", getAttribute() { return this.src || null; },
    removeAttribute() { calls.push("remove"); this.src = ""; },
    load() { calls.push("load"); },
    pause() { calls.push("pause"); this.paused = true; },
    play() { calls.push("play"); this.paused = false; return Promise.resolve(); }
  };
  const media = { url: "https://example.com/working.webm", loop: true };
  for (const kind of ["idle", "waiting", "finished"]) syncCompanionMedia(video, media, { kind }, false);
  assert.deepEqual(calls, [], "static states never assign or load a source");
  syncCompanionMedia(video, media, { kind: "working" }, false);
  assert.equal(video.src, media.url);
  assert.deepEqual(calls, ["load", "play"]);
  syncCompanionMedia(video, media, { kind: "idle" }, false);
  assert.equal(video.src, "");
  assert.deepEqual(calls.slice(2), ["pause", "remove", "load"]);
  syncCompanionMedia(video, media, { kind: "working" }, false);
  assert.equal(video.src, media.url);
  syncCompanionMedia(video, media, { kind: "working" }, true);
  assert.equal(video.src, "", "hidden companions also release the decoder");
});

test("animated mascots play visible idle and approval clips but release media when hidden", () => {
  const calls = [];
  const video = {
    paused: true, src: "", getAttribute() { return this.src || null; },
    removeAttribute() { calls.push("remove"); this.src = ""; },
    load() { calls.push("load"); },
    pause() { calls.push("pause"); this.paused = true; },
    play() { calls.push("play"); this.paused = false; return Promise.resolve(); }
  };
  const media = { url: "file:///chaos-cat/idle.webm", loop: true };
  assert.equal(syncCompanionMedia(video, media, { kind: "idle" }, false, true), true);
  assert.equal(video.src, media.url);
  assert.equal(video.paused, false);
  syncCompanionPlayback(video, { kind: "waiting" }, false, true);
  assert.equal(video.paused, false);
  assert.equal(syncCompanionMedia(video, media, { kind: "waiting" }, true, true), false);
  assert.equal(video.src, "");
  assert.deepEqual(calls, ["load", "play", "pause", "remove", "load"]);
});
