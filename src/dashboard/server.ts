import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { DASHBOARD_HTML } from "./page.ts";
import { KnowledgeBase } from "../knowledge/store.ts";
import type { HenryRuntime } from "../runtime.ts";

// Lazily constructed and cached: KnowledgeBase loads a local embedding model on
// construction, so it must be created at most once for the life of the process,
// never per-request.
let knowledgeBaseCache: KnowledgeBase | null = null;

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
      if (request.method === "GET" && url.pathname === "/api/health") { json(response, 200, { ok: true, timestamp: new Date().toISOString() }); return; }
      if (request.method === "GET" && url.pathname === "/api/status") { json(response, 200, await runtime.status()); return; }
      if (request.method === "GET" && url.pathname === "/api/activity") { json(response, 200, await runtime.activity.list(Number(url.searchParams.get("limit")) || 100)); return; }
      if (request.method === "GET" && url.pathname === "/api/approvals") { json(response, 200, await runtime.approvals.list()); return; }
      if (request.method === "GET" && url.pathname === "/api/workflows") { json(response, 200, await runtime.scheduler.definitions()); return; }
      if (request.method === "GET" && url.pathname === "/api/jobs") {
        json(response, 200, { summary: await runtime.jobs.store.summary(), applications: await runtime.jobs.store.list() }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/settings") { json(response, 200, { provider: runtime.config.provider }); return; }
      if (request.method === "GET" && url.pathname === "/api/knowledge") {
        try {
          await fs.access(runtime.config.knowledgeDbPath);
          knowledgeBaseCache ||= new KnowledgeBase(runtime.config);
          json(response, 200, { stats: knowledgeBaseCache.stats() });
        } catch (error) {
          json(response, 200, { stats: null, error: error instanceof Error ? error.message : String(error) });
        }
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
