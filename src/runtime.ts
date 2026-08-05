import type { LavuConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { ActivityLog } from "./activity.ts";
import { ApprovalStore } from "./approval/store.ts";
import { LavuMemory } from "./memory/engram.ts";
import { LavuAgent } from "./agent/lavu.ts";
import { LunaOrchestrator } from "./orchestration/luna.ts";
import { GmailService } from "./integrations/gmail.ts";
import { WorkflowScheduler } from "./scheduler/scheduler.ts";
import { PullRequestReviewer } from "./pr/review.ts";

export class LavuRuntime {
  readonly activity: ActivityLog;
  readonly approvals: ApprovalStore;
  readonly memory: LavuMemory;
  readonly agent: LavuAgent;
  readonly luna: LunaOrchestrator;
  readonly gmail: GmailService;
  readonly scheduler: WorkflowScheduler;
  readonly reviewer: PullRequestReviewer;

  private constructor(readonly config: LavuConfig) {
    this.activity = new ActivityLog(config.activityPath);
    this.approvals = new ApprovalStore(config.approvalsPath);
    this.memory = new LavuMemory(config, this.activity);
    this.gmail = new GmailService(config, this.activity, this.approvals);
    this.agent = new LavuAgent(config, this.activity, this.memory);
    this.luna = new LunaOrchestrator(config, this.activity, this.memory);
    this.scheduler = new WorkflowScheduler(config, this.activity, this.memory, this.gmail);
    this.reviewer = new PullRequestReviewer(config, this.activity, this.approvals, this.agent.providerRunner);
  }

  static async create(rootDir?: string): Promise<LavuRuntime> {
    const runtime = new LavuRuntime(loadConfig(rootDir));
    await runtime.activity.init();
    await runtime.approvals.init();
    await runtime.memory.init();
    return runtime;
  }

  async approve(id: string): Promise<void> {
    await this.approvals.setStatus(id, "approved");
    await this.activity.record("approval.approved", `Approved outbound action ${id}`, { approvalId: id });
  }

  async executeApproval(id: string): Promise<string> {
    const item = await this.approvals.claimForExecution(id);
    try {
      const result = item.kind === "gmail.send" ? await this.gmail.sendApproved(item) : await this.reviewer.postApproved(item);
      await this.approvals.setStatus(id, "executed", result);
      return result;
    } catch (error) {
      await this.approvals.setStatus(id, "failed", String(error));
      throw error;
    }
  }

  async status(): Promise<Record<string, unknown>> {
    return {
      name: "Lavu", user: "Dad", provider: this.config.provider,
      rootDir: this.config.rootDir, dashboard: `http://${this.config.host}:${this.config.port}`,
      approvals: (await this.approvals.list("pending")).length,
      memory: this.memory.engine.stats(),
    };
  }

  close(): void { this.memory.close(); this.scheduler.stop(); }
}
