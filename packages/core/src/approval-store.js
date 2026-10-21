import { HookEventType } from "./event-types.js";
import { eventTypeOf } from "./models.js";

const MAX_PRE_TOOL_USE_CACHE_ENTRIES = 200;

export const PermissionDecision = Object.freeze({
  ALLOW: "allow",
  DENY: "deny",
  DEFER: "defer"
});

function permissionResponse(decision, extra = {}) {
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: decision,
        ...extra
      }
    }
  };
}

export class ApprovalStore {
  constructor({ onDismiss = () => {}, onResolverError = () => {} } = {}) {
    this.onDismiss = onDismiss;
    this.onResolverError = onResolverError;
    this.pending = [];
    this.collapsedIds = new Set();
    this.preToolUseCache = new Map();
  }

  cachePreToolUse(event) {
    if (!event.sessionId || !event.toolName || !event.toolUseId) {
      return;
    }

    const key = `${event.sessionId}|${event.agentId ?? ""}|${event.toolName}`;
    // A null entry is ambiguous until the agent's turn ends. Never let the
    // latest parallel call overwrite a different still outstanding candidate.
    const previous = this.preToolUseCache.get(key);
    this.preToolUseCache.set(key,
      previous === undefined || previous === event.toolUseId ? event.toolUseId : null);
    while (this.preToolUseCache.size > MAX_PRE_TOOL_USE_CACHE_ENTRIES) {
      this.preToolUseCache.delete(this.preToolUseCache.keys().next().value);
    }
  }

  add(event, resolver) {
    const waiter = {
      id: crypto.randomUUID(),
      resolver
    };
    const cacheKey = `${event.sessionId ?? ""}|${event.agentId ?? ""}|${event.toolName ?? ""}`;
    const resolvedId = event.toolUseId ?? this.preToolUseCache.get(cacheKey) ?? null;

    // Duplicate by toolUseId
    if (resolvedId) {
      const dup = this.pending.find(
        (p) => p.event.sessionId === event.sessionId &&
          p.event.agentId === event.agentId &&
          (p.event.toolUseId === resolvedId || p.resolvedToolUseId === resolvedId)
      );
      if (dup) {
        dup.waiters.push(waiter);
        return { pending: dup, waiterId: waiter.id, isDuplicate: true };
      }
    }

    // Duplicate by canonical signature
    const sig = this.#canonicalSignature(event);
    const dupBySig = this.pending.find((p) => this.#canonicalSignature(p.event) === sig);
    if (dupBySig) {
      dupBySig.waiters.push(waiter);
      return { pending: dupBySig, waiterId: waiter.id, isDuplicate: true };
    }

    const pending = {
      id: crypto.randomUUID(),
      event,
      waiters: [waiter],
      receivedAt: new Date(),
      resolvedToolUseId: resolvedId
    };

    if (resolvedId && this.preToolUseCache.get(cacheKey) === resolvedId) {
      this.preToolUseCache.delete(cacheKey);
    }
    this.pending.push(pending);
    return { pending, waiterId: waiter.id, isDuplicate: false };
  }

  #canonicalSignature(event) {
    return `${event.sessionId ?? ""}|${event.agentId ?? ""}|${event.toolName ?? ""}|${JSON.stringify(event.toolInput ?? null)}`;
  }

  collapse(id) {
    this.collapsedIds.add(id);
  }

  expand(id) {
    this.collapsedIds.delete(id);
  }

  dismissForSession(sessionId) {
    this.clearPreToolUseCache(sessionId);
    for (const pending of [...this.pending]) {
      if (pending.event.sessionId === sessionId) {
        this.removeWithoutResponse(pending.id);
      }
    }
  }

  dismissForAgent(sessionId, agentId) {
    this.clearPreToolUseCache(sessionId, agentId ?? "");
    for (const pending of [...this.pending]) {
      if (pending.event.sessionId === sessionId && pending.event.agentId === (agentId ?? null)) {
        this.removeWithoutResponse(pending.id);
      }
    }
  }

  dismissByToolUseId(sessionId, toolUseId) {
    for (const [key, candidate] of this.preToolUseCache) {
      if (key.startsWith(`${sessionId}|`) && candidate === toolUseId) {
        this.preToolUseCache.delete(key);
      }
    }
    const match = this.pending.find(
      (pending) =>
        pending.event.sessionId === sessionId &&
        (pending.event.toolUseId === toolUseId || pending.resolvedToolUseId === toolUseId)
    );

    if (match) {
      this.removeWithoutResponse(match.id);
    }
  }

  resolve(id, decision, extra = {}) {
    const index = this.pending.findIndex((pending) => pending.id === id);
    if (index === -1) {
      return null;
    }

    if (decision === PermissionDecision.DEFER) {
      this.collapsedIds.add(id);
      return this.pending[index];
    }

    const [pending] = this.pending.splice(index, 1);
    this.collapsedIds.delete(id);

    for (const waiter of pending.waiters) {
      this.resolveWaiter(waiter, {
        statusCode: 200,
        body: permissionResponse(decision, extra)
      });
    }

    return pending;
  }

  removeWithoutResponse(id) {
    const index = this.pending.findIndex((pending) => pending.id === id);
    if (index === -1) {
      return null;
    }

    const [pending] = this.pending.splice(index, 1);
    this.collapsedIds.delete(id);
    for (const waiter of pending.waiters) {
      this.resolveWaiter(waiter, null);
    }
    this.onDismiss(pending);
    return pending;
  }

  resolveWaiter(waiter, response) {
    try {
      waiter.resolver(response);
    } catch (error) {
      try {
        this.onResolverError(error);
      } catch { /* One response or its diagnostic sink must not block other waiters. */ }
    }
  }

  clearPreToolUseCache(sessionId, agentId) {
    const prefix = agentId === undefined ? `${sessionId}|` : `${sessionId}|${agentId}|`;
    for (const key of this.preToolUseCache.keys()) {
      if (key.startsWith(prefix)) this.preToolUseCache.delete(key);
    }
  }

  detachWaiter(id, waiterId) {
    const pending = this.pending.find((item) => item.id === id);
    if (!pending) {
      return null;
    }

    pending.waiters = pending.waiters.filter((waiter) => waiter.id !== waiterId);
    if (pending.waiters.length > 0) {
      return pending;
    }

    return this.removeWithoutResponse(id);
  }

  handleLifecycleEvent(event) {
    const type = eventTypeOf(event);

    if (type === HookEventType.PRE_TOOL_USE) {
      this.cachePreToolUse(event);
      return;
    }

    if (!event.sessionId) {
      return;
    }

    if (type === HookEventType.POST_TOOL_USE || type === HookEventType.POST_TOOL_USE_FAILURE) {
      if (event.toolUseId) {
        this.dismissByToolUseId(event.sessionId, event.toolUseId);
      }
      return;
    }

    if (type === HookEventType.STOP || type === HookEventType.USER_PROMPT_SUBMIT) {
      this.dismissForAgent(event.sessionId, event.agentId ?? null);
    }
  }
}
