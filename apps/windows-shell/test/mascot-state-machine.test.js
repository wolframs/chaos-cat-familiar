import test from "node:test";
import assert from "node:assert/strict";
import { defaultMascotConfig } from "../renderer/default-mascot-config.js";
import { MascotStateMachine, mascotInputsFromState } from "../renderer/mascot-state-machine.js";

test("suppressed playback settles approval state and never replays its stale transition", () => {
  const mascot = new MascotStateMachine(defaultMascotConfig);
  mascot.applyInputs({ "claudeCode::isWorking": true, "claudeCode::isIdle": false });
  mascot.handleVideoEnded();
  const waiting = mascot.settleWithoutPlayback({ "claudeCode::isAlert": true });
  assert.equal(waiting.nodeName, "Needs Attention");
  assert.equal(waiting.phase, "loop");
  assert.equal(waiting.pendingTarget, null);
  const resumed = mascot.applyInputs({ "claudeCode::isAlert": false });
  assert.match(resumed.media.url, /needs-attention-working-/);
  assert.doesNotMatch(resumed.media.url, /working-needs-attention-/);
});

test("hidden playback discards an obsolete in-flight transition using latest inputs", () => {
  const mascot = new MascotStateMachine(defaultMascotConfig);
  mascot.applyInputs({ "claudeCode::isAlert": true });
  const hidden = mascot.settleWithoutPlayback({ "claudeCode::isAlert": false, "claudeCode::isWorking": true, "claudeCode::isIdle": false });
  assert.equal(hidden.nodeName, "Working");
  assert.equal(hidden.phase, "loop");
  assert.equal(mascot.applyInputs({}).phase, "loop");
  assert.match(hidden.media.url, /working-a172/);
});

test("suppressed playback settles graphs with missing media and bounds conditional cycles", () => {
  const config = {
    initialNode: "a", nodes: [{ id: "a" }, { id: "b" }],
    edges: [
      { source: "a", target: "b", conditions: [{ input: "go", value: true }] }
    ]
  };
  assert.equal(new MascotStateMachine(config).settleWithoutPlayback({ go: true }).nodeId, "b");
  config.edges.push({ source: "b", target: "a", conditions: [{ input: "go", value: true }] });
  const mascot = new MascotStateMachine(config);
  const snapshot = mascot.settleWithoutPlayback({ go: true });
  assert.equal(snapshot.phase, "loop");
  assert.equal(snapshot.pendingTarget, null);
  assert.equal(mascot.pendingEdge, null);
  assert.equal(snapshot.media.url, null);
});

test("static settling keeps the highest priority any-state destination without routing clips", () => {
  const config = {
    initialNode: "a", nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
    edges: [
      { source: "*", target: "c", priority: 10, conditions: [{ input: "alert", value: true }] },
      { source: "*", target: "b", priority: 5, conditions: [{ input: "go", value: true }] },
      { source: "a", target: "b", videos: { webm: "route.webm" } }
    ]
  };
  const mascot = new MascotStateMachine(config);
  assert.equal(mascot.settleWithoutPlayback({ alert: true, go: true }).nodeId, "c");
  const repeated = mascot.settleWithoutPlayback({});
  assert.equal(repeated.nodeId, "c");
  assert.equal(repeated.phase, "loop");
});

test("mascot inputs derive working, alert, compacting, and idle state from overlay state", () => {
  const inputs = mascotInputsFromState({
    approvals: [{ id: "a", collapsed: false }],
    sessions: [
      { id: "s1", status: "active", phase: "running", isCompacting: false, lastEventAt: new Date() },
      { id: "s2", status: "active", phase: "idle", isCompacting: true }
    ]
  });

  assert.equal(inputs["claudeCode::isWorking"], true);
  assert.equal(inputs["claudeCode::isIdle"], false);
  assert.equal(inputs["claudeCode::isAlert"], true);
  assert.equal(inputs["claudeCode::isCompacting"], true);
  assert.equal(inputs["claudeCode::sessionCount"], 2);
});

test("mascot inputs treat stale running sessions as idle", () => {
  const inputs = mascotInputsFromState({
    approvals: [],
    sessions: [
      {
        id: "stale",
        status: "active",
        phase: "running",
        isCompacting: false,
        lastEventAt: new Date(Date.now() - 2 * 60_000)
      }
    ]
  });

  assert.equal(inputs["claudeCode::isWorking"], false);
  assert.equal(inputs["claudeCode::isIdle"], true);
  assert.equal(inputs["claudeCode::isCompacting"], false);
});

