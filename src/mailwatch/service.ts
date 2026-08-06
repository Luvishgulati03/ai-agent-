import fs from "node:fs/promises";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { ProviderRunner } from "../providers/runner.ts";

/** Same shape as reminders' `ReminderNotifier` — kept local so this module never imports the reminders module directly (doctrine rule 7). */
export type MailWatchNotifier = (message: string, title?: string) => Promise<void>;

const SEEN_ID_CAP = 500;
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

interface MailWatchState {
  lastCheckIso: string;
  seenIds: string[];
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

  async status(): Promise<{ lastCheckIso: string; seenCount: number }> {
    const state = await this.readState();
    return { lastCheckIso: state.lastCheckIso, seenCount: state.seenIds.length };
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
      "If none, output exactly NO_ALERTS.",
    ].join(" ");

    const result = await this.runner.run(prompt, { provider: "codex", readOnly: true, role: "mailwatch" });
    const parsed: ParsedAlert[] = [];
    for (const line of result.response.split(/\r?\n/)) {
      const alert = parseAlertLine(line);
      if (alert) parsed.push(alert);
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
    return { alerts, checkedAt };
  }
}
