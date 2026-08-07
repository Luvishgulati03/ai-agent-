import fs from "node:fs/promises";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { ProviderRunner } from "../providers/runner.ts";
import { updateTracker } from "./tracker.ts";

/** Same shape as reminders' `ReminderNotifier` — kept local so this module never imports the reminders module directly (doctrine rule 7). */
export type MailWatchNotifier = (message: string, title?: string) => Promise<void>;

const SEEN_ID_CAP = 500;
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

interface MailWatchState {
  lastCheckIso: string;
  seenIds: string[];
}

/**
 * Dad's explicit request: stop hitting codex every 45 minutes (~32x/day) and instead run 5
 * random checks/day (~6x fewer calls). The cron tick stays frequent (every 30 min, see
 * workflows/defaults.json) purely as a scheduling heartbeat; this plan decides which ticks
 * actually do a check.
 */
const PLAN_CHECKS_PER_DAY = 5;
/** Inclusive local starting hour for planned checks. */
const PLAN_START_HOUR = 8;
/** Exclusive local ending hour for planned checks. */
const PLAN_END_HOUR = 23;

export interface MailWatchPlan {
  /** Local "YYYY-MM-DD" the plan's `times` belong to. */
  date: string;
  /** Sorted ISO timestamps, one per planned check for `date`. */
  times: string[];
  /** Indices into `times` that have already fired today. */
  fired: number[];
}

export type MailWatchTickResult = MailWatchResult | { skipped: true; reason: string; nextPlannedAt?: string };

/** Local "YYYY-MM-DD" — used to detect day rollover without any timezone library. */
function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Picks `count` distinct random minutes-of-day in `[startHour, endHour)` via a partial
 * Fisher-Yates shuffle (guarantees no duplicates in O(count) rng calls, unlike a reject-loop).
 * This is deliberately runtime randomness (Math.random by default) — not a workflow script, so
 * MASTER_PLAN's "no Math.random in generated workflow output" rule doesn't apply here. `rng` is
 * injectable so tests can assert exact slot placement.
 */
function planTimesForDate(date: Date, count: number, startHour: number, endHour: number, rng: () => number = Math.random): string[] {
  const startMinute = startHour * 60;
  const endMinute = endHour * 60;
  const available = Array.from({ length: endMinute - startMinute }, (_, index) => startMinute + index);
  for (let index = 0; index < count; index += 1) {
    const offset = Math.min(available.length - index - 1, Math.floor(Math.max(0, Math.min(0.999999999, rng())) * (available.length - index)));
    const selected = index + offset;
    [available[index], available[selected]] = [available[selected], available[index]];
  }
  return available.slice(0, count).sort((a, b) => a - b).map((minute) => {
    const slot = new Date(date);
    slot.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
    return slot.toISOString();
  });
}

export interface ParsedAlert {
  id: string;
  from: string;
  subject: string;
  what: string;
}

export interface MailWatchResult {
  alerts: string[];
  checkedAt: string;
}

/** Cheap, deterministic fallback id when the model doesn't give us a real message id. */
function subjectHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) hash = (hash * 31 + input.charCodeAt(i)) | 0;
  return `h${Math.abs(hash)}`;
}

/**
 * Defensively parses one `ALERT|<id>|<from>|<subject>|<what>` line. Returns `undefined` for
 * `NO_ALERTS`, blank lines, or anything else that doesn't match — the model's raw output is
 * never trusted structurally.
 */
export function parseAlertLine(line: string): ParsedAlert | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("ALERT|")) return undefined;
  const parts = trimmed.split("|");
  if (parts.length < 5) return undefined;
  const [, rawId, from, subject, ...rest] = parts;
  const what = rest.join("|").trim();
  const fromTrimmed = from.trim();
  const subjectTrimmed = subject.trim();
  if (!fromTrimmed || !subjectTrimmed || !what) return undefined;
  const id = rawId.trim() || subjectHash(`${fromTrimmed}|${subjectTrimmed}`);
  return { id, from: fromTrimmed, subject: subjectTrimmed, what };
}