test("mascot inputs keep sessions with active subagents in working state", () => {
  const inputs = mascotInputsFromState({
    approvals: [],
    sessions: [
      {
        id: "subagent",
        status: "active",
        phase: "idle",
        isCompacting: false,
        activeSubagentCount: 2,
        lastEventAt: new Date(Date.now() - 5 * 60_000)
      }
    ]
  });

  assert.equal(inputs["claudeCode::isWorking"], true);
  assert.equal(inputs["claudeCode::isIdle"], false);
});

test("mascot state machine starts in the configured idle loop", () => {
  const mascot = new MascotStateMachine(defaultMascotConfig);
  const snapshot = mascot.snapshot();

  assert.equal(snapshot.nodeName, "Idle");
  assert.equal(snapshot.phase, "loop");
  assert.match(snapshot.media.url, /\.webm$/);
  assert.equal(snapshot.media.fallbackUrl, null);
});

test("Windows playback keeps WebM alpha through transitions and destination loops", () => {
  const mascot = new MascotStateMachine(defaultMascotConfig);
  const transition = mascot.applyInputs({
    "claudeCode::isWorking": true,
    "claudeCode::isIdle": false
  });
  assert.equal(transition.phase, "transition");
  assert.match(transition.media.url, /\.webm$/);
  assert.equal(transition.media.fallbackUrl, null, "do not retry opaque HEVC on failure");
  const loop = mascot.handleVideoEnded();
  assert.equal(loop.nodeName, "Working");
  assert.match(loop.media.url, /\.webm$/);
});

test("HEVC-only imports retain their existing playback source", () => {
  const config = structuredClone(defaultMascotConfig);
  for (const edge of config.edges) delete edge.videos.webm;
  const snapshot = new MascotStateMachine(config).snapshot();
  assert.match(snapshot.media.url, /\.mov$/);
  assert.equal(snapshot.media.fallbackUrl, null);
});

test("mascot state machine prefers alert over working when approvals are visible", () => {
  const mascot = new MascotStateMachine(defaultMascotConfig);

  mascot.applyInputs({
    "claudeCode::isWorking": true,
    "claudeCode::isAlert": true,
    "claudeCode::isCompacting": false,
    "claudeCode::isIdle": false
  });

  const transition = mascot.snapshot();
  assert.equal(transition.phase, "transition");
  assert.match(transition.media.url, /needs-attention/i);

  mascot.handleVideoEnded();
  const settled = mascot.snapshot();
  assert.equal(settled.nodeName, "Needs Attention");
  assert.equal(settled.phase, "loop");
});

test("mascot state machine transitions into compacting and back to idle", () => {
  const mascot = new MascotStateMachine(defaultMascotConfig);

  mascot.applyInputs({
    "claudeCode::isWorking": false,
    "claudeCode::isAlert": false,
    "claudeCode::isCompacting": true,
    "claudeCode::isIdle": false
  });
  mascot.handleVideoEnded();

  assert.equal(mascot.snapshot().nodeName, "Thinking");

  mascot.applyInputs({
    "claudeCode::isWorking": false,
    "claudeCode::isAlert": false,
    "claudeCode::isCompacting": false,
    "claudeCode::isIdle": true
  });
  mascot.handleVideoEnded();

  assert.equal(mascot.snapshot().nodeName, "Idle");
});

// --- Any State edge tests ---

const anyStateConfig = {
  initialNode: "A",
  nodes: [
    { id: "A", name: "A", transparentThumbnailUrl: null },
    { id: "B", name: "B", transparentThumbnailUrl: null },
    { id: "C", name: "C", transparentThumbnailUrl: null }
  ],
  edges: [
    // Loop edges
    { source: "A", target: "A", isLoop: true, videos: { webm: "a-loop.webm" } },
    { source: "B", target: "B", isLoop: true, videos: { webm: "b-loop.webm" } },
    { source: "C", target: "C", isLoop: true, videos: { webm: "c-loop.webm" } },
    // Normal edge: A -> B when x is true
    { source: "A", target: "B", isLoop: false, conditions: [{ input: "x", op: "==", value: true }], videos: { webm: "a-to-b.webm" } },
    // Direct edge A -> C with video (for direct-edge preference test)
    { source: "A", target: "C", isLoop: false, conditions: [{ input: "alert", op: "==", value: true }], videos: { webm: "a-to-c-direct.webm" } },
    // Any State -> C when alert is true (priority 10)
    { source: "*", target: "C", isLoop: false, priority: 10, conditions: [{ input: "alert", op: "==", value: true }], videos: { webm: "any-to-c.webm" } },
    // Any State -> B when y is true (priority 5)
    { source: "*", target: "B", isLoop: false, priority: 5, conditions: [{ input: "y", op: "==", value: true }], videos: { webm: "any-to-b.webm" } }
  ]
};

