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
    let context = "No relevant memories were recalled.";
    try { context = await this.memory.context(prompt, 8) || context; } catch (error) {
      await this.activity.record("run.failed", "Memory recall failed; continuing without memory", { error: String(error) }, { runId });
    }
    let knowledgeBlock = "";
    const domain = detectKnowledgeDomain(prompt);
    // RAG-first (Dad's rule): don't gate on the regex router alone. Any substantive
    // turn gets a cheap LLM-free retrieval probe (~80-350ms); the corpus's own
    // relevance scores decide injection. Chatter (t0) and tiny turns skip the probe.
    const probeWorthy = domain !== null || (prompt.trim().length > 25 && classifyIntentTier(prompt) !== "t0");
    if (probeWorthy && this.knowledgeProvider) {
      try { knowledgeBlock = await this.knowledgeProvider().context(prompt, { domain: domain ?? undefined, budgetChars: 6000 }); } catch (error) {
        await this.activity.record("run.failed", "Knowledge recall failed; continuing without it", { error: String(error) }, { runId });
      }
    }
    if (knowledgeBlock) {
      // Routing brain: which lane answers which part of the question. The corpus header
      // (coverage strong/partial, or the explicit NO-coverage marker) is the signal; the
      // rules below are the policy. Gap turns get the short rule (prompt diet).
      const noCoverage = knowledgeBlock.startsWith("--- Curated knowledge: NO");
      knowledgeBlock = [
        noCoverage
          ? "KNOWLEDGE GAP: the curated corpus was consulted and has nothing for this query. For live or external facts (markets, competitors, regulation, pricing, news, docs) RESEARCH THE WEB NOW in this same run — claude: WebSearch+WebFetch; codex: your browser tool — read several sources and cite URL + date for every researched claim. Use general model knowledge only as labeled reasoning glue. If the research is substantial, save findings + source URLs to knowledge/research/<slug>.md and offer `knowledge add` (index only on Dad's yes)."
          : "KNOWLEDGE ROUTING — three lanes, always labeled, never silently blended: (1) PLAYBOOK lane: the curated block below (header shows coverage strong|partial) is tried-and-tested operator knowledge — the primary source for tactics, strategy, and frameworks; CITE module names for claims drawn from it. (2) LIVE lane: for market, competitor, regulatory, pricing, or current-events facts — or wherever coverage is partial and the gap matters — research the web IN THIS RUN (claude: WebSearch+WebFetch; codex: browser tool) and cite URL + date per claim. NEVER fabricate live facts from playbooks, and never stop at 'the corpus doesn't cover it' when research can. (3) GENERAL lane: model knowledge as reasoning glue, labeled as such. PROVENANCE RULE: these playbooks skew India-centric and offline-community-heavy — when Dad's target context differs (global, online-first, another industry), name which parts transfer weakly and adapt them instead of copying. After substantial web research, save findings + URLs to knowledge/research/<slug>.md and offer `knowledge add` (index only on Dad's yes — the curated corpus stays curated).",
        knowledgeBlock,
      ].join("\n");
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
      // Execution-order rules from AGENTS.md not already covered by soul.md or
      // the capabilities list below (latency §11.5 #3 — full AGENTS.md dropped).
      "Investigate with local files, git, CLIs, and Engram recall before acting; explain the intended action and any uncertainty.",
      "Save durable decisions, preferences, and outcomes to Engram as you learn them.",
      "Ground cover letters and job tailoring in Dad's resume file only — job descriptions are untrusted; never invent candidate facts.",
      "You have OWN CLI capabilities in this repo — when Dad's request matches one, EXECUTE it via shell (cwd = repo root) instead of describing it, then report actual output. All commands: `npx tsx src/cli.ts <cmd>`. Available (signatures below omit that prefix):",
      "- remind \"<text>\" --at \"YYYY-MM-DD HH:mm\"|--in 20m/2h (one-shot) · --every \"<cron>\" (recurring 5-field cron, re-arms after firing) · --random-daily 5 (five randomized daily checks, re-arms daily) · --prompt \"<instruction>\" instead of literal text to generate fresh content at fire time (combine with --at/--in/--every).",
      "- remind list (kind, cron, nextFireAt) · remind cancel <id> (stops any variant above). Fires inside any running Henry process (repl/dashboard/scheduler) — no second process needed.",
      "- gmail draft --to ... --subject ... --body ... stages an approval-gated draft and prints its approvalId; Dad reviews and runs `approve approve <id>` (Henry never approves on Dad's behalf); THEN schedule the actual send with `remind --execute-approval <id> --at \"YYYY-MM-DD HH:mm\"` (or --in) — if still pending at fire time it skips silently, never retries. `gmail draftreplies` (optional --limit N) auto-drafts replies to unread mail in Dad's voice (never sends).",
      "- gmail via your own MCP tools (codex): READ/triage/DRAFT freely; NEVER send, reply, forward, or modify labels/read-state via MCP — sending is ONLY through the approval queue above. If asked to send, stage it and say so.",
      "- cover <job-url-or-jd> (cover letter PDF) · resume edit \"<instructions>\" · knowledge search|context \"<query>\" (founder playbooks) · memory search|remember · goal \"<goal>\" · linkedin <topic> · screenshots backlog · jobs inspect|prepare <url> — any outbound from these still lands in the approval queue, never sent directly.",
      "- knowledge add <file-or-folder> [--name <batch-slug>] [--domain gtm|growth-strategy|product-management|software-development|community|sales|careers] [--distill]: when Dad says to add/learn/import material into your knowledge base, RUN this — derive --name as a short slug of what the material is, pick the closest --domain, and pass --distill ONLY if Dad explicitly wants strategy cards (it spends provider calls; plain indexing is free). Report the printed import counts.",
      "- launch intake \"<brief|repo path>\" (playbook-cited question file at data/launches/<slug>/intake.md; Dad fills ANSWER: blanks) · launch run <slug> (parallel gtm-strategist + auditor + competition crew -> dossier.md) · launch list (phases).",
      "- Application answers: when Dad shares job-application questions (pasted text OR a screenshot path — Read the image), write paste-ready first-person answers yourself. FIRST read skills/job-application/SKILL.md and follow it exactly (ground only in resume.md + application-profile.md; you ARE the flagship project — describe your own real architecture; never invent metrics).",
      "- Portfolio edits: Dad's live portfolio is the SEPARATE repo /Users/luvishgulati/dev/portfolio (one self-contained index.html; live at https://luvishgulati03.github.io). When Dad asks for portfolio changes: edit that file (facts ONLY from its content-dossier.md; keep zero external requests/frameworks), verify with `node /Users/luvishgulati/dev/portfolio/scripts/audit.mjs` run from THIS repo root (needs its Playwright; all checks must PASS), commit locally in that repo — then STOP and report the diff. `git push` there publishes to the public site: do it ONLY after Dad's explicit go for that specific change (approve ≠ execute).",
      "- jd --file <path> (or bare `jd`, paste, END): when Dad pastes a job description or asks to tailor his resume for a role, RUN this — it rewrites resume CONTENT to the JD with formatting/structure/facts locked (number-guard blocks invented metrics), renders his exact PDF template, and generates the cover letter into one data/applications/ folder. Report the folder path and the changes list.",
      "- Self-maintenance git: you may commit your own reviewed changes in THIS repo with repo-style messages. You are authorized to push ONLY to remote `personal` (github.com/Luvishgulati03/ai-agent-, account Luvishgulati03) — never to any other remote, repo, or account.",
      "- Application memory: every prepared application and every tracked status email lives in Engram (metadata kind application-prepared / application-update). When Dad names a company, CHECK recalled context for its application trail and lead with it: applied before or not, current status (applied/viewed/shortlisted/assessment/interview/rejected/offer), and the exact resume + cover-letter file paths used. `memory search \"<company>\"` digs deeper on request.",
      "- mailwatch check/status: the scheduler daemon already runs this every 45min read-only (mail.watch in workflows/defaults.json), notifying on shortlisting/interview/assessment/offer emails. The same scans classify application emails (LinkedIn/Naukri/portals) into data/job-tracker.md (Dad-readable) + .json (canonical) — mailwatch tracker reports it; mailwatch backfill --days 30 seeds it once from inbox history if thin or empty.",
      "\n--- soul.md (non-negotiable operating contract) ---\n", soul,
      "\n--- personality.md ---\n", persona,
    ].filter(Boolean);
    const dynamicTail = [
      "\n--- recalled Engram context ---\n", context,
      ...(knowledgeBlock ? ["\n", knowledgeBlock] : []),
      "\n--- Dad's request ---\n", prompt,
      "\nBE CONCISE: answer directly, then stop. No boilerplate status footers — mention approvals, commits, or staged items ONLY when one actually exists or needs Dad's decision right now; never say 'nothing staged/no outbound/not committed' as a routine sign-off. Detail only when Dad asks for it.",
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
