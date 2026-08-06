import fs from "node:fs/promises";
import path from "node:path";
import type { HenryConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { ActivityLog } from "./activity.ts";
import { ApprovalStore } from "./approval/store.ts";
import { HenryMemory } from "./memory/engram.ts";
import { KnowledgeBase } from "./knowledge/store.ts";
import { HenryAgent } from "./agent/henry.ts";
import { LunaOrchestrator } from "./orchestration/luna.ts";
import { GmailService } from "./integrations/gmail.ts";
import { WorkflowScheduler } from "./scheduler/scheduler.ts";
import { PullRequestReviewer } from "./pr/review.ts";
import { JobApplicationService } from "./jobs/service.ts";
import { CoverLetterService } from "./jobs/cover.ts";
import { MeetingShadowService } from "./meetings/service.ts";
import { ScreenshotSorterService } from "./screenshots/service.ts";
import { ResumeEditorService } from "./jobs/resume-editor.ts";
import { WorkflowEngine } from "./workflows/engine.ts";
import { GoalService } from "./goals/service.ts";
import { ReminderService, notifyReminder, type ReminderNotifier } from "./reminders/service.ts";
import { LinkedInDraftService } from "./social/linkedin.ts";
import { sendTelegram } from "./notify/telegram.ts";
import { MailWatchService } from "./mailwatch/service.ts";
import { DraftRepliesService } from "./gmail-drafts/service.ts";
import type { ProviderName, RunResult } from "./types.ts";

export class HenryRuntime {
  readonly activity: ActivityLog;
  readonly approvals: ApprovalStore;
  readonly memory: HenryMemory;
  readonly agent: HenryAgent;
  readonly luna: LunaOrchestrator;
  readonly gmail: GmailService;
  readonly scheduler: WorkflowScheduler;
  readonly reviewer: PullRequestReviewer;
  readonly jobs: JobApplicationService;
  readonly cover: CoverLetterService;
  readonly resumeEditor: ResumeEditorService;
  readonly meetings: MeetingShadowService;
  readonly screenshots: ScreenshotSorterService;
  readonly goals: GoalService;
  readonly reminders: ReminderService;
  readonly linkedin: LinkedInDraftService;
  readonly mailwatch: MailWatchService;
  readonly draftReplies: DraftRepliesService;
  private _knowledge?: KnowledgeBase;
  private _workflowEngine?: WorkflowEngine;

  /**
   * Composed operator-notification channel: console + osascript (via `notifyReminder`) then
   * a fire-and-forget Telegram send when configured. This is the one place reminders and
   * mail-watch alerts are wired together with Telegram — neither module imports the other or
   * imports `notify/telegram.ts` itself (doctrine rule 7); the runtime composition root does.
   */
  readonly notifyOperator: ReminderNotifier = async (message, title) => {
    await notifyReminder(message, title);
    void sendTelegram(this.config, title && title !== "Henry" ? `${title}: ${message}` : message).catch(() => undefined);
  };

  private constructor(readonly config: HenryConfig) {
    this.activity = new ActivityLog(config.activityPath);
    this.approvals = new ApprovalStore(config.approvalsPath);
    this.memory = new HenryMemory(config, this.activity);
    this.gmail = new GmailService(config, this.activity, this.approvals);
    this.agent = new HenryAgent(config, this.activity, this.memory, () => this.knowledge);
    this.luna = new LunaOrchestrator(config, this.activity, this.memory);
    this.reminders = new ReminderService(config, this.activity);
    this.scheduler = new WorkflowScheduler(
      config, this.activity, this.memory, this.gmail, this.reminders,
      this.notifyOperator,
      (prompt) => this.agent.run(prompt).then((result) => result.response),
      (approvalId) => this.executeApproval(approvalId),
    );
    this.mailwatch = new MailWatchService(config, this.activity, this.agent.providerRunner, this.notifyOperator);
    this.draftReplies = new DraftRepliesService(config, this.activity, this.agent.providerRunner, this.notifyOperator);
    this.reviewer = new PullRequestReviewer(config, this.activity, this.approvals, this.agent.providerRunner);
    this.jobs = new JobApplicationService(config, this.activity, this.approvals, this.memory, this.agent.providerRunner);
    this.cover = new CoverLetterService(config, this.activity, this.memory, this.agent.providerRunner, this.jobs);
    this.resumeEditor = new ResumeEditorService(config, this.activity, this.memory, this.agent.providerRunner);
    this.meetings = new MeetingShadowService(config, this.activity, this.memory, this.agent.providerRunner);
    this.screenshots = new ScreenshotSorterService(config, this.activity, this.agent.providerRunner);
    this.goals = new GoalService(config, this.activity, this.memory, this.luna);
    this.linkedin = new LinkedInDraftService(config, this.activity, this.memory, this.agent.providerRunner);
  }

  /** Lazily opens the GrowthX knowledge DB on first domain-relevant turn; keeps boot fast. */
  get knowledge(): KnowledgeBase {
    if (!this._knowledge) this._knowledge = new KnowledgeBase(this.config);
    return this._knowledge;
  }

  /**
   * Markdown workflow engine (`workflows/*.workflow.md`). Constructed on first use and
   * inert until `start()` — only the workflow/schedule daemons watch files and arm crons.
   */
  get workflowEngine(): WorkflowEngine {
    if (!this._workflowEngine) this._workflowEngine = new WorkflowEngine(this.config, this.activity, this.agent.providerRunner);
    return this._workflowEngine;
  }

  static async create(rootDir?: string): Promise<HenryRuntime> {
    const runtime = new HenryRuntime(loadConfig(rootDir));
    await runtime.loadSettings();
    await runtime.activity.init();
    await runtime.approvals.init();
    await runtime.memory.init();
    await runtime.jobs.init();
    return runtime;
  }

  /** Persisted operator settings override env defaults; the dashboard toggle writes them. */
  private async loadSettings(): Promise<void> {
    try {
      const settings = JSON.parse(await fs.readFile(this.config.settingsPath, "utf8")) as Record<string, unknown>;
      if (settings.provider === "codex" || settings.provider === "claude") this.config.provider = settings.provider;
    } catch { /* No settings file yet; env/default provider applies. */ }
  }

  async setProvider(provider: ProviderName): Promise<ProviderName> {
    if (provider !== "codex" && provider !== "claude") throw new Error(`Unknown provider: ${String(provider)}`);
    this.config.provider = provider;
    await fs.mkdir(path.dirname(this.config.settingsPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.config.settingsPath, `${JSON.stringify({ provider }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await this.activity.record("provider.switched", `Primary provider switched to ${provider}`, { provider });
    return provider;
  }

  /** Full-access engineering task inside any local repository Dad points Henry at. */
  async task(instruction: string, cwd?: string): Promise<RunResult> {
    const dir = path.resolve(cwd || this.config.rootDir);
    await fs.access(dir).catch(() => { throw new Error(`Task directory does not exist: ${dir}`); });
    await this.activity.record("task.started", `Codebase task in ${dir}`, { cwd: dir, instruction: instruction.slice(0, 240) });
    const result = await this.agent.run(
      [`Work inside the repository at ${dir}. Inspect it before changing anything, run the project's own checks after edits, and summarize every file you changed.`, instruction].join("\n\n"),
      { cwd: dir },
    );
    await this.activity.record("task.completed", `Codebase task finished in ${dir}`, { cwd: dir, exitCode: result.exitCode }, { runId: result.runId, provider: result.provider });
    return result;
  }

  async approve(id: string): Promise<void> {
    await this.approvals.setStatus(id, "approved");
    await this.activity.record("approval.approved", `Approved outbound action ${id}`, { approvalId: id });
  }

  async executeApproval(id: string): Promise<string> {
    const item = await this.approvals.claimForExecution(id);
    try {
      const result = item.kind === "gmail.send" ? await this.gmail.sendApproved(item)
        : item.kind === "job.application" ? await this.jobs.submitApproved(item)
        : await this.reviewer.postApproved(item);
      await this.approvals.setStatus(id, "executed", result);
      return result;
    } catch (error) {
      await this.approvals.setStatus(id, "failed", String(error));
      throw error;
    }
  }

  async status(): Promise<Record<string, unknown>> {
    return {
      name: "Henry", user: "Dad", provider: this.config.provider,
      rootDir: this.config.rootDir, dashboard: `http://${this.config.host}:${this.config.port}`,
      approvals: (await this.approvals.list("pending")).length,
      jobs: await this.jobs.store.summary(),
      memory: this.memory.engine.stats(),
    };
  }

  close(): void { this.memory.close(); this._knowledge?.close(); this.scheduler.stop(); this._workflowEngine?.stop(); }
}
