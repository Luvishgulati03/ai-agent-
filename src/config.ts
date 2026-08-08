import dotenv from "dotenv";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Root-anchored env loading: the global `henry` bin runs from ANY cwd, and the old
// side-effect import ("dotenv/config") only read $CWD/.env — so `henry repl` launched
// outside the repo silently lost every key (Telegram went mute while the terminal 🔔
// still fired). Load the repo's own .env first, then let a cwd .env fill remaining
// gaps (dotenv never overrides already-set vars).
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
dotenv.config();

const DEFAULT_SCREENSHOT_CATEGORIES = ["work", "design-reference", "receipts", "memes", "documents", "code", "_unsorted"];

export interface HenryConfig {
  rootDir: string;
  dataDir: string;
  memoryDir: string;
  capturedMemoryDir: string;
  dbPath: string;
  activityPath: string;
  approvalsPath: string;
  settingsPath: string;
  workflowsPath: string;
  /** Directory holding markdown workflows (`*.workflow.md`) for the workflow engine. */
  workflowsDir: string;
  host: string;
  port: number;
  dashboardToken?: string;
  allowRemoteDashboard: boolean;
  provider: "codex" | "claude";
  codexModel?: string;
  claudeModel?: string;
  requireOutboundApproval: boolean;
  dadEmail?: string;
  gmailCredentialsPath: string;
  gmailTokenPath: string;
  gmailRedirectUri: string;
  knowledgeDir: string;
  knowledgeDbPath: string;
  /** Recall-event JSONL sink for src/metrics/recall-metrics.ts (docs/dashboard-design-v2.md §C). */
  metricsDir: string;
  /** Seed eval queries live here; `henry knowledge eval` writes its report to last-run.json in the same directory. */
  evalPath: string;
  jobApplicationsPath: string;
  jobProfilePath: string;
  resumeSourcePath: string;
  resumeOutputDir: string;
  browserProfileDir: string;
  browserHeadless: boolean;
  screenshotCategories: string[];
  screenshotsWatchDir: string;
  screenshotsSortedDir: string;
  whisperModelPath?: string;
  meetingsDir: string;
  goalsDir: string;
  remindersPath: string;
  socialDir: string;
  /** Operator-notification channel only (never a general send-to-anyone surface). */
  telegramBotToken?: string;
  telegramChatId?: string;
  /** The team standup group — the ONLY chat the standup poller reads and the group sender writes. */
  telegramStandupChatId?: string;
  standupDbPath: string;
  /** Rendered per-day standup summaries Luvish actually reads (`data/standups/<date>.md`). */
  standupsDir: string;
  mailwatchPath: string;
  /** Today's randomized check-times plan (§ mailwatch tick planner) — separate file so a corrupt/racy write never touches the dedupe state in `mailwatchPath`. */
  mailwatchPlanPath: string;
  /** Canonical job-application ledger (keyed company+role, status history) — the source of truth `job-tracker.md` is regenerated from. */
  jobTrackerPath: string;
  /** Human-readable ledger Luvish actually reads — regenerated from `jobTrackerPath` after every update. */
  jobTrackerMarkdownPath: string;
  draftRepliesDir: string;
}

const thisFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(thisFile), "..");

