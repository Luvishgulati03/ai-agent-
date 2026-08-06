import fs from "node:fs/promises";
import path from "node:path";
import { Cron } from "croner";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { HenryMemory } from "../memory/engram.ts";
import type { GmailService } from "../integrations/gmail.ts";
import type { WorkflowDefinition } from "../types.ts";
import type { ReminderService, ReminderNotifier } from "../reminders/service.ts";
import { notifyReminder } from "../reminders/service.ts";

/** How often the daemon polls for due reminders (§ reminders doctrine). */
const REMINDER_POLL_MS = 60_000;

/** Reads the pid recorded in a lock file; returns undefined if absent/unreadable. */
async function readLockPid(lockPath: string): Promise<number | undefined> {
  try {
    const pid = Number((await fs.readFile(lockPath, "utf8")).trim());
    return Number.isFinite(pid) ? pid : undefined;
  } catch { return undefined; }
}

/** Signal 0 checks liveness without killing the process. */
function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class WorkflowScheduler {
  private jobs: Array<{ definition: WorkflowDefinition; cron: Cron }> = [];
  private reminderTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly memory: HenryMemory,
    private readonly gmail: GmailService,
    private readonly reminders?: ReminderService,
    private readonly notifyReminderFn: ReminderNotifier = notifyReminder,
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
    this.armReminders();
    return definitions;
  }

  /**
   * Arms the reminder poller: an immediate check (so reminders that came due while the
   * daemon was down fire right away, "(overdue)"-prefixed) followed by a 60s interval.
   */
  private armReminders(): void {
    if (!this.reminders) return;
    const check = (): void => {
      void this.reminders!.fireDue(this.notifyReminderFn).catch(
        (error) => this.activity.record("workflow.failed", "Reminder check failed", { error: String(error) }),
      );
    };
    check();
    this.reminderTimer = setInterval(check, REMINDER_POLL_MS);
    this.reminderTimer.unref?.();
  }

  async run(definition: WorkflowDefinition): Promise<unknown> {
    await this.activity.record("workflow.started", `Running workflow ${definition.id}`, { kind: definition.kind });
    try {
      let result: unknown;
      if (definition.kind === "memory.dream") result = await this.memory.dream();
      else if (definition.kind === "gmail.inbox") result = await this.gmail.inbox(20);
      else if (definition.kind === "knowledge.distill") result = await this.runKnowledgeDistill(definition);
      else result = { skipped: true, reason: "agent.prompt workflows require an orchestrator callback" };
      await this.activity.record("workflow.completed", `Workflow ${definition.id} completed`, { result });
      return result;
    } catch (error) {
      await this.activity.record("workflow.failed", `Workflow ${definition.id} failed`, { error: String(error) });
      throw error;
    }
  }

  /**
   * Distills GrowthX Learn modules into strategy cards. The KnowledgeBase (and its
   * resident embedding model) is constructed fresh for this one run and closed
   * before returning — the scheduler daemon may run for days between nightly
   * firings, so nothing about knowledge distillation should stay resident in
   * memory the rest of the time. A pid lock file guards data/knowledge.db against
   * concurrent writers (e.g. an overlapping manual run).
   */
  private async runKnowledgeDistill(definition: WorkflowDefinition): Promise<unknown> {
    const lockPath = path.join(this.config.dataDir, "knowledge.lock");
    const heldPid = await readLockPid(lockPath);
    if (heldPid !== undefined && isPidAlive(heldPid)) {
      return { skipped: true, reason: "knowledge.distill already running", pid: heldPid };
    }
    await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(lockPath, String(process.pid), { encoding: "utf8", mode: 0o600 });
    try {
      const { KnowledgeBase } = await import("../knowledge/store.ts");
      const { KnowledgeIngestor } = await import("../knowledge/ingest.ts");
      const { ProviderRunner } = await import("../providers/runner.ts");
      const kb = new KnowledgeBase(this.config);
      try {
        const runner = new ProviderRunner(this.config, this.activity);
        const ingestor = new KnowledgeIngestor(this.config, this.activity, kb, runner);
        return await ingestor.ingestCards({ limit: definition.batchLimit ?? 15 });
      } finally {
        kb.close();
      }
    } finally {
      await fs.rm(lockPath, { force: true });
    }
  }

  stop(): void {
    for (const job of this.jobs) job.cron.stop();
    this.jobs = [];
    if (this.reminderTimer) { clearInterval(this.reminderTimer); this.reminderTimer = undefined; }
  }
}
