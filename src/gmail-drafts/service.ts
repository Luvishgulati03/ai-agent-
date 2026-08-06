import fs from "node:fs/promises";
import path from "node:path";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { ProviderRunner } from "../providers/runner.ts";

/** Same shape as reminders'/mailwatch's notifier — kept local so this module never imports another module directly (doctrine rule 7). */
export type DraftRepliesNotifier = (message: string, title?: string) => Promise<void>;

export interface DraftedReplySummary {
  to: string;
  subject: string;
  preview: string;
}

export interface DraftRepliesResult {
  drafted: DraftedReplySummary[];
  skipped: number;
  localPath: string;
}

interface DraftBlock {
  to: string;
  subject: string;
  body: string;
}

/**
 * Defensively parses one `DRAFTED|<to>|<subject>|<preview>` summary line. Returns `undefined`
 * for `NO_REPLIES_NEEDED`, blank lines, or anything malformed — the model's raw output is
 * never trusted structurally (mirrors mailwatch's `parseAlertLine`).
 */
export function parseDraftedLine(line: string): DraftedReplySummary | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("DRAFTED|")) return undefined;
  const parts = trimmed.split("|");
  if (parts.length < 4) return undefined;
  const [, rawTo, rawSubject, ...rest] = parts;
  const to = rawTo.trim();
  const subject = rawSubject.trim();
  const preview = rest.join("|").trim();
  if (!to || !subject || !preview) return undefined;
  return { to, subject, preview };
}

/**
 * Defensively extracts `DRAFT_BEGIN ... DRAFT_END` full-body blocks from the model's raw
 * response. A malformed/incomplete block is simply not matched — never partially trusted.
 */
export function parseDraftBlocks(response: string): DraftBlock[] {
  const blocks: DraftBlock[] = [];
  const regex = /DRAFT_BEGIN\s*\r?\nTo:\s*(.*)\r?\nSubject:\s*(.*)\r?\nBody:\s*\r?\n([\s\S]*?)\r?\nDRAFT_END/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(response))) {
    const to = match[1].trim();
    const subject = match[2].trim();
    const body = match[3].trim();
    if (to && subject && body) blocks.push({ to, subject, body });
  }
  return blocks;
}

/** First few non-empty lines of the resume, used as light context rather than the full document. */
async function resumeSummary(resumePath: string, lines = 5): Promise<string> {
  try {
    const text = await fs.readFile(resumePath, "utf8");
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, lines).join("\n");
  } catch {
    return "";
  }
}

async function readText(filePath: string): Promise<string> {
  try { return await fs.readFile(filePath, "utf8"); } catch { return ""; }
}

export class DraftRepliesService {
  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly runner: ProviderRunner,
    private readonly notify?: DraftRepliesNotifier,
  ) {}

  /**
   * ONE ProviderRunner.run (codex — it has the authed gmail MCP). The model reads unread
   * inbox mail, drafts replies in Dad's voice, and creates real Gmail DRAFTS (never sends,
   * never touches read-state/labels). Full bodies are written to a local markdown file for
   * audit/review alongside the Gmail drafts themselves.
   */
  async draftReplies(limit = 5): Promise<DraftRepliesResult> {
    const persona = await readText(path.join(this.config.rootDir, "personality.md"));
    const summary = await resumeSummary(this.config.resumeSourcePath);

    const prompt = [
      `Read my ${limit} most recent UNREAD inbox emails that genuinely need a reply — skip newsletters, receipts, notifications, and automated blasts.`,
      "For each one worth replying to: draft a reply in Dad's voice (persona below) — concise, direct, no corporate filler. Never invent facts, commitments, dates, or numbers you don't have; use [placeholder] for anything unknown.",
      "Then CREATE A GMAIL DRAFT for it via the gmail MCP draft-creation tool, threaded to the original message. NEVER send. NEVER modify read-state or labels.",
      "For every drafted reply, output a block in EXACTLY this format (nothing else on the DRAFT_BEGIN/DRAFT_END lines):",
      "DRAFT_BEGIN",
      "To: <recipient email address>",
      "Subject: <reply subject line>",
      "Body:",
      "<the full reply body, may span multiple lines>",
      "DRAFT_END",
      "After ALL the blocks, output exactly one summary line per draft: DRAFTED|<to>|<subject>|<first 80 chars of the reply>",
      "If nothing needs a reply, output exactly NO_REPLIES_NEEDED and nothing else.",
      `\n--- Dad's voice (personality.md) ---\n${persona || "n/a"}`,
      `\n--- resume summary ---\n${summary || "n/a"}`,
    ].join("\n");

    const result = await this.runner.run(prompt, { provider: "codex", role: "draft-replies" });
    const response = result.response;

    const drafted: DraftedReplySummary[] = [];
    let skipped = 0;
    for (const line of response.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("DRAFTED|")) continue;
      const parsed = parseDraftedLine(trimmed);
      if (parsed) drafted.push(parsed); else skipped += 1;
    }
    const blocks = parseDraftBlocks(response);

    const localPath = await this.writeLocalDrafts(blocks.length ? blocks : drafted.map((item) => ({ to: item.to, subject: item.subject, body: item.preview })));

    await this.activity.record("gmail.drafted", `Drafted ${drafted.length} email replies`, {
      count: drafted.length, skipped, localPath,
    });

    if (drafted.length) {
      const message = `Drafted ${drafted.length} replies — review in Gmail drafts`;
      if (this.notify) await this.notify(message, "Henry — email drafts").catch(() => undefined);
    }

    return { drafted, skipped, localPath };
  }

  private async writeLocalDrafts(entries: DraftBlock[]): Promise<string> {
    await fs.mkdir(this.config.draftRepliesDir, { recursive: true, mode: 0o700 });
    const date = new Date().toISOString().slice(0, 10);
    const localPath = path.join(this.config.draftRepliesDir, `replies-${date}.md`);
    const body = entries.length
      ? entries.map((entry, index) => [
          `## ${index + 1}. ${entry.subject}`,
          `**To:** ${entry.to}`,
          "",
          entry.body,
          "",
          "---",
        ].join("\n")).join("\n")
      : "No replies were needed today.\n";
    await fs.writeFile(localPath, `# Drafted replies — ${date}\n\n${body}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(localPath, 0o600).catch(() => undefined);
    return localPath;
  }
}
