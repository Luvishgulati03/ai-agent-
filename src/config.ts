import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface LavuConfig {
  rootDir: string;
  dataDir: string;
  memoryDir: string;
  capturedMemoryDir: string;
  dbPath: string;
  activityPath: string;
  approvalsPath: string;
  workflowsPath: string;
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
}

const thisFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(thisFile), "..");

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function resolveFromRoot(rootDir: string, value: string | undefined, fallback: string): string {
  const selected = value || fallback;
  return path.isAbsolute(selected) ? selected : path.resolve(rootDir, selected);
}

export function loadConfig(rootDir = defaultRoot): LavuConfig {
  const dataDir = resolveFromRoot(rootDir, process.env.LAVU_DATA_DIR, "data");
  const memoryDir = resolveFromRoot(rootDir, process.env.LAVU_MEMORY_DIR, "memory");
  return {
    rootDir,
    dataDir,
    memoryDir,
    capturedMemoryDir: path.join(memoryDir, "captured"),
    dbPath: path.join(dataDir, "engram.db"),
    activityPath: path.join(dataDir, "activity.jsonl"),
    approvalsPath: path.join(dataDir, "approvals.json"),
    workflowsPath: resolveFromRoot(rootDir, process.env.LAVU_WORKFLOWS_PATH, "workflows/defaults.json"),
    host: process.env.LAVU_HOST || "127.0.0.1",
    port: Number(process.env.LAVU_PORT || 7337),
    dashboardToken: process.env.LAVU_DASHBOARD_TOKEN || undefined,
    allowRemoteDashboard: bool(process.env.LAVU_ALLOW_REMOTE_DASHBOARD, false),
    provider: process.env.LAVU_PROVIDER === "claude" ? "claude" : "codex",
    codexModel: process.env.LAVU_CODEX_MODEL || undefined,
    claudeModel: process.env.LAVU_CLAUDE_MODEL || undefined,
    requireOutboundApproval: bool(process.env.LAVU_REQUIRE_OUTBOUND_APPROVAL, true),
    dadEmail: process.env.DAD_EMAIL || undefined,
    gmailCredentialsPath: resolveFromRoot(rootDir, process.env.GMAIL_CREDENTIALS_PATH, "data/gmail-credentials.json"),
    gmailTokenPath: resolveFromRoot(rootDir, process.env.GMAIL_TOKEN_PATH, "data/gmail-token.json"),
    gmailRedirectUri: process.env.GMAIL_REDIRECT_URI || "http://127.0.0.1:43821/oauth2callback",
  };
}