test("any state edge fires from any node", () => {
  const mascot = new MascotStateMachine(anyStateConfig);
  assert.equal(mascot.currentNodeId, "A");

  mascot.applyInputs({ alert: true });
  assert.equal(mascot.phase, "transition");
  mascot.handleVideoEnded();
  assert.equal(mascot.currentNodeId, "C");

  // Now from B
  const mascot2 = new MascotStateMachine(anyStateConfig);
  // Get to B first via normal edge
  mascot2.applyInputs({ x: true });
  mascot2.handleVideoEnded();
  assert.equal(mascot2.currentNodeId, "B");

  mascot2.applyInputs({ alert: true, x: false });
  assert.equal(mascot2.phase, "transition");
  mascot2.handleVideoEnded();
  assert.equal(mascot2.currentNodeId, "C");
});

test("any state edge respects priority", () => {
  const mascot = new MascotStateMachine(anyStateConfig);
  // Both alert and y are true; alert edge has priority 10, y edge has priority 5
  mascot.applyInputs({ alert: true, y: true });
  mascot.handleVideoEnded();
  assert.equal(mascot.currentNodeId, "C");
});

test("any state edge skipped when already at target", () => {
  const mascot = new MascotStateMachine(anyStateConfig);
  // Get to C
  mascot.applyInputs({ alert: true });
  mascot.handleVideoEnded();
  assert.equal(mascot.currentNodeId, "C");

  // Now alert is still true, but we're already at C -- should stay looping
  const snap = mascot.applyInputs({ alert: true });
  assert.equal(snap.phase, "loop");
  assert.equal(snap.nodeId, "C");
});

test("any state edges beat normal edges", () => {
  const mascot = new MascotStateMachine(anyStateConfig);
  // Both x (normal A->B) and alert (any->C) are true; any state should win
  mascot.applyInputs({ x: true, alert: true });
  mascot.handleVideoEnded();
  assert.equal(mascot.currentNodeId, "C");
});

test("any state edge uses direct transition video when available", () => {
  const mascot = new MascotStateMachine(anyStateConfig);
  // From A with alert=true, there's a direct A->C edge with video
  const snap = mascot.applyInputs({ alert: true });
  assert.equal(snap.phase, "transition");
  assert.equal(snap.media.url, "a-to-c-direct.webm");
});

// Fix J: empty-condition any-state edges should be skipped (matching Swift behavior)
test("any state edge with no conditions stays in loop", () => {
  const unconditionalConfig = {
    initialNode: "A",
    nodes: [
      { id: "A", name: "A", transparentThumbnailUrl: null },
      { id: "B", name: "B", transparentThumbnailUrl: null }
    ],
    edges: [
      { source: "A", target: "A", isLoop: true, videos: { webm: "a-loop.webm" } },
      { source: "B", target: "B", isLoop: true, videos: { webm: "b-loop.webm" } },
      { source: "*", target: "B", isLoop: false, conditions: [], videos: { webm: "any-to-b.webm" } }
    ]
  };
  const mascot = new MascotStateMachine(unconditionalConfig);
  // Empty conditions should be skipped, not fire
  const snap = mascot.applyInputs({});
  assert.equal(snap.phase, "loop");
  assert.equal(snap.nodeId, "A");
});

test("default mascot config has no any state edges and behavior is unchanged", () => {
  const mascot = new MascotStateMachine(defaultMascotConfig);
  assert.equal(mascot.anyStateEdges.length, 0);
  const snap = mascot.snapshot();
  assert.equal(snap.nodeName, "Idle");
  assert.equal(snap.phase, "loop");
});

// --- pendingTarget routing tests ---

