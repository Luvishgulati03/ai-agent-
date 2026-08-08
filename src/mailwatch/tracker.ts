import fs from "node:fs/promises";
import type { HenryConfig } from "../config.ts";

/** Same rails as `service.ts`'s `MailWatchNotifier` — no shared type, kept local (doctrine rule 7). */

export const APP_STATUSES = ["applied", "viewed", "shortlisted", "assessment", "interview", "rejected", "offer"] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

function isAppStatus(value: string): value is AppStatus {
  return (APP_STATUSES as readonly string[]).includes(value);
}

export interface ParsedApp {
  company: string;
  role: string;
  source: string;
  status: AppStatus;
  dateText: string;
  subject: string;
}

/**
 * Defensively parses one `APP|<company>|<role>|<source>|<status>|<date-ish>|<subject>` line —
 * mirrors `parseAlertLine`'s discipline in `service.ts`. The model's raw output is never trusted
 * structurally: missing fields, an unknown status, or a short/garbage line all return `undefined`.
 */
export function parseAppLine(line: string): ParsedApp | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("APP|")) return undefined;
  const parts = trimmed.split("|");
  if (parts.length < 7) return undefined;
  const [, rawCompany, rawRole, rawSource, rawStatus, rawDate, ...rest] = parts;
  const company = rawCompany.trim().replace(/\|/g, "/");
  const role = rawRole.trim().replace(/\|/g, "/");
  const source = rawSource.trim().replace(/\|/g, "/");
  const status = rawStatus.trim().toLowerCase();
  const dateText = rawDate.trim();
  const subject = rest.join("|").trim();
  if (!company || !role || !source || !subject) return undefined;
  if (!isAppStatus(status)) return undefined;
  return { company, role, source, status, dateText: dateText || "unknown", subject };
}

export interface TrackerHistoryEntry {
  status: AppStatus;
  /** The "date-ish" text lifted from the email — never parsed into a real Date (too unreliable across providers). */
  dateText: string;
  subject: string;
  /** ISO timestamp of when Henry actually recorded this transition. */
  recordedAt: string;
}

export interface TrackerEntry {
  /** `company::role`, lowercased — the identity key applications are deduped and updated on. */
  key: string;
  company: string;
  role: string;
  source: string;
  status: AppStatus;
  appliedAt: string;
  lastUpdate: string;
  history: TrackerHistoryEntry[];
}

export interface TrackerState {
  entries: TrackerEntry[];
}

/** One concrete application event (new application or status transition) — the unit the memory layer records. */
export interface TrackerAppEvent {
  company: string;
  role: string;
  status: AppStatus;
  subject: string;
  dateText: string;
  isNew: boolean;
}

export interface TrackerUpdateResult {
  /** One "📋 Application update: ..." message per genuinely new application or status transition. */
  notifications: string[];
  created: number;
  changed: number;
  /** Mirrors notifications 1:1 with structured data, so callers can memorize transitions. */
  events: TrackerAppEvent[];
}

export interface TrackerSummary {
  jsonPath: string;
  markdownPath: string;
  total: number;
  byStatus: Record<AppStatus, number>;
}

function entryKey(company: string, role: string): string {
  return `${company.trim().toLowerCase()}::${role.trim().toLowerCase()}`;
}

function isTrackerEntry(value: unknown): value is TrackerEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TrackerEntry>;
  return (
    typeof candidate.key === "string" &&
    typeof candidate.company === "string" &&
    typeof candidate.role === "string" &&
    typeof candidate.source === "string" &&
    typeof candidate.status === "string" && isAppStatus(candidate.status) &&
    typeof candidate.appliedAt === "string" &&
    typeof candidate.lastUpdate === "string" &&
    Array.isArray(candidate.history)
  );
}

async function readTrackerState(config: HenryConfig): Promise<TrackerState> {
  try {
    const raw = JSON.parse(await fs.readFile(config.jobTrackerPath, "utf8")) as Partial<TrackerState>;
    const entries = Array.isArray(raw.entries) ? raw.entries.filter(isTrackerEntry) : [];
    return { entries };
  } catch {
    return { entries: [] };
  }
}

async function writeTrackerState(config: HenryConfig, state: TrackerState): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(config.jobTrackerPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(config.jobTrackerPath, 0o600).catch(() => undefined);
  // The .md is the artifact Luvish actually reads — no restrictive mode, same as cover letters / linkedin drafts.
  await fs.writeFile(config.jobTrackerMarkdownPath, renderMarkdown(state), "utf8");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "/").trim() || "—";
}

