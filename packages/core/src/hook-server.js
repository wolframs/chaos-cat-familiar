import http from "node:http";
import { timingSafeEqual, randomBytes, randomUUID } from "node:crypto";
import { HookEventType } from "./event-types.js";
import { normalizeEvent } from "./models.js";
import { validateHookPayload } from "./hook-validator.js";

const MAX_BODY_SIZE = 2 * 1024 * 1024;
const APPROVAL_ACTIONS = new Set(["allow", "deny", "defer", "allowWithAnswers", "allowWithFeedback", "allowWithPermissions"]);

// The cat's speech-bubble events: a catalog key such as "agent_idle", and flat placeholders
// ({agent: "temp", mins: 16}) that fill a short line.
function isBubbleEvent(event) {
  return typeof event === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(event);
}

function isBubblePlaceholders(placeholders) {
  if (!placeholders || typeof placeholders !== "object" || Array.isArray(placeholders)) return false;
  const entries = Object.entries(placeholders);
  return entries.length <= 12 && entries.every(([key, value]) => /^[a-z][a-z0-9_]{0,23}$/.test(key)
    && ((typeof value === "string" && value.length <= 120) || (typeof value === "number" && Number.isFinite(value))));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let byteLength = 0;
    let rejected = false;

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      byteLength += Buffer.byteLength(chunk, "utf8");
      if (byteLength > MAX_BODY_SIZE) {
        if (!rejected) {
          rejected = true;
          reject(new Error("payload_too_large"));
        }
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        const normalized = data.startsWith("\uFEFF") ? data.slice(1) : data;
        resolve(normalized ? JSON.parse(normalized) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

export class HookServer {
  constructor({ controller, host = "127.0.0.1", port = 49152, authToken = null,
    onCompanionStatus = null, onCompanionOpen = null, onCompanionBubble = null }) {
    this.controller = controller;
    this.authToken = authToken || randomBytes(32).toString("hex");
    this.host = host;
    this.port = port;
    this.onCompanionStatus = onCompanionStatus;
    this.onCompanionOpen = onCompanionOpen;
    this.onCompanionBubble = onCompanionBubble;
    this.server = null;
    this.stopping = false;
    this.observedIds=new Set();this.observationWork=Promise.resolve();
    this.hookWork = Promise.resolve();
  }

  // Resolves once every routine hook accepted so far has been ingested (or failed and logged).
  idle() {
    return this.hookWork;
  }

  logError(...args) {
    try { this.controller.logger?.error?.(...args); } catch { /* Transport must still finish the response. */ }
  }

  async start() {
    this.stopping = false;
    this.server = http.createServer(async (req, res) => {
      const startedAt = performance.now();
      const trace = { requestId: randomUUID(), method: req.method,
        route: req.url === "/hook" ? "hook" : req.url?.startsWith("/approvals/") ? "approval" : "other" };
      const debug = (message, context) => {
        try { this.controller.logger?.debug?.("transport", message, context); } catch {}
      };
      let finished = false;
      res.once("finish", () => {
        finished = true;
        debug("Request completed", { ...trace, statusCode: res.statusCode,
          durationMs: Math.round((performance.now() - startedAt) * 100) / 100 });
      });
      res.once("close", () => {
        if (!finished) debug("Client disconnected", { ...trace,
          durationMs: Math.round((performance.now() - startedAt) * 100) / 100 });
      });
      try {
        if (req.headers.host !== `${this.host}:${this.port}` || req.headers.origin || req.headers["sec-fetch-site"] === "cross-site") {
          res.writeHead(403); res.end(); return;
        }
        if (this.authToken && req.url !== "/health") {
          const expected = Buffer.from(this.authToken);
          const supplied = Buffer.from(String(req.headers["x-ccf-token"] ?? ""));
          if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
            res.writeHead(401); res.end(); return;
          }
        }
        if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("ok");
          return;
        }

        if (req.method === "GET" && req.url === "/state") {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(this.controller.snapshot()));
          return;
        }

        if (req.method === "POST" && req.url === "/companion/status" && this.onCompanionStatus) {
          try {
            const payload = await readJsonBody(req);
            const cwd = payload?.cwd ?? payload?.workspace?.current_dir;
            if (typeof payload?.session_id !== "string" || payload.session_id.length > 256
              || typeof cwd !== "string" || cwd.length > 4096) {
              res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ error: "invalid_companion_status" }));
              return;
            }
            await this.onCompanionStatus(payload);
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
          } catch (error) {
            res.writeHead(error?.message === "payload_too_large" ? 413 : 400,
              { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "invalid_companion_status" }));
          }
          return;
        }

        if (req.method === "POST" && req.url === "/companion/open" && this.onCompanionOpen) {
          try {
            const payload = (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'])
              ? await readJsonBody(req) : {};
            if (payload.backend !== undefined && !['claude', 'codex'].includes(payload.backend)) throw new Error('Unsupported companion backend.');
            await this.onCompanionOpen(payload);
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
          } catch (error) {
            const status = /already running/i.test(String(error?.message)) ? 409 : 503;
            res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: String(error?.message ?? error) }));
          }
          return;
        }

        // The work companion's watcher: a speech bubble from the cat when a session waits on the user.
        if (req.method === "POST" && req.url === "/companion/bubble" && this.onCompanionBubble) {
          const reply = (statusCode, body) => {
            res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(body));
          };
          let payload;
          try { payload = await readJsonBody(req); } catch (error) {
            reply(error?.message === "payload_too_large" ? 413 : 400, { error: "invalid_companion_bubble" });
            return;
          }
          const text = typeof payload?.text === "string" ? payload.text.trim() : "";
          // Either free text, or an event name + placeholders: the shell picks the line from the cat's
          // catalog. Text sent along with an event is the fallback for an event the catalog lacks.
          // style and special are optional overrides (tests, trying a look); normally the shell rolls them.
          const { style, special, event, placeholders } = payload ?? {};
          if ((!text && event === undefined) || text.length > 300
            || (event !== undefined && !isBubbleEvent(event))
            || (placeholders !== undefined && (event === undefined || !isBubblePlaceholders(placeholders)))
            || (style !== undefined && (typeof style !== "string" || style.length > 40))
            || (special !== undefined && typeof special !== "boolean")) {
            reply(400, { error: "invalid_companion_bubble" });
            return;
          }
          const result = await this.onCompanionBubble({ text: text || null, event: event ?? null,
            placeholders: placeholders ?? null, style: style ?? null, special: special ?? null });
          if (result?.rejected) {
            reply(400, { error: result.rejected });
            return;
          }
          reply(200, { ok: true, shown: Boolean(result?.shown),
            ...(result?.tier ? { tier: result.tier, kind: result.kind, text: result.text } : {}) });
          return;
        }

        if(req.method==='POST'&&req.url==='/codex/hook'){
          try{
            const payload=await readJsonBody(req);
            if(payload.backend!=='codex'||payload.observation_only!==true||payload.integration_source!=='codex-hook'||typeof payload.event_id!=='string'||!payload.event_id||payload.event_id.length>256||typeof payload.session_id!=='string'||!payload.session_id||!validateHookPayload(payload).ok)throw new Error('Invalid Codex observation envelope.');
            if(payload.tool_response!=null&&JSON.stringify(payload.tool_response).length>16384)payload.tool_response={truncated:true,preview:JSON.stringify(payload.tool_response).slice(0,16384)};
            const operation=this.observationWork.then(async()=>{
              if(this.observedIds.has(payload.event_id))return;
              await this.controller.ingestEvent(normalizeEvent(payload));this.observedIds.add(payload.event_id);
              if(this.observedIds.size>2000)this.observedIds.delete(this.observedIds.values().next().value);
            });
            this.observationWork=operation.catch(()=>{});await operation;
            res.writeHead(200,{'content-type':'application/json; charset=utf-8'});res.end('{}');
          }catch(error){res.writeHead(error.message==='payload_too_large'?413:400,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'invalid_codex_observation'}));}
          return;
        }

        if (req.method === "POST" && req.url === "/hook") {
          try {
            const payload = await readJsonBody(req);
            if(payload.backend==='codex')throw new Error('Codex hook observations must use the observation-only route.');
            const validation = validateHookPayload(payload);
            if (!validation.ok) {
              this.logError("hook", "Hook payload validation failed", {
                issues: validation.issues
              });
              res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ error: "invalid_hook_payload", issues: validation.issues }));
              return;
            }
            // Keep lifecycle identity for large tool results without retaining their entire contents.
            if (payload.tool_response != null && JSON.stringify(payload.tool_response).length > 16_384) {
              payload.tool_response = { truncated: true, preview: JSON.stringify(payload.tool_response).slice(0, 16_384) };
            }
            const event = normalizeEvent(payload);
            Object.assign(trace, { sessionId: event.sessionId, hookEventName: event.hookEventName,
              toolName: event.toolName, toolUseId: event.toolUseId });
            debug("Hook accepted", trace);

            if (event.hookEventName === HookEventType.PERMISSION_REQUEST) {
              if (this.stopping) {
                res.writeHead(204);
                res.end();
                return;
              }
              const result = await this.controller.enqueueApproval(event, (response) => {
                if (res.headersSent || res.writableEnded || res.destroyed) return;
                if (response === null) {
                  if (!res.writableEnded) {
                    res.writeHead(204);
                    res.end();
                  }
                  return;
                }

                res.writeHead(response.statusCode, {
                  "content-type": "application/json; charset=utf-8"
                });
                res.end(JSON.stringify(response.body));
              });
              const pending = result?.pending ?? null;
              const waiterId = result?.waiterId ?? null;
              if (pending && waiterId) {
                const detachWaiter = () => {
                  if (!res.writableFinished) {
                    this.controller.detachApprovalWaiter(pending.id, waiterId);
                  }
                };
                res.on("close", detachWaiter);
                if (res.destroyed) detachWaiter();
              }
              return;
            }

            // Claude Code http hooks block until we answer, so answer first and ingest
            // afterwards. One serial chain keeps events in arrival order.
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
            this.hookWork = this.hookWork.then(() => this.controller.ingestEvent(event)).catch((error) => {
              this.logError("hook", "Hook ingestion failed after the response", {
                hookEventName: event.hookEventName, sessionId: event.sessionId,
                error: String(error?.message ?? error)
              });
            });
          } catch (error) {
            const statusCode = error.message === "payload_too_large" ? 413 : 400;
            this.logError("hook", "Hook request failed", {
              error: String(error.message ?? error)
            });
            if (res.headersSent || res.writableEnded || res.destroyed) return;
            res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: String(error.message ?? error) }));
          }
          return;
        }

        if (req.method === "POST" && req.url?.startsWith("/approvals/")) {
          const [, , approvalId, action, extraPath] = req.url.split("/");
          if (!approvalId || extraPath !== undefined || !APPROVAL_ACTIONS.has(action)) {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "invalid_approval_action" })); return;
          }
          let payload;
          try {
            payload = await readJsonBody(req);
          } catch {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "invalid_json" }));
            return;
          }
          const extra = {};

          if (action === "allowWithAnswers" && payload.answers) {
            extra.updatedInput = { answers: payload.answers };
          } else if (action === "allowWithFeedback" && payload.feedback) {
            extra.updatedInput = { userFeedback: payload.feedback };
          } else if (action === "allowWithPermissions" && payload.updatedPermissions) {
            extra.updatedPermissions = payload.updatedPermissions;
          }

          const decision =
            action === "deny" ? "deny" : action === "defer" ? "defer" : "allow";
          const resolved = this.controller.resolveApproval(approvalId, decision, extra);

          if (!resolved) {
            res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "approval_not_found" }));
            return;
          }

          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "not_found" }));
      } catch (error) {
        this.logError("hook", "Request failed", { error: String(error.message ?? error) });
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "request_failed" }));
        }
      }
    });

    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        const address = this.server.address();
        if (address && typeof address === "object") {
          this.port = address.port;
        }
        resolve();
      });
    });
  }

  async stop() {
    if (!this.server) {
      return;
    }

    this.stopping = true;
    const pending = this.controller.approvals?.pending ?? [];
    for (const approval of [...pending]) {
      this.controller.approvals.removeWithoutResponse(approval.id);
    }
    try {
      this.controller.persistState?.();
      this.controller.publishState?.();
    } catch {}

    await new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    this.server = null;
    // Routine hooks were answered before ingestion: drain them before the final checkpoint.
    await this.hookWork;
    try {
      this.controller.persistState?.();
      this.controller.publishState?.();
    } catch {}
  }
}