const pendingTargetConfig = {
  initialNode: "A",
  nodes: [
    { id: "A", name: "A", transparentThumbnailUrl: null },
    { id: "B", name: "B", transparentThumbnailUrl: null },
    { id: "C", name: "C", transparentThumbnailUrl: null },
    { id: "D", name: "D", transparentThumbnailUrl: null }
  ],
  edges: [
    // Loop edges
    { source: "A", target: "A", isLoop: true, videos: { webm: "a-loop.webm" } },
    { source: "B", target: "B", isLoop: true, videos: { webm: "b-loop.webm" } },
    { source: "C", target: "C", isLoop: true, videos: { webm: "c-loop.webm" } },
    { source: "D", target: "D", isLoop: true, videos: { webm: "d-loop.webm" } },
    // Normal edges with video
    { source: "A", target: "B", isLoop: false, conditions: [{ input: "x", op: "==", value: true }], videos: { webm: "a-to-b.webm" } },
    { source: "B", target: "C", isLoop: false, conditions: [{ input: "goC", op: "==", value: true }], videos: { webm: "b-to-c.webm" } },
    { source: "B", target: "D", isLoop: false, conditions: [{ input: "goD", op: "==", value: true }], videos: { webm: "b-to-d.webm" } },
    // No direct A->C edge with video (the multi-hop scenario)
    // Any State -> C when alert is true (priority 5)
    { source: "*", target: "C", isLoop: false, priority: 5, conditions: [{ input: "alert", op: "==", value: true }], videos: { webm: "any-to-c.webm" } },
    // Any State -> D when urgent is true (priority 10)
    { source: "*", target: "D", isLoop: false, priority: 10, conditions: [{ input: "urgent", op: "==", value: true }], videos: { webm: "any-to-d.webm" } }
  ]
};

test("pendingTarget routes through intermediate node", () => {
  const mascot = new MascotStateMachine(pendingTargetConfig);
  assert.equal(mascot.currentNodeId, "A");

  // Any State targets C from A, but no direct A->C video edge
  // Should set pendingTarget=C and use fallback edge A->B
  const snap = mascot.applyInputs({ alert: true });
  assert.equal(snap.phase, "transition");
  assert.equal(snap.pendingTarget, "C");
  assert.equal(snap.media.url, "a-to-b.webm"); // fallback through B

  // Arrive at B, pendingTarget should continue routing toward C
  const snap2 = mascot.handleVideoEnded();
  assert.equal(snap2.nodeId, "B");
  assert.equal(snap2.phase, "transition");
  assert.equal(snap2.media.url, "b-to-c.webm"); // direct B->C

  // Arrive at C
  const snap3 = mascot.handleVideoEnded();
  assert.equal(snap3.nodeId, "C");
  assert.equal(snap3.phase, "loop");
});

test("pendingTarget clears on arrival", () => {
  const mascot = new MascotStateMachine(pendingTargetConfig);
  mascot.applyInputs({ alert: true });
  mascot.handleVideoEnded(); // at B, routing toward C
  mascot.handleVideoEnded(); // at C
  assert.equal(mascot.pendingTarget, null);
  assert.equal(mascot.currentNodeId, "C");
});

test("mid-transition any state sets pendingTarget", () => {
  const mascot = new MascotStateMachine(pendingTargetConfig);

  // Start normal transition A->B
  mascot.applyInputs({ x: true });
  assert.equal(mascot.phase, "transition");
  assert.equal(mascot.pendingTarget, null);

  // Mid-transition, alert triggers Any State->C
  mascot.applyInputs({ alert: true, x: false });
  assert.equal(mascot.phase, "transition"); // still transitioning
  assert.equal(mascot.pendingTarget, "C");

  // Complete A->B transition, should continue toward C
  const snap = mascot.handleVideoEnded();
  assert.equal(snap.nodeId, "B");
  assert.equal(snap.phase, "transition");
  assert.equal(snap.media.url, "b-to-c.webm");
});

test("mid-transition pendingTarget clears when conditions clear", () => {
  const mascot = new MascotStateMachine(pendingTargetConfig);

  // Start normal transition A->B
  mascot.applyInputs({ x: true });
  assert.equal(mascot.phase, "transition");

  // Mid-transition, alert triggers pendingTarget=C
  mascot.applyInputs({ alert: true, x: false });
  assert.equal(mascot.pendingTarget, "C");

  // Clear the alert before arrival
  mascot.applyInputs({ alert: false });
  assert.equal(mascot.pendingTarget, null);

  // Complete A->B, should NOT route toward C
  const snap = mascot.handleVideoEnded();
  assert.equal(snap.nodeId, "B");
  assert.equal(snap.phase, "loop");
});

