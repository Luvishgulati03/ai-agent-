import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Cron } from "croner";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";

export type ReminderStatus = "pending" | "fired" | "cancelled";

/**
 * "message" delivers `text` literally; "prompt" runs `text` through the agent at fire time and
 * delivers the response; "approval.execute" executes an already-approved outbound action
 * (`approvalId`) at fire time — it never creates or approves anything itself.
 */
export type ReminderKind = "message" | "prompt" | "approval.execute";

export interface Reminder {
  id: string;
  /** Literal notification text for "message" reminders, the agent instruction for "prompt"
   *  reminders, or a display title for "approval.execute" reminders. */
  text: string;
  kind: ReminderKind;
  /** One-shot: the fire time. Recurring (cron set): the next scheduled fire time — re-armed after every fire. */
  dueAt: string;
  /** Croner expression; when set the reminder is recurring and re-arms instead of being marked "fired". */
  cron?: string;
  /** Mirrors `dueAt` for recurring reminders — kept for callers that want the "next fire" concept explicitly. */
  nextFireAt?: string;
  /** Present when kind === "approval.execute": the approval queue item to execute at fire time. */
  approvalId?: string;
  status: ReminderStatus;
  createdAt: string;
  firedAt?: string;
}

/**
 * Reminders fired more than this long after their due time get an "(overdue)" prefix —
 * the 60s scheduler poll accounts for small delays under this, so anything further out
 * almost certainly means the daemon was down when the reminder should have fired.
 */
export const REMINDER_OVERDUE_GRACE_MS = 90_000;

/** macOS notification bodies get unwieldy past this; console + activity metadata always keep the full text. */
export const OSASCRIPT_NOTIFICATION_MAX_CHARS = 180;

export type ReminderNotifier = (message: string, title?: string) => Promise<void>;

/** Runs a reminder's prompt through the agent (t1) and returns the response text; injected so the reminder service stays agent-agnostic. */
export type PromptRunner = (prompt: string) => Promise<string>;

/**
 * Executes an already-approved outbound action by id (gmail send, job submission, PR comment —
 * whatever `HenryRuntime.executeApproval` dispatches to). Injected so the reminder service never
 * depends on the runtime/approval store directly. Must throw if the item isn't "approved" —
 * the scheduler only ever executes pre-approved items, never creates or approves them.
 */
export type ExecuteApprovalFn = (approvalId: string) => Promise<string>;

