function conditionValue(value) {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "number") {
    return value;
  }
  return Number(value ?? 0);
}

function compareValues(left, op, right) {
  switch (op) {
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
      return left > right;
    case "<":
      return left < right;
    case ">=":
      return left >= right;
    case "<=":
      return left <= right;
    default:
      return false;
  }
}

function mediaUrlForEdge(edge) {
  // Electron on Windows needs the WebM alpha channel. HEVC can decode
  // successfully with an opaque background, so an error fallback is too late.
  return edge?.videos?.webm ?? edge?.videos?.hevc ?? null;
}

function fallbackMediaUrlForEdge(edge) {
  // Do not replace a failed transparent WebM with an opaque HEVC rendition.
  return null;
}

function nodeById(config, id) {
  return config.nodes.find((node) => node.id === id) ?? null;
}

function loopEdgeForNode(config, nodeId) {
  return config.edges.find((edge) => edge.source === nodeId && edge.target === nodeId && edge.isLoop) ?? null;
}

function transitionEdgesForNode(config, nodeId) {
  return config.edges.filter((edge) => edge.source === nodeId && !edge.isLoop);
}

function toTimestamp(value) {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function mascotInputsFromState(state) {
  const activeSessions = (state?.sessions ?? []).filter((session) => session.status === "active");
  const visibleApprovals = (state?.approvals ?? []).filter((approval) => !approval.collapsed);
  const staleRunningMs = 90_000;
  const now = Date.now();
  const compacting = activeSessions.some((session) => session.isCompacting || session.phase === "compacting");
  const workingSessions = activeSessions.filter((session) => {
    if ((session.activeSubagentCount ?? 0) > 0) {
      return true;
    }
    if (session.phase !== "running") {
      return false;
    }
    const lastEventAt = toTimestamp(session.lastEventAt);
    if (lastEventAt == null) {
      return true;
    }
    return now - lastEventAt <= staleRunningMs;
  });

  const isWorking = workingSessions.length > 0;
  const isIdle = activeSessions.length === 0 || (!compacting && workingSessions.length === 0);
  const isAlert = visibleApprovals.length > 0;
  const sessionCount = activeSessions.length;

  return {
    "claudeCode::isWorking": isWorking,
    "claudeCode::isIdle": isIdle,
    "claudeCode::isAlert": isAlert,
    "claudeCode::isCompacting": compacting,
    "claudeCode::sessionCount": sessionCount,
    "agent::isWorking": isWorking,
    "agent::isIdle": isIdle,
    "agent::isAlert": isAlert,
    "agent::isCompacting": compacting,
    "agent::sessionCount": sessionCount
  };
}

export class MascotStateMachine {
  constructor(config, { clock = Date.now } = {}) {
    this.config = config;
    this.clock = clock;
    this.inputs = mascotInputsFromState({});
    if (Array.isArray(config.inputs)) {
      for (const input of config.inputs) {
        if (input.name && input.defaultValue !== undefined) {
          this.inputs[input.name] = input.defaultValue;
        }
      }
    }
    this.pendingEdge = null;
    this.pendingTarget = null;
    this.anyStateEdges = config.edges
      .filter(e => e.source === "*" && !e.isLoop)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    this.#arriveAtNode(config.initialNode);
  }

  get currentNode() {
    return nodeById(this.config, this.currentNodeId);
  }

  get currentNodeName() {
    return this.currentNode?.name ?? this.currentNodeId;
  }

  get currentThumbnailUrl() {
    return this.currentNode?.transparentThumbnailUrl ?? null;
  }

  snapshot() {
    return {
      nodeId: this.currentNodeId,
      nodeName: this.currentNodeName,
      phase: this.phase,
      media: this.currentMedia,
      thumbnailUrl: this.currentThumbnailUrl,
      pendingTarget: this.pendingTarget,
      nodeTimeThresholds: this.getNodeTimeThresholds()
    };
  }

  #arriveAtNode(nodeId) {
    this.currentNodeId = nodeId;
    this.phase = "loop";
    this.currentMedia = this.#loopMediaForNode(nodeId);
    this.nodeArrivalTime = this.clock();
    this.inputs["nodeTime"] = 0;
    this.inputs["loopCount"] = 0;
  }

  applyInputs(nextInputs) {
    this.inputs = {
      ...this.inputs,
      ...nextInputs
    };
    this.inputs["nodeTime"] = this.clock() - this.nodeArrivalTime;
    if (this.phase === "transition") {
      if (this.anyStateEdges.length > 0) {
        const best = this.#bestAnyStateMatch();
        if (best && best.target !== this.pendingEdge?.target) {
          this.pendingTarget = best.target;
        } else if (!best && this.pendingTarget) {
          this.pendingTarget = null;
        }
      }
      return this.snapshot();
    }
    const anyEdge = this.#bestAnyStateMatch();
    if (anyEdge) {
      const direct = this.#findDirectEdge(this.currentNodeId, anyEdge.target);
      if (direct) {
        this.pendingTarget = null;
        this.pendingEdge = direct;
      } else {
        this.pendingTarget = anyEdge.target;
        const fallback = this.#findFallbackEdge(this.currentNodeId);
        this.pendingEdge = fallback ?? anyEdge;
      }
      this.phase = "transition";
      this.currentMedia = {
        url: mediaUrlForEdge(this.pendingEdge),
        fallbackUrl: fallbackMediaUrlForEdge(this.pendingEdge),
        loop: false
      };
      return this.snapshot();
    }
    const edge = this.#matchingTransition();
    if (edge) {
      this.pendingEdge = edge;
      this.phase = "transition";
      this.currentMedia = {
        url: mediaUrlForEdge(edge),
        fallbackUrl: fallbackMediaUrlForEdge(edge),
        loop: false
      };
    } else {
      this.phase = "loop";
      this.currentMedia = this.#loopMediaForNode(this.currentNodeId);
    }
    return this.snapshot();
  }

  settleWithoutPlayback(nextInputs = {}) {
    // A removed video cannot deliver `ended`. Re-evaluate current inputs instead
    // of retaining an in-flight clip that may already describe obsolete state.
    this.pendingEdge = null;
    this.pendingTarget = null;
    this.phase = "loop";
    const visited = new Set([this.currentNodeId]);
    this.applyInputs(nextInputs);
    while (this.phase === "transition" && this.pendingEdge) {
      // Static presentation needs the destination, not intermediate routing clips.
      const target = this.#bestAnyStateMatch(true)?.target ?? this.pendingTarget ?? this.pendingEdge.target;
      this.pendingEdge = null;
      this.pendingTarget = null;
      if (visited.has(target)) break;
      visited.add(target);
      this.#arriveAtNode(target);
      this.#resetTriggers();
      this.applyInputs({});
    }
    // Imported graphs may contain always-matching cycles or no video at all.
    // Leave a stable node even when there is no terminal transition to reach.
    this.pendingEdge = null;
    this.pendingTarget = null;
    this.phase = "loop";
    this.currentMedia = this.#loopMediaForNode(this.currentNodeId);
    return this.snapshot();
  }

  handleVideoEnded() {
    if (this.phase !== "transition" || !this.pendingEdge) {
      return this.snapshot();
    }
    const targetId = this.pendingEdge.target;
    this.pendingEdge = null;
    this.#arriveAtNode(targetId);
    this.#resetTriggers();

    if (this.pendingTarget) {
      if (this.pendingTarget === targetId) {
        this.pendingTarget = null;
      } else {
        const best = this.#bestAnyStateMatch();
        if (best && best.target === this.pendingTarget) {
          const direct = this.#findDirectEdge(targetId, this.pendingTarget);
          if (direct) {
            this.pendingTarget = null;
            this.pendingEdge = direct;
            this.phase = "transition";
            this.currentMedia = {
              url: mediaUrlForEdge(direct),
              fallbackUrl: fallbackMediaUrlForEdge(direct),
              loop: false
            };
            return this.snapshot();
          }
          const fallback = this.#findFallbackEdge(targetId);
          if (fallback) {
            this.pendingEdge = fallback;
            this.phase = "transition";
            this.currentMedia = {
              url: mediaUrlForEdge(fallback),
              fallbackUrl: fallbackMediaUrlForEdge(fallback),
              loop: false
            };
            return this.snapshot();
          }
        }
        this.pendingTarget = null;
      }
    }

    return this.applyInputs({});
  }

  handleLoopCycleCompleted() {
    if (this.phase !== "loop") return this.snapshot();
    this.inputs["loopCount"] = (this.inputs["loopCount"] ?? 0) + 1;
    return this.applyInputs({});
  }

  getNodeTimeThresholds() {
    const allEdges = [
      ...transitionEdgesForNode(this.config, this.currentNodeId),
      ...this.anyStateEdges
    ];
    const values = new Set();
    for (const edge of allEdges) {
      const conditions = Array.isArray(edge.conditions) ? edge.conditions : [];
      for (const cond of conditions) {
        if (cond.input === "nodeTime" && typeof cond.value === "number") {
          values.add(cond.value);
        }
      }
    }
    return [...values].sort((a, b) => a - b);
  }

  #bestAnyStateMatch(includeCurrent = false) {
    for (const edge of this.anyStateEdges) {
      if (!includeCurrent && edge.target === this.currentNodeId) {
        continue;
      }
      const conditions = Array.isArray(edge.conditions) ? edge.conditions : [];
      if (conditions.length === 0) {
        continue;
      }
      const matched = conditions.every((condition) => {
        const left = conditionValue(this.inputs[condition.input]);
        const right = conditionValue(condition.value);
        return compareValues(left, condition.op ?? "==", right);
      });
      if (matched) {
        return edge;
      }
    }
    return null;
  }

  static #stateInputs = new Set([
    "isWorking", "isIdle", "isAlert", "isCompacting", "sessionCount"
  ]);

  #resetTriggers() {
    this.inputs["clicked"] = false;
    this.inputs["mouseOver"] = false;
    for (const key of Object.keys(this.inputs)) {
      if ((key.startsWith("agent::") || key.startsWith("claudeCode::"))
          && !MascotStateMachine.#stateInputs.has(key.split("::")[1])) {
        this.inputs[key] = false;
      }
    }
    if (Array.isArray(this.config.inputs)) {
      for (const input of this.config.inputs) {
        if (input.type === "trigger") {
          this.inputs[input.name] = input.defaultValue ?? false;
        }
      }
    }
  }

  #findFallbackEdge(fromId) {
    return this.config.edges.find(
      (e) => e.source === fromId && !e.isLoop && e.target !== fromId && mediaUrlForEdge(e)
    ) ?? null;
  }

  #findDirectEdge(fromId, toId) {
    return this.config.edges.find(
      (e) => e.source === fromId && e.target === toId && !e.isLoop && mediaUrlForEdge(e)
    ) ?? null;
  }

  #matchingTransition() {
    for (const edge of transitionEdgesForNode(this.config, this.currentNodeId)) {
      const conditions = Array.isArray(edge.conditions) ? edge.conditions : [];
      if (conditions.length === 0) {
        continue;
      }
      const matched = conditions.every((condition) => {
        const left = conditionValue(this.inputs[condition.input]);
        const right = conditionValue(condition.value);
        return compareValues(left, condition.op ?? "==", right);
      });
      if (matched) {
        return edge;
      }
    }
    return null;
  }

  #loopMediaForNode(nodeId) {
    const edge = loopEdgeForNode(this.config, nodeId);
    return {
      url: mediaUrlForEdge(edge),
      fallbackUrl: fallbackMediaUrlForEdge(edge),
      loop: true
    };
  }
}