test("pendingTarget overridden by higher-priority any state", () => {
  const mascot = new MascotStateMachine(pendingTargetConfig);

  // Start with alert (priority 5, targets C) via fallback through B
  mascot.applyInputs({ alert: true });
  assert.equal(mascot.pendingTarget, "C");

  // Mid-transition, urgent (priority 10, targets D) fires
  mascot.applyInputs({ urgent: true });
  assert.equal(mascot.pendingTarget, "D");
});

test("direct edge still works without pendingTarget", () => {
  // Use the original anyStateConfig which has a direct A->C edge
  const mascot = new MascotStateMachine(anyStateConfig);

  const snap = mascot.applyInputs({ alert: true });
  assert.equal(snap.phase, "transition");
  assert.equal(snap.media.url, "a-to-c-direct.webm");
  assert.equal(snap.pendingTarget, null); // no pendingTarget needed
});

// --- nodeTime & loopCount tests ---

const timerConfig = {
  initialNode: "idle",
  nodes: [
    { id: "idle", name: "Idle", transparentThumbnailUrl: null },
    { id: "bored", name: "Bored", transparentThumbnailUrl: null },
    { id: "sleeping", name: "Sleeping", transparentThumbnailUrl: null }
  ],
  edges: [
    { source: "idle", target: "idle", isLoop: true, videos: { webm: "idle-loop.webm" } },
    { source: "bored", target: "bored", isLoop: true, videos: { webm: "bored-loop.webm" } },
    { source: "sleeping", target: "sleeping", isLoop: true, videos: { webm: "sleeping-loop.webm" } },
    // idle -> bored after 5s
    { source: "idle", target: "bored", isLoop: false,
      conditions: [{ input: "nodeTime", op: ">=", value: 5000 }],
      videos: { webm: "idle-to-bored.webm" } },
    // bored -> sleeping after 3 loops
    { source: "bored", target: "sleeping", isLoop: false,
      conditions: [{ input: "loopCount", op: ">=", value: 3 }],
      videos: { webm: "bored-to-sleeping.webm" } },
    // sleeping -> idle on wakeUp
    { source: "sleeping", target: "idle", isLoop: false,
      conditions: [{ input: "wakeUp", op: "==", value: true }],
      videos: { webm: "sleeping-to-idle.webm" } }
  ]
};

const combinedConfig = {
  initialNode: "X",
  nodes: [
    { id: "X", name: "X", transparentThumbnailUrl: null },
    { id: "Y", name: "Y", transparentThumbnailUrl: null }
  ],
  edges: [
    { source: "X", target: "X", isLoop: true, videos: { webm: "x-loop.webm" } },
    { source: "Y", target: "Y", isLoop: true, videos: { webm: "y-loop.webm" } },
    { source: "X", target: "Y", isLoop: false,
      conditions: [
        { input: "nodeTime", op: ">=", value: 2000 },
        { input: "loopCount", op: ">=", value: 2 }
      ],
      videos: { webm: "x-to-y.webm" } }
  ]
};

// --- nodeTime tests ---

test("nodeTime initializes to 0 on construction", () => {
  let now = 1000;
  const mascot = new MascotStateMachine(timerConfig, { clock: () => now });
  assert.equal(mascot.inputs["nodeTime"], 0);
});

test("nodeTime updates on applyInputs based on elapsed clock time", () => {
  let now = 1000;
  const mascot = new MascotStateMachine(timerConfig, { clock: () => now });

  now = 3500;
  mascot.applyInputs({});
  assert.equal(mascot.inputs["nodeTime"], 2500);
});

test("nodeTime triggers transition when threshold exceeded", () => {
  let now = 0;
  const mascot = new MascotStateMachine(timerConfig, { clock: () => now });

  now = 5000;
  const snap = mascot.applyInputs({});
  assert.equal(snap.phase, "transition");
  assert.equal(snap.media.url, "idle-to-bored.webm");

  mascot.handleVideoEnded();
  assert.equal(mascot.currentNodeId, "bored");
});

