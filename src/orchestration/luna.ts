import type { ActivityLog } from "../activity.ts";
import type { HenryConfig } from "../config.ts";
import type { HenryMemory } from "../memory/engram.ts";
import type { DispatchTier } from "../types.ts";
import { ProviderRunner } from "../providers/runner.ts";
import { sharedAdmissionController } from "./admission.ts";

export const SPECIALISTS = {
  architect: "Design boundaries, data flow, and sequencing. Do not edit unrelated files.",
  runtime: "Own Codex/Claude execution, subprocess lifecycle, streaming, and failure recovery.",
  memory: "Own the actual Engram integration, indexing, recall traces, graph, and dreaming.",
  dashboard: "Own local dashboard state, APIs, approvals, activity, and clear operator UX.",
  gmail: "Own Gmail OAuth, inbox reading, drafts, polling, and approval-gated outbound actions.",
  "pr-review": "Own the six-pass PR review workflow, re-review behavior, findings, and staged GitHub comments.",
  "job-application": "Own job posting inspection, truthful tailoring of resumes and answers, form filling for review, and the approval-gated submission boundary. Never invent candidate facts and never bypass site protections.",
  qa: "Own tests, type safety, security boundaries, and verification of the whole agent.",
} as const;

export type SpecialistRole = keyof typeof SPECIALISTS;

/** Default tier per specialist (§11.2: lowest tier that clears the quality bar). */
const ROLE_TIER: Partial<Record<SpecialistRole, DispatchTier>> = {
  architect: "t2",
  "pr-review": "t2",
};

export interface DispatchOptions {
  allowEdits?: boolean;
  cwd?: string;
  /** §11.1 tier knob; defaults to the role's tier, else the configured models. */
  tier?: DispatchTier;
  /** §7 wall-clock envelope for the dispatched worker. */
  timeoutMs?: number;
}

export class LunaOrchestrator {
  private readonly runner: ProviderRunner;

  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly memory: HenryMemory,
  ) {
    // One admission controller for the whole process: Luna's dispatches, the
    // agent's own runs, and scheduled workflows all draw on the same 2-slot budget.
    this.runner = new ProviderRunner(config, activity, sharedAdmissionController());
  }

  async dispatch(role: string, task: string, options: DispatchOptions = {}): Promise<Awaited<ReturnType<ProviderRunner["run"]>>> {
    const selected = (role in SPECIALISTS ? role : "architect") as SpecialistRole;
    const prompt = [
      `You are Luna's ${selected} specialist working on Henry.`,
      SPECIALISTS[selected],
      options.allowEdits ? "You may edit only files needed for this task and must report changed files." : "This is an investigation pass. Do not edit files; return an implementation memo with concrete next actions.",
      "Keep outbound communication staged; never post messages or comments directly.",
      `Task from Dad: ${task}`,
    ].join("\n\n");
    const tier = options.tier ?? ROLE_TIER[selected];
    const result = await this.runner.run(prompt, {
      cwd: options.cwd || this.config.rootDir,
      role: selected,
      readOnly: !options.allowEdits,
      ...(tier ? { tier } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    await this.activity.record("agent.dispatched", `Luna dispatched ${selected}`, { task, provider: result.provider, tier, success: result.exitCode === 0 }, { runId: result.runId, role: selected, provider: result.provider });
    if (result.response) await this.memory.remember(`Luna dispatched ${selected} for: ${task}\n\nResult:\n${result.response}`, { tier: "procedural", importance: 6, metadata: { role: selected, runId: result.runId } });
    return result;
  }

  /**
   * Parallel dispatch is safe because admission control serializes the actual
   * spawns to the M1 budget (§7) — the extra tasks simply queue.
   */
  async dispatchMany(tasks: Array<{ role: string; task: string } & DispatchOptions>): Promise<Array<Awaited<ReturnType<ProviderRunner["run"]>>>> {
    return Promise.all(tasks.map(({ role, task, ...options }) => this.dispatch(role, task, options)));
  }
}