export class MailWatchService {
  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly runner: ProviderRunner,
    private readonly notify?: MailWatchNotifier,
  ) {}

  private async readState(): Promise<MailWatchState> {
    try {
      const raw = JSON.parse(await fs.readFile(this.config.mailwatchPath, "utf8")) as Partial<MailWatchState>;
      return {
        lastCheckIso: typeof raw.lastCheckIso === "string" ? raw.lastCheckIso : new Date(Date.now() - FIRST_RUN_LOOKBACK_MS).toISOString(),
        seenIds: Array.isArray(raw.seenIds) ? raw.seenIds.filter((item): item is string => typeof item === "string") : [],
      };
    } catch {
      return { lastCheckIso: new Date(Date.now() - FIRST_RUN_LOOKBACK_MS).toISOString(), seenIds: [] };
    }
  }

  private async writeState(state: MailWatchState): Promise<void> {
    await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    const capped: MailWatchState = { lastCheckIso: state.lastCheckIso, seenIds: state.seenIds.slice(-SEEN_ID_CAP) };
    await fs.writeFile(this.config.mailwatchPath, `${JSON.stringify(capped, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(this.config.mailwatchPath, 0o600).catch(() => undefined);
  }

  async status(now: Date = new Date()): Promise<{
    lastCheckIso: string;
    seenCount: number;
    plan: { date: string; times: string[]; fired: string[]; pending: string[]; nextPlannedAt?: string };
  }> {
    const state = await this.readState();
    const currentPlan = await this.plan(now);
    const fired = currentPlan.times.filter((_, index) => currentPlan.fired.includes(index));
    const pending = currentPlan.times.filter((_, index) => !currentPlan.fired.includes(index));
    return {
      lastCheckIso: state.lastCheckIso,
      seenCount: state.seenIds.length,
      plan: { date: currentPlan.date, times: currentPlan.times, fired, pending, nextPlannedAt: pending[0] },
    };
  }

  private async readPlan(): Promise<MailWatchPlan | undefined> {
    try {
      const raw = JSON.parse(await fs.readFile(this.config.mailwatchPlanPath, "utf8")) as Partial<MailWatchPlan>;
      if (typeof raw.date !== "string" || !Array.isArray(raw.times)) return undefined;
      return {
        date: raw.date,
        times: raw.times.filter((item): item is string => typeof item === "string"),
        fired: Array.isArray(raw.fired) ? raw.fired.filter((item): item is number => typeof item === "number") : [],
      };
    } catch { return undefined; }
  }

  private async writePlan(plan: MailWatchPlan): Promise<void> {
    await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.config.mailwatchPlanPath, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(this.config.mailwatchPlanPath, 0o600).catch(() => undefined);
  }

  /**
   * Returns today's randomized check-times plan, generating a fresh one of `PLAN_CHECKS_PER_DAY`
   * times (persisted) whenever the stored plan is missing, malformed, or dated for a previous
   * local day. Idempotent within a single day — repeated calls return the same persisted plan.
   */
  async plan(now: Date = new Date(), rng: () => number = Math.random): Promise<MailWatchPlan> {
    const today = localDateKey(now);
    const existing = await this.readPlan();
    if (existing && existing.date === today && existing.times.length === PLAN_CHECKS_PER_DAY) return existing;
    const fresh: MailWatchPlan = {
      date: today,
      times: planTimesForDate(now, PLAN_CHECKS_PER_DAY, PLAN_START_HOUR, PLAN_END_HOUR, rng),
      fired: [],
    };
    await this.writePlan(fresh);
    return fresh;
  }

  /**
   * Called on every cron tick (every 30 min — see workflows/defaults.json). Regenerates the plan
   * on day rollover, then only actually runs `check()` if a planned time is now due and hasn't
   * fired yet; otherwise it's a no-op that reports the next planned time. This is what turns a
   * frequent cron tick into ~5 real codex calls/day instead of one per tick.
   */
  async tick(now: Date = new Date()): Promise<MailWatchTickResult> {
    const currentPlan = await this.plan(now);
    const dueIndex = currentPlan.times.findIndex(
      (time, index) => !currentPlan.fired.includes(index) && new Date(time).getTime() <= now.getTime(),
    );
    if (dueIndex === -1) {
      const nextPlannedAt = currentPlan.times.find((_, index) => !currentPlan.fired.includes(index));
      return { skipped: true, reason: "no planned mailwatch check due yet", nextPlannedAt };
    }
    const result = await this.check();
    // Re-read right before marking fired — never trust the copy read at the top of this call
    // (the reminders-store clobber lesson: two processes writing the same JSON).
    const fresh = await this.plan(now);
    if (!fresh.fired.includes(dueIndex)) {
      fresh.fired = [...fresh.fired, dueIndex].sort((a, b) => a - b);
      await this.writePlan(fresh);
    }
    return result;
  }

  /**
   * One ProviderRunner.run call (codex primary — it has the authed gmail MCP), read-only,
   * no fallback provider. Alerts are deduped against `data/mailwatch.json` and the state file
   * is re-read immediately before writing — the reminders-store clobber lesson (two processes
   * writing the same JSON) applies here too.
   */
  async check(): Promise<MailWatchResult> {
    const checkedAt = new Date().toISOString();
    const state = await this.readState();
    const prompt = [
      "Read-only task. Search my Gmail inbox for messages received after", state.lastCheckIso,
      "that relate to job applications: shortlisting, resume selected/rejected, interview",
      "scheduled/invitation, assessment/test invites, offer letters, recruiter outreach.",
      "DO NOT modify anything in the mailbox (no read-state, labels, drafts).",
      "For each match output exactly one line: ALERT|<message-id-or-subject-hash>|<from>|<subject>|<one-clause what it is>.",
      "Also search the same window for application-lifecycle emails: application confirmations",
      "(\"your application was sent to X\", \"thanks for applying\", \"application received\") from",
      "LinkedIn Easy Apply, Naukri, or direct company portals, plus status updates (viewed,",
      "shortlisted, assessment invite, interview scheduled) and outcomes (rejected, offer).",
      "For each such email output exactly one line: APP|<company>|<role>|<source: LinkedIn, Naukri,",
      "or direct>|<status: applied, viewed, shortlisted, assessment, interview, rejected, or",
      "offer>|<date-ish from the email>|<subject>. One email may produce both an ALERT and an APP",
      "line when it qualifies for both.",
      "If nothing matches either category, output exactly NO_ALERTS.",
    ].join(" ");

    const result = await this.runner.run(prompt, { provider: "codex", readOnly: true, role: "mailwatch" });
    const parsed: ParsedAlert[] = [];
    const appLines: string[] = [];
    for (const line of result.response.split(/\r?\n/)) {
      const alert = parseAlertLine(line);
      if (alert) parsed.push(alert);
      if (line.trim().startsWith("APP|")) appLines.push(line);
    }

    // Re-read right before writing — never trust the copy read at the top of this call.
    const fresh = await this.readState();
    const seen = new Set(fresh.seenIds);
    const alerts: string[] = [];
    for (const alert of parsed) {
      if (seen.has(alert.id)) continue;
      seen.add(alert.id);
      const message = `${alert.subject} — from ${alert.from} (${alert.what})`;
      alerts.push(message);
      if (this.notify) await this.notify(message, "Henry — job mail").catch(() => undefined);
      await this.activity.record("workflow.completed", `Job-mail alert: ${alert.subject}`, {
        mailwatch: true, id: alert.id, from: alert.from, subject: alert.subject, what: alert.what,
      });
    }

    await this.writeState({ lastCheckIso: checkedAt, seenIds: Array.from(seen) });

    // APP lines feed the job-application tracker (data/job-tracker.json + .md). Deduped via the
    // tracker's own status-history — never via seenIds above, which only guards ALERT lines.
    if (appLines.length) {
      const tracker = await updateTracker(this.config, appLines);
      for (const message of tracker.notifications) {
        if (this.notify) await this.notify(message, "Henry — job tracker").catch(() => undefined);
        await this.activity.record("workflow.completed", message, { jobTracker: true });
      }
    }

    return { alerts, checkedAt };
  }

  /**
   * One-off, read-only provider call scanning the last `days` of inbox for application-lifecycle
   * emails (same APP| format as `check()`), to seed the ledger for someone who's been applying
   * for a while before Henry started watching. Deliberately does not touch `check()`'s
   * lastCheckIso/seenIds state — this is a separate seeding sweep, not a recurring check.
   */
  async backfill(days = 30): Promise<{ appLines: number; created: number; changed: number; notifications: string[] }> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const prompt = [
      "Read-only task. Search my Gmail inbox for messages received after", since,
      "that relate to job applications: application confirmations (\"your application was sent to X\",",
      "\"thanks for applying\", \"application received\") from LinkedIn Easy Apply, Naukri, or direct",
      "company portals, plus status updates (viewed, shortlisted, assessment invite, interview",
      "scheduled) and outcomes (rejected, offer). DO NOT modify anything in the mailbox (no",
      "read-state, labels, drafts). For each match output exactly one line:",
      "APP|<company>|<role>|<source: LinkedIn, Naukri, or direct>|<status: applied, viewed,",
      "shortlisted, assessment, interview, rejected, or offer>|<date-ish from the email>|<subject>.",
      "If none, output exactly NO_ALERTS.",
    ].join(" ");

    const result = await this.runner.run(prompt, { provider: "codex", readOnly: true, role: "mailwatch-backfill" });
    const appLines = result.response.split(/\r?\n/).filter((line) => line.trim().startsWith("APP|"));
    const tracker = await updateTracker(this.config, appLines);
    for (const message of tracker.notifications) {
      if (this.notify) await this.notify(message, "Henry — job tracker").catch(() => undefined);
      await this.activity.record("workflow.completed", message, { jobTracker: true, backfill: true });
    }
    return { appLines: appLines.length, created: tracker.created, changed: tracker.changed, notifications: tracker.notifications };
  }
}