test("nodeTime resets to 0 on node arrival", () => {
  let now = 0;
  const mascot = new MascotStateMachine(timerConfig, { clock: () => now });

  now = 5000;
  mascot.applyInputs({});

  now = 6000;
  mascot.handleVideoEnded();
  // After arriving at bored, nodeTime should reset
  assert.equal(mascot.inputs["nodeTime"], 0);
});

test("nodeTime uses injected clock", () => {
  let clockA = 0;
  let clockB = 0;
  const mascotA = new MascotStateMachine(timerConfig, { clock: () => clockA });
  const mascotB = new MascotStateMachine(timerConfig, { clock: () => clockB });

  clockA = 5000; // enough for transition
  clockB = 1000; // not enough
  mascotA.applyInputs({});
  mascotB.applyInputs({});

  assert.equal(mascotA.snapshot().phase, "transition");
  assert.equal(mascotB.snapshot().phase, "loop");
});

test("getNodeTimeThresholds returns sorted thresholds for current node", () => {
  let now = 0;
  const mascot = new MascotStateMachine(timerConfig, { clock: () => now });
  const thresholds = mascot.getNodeTimeThresholds();
  assert.deepEqual(thresholds, [5000]);
});

// --- loopCount tests ---

test("loopCount initializes to 0 on construction", () => {
  let now = 0;
  const mascot = new MascotStateMachine(timerConfig, { clock: () => now });
  assert.equal(mascot.inputs["loopCount"], 0);
});

test("handleLoopCycleCompleted increments loopCount", () => {
  let now = 0;
  const mascot = new MascotStateMachine(timerConfig, { clock: () => now });

  // Get to bored first
  now = 5000;
  mascot.applyInputs({});
  now = 5001;
  mascot.handleVideoEnded();
  assert.equal(mascot.currentNodeId, "bored");

  mascot.handleLoopCycleCompleted();
  assert.equal(mascot.inputs["loopCount"], 1);
  mascot.handleLoopCycleCompleted();
  assert.equal(mascot.inputs["loopCount"], 2);
});

test("loopCount triggers transition when threshold reached", () => {
  let now = 0;
  const mascot = new MascotStateMachine(timerConfig, { clock: () => now });

  // Get to bored
  now = 5000;
  mascot.applyInputs({});
  now = 5001;
  mascot.handleVideoEnded();
  assert.equal(mascot.currentNodeId, "bored");

  // 3 loop cycles should trigger bored -> sleeping
  mascot.handleLoopCycleCompleted();
  mascot.handleLoopCycleCompleted();
  const snap = mascot.handleLoopCycleCompleted();
  assert.equal(snap.phase, "transition");
  assert.equal(snap.media.url, "bored-to-sleeping.webm");
});

test("loopCount does not trigger below threshold", () => {
  let now = 0;
  const mascot = new MascotStateMachine(timerConfig, { clock: () => now });

  // Get to bored
  now = 5000;
  mascot.applyInputs({});
  now = 5001;
  mascot.handleVideoEnded();

  mascot.handleLoopCycleCompleted();
  mascot.handleLoopCycleCompleted();
  assert.equal(mascot.snapshot().phase, "loop");
  assert.equal(mascot.inputs["loopCount"], 2);
});

test("loopCount resets to 0 on node arrival", () => {
  let now = 0;
  const mascot = new MascotStateMachine(timerConfig, { clock: () => now });

  // Get to bored
  now = 5000;
  mascot.applyInputs({});
  now = 5001;
  mascot.handleVideoEnded();

  // Do 3 loops -> transition to sleeping
  mascot.handleLoopCycleCompleted();
  mascot.handleLoopCycleCompleted();
  mascot.handleLoopCycleCompleted();
  now = 5002;
  mascot.handleVideoEnded();

  assert.equal(mascot.currentNodeId, "sleeping");
  assert.equal(mascot.inputs["loopCount"], 0);
});

test("handleLoopCycleCompleted is no-op during transition phase", () => {
  let now = 0;
  const mascot = new MascotStateMachine(timerConfig, { clock: () => now });

  now = 5000;
  mascot.applyInputs({});
  assert.equal(mascot.phase, "transition");

  const snap = mascot.handleLoopCycleCompleted();
  assert.equal(snap.phase, "transition");
  assert.equal(mascot.inputs["loopCount"], 0);
});

