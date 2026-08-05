import fs from "node:fs/promises";
import { Cron } from "croner";
import type { LavuConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { LavuMemory } from "../memory/engram.ts";
import type { GmailService } from "../integrations/gmail.ts";
import type { WorkflowDefinition } from "../types.ts";

export class WorkflowScheduler {
  private jobs: Array<{ definition: WorkflowDefinition; cron: Cron }> = [];

  constructor(
    private readonly config: LavuConfig,
    private readonly activity: ActivityLog,
    private readonly memory: LavuMemory,
    private readonly gmail: GmailService,
  ) {}

  async definitions(): Promise<WorkflowDefinition[]> {
    try { return JSON.parse(await fs.readFile(this.config.workflowsPath, "utf8")) as WorkflowDefinition[]; }
    catch { return []; }
  }

  async start(): Promise<WorkflowDefinition[]> {
    const definitions = (await this.definitions()).filter((definition) => definition.enabled);
    for (const definition of definitions) {
      const cron = new Cron(definition.cron, { protect: true }, () => void this.run(definition));
      this.jobs.push({ definition, cron });
    }
    await this.activity.record("workflow.started", `Started ${definitions.length} scheduled workflows`, { workflows: definitions.map((item) => item.id) });
    return definitions;
  }

  async run(definition: WorkflowDefinition): Promise<unknown> {
    await this.activity.record("workflow.started", `Running workflow ${definition.id}`, { kind: definition.kind });
    try {
      let result: unknown;
      if (definition.kind === "memory.dream") result = await this.memory.dream();
      else if (definition.kind === "gmail.inbox") result = await this.gmail.inbox(20);
      else result = { skipped: true, reason: "agent.prompt workflows require an orchestrator callback" };
      await this.activity.record("workflow.completed", `Workflow ${definition.id} completed`, { result });
      return result;
    } catch (error) {
      await this.activity.record("workflow.failed", `Workflow ${definition.id} failed`, { error: String(error) });
      throw error;
    }
  }

  stop(): void { for (const job of this.jobs) job.cron.stop(); this.jobs = []; }
}
