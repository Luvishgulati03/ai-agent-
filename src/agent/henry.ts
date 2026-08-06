import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { HenryMemory } from "../memory/engram.ts";
import type { KnowledgeBase } from "../knowledge/store.ts";
import { classifyIntentTier } from "./intent.ts";
import { detectKnowledgeDomain } from "../knowledge/router.ts";
import { ProviderRunner, type RunOptions } from "../providers/runner.ts";
import { redactSecrets } from "../util/env.ts";
import { OUTBOUND_EMAIL_APPROVAL_GUARDRAIL } from "../guardrails.ts";

async function readText(path: string): Promise<string> {
  try { return await fs.readFile(path, "utf8"); } catch { return ""; }
}

export class HenryAgent {
  private readonly runner: ProviderRunner;

  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly memory: HenryMemory,
    // Lazy provider (not the instance itself) so a plain HenryAgent construction
    // never forces the knowledge DB open; runtime.ts wires this to its lazy accessor.
    private readonly knowledgeProvider?: () => KnowledgeBase,
  ) { this.runner = new ProviderRunner(config, activity); }

  /** Assembles the full provider prompt without invoking the provider — the testable seam. */
  /**
   * fresh=true builds the full prompt (soul/persona/instructions + dynamic
   * context). fresh=false (a resumed provider session already holds the static
   * blocks) sends only a compact safety header + dynamic context + the request —
   * the prompt-diet half of session reuse (latency §11.5 #2+#3).
   */
  async buildPrompt(prompt: string, runId: string, fresh = true): Promise<string> {
    const soul = await readText(`${this.config.rootDir}/soul.md`);
    const persona = await readText(`${this.config.rootDir}/personality.md`);
    const instructions = await readText(`${this.config.rootDir}/AGENTS.md`);
    let context = "No relevant memories were recalled.";
    try { context = await this.memory.context(prompt, 8) || context; } catch (error) {
      await this.activity.record("run.failed", "Memory recall failed; continuing without memory", { error: String(error) }, { runId });
    }
    let knowledgeBlock = "";
    const domain = detectKnowledgeDomain(prompt);
    if (domain && this.knowledgeProvider) {
      try { knowledgeBlock = await this.knowledgeProvider().context(prompt, { domain, budgetChars: 6000 }); } catch (error) {
        await this.activity.record("run.failed", "Knowledge recall failed; continuing without it", { error: String(error) }, { runId });
      }
    }
    const slimHeader = [
      "You are Henry (session resumed — your soul, personality, and operating rules from earlier in this session still apply).",
      "Never send anything outbound without Dad's explicit approval; stage it instead.",
    ];
    const staticBlocks = [
      "You are Henry, Luvish Junior, a terminal-first personal engineering agent.",
      "Call the user Dad. Luna is the top-level orchestrator and may delegate specialist work to you.",
      OUTBOUND_EMAIL_APPROVAL_GUARDRAIL,
      "The approval and execution steps are separate. Never approve an action on Dad's behalf, and never treat a send command as approval.",
      "Investigate briefly before asking a question. Be kind, sarcastic, appealing, and useful.",
      "You have your OWN CLI capabilities in this repository. When Dad's request matches one, EXECUTE it with the shell (cwd is the repo root) instead of describing it, then report the actual output:",
      "- reminders (one-shot): `npx tsx src/cli.ts remind \"<text>\" --at \"YYYY-MM-DD HH:mm\"` (or --in 20m/2h). \"send me a hi at 9:50\" → one-shot --at/--in with the literal text as the message.",
      "- reminders (recurring): add `--every \"<cron>\"` instead of --at/--in, e.g. `remind \"standup\" --every \"0 9 * * 1-5\"`. \"every day/weekday/Monday...\" phrasing maps to --every with the matching 5-field cron; these re-arm after firing and only stop via `remind cancel <id>`.",
      "- reminders (random daily): use `--random-daily 5` for exactly five randomized local-time checks per day; these re-arm with fresh slots each day and stop via `remind cancel <id>`.\n",
      "- reminders (prompt jobs): use `--prompt \"<instruction>\"` instead of literal text when the reminder should generate fresh content at fire time (e.g. \"wish Dad good morning with one useful thing from memory\") — combine with --at/--in/--every, e.g. `remind --prompt \"...\" --every \"30 7 * * *\"`. At fire time Henry runs the instruction and delivers the response, not the instruction text.",
      "- list/cancel: `remind list` (shows kind, cron, nextFireAt); `remind cancel <id>`. Reminders fire inside any running Henry process (repl, dashboard, or the schedule daemon) — no second process needed.",
      "- \"draft X and send it at <time>\" is a THREE-step flow, never a direct send: (1) create the draft — `npx tsx src/cli.ts gmail draft --to ... --subject ... --body ...` — and note the approvalId it prints; (2) tell Dad to review and approve it (`henry approve approve <approvalId>`) — Henry never approves on Dad's behalf; (3) schedule the send with `npx tsx src/cli.ts remind --execute-approval <approvalId> --at \"YYYY-MM-DD HH:mm\"` (or --in). Make clear to Dad that the send only actually happens if the approval is approved by fire time — if it's still pending, the scheduled job skips the send (never retries) and just notifies that it was skipped.",
      "- cover letter PDF: `npx tsx src/cli.ts cover <job-url-or-jd>`; resume edits: `npx tsx src/cli.ts resume edit \"<instructions>\"`.",
      "- knowledge (founder playbooks): `npx tsx src/cli.ts knowledge search|context \"<query>\"`; memory: `npx tsx src/cli.ts memory search|remember`.",
      "- goals: `npx tsx src/cli.ts goal \"<goal>\"`; linkedin drafts: `npx tsx src/cli.ts linkedin <topic>`; screenshots: `npx tsx src/cli.ts screenshots backlog`.",
      "- jobs: `npx tsx src/cli.ts jobs inspect|prepare <url>`. Anything outbound still lands in the approval queue, never sent directly.",
      "- job-mail watching: runs automatically every 45min via the scheduler daemon (`mail.watch` in workflows/defaults.json) — it reads Gmail read-only and notifies (console/osascript/Telegram) on shortlisting, interview, assessment, or offer emails. Manual run: `npx tsx src/cli.ts mailwatch check`; last-check time: `npx tsx src/cli.ts mailwatch status`.",
      "- gmail (via your own MCP tools when running on codex): you can READ inbox/threads and summarize/triage directly in conversation, and you may create DRAFTS. HARD RULE: NEVER send, reply, forward, or modify labels/read-state via MCP gmail tools — sending goes ONLY through the approval queue (npx tsx src/cli.ts gmail draft ... then Dad approves). If asked to send, stage it and say so.",
      "- \"draft replies to my emails\": run `npx tsx src/cli.ts gmail draftreplies` (optionally `--limit N`) — this reads unread inbox mail, drafts replies in Dad's voice, and creates real Gmail drafts (never sends). Report the actual summary it prints (how many drafted, the local review file path).",
      "\n--- soul.md (non-negotiable operating contract) ---\n", soul,
      "\n--- personality.md ---\n", persona,
      "\n--- AGENTS.md ---\n", instructions,
    ].filter(Boolean);
    const dynamicTail = [
      "\n--- recalled Engram context ---\n", context,
      ...(knowledgeBlock ? ["\n", knowledgeBlock] : []),
      "\n--- Dad's request ---\n", prompt,
      "\nReturn a clear answer and state any action that was intentionally staged for approval.",
    ];
    return [...(fresh ? staticBlocks : slimHeader), ...dynamicTail].join("\n");
  }

  async run(prompt: string, options: RunOptions = {}): Promise<Awaited<ReturnType<ProviderRunner["run"]>>> {
    const runId = randomUUID();
    // Surface sessions (latency §11.5): resumed turns send a slim prompt — the
    // provider session already holds the static soul/persona blocks.
    // Trivial chatter rides t0 (latency §11.5 #5); explicit caller tier always wins.
    const tier = options.tier ?? classifyIntentTier(prompt);
    // t0 turns bypass sessions: resuming a session with a different --model is
    // rejected by claude, and a fresh haiku one-off is fast enough by itself.
    const surface = tier === "t0" ? undefined : options.surface;
    const session = surface ? this.runner.acquireSession(surface, options.provider) : undefined;
    const fullPrompt = await this.buildPrompt(prompt, runId, session ? session.fresh : true);
    let result = await this.runner.run(fullPrompt, { ...options, surface, tier, session, onEvent: (event) => options.onEvent?.(event) });
    if (surface && session && !session.fresh && (result as { sessionReset?: boolean }).sessionReset) {
      // Provider evicted the session mid-stream: rebuild fresh once with the full prompt.
      const retrySession = this.runner.acquireSession(surface, options.provider);
      const retryPrompt = await this.buildPrompt(prompt, runId, true);
      result = await this.runner.run(retryPrompt, { ...options, surface, tier, session: retrySession, onEvent: (event) => options.onEvent?.(event) });
    }
    if (result.response.trim()) {
      // Fire-and-forget (latency §11.5 #4): the reply reaches Dad immediately; capture
      // finishes in the background. A process exiting instantly after a turn may drop
      // this one capture — acceptable for interactive speed.
      void this.memory.remember(redactSecrets(`Dad asked: ${prompt}\n\nHenry answered:\n${result.response}`), {
        source: `captured/${new Date().toISOString().slice(0, 10)}-conversation.md`,
        tier: "episodic", importance: 5, metadata: { runId, provider: result.provider },
      }).catch((error) => void this.activity.record("run.failed", "Post-turn memory capture failed", { error: String(error) }, { runId }));
    }
    return result;
  }

  get providerRunner(): ProviderRunner { return this.runner; }
}