/** macOS notification, best-effort; console logging always fires as the say-free fallback (and always gets the untruncated text). */
export const notifyReminder: ReminderNotifier = async (message, title = "Henry") => {
  console.log(`[Henry reminder] ${message}`);
  const body = message.length > OSASCRIPT_NOTIFICATION_MAX_CHARS
    ? `${message.slice(0, OSASCRIPT_NOTIFICATION_MAX_CHARS - 1)}…`
    : message;
  await new Promise<void>((resolve) => {
    const child = spawn(
      "osascript",
      ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`],
      { stdio: "ignore" },
    );
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
};

/** Next fire time for a croner expression, strictly after `from`. Throws on an invalid expression or one with no future runs. */
export function nextCronFireAt(cronExpression: string, from: Date = new Date()): Date {
  const job = new Cron(cronExpression, { paused: true });
  const next = job.nextRun(from);
  if (!next) throw new Error(`Cron expression "${cronExpression}" has no future runs`);
  return next;
}

/** "YYYY-MM-DD HH:mm" (local time, 24h clock; "T" separator also accepted) → Date. */
export function parseAt(value: string): Date {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid --at value: "${value}". Expected "YYYY-MM-DD HH:mm".`);
  const [, y, mo, d, h, mi] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0, 0);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid --at value: "${value}"`);
  return date;
}

/** "2h", "30m", "1d", "1h30m" → a Date offset from `from`. */
export function parseIn(value: string, from: Date = new Date()): Date {
  const pattern = /(\d+)\s*(d|h|m)/gi;
  let totalMs = 0;
  let matched = false;
  for (const match of value.trim().matchAll(pattern)) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    totalMs += unit === "d" ? amount * 86_400_000 : unit === "h" ? amount * 3_600_000 : amount * 60_000;
  }
  if (!matched) throw new Error(`Invalid --in duration: "${value}". Use forms like "30m", "2h", "1d".`);
  return new Date(from.getTime() + totalMs);
}

export class ReminderService {
  private items: Reminder[] = [];
  private loaded = false;
  private mutationChain = Promise.resolve();

  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
  ) {}

  private async ensure(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(path.dirname(this.config.remindersPath), { recursive: true, mode: 0o700 });
    try {
      this.items = JSON.parse(await fs.readFile(this.config.remindersPath, "utf8")) as Reminder[];
    } catch {
      this.items = [];
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await fs.writeFile(this.config.remindersPath, `${JSON.stringify(this.items, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(this.config.remindersPath, 0o600).catch(() => undefined);
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationChain;
    let release!: () => void;
    this.mutationChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  /** One-shot reminder, due at `dueAt`. `kind: "prompt"` runs `text` through the agent at fire time instead of delivering it literally. */
  async create(text: string, dueAt: Date, kind: ReminderKind = "message"): Promise<Reminder> {
    return this.mutate(async () => {
      await this.ensure();
      const item: Reminder = {
        id: randomUUID(), text, kind, dueAt: dueAt.toISOString(), status: "pending", createdAt: new Date().toISOString(),
      };
      this.items.push(item);
      await this.save();
      await this.activity.record("task.started", `Reminder set: ${text}`, { reminder: true, id: item.id, dueAt: item.dueAt, kind });
      return item;
    });
  }

  /**
   * Recurring reminder driven by a croner expression. Never transitions to "fired" — each
   * firing re-arms `dueAt`/`nextFireAt` to the following occurrence; `cancel()` is the only
   * way to stop it.
   */
  async createRecurring(text: string, cronExpression: string, kind: ReminderKind = "message", now: Date = new Date()): Promise<Reminder> {
    const nextFireAt = nextCronFireAt(cronExpression, now);
    return this.mutate(async () => {
      await this.ensure();
      const item: Reminder = {
        id: randomUUID(), text, kind, dueAt: nextFireAt.toISOString(), cron: cronExpression,
        nextFireAt: nextFireAt.toISOString(), status: "pending", createdAt: new Date().toISOString(),
      };
      this.items.push(item);
      await this.save();
      await this.activity.record("task.started", `Recurring reminder set: ${text}`, {
        reminder: true, id: item.id, dueAt: item.dueAt, cron: cronExpression, kind,
      });
      return item;
    });
  }

  /**
   * One-shot: at `dueAt`, execute the already-approved action `approvalId` (never creates or
   * approves anything — the approval must already be "approved" before this fires). `title`
   * is a friendly display name for notifications/listing; defaults to the approval id.
   */
  async createApprovalExecute(approvalId: string, dueAt: Date, title?: string): Promise<Reminder> {
    return this.mutate(async () => {
      await this.ensure();
      const item: Reminder = {
        id: randomUUID(), text: title || `approval ${approvalId}`, kind: "approval.execute", approvalId,
        dueAt: dueAt.toISOString(), status: "pending", createdAt: new Date().toISOString(),
      };
      this.items.push(item);
      await this.save();
      await this.activity.record("task.started", `Scheduled approval execution: ${item.text}`, {
        reminder: true, id: item.id, dueAt: item.dueAt, kind: "approval.execute", approvalId,
      });
      return item;
    });
  }

  async list(status?: ReminderStatus): Promise<Reminder[]> {
    await this.ensure();
    return this.items.filter((item) => !status || item.status === status).slice().sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }

  async get(id: string): Promise<Reminder | undefined> {
    await this.ensure();
    return this.items.find((item) => item.id === id);
  }

  async cancel(id: string): Promise<Reminder> {
    return this.mutate(async () => {
      await this.ensure();
      const item = this.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`Reminder not found: ${id}`);
      if (item.status !== "pending") throw new Error(`Reminder ${id} is ${item.status}; only pending reminders can be cancelled`);
      item.status = "cancelled";
      await this.save();
      return item;
    });
  }

  /** Pending reminders whose dueAt has passed, earliest first. */
  async due(now: Date = new Date()): Promise<Reminder[]> {
    await this.ensure();
    return this.items
      .filter((item) => item.status === "pending" && new Date(item.dueAt).getTime() <= now.getTime())
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }

  async markFired(id: string, firedAt: Date = new Date()): Promise<Reminder> {
    return this.mutate(async () => {
      await this.ensure();
      const item = this.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`Reminder not found: ${id}`);
      item.status = "fired";
      item.firedAt = firedAt.toISOString();
      await this.save();
      return item;
    });
  }

  /** Re-arms a recurring reminder to its next occurrence after `firedAt`; status stays "pending". */
  async rearm(id: string, firedAt: Date = new Date()): Promise<Reminder> {
    return this.mutate(async () => {
      await this.ensure();
      const item = this.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`Reminder not found: ${id}`);
      if (!item.cron) throw new Error(`Reminder ${id} has no cron expression to re-arm from`);
      const next = nextCronFireAt(item.cron, firedAt);
      item.dueAt = next.toISOString();
      item.nextFireAt = next.toISOString();
      item.firedAt = firedAt.toISOString();
      await this.save();
      return item;
    });
  }

  /**
   * Fires every due reminder. One-shot reminders flip to "fired" (fire-once — only "pending"
   * reminders match `due()`); recurring reminders (cron set) re-arm to their next occurrence
   * and stay "pending" — `cancel()` is the only way to stop them.
   *
   * - "message" reminders deliver `text` literally.
   * - "prompt" reminders run `text` through `runPrompt` (the agent) and deliver the response
   *   text instead.
   * - "approval.execute" reminders call `executeApproval(approvalId)` — never anything else.
   *   `executeApproval` is expected to throw unless the item is already "approved" (the
   *   scheduler only ever executes pre-approved items, never creates or approves them). ANY
   *   failure — not approved, already executed, provider error — is reported as a "skipped"
   *   notification and the reminder is marked fired regardless: it never retries a send.
   *
   * Reminders overdue by more than REMINDER_OVERDUE_GRACE_MS get an "(overdue)" prefix — this
   * is how a reminder due while the daemon was down still fires (with the prefix) on next start.
   */
  async fireDue(
    notify: ReminderNotifier = notifyReminder,
    now: Date = new Date(),
    runPrompt?: PromptRunner,
    executeApproval?: ExecuteApprovalFn,
  ): Promise<Reminder[]> {
    const due = await this.due(now);
    const fired: Reminder[] = [];
    for (const reminder of due) {
      const overdueMs = now.getTime() - new Date(reminder.dueAt).getTime();
      const overdue = overdueMs > REMINDER_OVERDUE_GRACE_MS;
      let body = reminder.text;
      let approvalError: string | undefined;
      if (reminder.kind === "prompt") {
        try {
          body = runPrompt ? (await runPrompt(reminder.text)).trim() || "(the agent returned an empty response)" : "(no prompt runner configured; unable to run this reminder's prompt)";
        } catch (error) {
          body = `(prompt reminder failed: ${error instanceof Error ? error.message : String(error)})`;
        }
      } else if (reminder.kind === "approval.execute") {
        if (!reminder.approvalId) approvalError = `reminder ${reminder.id} has no approvalId`;
        else if (!executeApproval) approvalError = "no executeApproval handler configured";
        else {
          try { await executeApproval(reminder.approvalId); }
          catch (error) { approvalError = error instanceof Error ? error.message : String(error); }
        }
        body = approvalError ? `Scheduled send skipped: ${approvalError}` : `Sent scheduled approval ${reminder.text}`;
      }
      const message = overdue ? `(overdue) ${body}` : body;
      await notify(message);
      // approval.execute reminders are always one-shot (createApprovalExecute never sets cron) —
      // this still routes through the same fire-once path as any other one-shot reminder.
      const updated = reminder.cron ? await this.rearm(reminder.id, now) : await this.markFired(reminder.id, now);
      await this.activity.record("workflow.completed", `Reminder fired: ${reminder.text}`, {
        reminder: true, id: reminder.id, overdue, kind: reminder.kind, recurring: Boolean(reminder.cron), message,
        ...(reminder.kind === "approval.execute" ? { approvalId: reminder.approvalId, error: approvalError } : {}),
      });
      fired.push(updated);
    }
    return fired;
  }
}