// --- Combined / interaction tests ---

test("combined nodeTime AND loopCount condition requires both met", () => {
  let now = 0;
  const mascot = new MascotStateMachine(combinedConfig, { clock: () => now });

  // Only time met, not loops
  now = 3000;
  mascot.applyInputs({});
  assert.equal(mascot.snapshot().phase, "loop");

  // Only loops met, not time
  now = 0;
  const mascot2 = new MascotStateMachine(combinedConfig, { clock: () => now });
  mascot2.handleLoopCycleCompleted();
  mascot2.handleLoopCycleCompleted();
  assert.equal(mascot2.snapshot().phase, "loop");

  // Both met
  now = 2000;
  const snap = mascot2.applyInputs({});
  assert.equal(snap.phase, "transition");
  assert.equal(snap.media.url, "x-to-y.webm");
});

test("regular inputs work alongside nodeTime and loopCount", () => {
  let now = 0;
  const mascot = new MascotStateMachine(timerConfig, { clock: () => now });

  // Get to sleeping via nodeTime + loopCount chain
  now = 5000;
  mascot.applyInputs({});
  now = 5001;
  mascot.handleVideoEnded();
  mascot.handleLoopCycleCompleted();
  mascot.handleLoopCycleCompleted();
  mascot.handleLoopCycleCompleted();
  now = 5002;
  mascot.handleVideoEnded();
  assert.equal(mascot.currentNodeId, "sleeping");

  // Regular input wakeUp should work
  now = 5003;
  const snap = mascot.applyInputs({ wakeUp: true });
  assert.equal(snap.phase, "transition");
  assert.equal(snap.media.url, "sleeping-to-idle.webm");
});

test("nodeTime and loopCount reset when any-state edge changes node", () => {
  const configWithAny = {
    initialNode: "idle",
    nodes: [
      { id: "idle", name: "Idle", transparentThumbnailUrl: null },
      { id: "alert", name: "Alert", transparentThumbnailUrl: null }
    ],
    edges: [
      { source: "idle", target: "idle", isLoop: true, videos: { webm: "idle-loop.webm" } },
      { source: "alert", target: "alert", isLoop: true, videos: { webm: "alert-loop.webm" } },
      { source: "*", target: "alert", isLoop: false,
        conditions: [{ input: "isAlert", op: "==", value: true }],
        videos: { webm: "any-to-alert.webm" } }
    ]
  };

  let now = 0;
  const mascot = new MascotStateMachine(configWithAny, { clock: () => now });

  now = 3000;
  mascot.applyInputs({});
  assert.equal(mascot.inputs["nodeTime"], 3000);

  mascot.handleLoopCycleCompleted();
  assert.equal(mascot.inputs["loopCount"], 1);

  // Any-state edge fires
  mascot.applyInputs({ isAlert: true });
  now = 3001;
  mascot.handleVideoEnded();

  assert.equal(mascot.currentNodeId, "alert");
  assert.equal(mascot.inputs["nodeTime"], 0);
  assert.equal(mascot.inputs["loopCount"], 0);
});

test("getNodeTimeThresholds returns empty array when no nodeTime conditions", () => {
  const mascot = new MascotStateMachine(anyStateConfig);
  assert.deepEqual(mascot.getNodeTimeThresholds(), []);
});

// --- Backward compat tests ---

test("default mascot config unaffected by nodeTime/loopCount", () => {
  const mascot = new MascotStateMachine(defaultMascotConfig);
  assert.deepEqual(mascot.getNodeTimeThresholds(), []);
  assert.equal(mascot.inputs["nodeTime"], 0);
  assert.equal(mascot.inputs["loopCount"], 0);

  // Normal behavior still works
  mascot.applyInputs({
    "claudeCode::isWorking": true,
    "claudeCode::isIdle": false,
    "claudeCode::isAlert": false,
    "claudeCode::isCompacting": false
  });
  assert.equal(mascot.snapshot().phase, "transition");
});

test("constructor without options works (clock defaults to Date.now)", () => {
  const mascot = new MascotStateMachine(timerConfig);
  assert.equal(mascot.inputs["nodeTime"], 0);
  assert.equal(mascot.inputs["loopCount"], 0);
  assert.equal(typeof mascot.clock, "function");
  // nodeArrivalTime should be a reasonable timestamp
  assert.ok(mascot.nodeArrivalTime > 0);
});

