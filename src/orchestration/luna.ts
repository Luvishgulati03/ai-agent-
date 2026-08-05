import type { ActivityLog } from "../activity.ts";
import type { LavuConfig } from "../config.ts";
import type { LavuMemory } from "../memory/engram.ts";
import { ProviderRunner } from "../providers/runner.ts";

export const SPECIALISTS = {
  architect: "Design boundaries, data flow, and sequencing. Do not edit unrelated files.",
  runtime: "Own Codex/Claude execution, subprocess lifecycle, streaming, and failure recovery.",
  memory: "Own the actual Engram integration, indexing, recall traces, graph, and dreaming.",
  dashboard: "Own local dashboard state, APIs, approvals, activity, and clear operator UX.",
  gmail: "Own Gmail OAuth, inbox reading, drafts, polling, and approval-gated outbound actions.",
  "pr-review": "Own the six-pass PR review workflow, re-review behavior, findings, and staged GitHub comments.",
  qa: "Own tests, type safety, security boundaries, and verification of the whole agent.",
} as const;

export type SpecialistRole = keyof typeof SPECIALISTS;

export class LunaOrchestrator {
  private readonly runner: ProviderRunner;

  constructor(
    private readonly config: LavuConfig,
    private readonly activity: ActivityLog,
    private readonly memory: LavuMemory,
  ) { this.runner = new ProviderRunner(config, activity); }

  async dispatch(role: string, task: string, options: { allowEdits?: boolean; cwd?: string } = {}): Promise<Awaited<ReturnType<ProviderRunner["run"]>>> {
    const selected = (role in SPECIALISTS ? role : "architect") as SpecialistRole;
    const prompt = [
      `You are Luna's ${selected} specialist working on Lavu.`,
      SPECIALISTS[selected],
      options.allowEdits ? "You may edit only files needed for this task and must report changed files." : "This is an investigation pass. Do not edit files; return an implementation memo with concrete next actions.",
      "Keep outbound communication staged; never post messages or comments directly.",
      `Task from Dad: ${task}`,
    ].join("\n\n");
    const result = await this.runner.run(prompt, { cwd: options.cwd || this.config.rootDir, role: selected, readOnly: !options.allowEdits });
    await this.activity.record("agent.dispatched", `Luna dispatched ${selected}`, { task, provider: result.provider, success: result.exitCode === 0 }, { runId: result.runId, role: selected, provider: result.provider });
    if (result.response) await this.memory.remember(`Luna dispatched ${selected} for: ${task}\n\nResult:\n${result.response}`, { tier: "procedural", importance: 6, metadata: { role: selected, runId: result.runId } });
    return result;
  }

  async dispatchMany(tasks: Array<{ role: string; task: string }>): Promise<Array<Awaited<ReturnType<ProviderRunner["run"]>>>> {
    return Promise.all(tasks.map((task) => this.dispatch(task.role, task.task)));
  }
}
