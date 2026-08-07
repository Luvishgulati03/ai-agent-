import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { HenryConfig } from "../config.ts";

/**
 * Recall measurement layer (docs/dashboard-design-v2.md §C). Every recall attempt across both
 * stores (personal Engram + knowledge base) emits one `RecallEvent` to a local, append-only
 * JSONL log; `summarizeRecallMetrics` aggregates that log into the numbers the mission-control
 * memory-health strip (§B2) and a future `/api/engram/metrics` route read. Local-only. Never
 * stores raw query text for the personal store — only a short hash (queryHash).
 */
export interface RecallEvent {
  ts: string;
  store: "personal" | "knowledge";
  queryHash: string;
  k: number;
  results: number;
  topScore: number | null;
  latencyMs: number;
  engineError?: string;
}

function eventsPath(config: HenryConfig): string {
  return path.join(config.metricsDir, "recall-events.jsonl");
}

/** sha256 of the query, first 12 hex chars — enough to dedupe/correlate without storing raw text. */
export function hashQuery(query: string): string {
  return createHash("sha256").update(query).digest("hex").slice(0, 12);
}

/**
 * Appends one recall event to `data/metrics/recall-events.jsonl`. Fire-and-forget by design: a
 * metrics write must never be the reason a recall call fails (fail-open, module-doctrine #6),
 * so this returns synchronously and swallows every error itself, including from the background
 * write.
 */
export function recordRecallEvent(config: HenryConfig, event: RecallEvent): void {
  try {
    const line = `${JSON.stringify(event)}\n`;
    void fs.mkdir(config.metricsDir, { recursive: true, mode: 0o700 })
      .then(() => fs.appendFile(eventsPath(config), line, "utf8"))
      .catch(() => undefined);
  } catch {
    // Never throw — a metrics failure must never break a recall call.
  }
}

export interface MetricsSummary {
  totalAttempts: number;
  engineFailures: number;
  healthyAttempts: number;
  recallCoverage: number | null;
  zeroResultRate: number | null;
  avgReturned: number | null;
  failureRate: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  byStore: Record<string, { attempts: number; coverage: number | null }>;
  indexFreshness: { personal: string | null; knowledge: string | null };
  windowDays: number;
}

/** Tolerant JSONL reader: a missing file reads as no events; malformed/short-shaped lines are skipped, never fatal. */
async function readEvents(config: HenryConfig): Promise<RecallEvent[]> {
  const raw = await fs.readFile(eventsPath(config), "utf8").catch(() => "");
  const events: RecallEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<RecallEvent>;
      const validShape = typeof parsed.ts === "string" && !Number.isNaN(Date.parse(parsed.ts))
        && (parsed.store === "personal" || parsed.store === "knowledge")
        && typeof parsed.k === "number" && typeof parsed.results === "number" && typeof parsed.latencyMs === "number";
      if (!validShape) continue;
      events.push({
        ts: parsed.ts as string, store: parsed.store as "personal" | "knowledge",
        queryHash: String(parsed.queryHash ?? ""), k: parsed.k as number, results: parsed.results as number,
        topScore: typeof parsed.topScore === "number" ? parsed.topScore : null,
        latencyMs: parsed.latencyMs as number,
        ...(typeof parsed.engineError === "string" ? { engineError: parsed.engineError } : {}),
      });
    } catch {
      continue; // one corrupt line never sinks the whole read
    }
  }
  return events;
}

/** Nearest-rank percentile over an ascending-sorted array (1-indexed rank = ceil(p/100 * n)). */
function percentile(sortedAsc: number[], p: number): number | null {
  if (!sortedAsc.length) return null;
  const rank = Math.min(sortedAsc.length, Math.max(1, Math.ceil((p / 100) * sortedAsc.length)));
  return sortedAsc[rank - 1];
}

async function mtimeIso(filePath: string): Promise<string | null> {
  return fs.stat(filePath).then((stat) => stat.mtime.toISOString()).catch(() => null);
}

/**
 * Aggregates the recall-event log into the Friday-brief metrics (docs/dashboard-design-v2.md §C).
 * Formulas — null (never 0) when their denominator is 0:
 *   healthy        = total - engineFailures
 *   recallCoverage = (healthy attempts with >=1 result) / healthy
 *   zeroResultRate = (healthy attempts with 0 results) / healthy
 *   avgReturned    = sum(results over healthy) / healthy
 *   failureRate    = engineFailures / total
 * Engine failures are never counted as zero-result recalls — they're excluded from the healthy
 * pool entirely before coverage/zeroResultRate/avgReturned/latency percentiles are computed
 * (non-negotiable, per the design doc). p50/p95 run over healthy latencies only.
 */
export async function summarizeRecallMetrics(config: HenryConfig, windowDays = 7): Promise<MetricsSummary> {
  const all = await readEvents(config);
  const since = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const events = all.filter((event) => Date.parse(event.ts) >= since);

  const healthy = events.filter((event) => !event.engineError);
  const engineFailures = events.length - healthy.length;
  const healthyAttempts = healthy.length;
  const withResult = healthy.filter((event) => event.results >= 1).length;
  const zeroResult = healthy.filter((event) => event.results === 0).length;

  const byStore: Record<string, { attempts: number; coverage: number | null }> = {
    personal: { attempts: 0, coverage: null },
    knowledge: { attempts: 0, coverage: null },
  };
  for (const store of new Set(events.map((event) => event.store))) {
    const storeHealthy = events.filter((event) => event.store === store && !event.engineError);
    const storeWithResult = storeHealthy.filter((event) => event.results >= 1).length;
    byStore[store] = {
      attempts: events.filter((event) => event.store === store).length,
      coverage: storeHealthy.length ? storeWithResult / storeHealthy.length : null,
    };
  }

  const latencies = healthy.map((event) => event.latencyMs).sort((a, b) => a - b);

  return {
    totalAttempts: events.length,
    engineFailures,
    healthyAttempts,
    recallCoverage: healthyAttempts ? withResult / healthyAttempts : null,
    zeroResultRate: healthyAttempts ? zeroResult / healthyAttempts : null,
    avgReturned: healthyAttempts ? healthy.reduce((sum, event) => sum + event.results, 0) / healthyAttempts : null,
    failureRate: events.length ? engineFailures / events.length : null,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    byStore,
    indexFreshness: {
      personal: await mtimeIso(config.dbPath),
      knowledge: await mtimeIso(config.knowledgeDbPath),
    },
    windowDays,
  };
}
