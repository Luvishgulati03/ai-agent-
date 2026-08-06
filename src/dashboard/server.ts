import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DASHBOARD_HTML } from "./page.ts";
import { KnowledgeBase } from "../knowledge/store.ts";
import { sampleResources } from "./resources.ts";
import { sharedAdmissionController } from "../orchestration/admission.ts";
import type { HenryRuntime } from "../runtime.ts";
import type { ActivityEvent } from "../types.ts";

const EVENTS_POLL_MS = 2000;

function sseWrite(response: http.ServerResponse, event: string, data: unknown): void {
  if (response.writableEnded) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Lazily constructed and cached: constructing KnowledgeBase is cheap (the local
// embedding model is lazy-loaded on first `embed()` call, not on construction —
// see src/embeddings.ts), but `engine.stats()` runs several synchronous
// better-sqlite3 queries (COUNT/GROUP BY over the whole table) that measured
// ~300-400ms cold on a ~19k-row knowledge.db and ~1-2ms once the SQLite page
// cache is warm. better-sqlite3 is synchronous, so that first call blocks the
// whole Node event loop — starving every other in-flight request (including
// /api/status and the SSE handshake) for its duration. To keep /api/knowledge
// off the hot path we never do this work inline on a request: the first
// request kicks off construction+stats() in the background via setImmediate
// (so it runs after the current response is flushed) and replies
// {loading:true} immediately; once the background job finishes, the computed
// stats are cached and every subsequent request (including later polls of the
// same loading request) returns them instantly.
let knowledgeBaseCache: KnowledgeBase | null = null;
let knowledgeStatsCache: Record<string, unknown> | null = null;
let knowledgeStatsError: string | null = null;
let knowledgeInitStarted = false;

function startKnowledgeInit(runtime: HenryRuntime): void {
  if (knowledgeInitStarted) return;
  knowledgeInitStarted = true;
  setImmediate(() => {
    try {
      knowledgeBaseCache ||= new KnowledgeBase(runtime.config);
      knowledgeStatsCache = knowledgeBaseCache.stats();
      knowledgeStatsError = null;
    } catch (error) {
      knowledgeStatsError = error instanceof Error ? error.message : String(error);
    } finally {
      // Allow a later retry (e.g. db appeared after a failed access check).
      if (knowledgeStatsError) knowledgeInitStarted = false;
    }
  });
}

// The Memory Observatory is a ~2k-line designer-authored page. It is served
// from disk rather than embedded in page.ts's template literal: that literal
// already produced a page-killing escaping bug once, and a standalone .html
// keeps backticks/${...}/backslashes in the designer's markup harmless. Read
// once, then cached for the process lifetime (the file never changes at run
// time); a read failure is not cached, so a fixed file recovers on next hit.
const OBSERVATORY_HTML_PATH = fileURLToPath(new URL("./observatory.html", import.meta.url));
let observatoryHtmlCache: string | null = null;

async function observatoryHtml(): Promise<string> {
  observatoryHtmlCache ??= await fs.readFile(OBSERVATORY_HTML_PATH, "utf8");
  return observatoryHtmlCache;
}

// The holographic memory display is hand-rolled 3D canvas code. Same reasoning
// as the observatory above: it ships as a plain .js asset instead of living
// inside page.ts's template literal, where backticks/${...}/backslashes would
// be a live escaping hazard. Cached for the process lifetime; failures are not
// cached so a fixed file recovers on the next request.
const HOLO_JS_PATH = fileURLToPath(new URL("./holo.js", import.meta.url));
let holoJsCache: string | null = null;

async function holoJs(): Promise<string> {
  holoJsCache ??= await fs.readFile(HOLO_JS_PATH, "utf8");
  return holoJsCache;
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function body(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 256_000) throw new Error("request body too large");
  }
  try { return JSON.parse(raw || "{}") as Record<string, unknown>; } catch { throw new Error("Invalid JSON body"); }
}

function localOrigin(request: http.IncomingMessage): boolean {
  const origin = request.headers.origin;
  return !origin || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
}

function loopback(host: string): boolean { return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]"; }

function authorized(request: http.IncomingMessage, runtime: HenryRuntime): boolean {
  if (loopback(runtime.config.host)) return true;
  if (!runtime.config.allowRemoteDashboard || !runtime.config.dashboardToken) return false;
  const authorization = request.headers.authorization || "";
  return authorization === `Bearer ${runtime.config.dashboardToken}` || request.headers["x-henry-token"] === runtime.config.dashboardToken;
}

export function startDashboard(runtime: HenryRuntime): http.Server {
  if (!loopback(runtime.config.host) && (!runtime.config.allowRemoteDashboard || !runtime.config.dashboardToken)) {
    throw new Error("Remote dashboard is disabled; bind HENRY_HOST to loopback or configure HENRY_ALLOW_REMOTE_DASHBOARD=true with HENRY_DASHBOARD_TOKEN");
  }
  const server = http.createServer(async (request, response) => {
    try {
      if (!loopback(runtime.config.host) && !runtime.config.allowRemoteDashboard) throw new Error("Remote dashboard is disabled; bind HENRY_HOST to loopback or explicitly enable a token-protected remote dashboard");
      if (!authorized(request, runtime)) { json(response, 401, { error: "dashboard authentication required" }); return; }
      const url = new URL(request.url || "/", `http://${runtime.config.host}:${runtime.config.port}`);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(DASHBOARD_HTML); return;
      }
      if (request.method === "GET" && (url.pathname === "/memory" || url.pathname === "/memory/")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(await observatoryHtml());
        return;
      }
      if (request.method === "GET" && url.pathname === "/holo.js") {
        response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
        response.end(await holoJs());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") { json(response, 200, { ok: true, timestamp: new Date().toISOString() }); return; }
      if (request.method === "GET" && url.pathname === "/api/status") { json(response, 200, await runtime.status()); return; }
      if (request.method === "GET" && url.pathname === "/api/activity") { json(response, 200, await runtime.activity.list(Number(url.searchParams.get("limit")) || 100)); return; }
      if (request.method === "GET" && url.pathname === "/api/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          "connection": "keep-alive",
        });
        sseWrite(response, "hello", { timestamp: new Date().toISOString() });

        let lastSeenId: string | null = null;

        const tick = async (): Promise<void> => {
          if (response.writableEnded) return;
          let events: ActivityEvent[] = [];
          try { events = await runtime.activity.list(20); } catch { /* activity log hiccup; skip this tick's diff */ }
          if (events.length) {
            const chronological = [...events].reverse(); // oldest -> newest
            const startIndex = lastSeenId ? chronological.findIndex((event) => event.id === lastSeenId) + 1 : 0;
            for (const event of chronological.slice(startIndex)) sseWrite(response, "activity", event);
            lastSeenId = chronological[chronological.length - 1].id;
          }
          try {
            const resources = await sampleResources();
            const pending = await runtime.approvals.list("pending").catch(() => []);
            const admission = sharedAdmissionController().snapshot();
            const lastActivityAt = events[0]?.timestamp ?? null;
            const lastActivityAgeSec = lastActivityAt
              ? Math.max(0, Math.round((Date.now() - new Date(lastActivityAt).getTime()) / 1000))
              : null;
            sseWrite(response, "resources", {
              ...resources,
              agentState: {
                state: admission.running > 0 ? "working" : "idle",
                running: admission.running,
                heavy: admission.heavyRunning,
                queued: admission.queued,
              },
              heartbeat: {
                uptimeSec: Math.round(process.uptime()),
                lastActivityAt,
                lastActivityAgeSec,
                pendingApprovals: pending.length,
              },
            });
          } catch { /* resource sampling hiccup; skip this tick's resources push */ }
        };

        await tick();
        const interval = setInterval(() => { void tick(); }, EVENTS_POLL_MS);
        request.on("close", () => clearInterval(interval));
        response.on("close", () => clearInterval(interval));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/approvals") { json(response, 200, await runtime.approvals.list()); return; }
      if (request.method === "GET" && url.pathname === "/api/workflows") { json(response, 200, await runtime.scheduler.definitions()); return; }
      if (request.method === "GET" && url.pathname === "/api/jobs") {
        json(response, 200, { summary: await runtime.jobs.store.summary(), applications: await runtime.jobs.store.list() }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/settings") { json(response, 200, { provider: runtime.config.provider }); return; }
      if (request.method === "GET" && url.pathname === "/api/knowledge") {
        if (knowledgeStatsCache) { json(response, 200, { stats: knowledgeStatsCache }); return; }
        if (knowledgeStatsError) { json(response, 200, { stats: null, error: knowledgeStatsError }); return; }
        try {
          await fs.access(runtime.config.knowledgeDbPath);
        } catch (error) {
          json(response, 200, { stats: null, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        startKnowledgeInit(runtime);
        json(response, 200, { stats: null, loading: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/covers") {
        const dir = path.join(runtime.config.dataDir, "cover-letters");
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          const files = await Promise.all(
            entries.filter((entry) => entry.isFile()).map(async (entry) => {
              const stat = await fs.stat(path.join(dir, entry.name));
              return { name: entry.name, size: stat.size, mtime: stat.mtime.toISOString() };
            }),
          );
          files.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));
          json(response, 200, files);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") { json(response, 200, []); return; }
          throw error;
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/memory/graph") { json(response, 200, runtime.memory.graph()); return; }
      if (request.method === "GET" && url.pathname === "/api/memory/recall") {
        const query = url.searchParams.get("q") || "";
        if (!query) { json(response, 400, { error: "q is required" }); return; }
        json(response, 200, await runtime.memory.recall(query)); return;
      }
      if (!localOrigin(request)) { json(response, 403, { error: "cross-origin request rejected" }); return; }
      if (request.method === "POST" && url.pathname === "/api/settings/provider") {
        const input = await body(request);
        json(response, 200, { provider: await runtime.setProvider(String(input.provider) as "codex" | "claude") }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/ask") {
        const input = await body(request); const prompt = String(input.prompt || "");
        if (!prompt) { json(response, 400, { error: "prompt is required" }); return; }
        json(response, 200, await runtime.agent.run(prompt)); return;
      }
      if (request.method === "POST" && url.pathname === "/api/dispatch") {
        const input = await body(request); const role = String(input.role || "architect"); const task = String(input.task || "");
        if (!task) { json(response, 400, { error: "task is required" }); return; }
        json(response, 200, await runtime.luna.dispatch(role, task, { allowEdits: input.allowEdits === true })); return;
      }
      const approval = url.pathname.match(/^\/api\/approvals\/([^/]+)\/(approve|execute)$/);
      if (request.method === "POST" && approval) {
        const id = decodeURIComponent(approval[1]);
        if (approval[2] === "approve") { await runtime.approve(id); json(response, 200, { ok: true }); return; }
        json(response, 200, { ok: true, result: await runtime.executeApproval(id) }); return;
      }
      json(response, 404, { error: "not found" });
    } catch (error) { json(response, 500, { error: error instanceof Error ? error.message : String(error) }); }
  });
  server.listen(runtime.config.port, runtime.config.host);
  return server;
}