// --- Fix G: Dual prefix agent:: + claudeCode:: ---

test("mascot inputs include both agent:: and claudeCode:: prefixes with equal values", () => {
  const inputs = mascotInputsFromState({
    approvals: [{ id: "a", collapsed: false }],
    sessions: [
      { id: "s1", status: "active", phase: "running", isCompacting: false, lastEventAt: new Date() }
    ]
  });

  assert.equal(inputs["agent::isWorking"], inputs["claudeCode::isWorking"]);
  assert.equal(inputs["agent::isIdle"], inputs["claudeCode::isIdle"]);
  assert.equal(inputs["agent::isAlert"], inputs["claudeCode::isAlert"]);
  assert.equal(inputs["agent::isCompacting"], inputs["claudeCode::isCompacting"]);
  assert.equal(inputs["agent::sessionCount"], inputs["claudeCode::sessionCount"]);
});

// --- Fix H: Initialize custom inputs from config.inputs ---

test("config with inputs array initializes custom input defaults", () => {
  const configWithInputs = {
    ...timerConfig,
    inputs: [
      { name: "customFlag", type: "boolean", defaultValue: false },
      { name: "customCount", type: "number", defaultValue: 42 }
    ]
  };
  const mascot = new MascotStateMachine(configWithInputs, { clock: () => 0 });
  assert.equal(mascot.inputs["customFlag"], false);
  assert.equal(mascot.inputs["customCount"], 42);
});

test("config without inputs array works normally", () => {
  const mascot = new MascotStateMachine(timerConfig, { clock: () => 0 });
  assert.equal(mascot.inputs["nodeTime"], 0);
  assert.equal(mascot.inputs["loopCount"], 0);
});

// --- Fix I: Trigger reset after transitions ---

test("trigger inputs reset after transition completes", () => {
  const triggerConfig = {
    initialNode: "A",
    nodes: [
      { id: "A", name: "A", transparentThumbnailUrl: null },
      { id: "B", name: "B", transparentThumbnailUrl: null }
    ],
    edges: [
      { source: "A", target: "A", isLoop: true, videos: { webm: "a-loop.webm" } },
      { source: "B", target: "B", isLoop: true, videos: { webm: "b-loop.webm" } },
      { source: "A", target: "B", isLoop: false,
        conditions: [{ input: "clicked", op: "==", value: true }],
        videos: { webm: "a-to-b.webm" } }
    ],
    inputs: [
      { name: "myTrigger", type: "trigger", defaultValue: false }
    ]
  };
  let now = 0;
  const mascot = new MascotStateMachine(triggerConfig, { clock: () => now });

  mascot.applyInputs({ clicked: true, mouseOver: true, myTrigger: true });
  assert.equal(mascot.phase, "transition");

  now = 1;
  mascot.handleVideoEnded();
  assert.equal(mascot.currentNodeId, "B");

  // Triggers should be reset
  assert.equal(mascot.inputs["clicked"], false);
  assert.equal(mascot.inputs["mouseOver"], false);
  assert.equal(mascot.inputs["myTrigger"], false);
});

test("state inputs NOT reset after transition", () => {
  let now = 0;
  const mascot = new MascotStateMachine(anyStateConfig, { clock: () => now });

  mascot.applyInputs({
    "claudeCode::isWorking": true,
    "claudeCode::isIdle": false,
    alert: true
  });
  assert.equal(mascot.phase, "transition");

  now = 1;
  mascot.handleVideoEnded();

  // State inputs should persist
  assert.equal(mascot.inputs["claudeCode::isWorking"], true);
  assert.equal(mascot.inputs["claudeCode::isIdle"], false);
});

// --- Bonus: nodeTime boundary precision ---

test("nodeTime at exact boundary triggers transition", () => {
  let now = 0;
  const mascot = new MascotStateMachine(timerConfig, { clock: () => now });

  now = 5000; // exactly at boundary (>= 5000)
  const snap = mascot.applyInputs({});
  assert.equal(snap.phase, "transition");
});

test("nodeTime just below boundary stays in loop", () => {
  let now = 0;
  const mascot = new MascotStateMachine(timerConfig, { clock: () => now });

  now = 4999; // just below boundary
  const snap = mascot.applyInputs({});
  assert.equal(snap.phase, "loop");
});