/** Reads HENRY_<name>, falling back to the legacy LAVU_<name> spelling. */
function env(name: string): string | undefined {
  return process.env[`HENRY_${name}`] ?? process.env[`LAVU_${name}`];
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function resolveFromRoot(rootDir: string, value: string | undefined, fallback: string): string {
  const selected = value || fallback;
  return path.isAbsolute(selected) ? selected : path.resolve(rootDir, selected);
}

/** Expands a leading `~` (or `~/...`) to the current user's home directory. */
function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseScreenshotCategories(value: string | undefined): string[] {
  if (!value) return DEFAULT_SCREENSHOT_CATEGORIES;
  const parsed = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return parsed.length ? parsed : DEFAULT_SCREENSHOT_CATEGORIES;
}

export function loadConfig(rootDir = defaultRoot): HenryConfig {
  const dataDir = resolveFromRoot(rootDir, env("DATA_DIR"), "data");
  const memoryDir = resolveFromRoot(rootDir, env("MEMORY_DIR"), "memory");
  return {
    rootDir,
    dataDir,
    memoryDir,
    capturedMemoryDir: path.join(memoryDir, "captured"),
    dbPath: path.join(dataDir, "engram.db"),
    activityPath: path.join(dataDir, "activity.jsonl"),
    approvalsPath: path.join(dataDir, "approvals.json"),
    settingsPath: path.join(dataDir, "settings.json"),
    workflowsPath: resolveFromRoot(rootDir, env("WORKFLOWS_PATH"), "workflows/defaults.json"),
    workflowsDir: resolveFromRoot(rootDir, env("WORKFLOWS_DIR"), "workflows"),
    host: env("HOST") || "127.0.0.1",
    port: Number(env("PORT") || 7337),
    dashboardToken: env("DASHBOARD_TOKEN") || undefined,
    allowRemoteDashboard: bool(env("ALLOW_REMOTE_DASHBOARD"), false),
    provider: env("PROVIDER") === "claude" ? "claude" : "codex",
    codexModel: env("CODEX_MODEL") || undefined,
    claudeModel: env("CLAUDE_MODEL") || undefined,
    requireOutboundApproval: bool(env("REQUIRE_OUTBOUND_APPROVAL"), true),
    dadEmail: process.env.DAD_EMAIL || undefined,
    gmailCredentialsPath: resolveFromRoot(rootDir, process.env.GMAIL_CREDENTIALS_PATH, "data/gmail-credentials.json"),
    gmailTokenPath: resolveFromRoot(rootDir, process.env.GMAIL_TOKEN_PATH, "data/gmail-token.json"),
    gmailRedirectUri: process.env.GMAIL_REDIRECT_URI || "http://127.0.0.1:43821/oauth2callback",
    knowledgeDir: resolveFromRoot(rootDir, env("KNOWLEDGE_DIR"), "knowledge"),
    knowledgeDbPath: path.join(dataDir, "knowledge.db"),
    metricsDir: path.join(dataDir, "metrics"),
    evalPath: path.join(dataDir, "eval", "queries.json"),
    jobApplicationsPath: path.join(dataDir, "job-applications.json"),
    jobProfilePath: resolveFromRoot(rootDir, env("JOB_PROFILE_PATH"), "application-profile.md"),
    resumeSourcePath: resolveFromRoot(rootDir, env("RESUME_SOURCE_PATH"), "resume.md"),
    resumeOutputDir: path.join(dataDir, "resumes"),
    browserProfileDir: resolveFromRoot(rootDir, env("BROWSER_PROFILE_DIR"), "data/browser-profile"),
    browserHeadless: bool(env("BROWSER_HEADLESS"), false),
    screenshotCategories: parseScreenshotCategories(env("SCREENSHOT_CATEGORIES")),
    screenshotsWatchDir: path.resolve(expandHome(env("SCREENSHOTS_DIR") || "~/Desktop")),
    screenshotsSortedDir: path.resolve(expandHome(env("SCREENSHOTS_SORTED_DIR") || "~/Pictures/sorted-screenshots")),
    whisperModelPath: env("WHISPER_MODEL") || undefined,
    meetingsDir: path.join(dataDir, "meetings"),
    goalsDir: path.join(dataDir, "goals"),
    remindersPath: path.join(dataDir, "reminders.json"),
    socialDir: path.join(dataDir, "social"),
    telegramBotToken: env("TELEGRAM_BOT_TOKEN") || undefined,
    telegramChatId: env("TELEGRAM_CHAT_ID") || undefined,
    telegramStandupChatId: env("TELEGRAM_STANDUP_CHAT_ID") || undefined,
    standupDbPath: path.join(dataDir, "standups.db"),
    standupsDir: path.join(dataDir, "standups"),
    mailwatchPath: path.join(dataDir, "mailwatch.json"),
    mailwatchPlanPath: path.join(dataDir, "mailwatch-plan.json"),
    jobTrackerPath: path.join(dataDir, "job-tracker.json"),
    jobTrackerMarkdownPath: path.join(dataDir, "job-tracker.md"),
    draftRepliesDir: path.join(dataDir, "drafts"),
  };
}
