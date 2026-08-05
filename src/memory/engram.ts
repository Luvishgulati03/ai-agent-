import fs from "node:fs/promises";
import path from "node:path";
import { Engram } from "engram-memory";
import type { GraphExport, RecallResult } from "engram-memory";
import type { LavuConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";

export class LavuMemory {
  readonly engine: Engram;

  constructor(private readonly config: LavuConfig, private readonly activity: ActivityLog) {
    this.engine = new Engram({ dbPath: config.dbPath, defaultK: 8 });
  }

  async init(): Promise<void> {
    await fs.mkdir(this.config.memoryDir, { recursive: true });
    await fs.mkdir(this.config.capturedMemoryDir, { recursive: true });
    await fs.mkdir(this.config.dataDir, { recursive: true });
    await this.engine.indexDirectory(this.config.memoryDir, { incremental: true });
  }

  async recall(query: string, k = 8): Promise<RecallResult[]> {
    const results = await this.engine.recall(query, {
      k, associative: true, markUsed: true, reinforce: true,
    });
    await this.activity.record("memory.recalled", `Recalled ${results.length} memories`, { query, results: results.map((r) => ({ id: r.id, why: r.why })) });
    return results;
  }

  async context(query: string, k = 8): Promise<string> {
    return this.engine.toContextBlock(await this.recall(query, k));
  }

  async remember(content: string, input: { source?: string; tier?: string; importance?: number; metadata?: Record<string, unknown> } = {}): Promise<string> {
    const now = new Date();
    const fileName = `${now.toISOString().replace(/[:.]/g, "-")}-${content.slice(0, 32).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase() || "memory"}.md`;
    const source = input.source || path.join("captured", fileName);
    const absolute = path.join(this.config.memoryDir, source);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const frontmatter = [
      "---", `title: ${JSON.stringify(content.slice(0, 80))}`, `created: ${now.toISOString()}`,
      `tier: ${input.tier || "episodic"}`, `importance: ${input.importance ?? 6}`, "---", "",
    ].join("\n");
    let exists = false;
    try { await fs.access(absolute); exists = true; } catch { exists = false; }
    if (exists) {
      await fs.appendFile(absolute, `\n## ${now.toISOString()}\n\n${content.trim()}\n`, "utf8");
    } else {
      await fs.writeFile(absolute, `${frontmatter}${content.trim()}\n`, "utf8");
    }
    const id = await this.engine.add({
      content: content.trim(), source, tier: input.tier || "episodic",
      importance: input.importance ?? 6, metadata: input.metadata || null,
    });
    await this.activity.record("memory.saved", `Saved memory ${id}`, { id, source, content: content.slice(0, 240) });
    return id;
  }

  async index(fresh = false): Promise<unknown> {
    const result = await this.engine.indexDirectory(this.config.memoryDir, { incremental: !fresh, fresh });
    await this.activity.record("memory.saved", `Indexed memory directory (${result.memories} memories)`, { result });
    return result;
  }

  graph(): GraphExport { return this.engine.graphExport(); }

  async dream(): Promise<unknown> {
    const result = this.engine.dream({ consolidate: false });
    await this.activity.record("workflow.completed", "Engram dream completed", { result });
    return result;
  }

  close(): void { this.engine.close(); }
}
