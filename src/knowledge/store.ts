import { mkdirSync } from "node:fs";
import path from "node:path";
import { Engram } from "engram-memory";
import type { RecallResult } from "engram-memory";
import type { HenryConfig } from "../config.ts";
import { LocalEmbeddingProvider } from "../embeddings.ts";
import { hashQuery, recordRecallEvent } from "../metrics/recall-metrics.ts";

export const KNOWLEDGE_DOMAINS = [
  "gtm", "growth-strategy", "product-management", "software-development",
  "community", "sales", "careers", "general",
] as const;
export type KnowledgeDomain = (typeof KNOWLEDGE_DOMAINS)[number];

export interface KnowledgeEntry {
  content: string;
  source: string;
  metadata: Record<string, unknown>;
  importance?: number;
}

/**
 * The curated domain-knowledge index (GrowthX Learn + future sources).
 * Separate from personal memory by design: versioned, source-attributed,
 * no decay/supersede lifecycle, injected on demand rather than every turn.
 * Proprietary content — knowledge/ and data/knowledge.db never leave this machine.
 */
export class KnowledgeBase {
  readonly engine: Engram;

  constructor(private readonly config: HenryConfig) {
    mkdirSync(path.dirname(config.knowledgeDbPath), { recursive: true, mode: 0o700 });
    this.engine = new Engram({ dbPath: config.knowledgeDbPath, defaultK: 8, embedding: new LocalEmbeddingProvider() });
  }

  async add(entry: KnowledgeEntry): Promise<string> {
    return this.engine.add({
      content: entry.content, source: entry.source, tier: "semantic",
      importance: entry.importance ?? 6, metadata: entry.metadata,
    });
  }

  /**
   * Cards outrank raw chunks; a domain filter narrows recall when the task declares one.
   * LX-RAG-proven rules: score threshold beats pure top-K (kills false positives),
   * and capping results per module keeps the context diverse.
   */
  async recall(query: string, options: { k?: number; domain?: string; layer?: "card" | "raw"; minScore?: number; markUsed?: boolean; reinforce?: boolean } = {}): Promise<RecallResult[]> {
    const k = options.k ?? 8;
    // Engram's fused hybrid scores live in a small range; 0.02 is the empirical noise floor.
    const minScore = options.minScore ?? 0.02;
    const startedAt = Date.now();
    const base = { ts: new Date().toISOString(), store: "knowledge" as const, queryHash: hashQuery(query), k };
    // Both default true (unchanged behavior for every existing caller). Read-only callers —
    // the eval harness, a future recall-lab preview — pass both false so grading/browsing never
    // distorts salience.
    const results = await this.engine.recall(query, { k: k * 4, associative: true, markUsed: options.markUsed ?? true, reinforce: options.reinforce ?? true })
      .catch((error) => {
        recordRecallEvent(this.config, { ...base, results: 0, topScore: null, latencyMs: Date.now() - startedAt, engineError: error instanceof Error ? error.message : String(error) });
        throw error;
      });
    // LX-RAG lesson: a declared domain BOOSTS ranking but never hard-filters —
    // hard domain filters create blind spots (community content answering a GTM query).
    const boosted = options.domain
      ? results.map((result) => {
          const meta = (result.metadata || {}) as Record<string, unknown>;
          return meta.domain === options.domain ? { ...result, score: result.score * 1.5 } : result;
        }).sort((a, b) => b.score - a.score)
      : results;
    const perModule = new Map<string, number>();
    const filtered = boosted.filter((result) => {
      const meta = (result.metadata || {}) as Record<string, unknown>;
      if (result.score < minScore) return false;
      if (options.layer && meta.layer !== options.layer) return false;
      const moduleKey = String(meta.moduleId || meta.module || result.source);
      const seen = perModule.get(moduleKey) || 0;
      if (seen >= 2) return false;
      perModule.set(moduleKey, seen + 1);
      return true;
    });
    const cards = filtered.filter((r) => (r.metadata as Record<string, unknown> | null)?.layer === "card");
    const raw = filtered.filter((r) => (r.metadata as Record<string, unknown> | null)?.layer !== "card");
    const final = [...cards, ...raw].slice(0, k);
    recordRecallEvent(this.config, { ...base, results: final.length, topScore: final[0]?.score ?? null, latencyMs: Date.now() - startedAt });
    return final;
  }

  /** Labeled context block so the model treats this as tried-and-tested practice, not general knowledge. */
  async context(query: string, options: { k?: number; domain?: string; budgetChars?: number } = {}): Promise<string> {
    const results = await this.recall(query, options);
    if (!results.length) return "";
    const budget = options.budgetChars ?? 8000;
    const lines: string[] = ["--- GrowthX knowledge (tried & tested founder playbooks) ---"];
    let used = 0;
    for (const result of results) {
      const meta = (result.metadata || {}) as Record<string, unknown>;
      const header = `[${meta.domain || "general"} · ${meta.module || result.source}]`;
      const chunk = `${header}\n${result.content.trim()}`;
      if (used + chunk.length > budget) break;
      lines.push(chunk);
      used += chunk.length;
    }
    return lines.join("\n\n");
  }

  stats(): Record<string, unknown> { return this.engine.stats() as unknown as Record<string, unknown>; }
  close(): void { this.engine.close(); }
}
