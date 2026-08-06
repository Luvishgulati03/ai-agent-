import { mkdirSync } from "node:fs";
import path from "node:path";
import { Engram } from "engram-memory";
import type { RecallResult } from "engram-memory";
import type { HenryConfig } from "../config.ts";
import { LocalEmbeddingProvider } from "./embeddings.ts";

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
  async recall(query: string, options: { k?: number; domain?: string; layer?: "card" | "raw"; minScore?: number } = {}): Promise<RecallResult[]> {
    const k = options.k ?? 8;
    const minScore = options.minScore ?? 0.05;
    const results = await this.engine.recall(query, { k: k * 3, associative: true, markUsed: true, reinforce: true });
    const perModule = new Map<string, number>();
    const filtered = results.filter((result) => {
      const meta = (result.metadata || {}) as Record<string, unknown>;
      if (result.score < minScore) return false;
      if (options.domain && meta.domain !== options.domain) return false;
      if (options.layer && meta.layer !== options.layer) return false;
      const moduleKey = String(meta.moduleId || meta.module || result.source);
      const seen = perModule.get(moduleKey) || 0;
      if (seen >= 2) return false;
      perModule.set(moduleKey, seen + 1);
      return true;
    });
    const cards = filtered.filter((r) => (r.metadata as Record<string, unknown> | null)?.layer === "card");
    const raw = filtered.filter((r) => (r.metadata as Record<string, unknown> | null)?.layer !== "card");
    return [...cards, ...raw].slice(0, k);
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
