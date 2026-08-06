import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { HenryMemory } from "../memory/engram.ts";
import type { KnowledgeBase } from "../knowledge/store.ts";
import { detectKnowledgeDomain } from "../knowledge/router.ts";
import { ProviderRunner, type RunOptions } from "../providers/runner.ts";
import { redactSecrets } from "../util/env.ts";
import { OUTBOUND_EMAIL_APPROVAL_GUARDRAIL } from "../guardrails.ts";

async function readText(path: string): Promise<string> {
  try { return await fs.readFile(path, "utf8"); } catch { return ""; }
}

export class HenryAgent {
  private readonly runner: ProviderRunner;

  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly memory: HenryMemory,
    // Lazy provider (not the instance itself) so a plain HenryAgent construction
    // never forces the knowledge DB open; runtime.ts wires this to its lazy accessor.
    private readonly knowledgeProvider?: () => KnowledgeBase,
  ) { this.runner = new ProviderRunner(config, activity); }

  /** Assembles the full provider prompt without invoking the provider — the testable seam. */
  async buildPrompt(prompt: string, runId: string): Promise<string> {
    const soul = await readText(`${this.config.rootDir}/soul.md`);
    const persona = await readText(`${this.config.rootDir}/personality.md`);
    const instructions = await readText(`${this.config.rootDir}/AGENTS.md`);
    let context = "No relevant memories were recalled.";
    try { context = await this.memory.context(prompt, 8) || context; } catch (error) {
      await this.activity.record("run.failed", "Memory recall failed; continuing without memory", { error: String(error) }, { runId });
    }
    let knowledgeBlock = "";
    const domain = detectKnowledgeDomain(prompt);
    if (domain && this.knowledgeProvider) {
      try { knowledgeBlock = await this.knowledgeProvider().context(prompt, { domain, budgetChars: 6000 }); } catch (error) {
        await this.activity.record("run.failed", "Knowledge recall failed; continuing without it", { error: String(error) }, { runId });
      }
    }
    return [
      "You are Henry, Luvish Junior, a terminal-first personal engineering agent.",
      "Call the user Dad. Luna is the top-level orchestrator and may delegate specialist work to you.",
      OUTBOUND_EMAIL_APPROVAL_GUARDRAIL,
      "The approval and execution steps are separate. Never approve an action on Dad's behalf, and never treat a send command as approval.",
      "Investigate briefly before asking a question. Be kind, sarcastic, appealing, and useful.",
      "\n--- soul.md (non-negotiable operating contract) ---\n", soul,
      "\n--- personality.md ---\n", persona,
      "\n--- AGENTS.md ---\n", instructions,
      "\n--- recalled Engram context ---\n", context,
      ...(knowledgeBlock ? ["\n", knowledgeBlock] : []),
      "\n--- Dad's request ---\n", prompt,
      "\nReturn a clear answer and state any action that was intentionally staged for approval.",
    ].join("\n");
  }

  async run(prompt: string, options: RunOptions = {}): Promise<Awaited<ReturnType<ProviderRunner["run"]>>> {
    const runId = randomUUID();
    const fullPrompt = await this.buildPrompt(prompt, runId);
    const result = await this.runner.run(fullPrompt, { ...options, onEvent: (event) => options.onEvent?.(event) });
    if (result.response.trim()) {
      await this.memory.remember(redactSecrets(`Dad asked: ${prompt}\n\nHenry answered:\n${result.response}`), {
        source: `captured/${new Date().toISOString().slice(0, 10)}-conversation.md`,
        tier: "episodic", importance: 5, metadata: { runId, provider: result.provider },
      });
    }
    return result;
  }

  get providerRunner(): ProviderRunner { return this.runner; }
}
