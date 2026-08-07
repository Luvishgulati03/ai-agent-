import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DASHBOARD_HTML } from "./page.ts";
import { KnowledgeBase } from "../knowledge/store.ts";
import { sampleResources } from "./resources.ts";
import { sharedAdmissionController } from "../orchestration/admission.ts";
import type { HenryRuntime } from "../runtime.ts";
import type { ActivityEvent, ProviderName } from "../types.ts";

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

// Distillation progress (dashboard-design-v2.md §B3): knowledge/cards/.distilled.json
// lists already-distilled module keys; knowledge/raw/chunks.jsonl's distinct
// module_id values are the population that could be distilled (mirrors, read-only,
// the pending-set src/knowledge/ingest.ts#distillCards derives from — this file never
// writes to either path). chunks.jsonl runs ~12MB/5k lines, so — same reasoning as
// the knowledge-stats cache above — it is read once in the background via
// setImmediate and cached rather than inline on a request.
let distillationCache: { distilled: number; totalModules: number } | null = null;
let distillationError: string | null = null;
let distillationInitStarted = false;

function startDistillationInit(runtime: HenryRuntime): void {
  if (distillationInitStarted) return;
  distillationInitStarted = true;
  setImmediate(async () => {
    try {
      const cardsDir = path.join(runtime.config.knowledgeDir, "cards");
      const rawDir = path.join(runtime.config.knowledgeDir, "raw");
      const distilledRaw = await fs.readFile(path.join(cardsDir, ".distilled.json"), "utf8");
      const distilledIds: unknown = JSON.parse(distilledRaw);
      const distilled = Array.isArray(distilledIds) ? distilledIds.length : 0;
      const chunksRaw = await fs.readFile(path.join(rawDir, "chunks.jsonl"), "utf8");
      const modules = new Set<string>();
      const moduleIdPattern = /"module_id"\s*:\s*"([^"]*)"/;
      for (const line of chunksRaw.split("\n")) {
        const match = moduleIdPattern.exec(line);
        if (match?.[1]) modules.add(match[1]);
      }
      distillationCache = { distilled, totalModules: modules.size };
      distillationError = null;
    } catch (error) {
      distillationError = error instanceof Error ? error.message : String(error);
    } finally {
      if (distillationError) distillationInitStarted = false;
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

// GET /api/engram/metrics wraps src/metrics/recall-metrics.ts#summarizeRecallMetrics —
// a module owned elsewhere (dashboard-design-v2.md §C). The field list is declared
// locally (the exact contract, nothing beyond it) rather than imported, and the
// module is loaded through a non-literal specifier so tsc never has to resolve it
// statically: this endpoint verifies and fails soft to {available:false} whether
// or not src/metrics/** has landed yet (module-doctrine.md rule 6).
interface EngramMetricsSummary {
  totalAttempts: number | null;
  engineFailures: number | null;
  healthyAttempts: number | null;
  recallCoverage: number | null;
  zeroResultRate: number | null;
  avgReturned: number | null;
  failureRate: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  byStore: unknown;
  indexFreshness: unknown;
  windowDays: number | null;
}

const RECALL_METRICS_MODULE_SPECIFIER = "../metrics/recall-metrics.ts";

async function engramMetricsSummary(runtime: HenryRuntime): Promise<{ available: boolean } & Partial<EngramMetricsSummary>> {
  try {
    const mod = (await import(RECALL_METRICS_MODULE_SPECIFIER)) as {
      summarizeRecallMetrics?: (config: HenryRuntime["config"], windowDays?: number) => Promise<EngramMetricsSummary>;
    };
    if (typeof mod.summarizeRecallMetrics !== "function") return { available: false };
    const summary = await mod.summarizeRecallMetrics(runtime.config);
    return { available: true, ...summary };
  } catch {
    return { available: false };
  }
}

const AUTH_ALERT_WINDOW_MS = 10 * 60 * 1000;

/** Most recent provider auth failure in `events` (newest-first, per ActivityLog#list), or null. Powers §B1's re-login banner. */
function scanAuthAlert(events: ActivityEvent[]): { provider: ProviderName; at: string } | null {
  const cutoff = Date.now() - AUTH_ALERT_WINDOW_MS;
  for (const event of events) {
    if (event.kind !== "run.failed" || !event.provider) continue;
    if (event.metadata?.authFailure !== true) continue;
    const at = new Date(event.timestamp).getTime();
    if (!Number.isFinite(at) || at < cutoff) continue;
    return { provider: event.provider, at: event.timestamp };
  }
  return null;
}

const RELOGIN_COMMANDS: Record<ProviderName, string> = { codex: "codex login", claude: "claude" };

/**
 * Opens Terminal pre-typed with the provider's login command (§B1). Args are
 * passed as an array (spawn, not a shell string) and the AppleScript string
 * literal is built via JSON.stringify — same quoting idiom as the existing
 * osascript call in src/reminders/service.ts.
 */
function relogin(provider: ProviderName): Promise<void> {
  const command = RELOGIN_COMMANDS[provider];
  const script = `tell application "Terminal" to do script ${JSON.stringify(command)}\ntell application "Terminal" to activate`;
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`osascript exited ${code}`))));
  });
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
          // 40 (not 20): also the scan window for scanAuthAlert's 10-minute lookback below.
          try { events = await runtime.activity.list(40); } catch { /* activity log hiccup; skip this tick's diff */ }
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
              authAlert: scanAuthAlert(events),
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
        startDistillationInit(runtime);
        const distillation = distillationCache ?? (distillationError ? { error: distillationError } : { loading: true });
        if (knowledgeStatsCache) { json(response, 200, { stats: knowledgeStatsCache, distillation }); return; }
        if (knowledgeStatsError) { json(response, 200, { stats: null, error: knowledgeStatsError, distillation }); return; }
        try {
          await fs.access(runtime.config.knowledgeDbPath);
        } catch (error) {
          json(response, 200, { stats: null, error: error instanceof Error ? error.message : String(error), distillation });
          return;
        }
        startKnowledgeInit(runtime);
        json(response, 200, { stats: null, loading: true, distillation });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/engram/metrics") {
        json(response, 200, await engramMetricsSummary(runtime)); return;
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
      if (request.method === "POST" && url.pathname === "/api/engram/recall") {
        const input = await body(request);
        const query = String(input.query || "").trim();
        if (!query) { json(response, 400, { error: "query is required" }); return; }
        const store = input.store === "knowledge" ? "knowledge" : "personal";
        const k = Math.min(50, Math.max(1, Math.trunc(Number(input.k)) || 8));
        const startedAt = Date.now();
        // Read-only lab recall: bypass HenryMemory/KnowledgeBase's recall() wrappers (which
        // mark-used + reinforce on every call) and hit the engine directly with those signals
        // off, exactly like runtime.memory.recall does for the real path minus the side effects.
        const engine = store === "knowledge" ? runtime.knowledge.engine : runtime.memory.engine;
        try {
          const trace = await engine.recallTrace(query, { k, associative: true, markUsed: false, reinforce: false });
          json(response, 200, {
            results: trace.results.map((result) => ({
              id: result.id,
              content: result.content.slice(0, 300),
              source: result.source,
              tier: result.tier,
              score: result.score,
              why: result.why,
            })),
            activation: {
              seeds: trace.trace.seeds.map((seed) => seed.id),
              activated: trace.trace.activations.map((activation) => activation.id),
            },
            latencyMs: Date.now() - startedAt,
          });
        } catch (error) {
          json(response, 200, {
            results: [],
            activation: { seeds: [], activated: [] },
            latencyMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/relogin") {
        const input = await body(request);
        const provider = input.provider === "codex" || input.provider === "claude" ? input.provider : null;
        if (!provider) { json(response, 400, { error: 'provider must be "codex" or "claude"' }); return; }
        try {
          await relogin(provider);
          json(response, 200, { ok: true, provider });
        } catch (error) {
          json(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
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
