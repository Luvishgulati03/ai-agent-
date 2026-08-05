import http from "node:http";
import { DASHBOARD_HTML } from "./page.ts";
import type { LavuRuntime } from "../runtime.ts";

function json(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function body(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  try { return JSON.parse(raw || "{}") as Record<string, unknown>; } catch { throw new Error("Invalid JSON body"); }
}

function localOrigin(request: http.IncomingMessage): boolean {
  const origin = request.headers.origin;
  return !origin || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
}

export function startDashboard(runtime: LavuRuntime): http.Server {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${runtime.config.host}:${runtime.config.port}`);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(DASHBOARD_HTML); return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") { json(response, 200, { ok: true, timestamp: new Date().toISOString() }); return; }
      if (request.method === "GET" && url.pathname === "/api/status") { json(response, 200, await runtime.status()); return; }
      if (request.method === "GET" && url.pathname === "/api/activity") { json(response, 200, await runtime.activity.list(Number(url.searchParams.get("limit")) || 100)); return; }
      if (request.method === "GET" && url.pathname === "/api/approvals") { json(response, 200, await runtime.approvals.list()); return; }
      if (request.method === "GET" && url.pathname === "/api/workflows") { json(response, 200, await runtime.scheduler.definitions()); return; }
      if (request.method === "GET" && url.pathname === "/api/memory/graph") { json(response, 200, runtime.memory.graph()); return; }
      if (request.method === "GET" && url.pathname === "/api/memory/recall") {
        const query = url.searchParams.get("q") || "";
        if (!query) { json(response, 400, { error: "q is required" }); return; }
        json(response, 200, await runtime.memory.recall(query)); return;
      }
      if (!localOrigin(request)) { json(response, 403, { error: "cross-origin request rejected" }); return; }
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
