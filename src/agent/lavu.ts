import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { LavuConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { LavuMemory } from "../memory/engram.ts";
import { ProviderRunner, type RunOptions } from "../providers/runner.ts";

async function readText(path: string): Promise<string> {
  try { return await fs.readFile(path, "utf8"); } catch { return ""; }
}

export class LavuAgent {
  private readonly runner: ProviderRunner;

  constructor(
    private readonly config: LavuConfig,
    private readonly activity: ActivityLog,
    private readonly memory: LavuMemory,
  ) { this.runner = new ProviderRunner(config, activity); }

  async run(prompt: string, options: RunOptions = {}): Promise<Awaited<ReturnType<ProviderRunner["run"]>>> {
    const runId = randomUUID();
    const persona = await readText(`${this.config.rootDir}/personality.md`);
    const instructions = await readText(`${this.config.rootDir}/AGENTS.md`);
    let context = "No relevant memories were recalled.";
    try { context = await this.memory.context(prompt, 8) || context; } catch (error) {
      await this.activity.record("run.failed", "Memory recall failed; continuing without memory", { error: String(error) }, { runId });
    }
    const fullPrompt = [
      "You are Lavu, Luvish Junior, a terminal-first personal engineering agent.",
      "Call the user Dad. Luna is the top-level orchestrator and may delegate specialist work to you.",
      "Never send or post an outbound message without explicit Dad approval. Draft it, save it, and surface it instead.",
      "Investigate briefly before asking a question. Be kind, sarcastic, appealing, and useful.",
      "\n--- personality.md ---\n", persona,
      "\n--- AGENTS.md ---\n", instructions,
      "\n--- recalled Engram context ---\n", context,
      "\n--- Dad's request ---\n", prompt,
      "\nReturn a clear answer and state any action that was intentionally staged for approval.",
    ].join("\n");
    const result = await this.runner.run(fullPrompt, { ...options, onEvent: (event) => options.onEvent?.(event) });
    if (result.response.trim()) {
      await this.memory.remember(`Dad asked: ${prompt}\n\nLavu answered:\n${result.response}`, {
        source: `captured/${new Date().toISOString().slice(0, 10)}-conversation.md`,
        tier: "episodic", importance: 5, metadata: { runId, provider: result.provider },
      });
    }
    return result;
  }

  get providerRunner(): ProviderRunner { return this.runner; }
}
