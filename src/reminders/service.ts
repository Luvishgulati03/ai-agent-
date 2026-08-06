import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";

export type ReminderStatus = "pending" | "fired" | "cancelled";

export interface Reminder {
  id: string;
  text: string;
  dueAt: string;
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

export type ReminderNotifier = (message: string, title?: string) => Promise<void>;

/** macOS notification, best-effort; console logging always fires as the say-free fallback. */
export const notifyReminder: ReminderNotifier = async (message, title = "Henry") => {
  console.log(`[Henry reminder] ${message}`);
  await new Promise<void>((resolve) => {
    const child = spawn(
      "osascript",
      ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`],
      { stdio: "ignore" },
    );
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
};

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

  async create(text: string, dueAt: Date): Promise<Reminder> {
    return this.mutate(async () => {
      await this.ensure();
      const item: Reminder = {
        id: randomUUID(), text, dueAt: dueAt.toISOString(), status: "pending", createdAt: new Date().toISOString(),
      };
      this.items.push(item);
      await this.save();
      await this.activity.record("task.started", `Reminder set: ${text}`, { reminder: true, id: item.id, dueAt: item.dueAt });
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

  /**
   * Fires every due reminder: notifies, flips status to "fired" (fire-once — only
   * "pending" reminders match `due()`), and records an activity event. Reminders overdue
   * by more than REMINDER_OVERDUE_GRACE_MS get an "(overdue)" prefix — this is how a
   * reminder due while the daemon was down still fires (with the prefix) on next start.
   */
  async fireDue(notify: ReminderNotifier = notifyReminder, now: Date = new Date()): Promise<Reminder[]> {
    const due = await this.due(now);
    const fired: Reminder[] = [];
    for (const reminder of due) {
      const overdueMs = now.getTime() - new Date(reminder.dueAt).getTime();
      const overdue = overdueMs > REMINDER_OVERDUE_GRACE_MS;
      const message = overdue ? `(overdue) ${reminder.text}` : reminder.text;
      await notify(message);
      const updated = await this.markFired(reminder.id, now);
      await this.activity.record("workflow.completed", `Reminder fired: ${reminder.text}`, { reminder: true, id: reminder.id, overdue });
      fired.push(updated);
    }
    return fired;
  }
}