/** Renders the canonical ledger: a table sorted by last-update desc, plus a per-application history section. */
export function renderMarkdown(state: TrackerState, now: Date = new Date()): string {
  const sorted = [...state.entries].sort((a, b) => (b.lastUpdate || "").localeCompare(a.lastUpdate || ""));
  const lines: string[] = ["# Job Application Tracker", "", `_Last regenerated: ${now.toISOString()}_`, ""];
  if (sorted.length === 0) {
    lines.push(
      "No applications tracked yet. Run `npx tsx src/cli.ts mailwatch backfill --days 30` to seed this ledger from recent inbox history, or wait for the next scheduled mailwatch check.",
      "",
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push("| Company | Role | Source | Current status | Applied | Last update |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const entry of sorted) {
    lines.push(
      `| ${escapeCell(entry.company)} | ${escapeCell(entry.role)} | ${escapeCell(entry.source)} | ${escapeCell(entry.status)} | ${escapeCell(entry.appliedAt)} | ${escapeCell(entry.lastUpdate)} |`,
    );
  }
  lines.push("", "## History", "");
  for (const entry of sorted) {
    lines.push(`### ${entry.company} — ${entry.role}`);
    for (const item of entry.history) {
      lines.push(`- ${escapeCell(item.dateText)} — **${item.status}** — "${item.subject}" (${entry.source}, recorded ${item.recordedAt})`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Applies `APP|...` lines (from either `check()`'s live scan or `backfill()`'s wider sweep) to
 * the canonical ledger, then regenerates `job-tracker.md`. Dedupe is via the tracker's own
 * history — not mailwatch's `seenIds` — so a re-seen "applied" email for a company+role that's
 * already tracked at that status is a no-op, but a *different* status for the same
 * company+role always appends a new history entry and is reported back for notification.
 * Re-reads the state file immediately before writing (the reminders-store clobber lesson).
 */
export async function updateTracker(config: HenryConfig, lines: string[]): Promise<TrackerUpdateResult> {
  const parsed = lines.map(parseAppLine).filter((item): item is ParsedApp => item !== undefined);
  if (parsed.length === 0) return { notifications: [], created: 0, changed: 0, events: [] };

  const state = await readTrackerState(config);
  const notifications: string[] = [];
  const events: TrackerAppEvent[] = [];
  let created = 0;
  let changed = 0;
  const now = new Date().toISOString();

  for (const app of parsed) {
    const key = entryKey(app.company, app.role);
    const entry = state.entries.find((candidate) => candidate.key === key);
    if (!entry) {
      state.entries.push({
        key, company: app.company, role: app.role, source: app.source, status: app.status,
        appliedAt: app.dateText, lastUpdate: now,
        history: [{ status: app.status, dateText: app.dateText, subject: app.subject, recordedAt: now }],
      });
      created += 1;
      notifications.push(`📋 Application update: ${app.company} ${app.role} → ${app.status}`);
      events.push({ company: app.company, role: app.role, status: app.status, subject: app.subject, dateText: app.dateText, isNew: true });
      continue;
    }
    const lastStatus = entry.history[entry.history.length - 1]?.status;
    if (lastStatus === app.status) continue; // already-seen status for this application — no-op, no notify
    entry.company = app.company;
    entry.role = app.role;
    entry.source = app.source || entry.source;
    entry.status = app.status;
    entry.lastUpdate = now;
    entry.history.push({ status: app.status, dateText: app.dateText, subject: app.subject, recordedAt: now });
    changed += 1;
    notifications.push(`📋 Application update: ${app.company} ${app.role} → ${app.status}`);
    events.push({ company: app.company, role: app.role, status: app.status, subject: app.subject, dateText: app.dateText, isNew: false });
  }

  if (created > 0 || changed > 0) await writeTrackerState(config, state);
  return { notifications, created, changed, events };
}

/** Read-only summary for `henry mailwatch tracker` — never writes. */
export async function trackerSummary(config: HenryConfig): Promise<TrackerSummary> {
  const state = await readTrackerState(config);
  const byStatus = Object.fromEntries(APP_STATUSES.map((status) => [status, 0])) as Record<AppStatus, number>;
  for (const entry of state.entries) byStatus[entry.status] += 1;
  return { jsonPath: config.jobTrackerPath, markdownPath: config.jobTrackerMarkdownPath, total: state.entries.length, byStatus };
}
