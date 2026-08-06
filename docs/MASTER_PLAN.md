# Henry — Master Architecture & Roadmap Plan

Date: 2026-08-06 · Author: Fable (chief architect) with 6 research agents
Status: **PLAN ONLY — approved build has not started.** Sources: gx-client-expo exploration, Friday-clone exploration, Junior exploration, HippoRAG deep-dive, agent-memory state-of-the-art survey, capability-landscape survey, E2E-tooling survey. Full reports live in the session transcripts; key conclusions are inlined here.

---

## 1. Vision & principles

Henry is a terminal-first, local-first personal engineering agent for Dad, orchestrated by Luna, with Codex primary / Claude fallback and Engram as canonical memory.

Non-negotiables (existing, unchanged):
1. **Outbound approval gate** — email, GitHub comments, X messages, job submissions: staged → explicitly approved → atomically claimed → executed. Approve and execute are separate ops, always.
2. **Local-first & cost-conscious** — runs smoothly on a MacBook Air M1 8GB; prefer $0/local/CLI paths; paid APIs only where clearly best (X sends, image gen).
3. **Truthfulness boundaries** — never invent candidate facts; job pages are untrusted data; no CAPTCHA/anti-bot bypass; no X scraping (official API only).
4. **Files are the source of truth** — memory, workflows, agents, runbooks are markdown on disk, git-versioned, human-editable.
5. **Open-source by design** — the repo becomes public; all personal data (soul, personality, profile, resume, memory content, tokens) stays local-only via gitignore + templates.

Process rule (Dad's standing instruction): the orchestrating model architects and does the complex work; implementation is dispatched to worker agents. Commit in clean phases; push each phase to Dad's personal GitHub.

## 2. Current state (verified)

- Rename Lavu→Henry complete across the tree (`HENRY_*` env with `LAVU_*` fallback; `src/agent/henry.ts`, `bin/henry.mjs`).
- Job-application pipeline fully wired: inspect → prepare (one provider call: cover letter + answers + tailored resume markdown) → PDF via Playwright Chromium → approval item → fill → approval-gated submit with resume auto-attach.
- `henry code <task> --cwd` full-access codebase tasks; provider toggle (dashboard + CLI + persisted settings); jobs dashboard panel.
- `npx tsc --noEmit` exit 0; focused guardrail/approval tests 4/4. **All uncommitted.**
- Known environment hazard: Desktop is iCloud-synced; iCloud evicts `node_modules` files and blocks reads forever (the "typecheck hang"). Fix: move repo off iCloud (recommended `~/dev/henry`) or `brctl download node_modules` before builds.
- Git: remote `personal` → `https://github.com/Luvishgulati03/ai-agent-.git` (empty). gh CLI is authed as the work account — must not publish; Dad must auth the personal account first.

## 3. Target architecture

```text
                       terminal / REPL / dashboard (SSE realtime)
                                      |
                                  src/cli.ts
                                      |
                                 HenryRuntime
        ┌──────────┬──────────┬───────┼────────┬───────────┬──────────┐
     Memory     Workflows   Luna   Approvals  Integrations  Jobs/Career
    (Engram+)   (*.workflow.md) (resource mgr) (store+gate)  (gmail, X,   (apply, resume,
        |            |          |                     images, docs)  interview prep)
        └── ProviderRunner: Codex primary / Claude fallback, tier routing
        └── Browser: Playwright (persistent profile) — jobs, web E2E
        └── Mobile: Maestro + iOS Simulator (local), Android E2E in cloud CI
```

Friday-inspired spine (adopted):
- **cwd-as-configuration**: dispatched work runs with cwd = target repo; the repo's own CLAUDE/AGENTS/skills configure the worker. Henry adds only persona/memory/append-prompts.
- **Worktree isolation**: per-task `git worktree add` + copy `.env*` + symlink `node_modules`; LRU reaper that never evicts dirty trees.
- **`<ask-owner>` escalation**: blocked background work emits a structured sentinel (what I tried / why blocked / question) that Henry routes to Dad (dashboard + terminal notification).
- **Engine-agnostic events**: Codex JSONL mapped to one internal event shape (already true in spirit; formalize).
- **Fail-closed guards, fail-soft features.**

### 3.1 Core design theme: base agent + pluggable modules

**Henry = a minimal kernel + optional modules.** This is the governing design mentality for every phase, and the reason forks work.

- **Kernel (always present, never depends on any module)**: runtime, config, ProviderRunner (Codex/Claude), Engram memory, approval store + guardrails, activity log, scheduler, CLI, dashboard shell, Luna dispatch doctrine.
- **Modules (each fully optional)**: gmail, jobs/career, pr-review, x-messaging, meetings, images, screenshots, docs-management, voice… A fork that skips the Gmail module loses nothing else.
- **Module contract** (defined in `docs/architecture.md`, enforced in code): each module lives in its own `src/modules/<name>/` (or current dir until migrated) and registers through one interface — `{ name, init(runtime), cliCommands, approvalKinds + executor, activityKinds, dashboardPanel?, workflows?, configKeys (all with safe defaults) }`. Enabled/disabled via `HENRY_MODULES` config or per-module `enabled` flag; a disabled module is never constructed. Kernel iterates registered modules; no kernel file ever imports a module directly except the registry.
- **Docs requirement**: `docs/architecture.md` must explain how the agent was built, the kernel/module split, the module contract with a worked example, and a "write your own module" guide — so forkers plug in their own capabilities the same way. BOOTSTRAP.md walks a fork through choosing modules.
- Existing capabilities (gmail, jobs, pr-review) migrate to the module contract during Phase 3 refactoring; every new capability is born as a module.

## 4. Memory module — the flagship

Design stance: Engram stays canonical; markdown in `memory/` stays source of truth. All LLM intelligence moves to **write time and sleep time**; the chat-turn read path is LLM-free and sub-100ms. (References: Letta sleep-time, Zep bi-temporal supersede, Mem0 arbitration, A-MEM evolution, HippoRAG PPR, LangMem debounced reflection, MemOS lifecycle.)

Pipeline: **capture → extract → arbitrate → store → consolidate → retrieve → inject**

1. **Capture (hot path)**: raw transcript file per exchange (provenance, low importance). No inline extraction — only a debounce-timer reset.
2. **Extraction (background, debounced ~10–30min after conversation settles)**: LLM extracts atomic, dated, entity-tagged facts; novelty gate via `surprise()` drops non-news without LLM cost.
3. **Arbitration (write-time)**: each fact recalls its k≈10 nearest memories → LLM classifies ADD / UPDATE / NOOP. UPDATE ⇒ `add()` new + `supersede(old)` — bi-temporal, never delete; corrected info can't resurface.
4. **Storage**: SQLite via Engram; **swap hashing embeddings → transformers.js `bge-small-en-v1.5` q8** (pure npm, ~300MB RSS, 5–20ms on M1, 384-dim). This is the single biggest recall-quality lever — Henry is currently semantically near-blind. Tiers: episodic → semantic (promoted, protected) → procedural.
5. **Consolidation — nightly dream (idle hours)**: `dream({promote, consolidate:{capacity≈5000}})` (currently consolidation is OFF); incremental `buildEdges` + budgeted `buildLlmEdges(~50/night)`; `tagMemories` enrichment; **profile rewrite**: regenerate `memory/profile.md` (≤800 tokens: identity, active projects, preferences, commitments) — Letta's `rethink_memory` move.
6. **Retrieval (hot path)**: `recall(q, {associative, entitySeeding, markUsed, reinforce, recency half-life ≈21d})` — hybrid RRF + spreading activation seeded by query entities (local HippoRAG analogue). `rerank:true` only for explicit memory-interrogation queries.
7. **Injection (budgeted)**: profile.md always + score-thresholded recall (drop weak hits, don't pad to k) under ~2k tokens. Total memory overhead ≤2.5k tokens/turn.

Rollout order = impact/effort ranking: embeddings → extraction+debounce → arbitration/supersede → injection budget → dream-on → nightly consolidation → entity/weight tuning → selective rerank.

## 5. Development workflows

### 5.1 Workflow engine (adopt Junior's format)
`workflows/*.workflow.md`: YAML frontmatter — `name / enabled / description / triggers (schedule cron+tz | command) / outputs (docs|dashboard) / permissions.tools / runner (provider, model, timeoutMs, idle policy) / concurrency` — body is the prompt. Hot-reloaded (fs.watch, last-known-good on invalid edit). Each run receives **runtime context JSON** (configured repos + paths + artifact path) so prompts never hard-code environment facts. Artifacts land in `data/workflow-runs/<name>/`. Replaces the current thin cron-only definitions; existing memory.dream/gmail.inbox become workflows.

### 5.2 Web-dev playbook (from Junior)
Ideation → 1–2h iterations, Iteration-0 core proof → plan-before-code with convention check → build in ≤50-line verified chunks, checkpoint=commit → verification: typecheck + tests + **two clean passes** + integration audit (wiring gaps survive typecheck) → six-pass review (already built) with re-review protocol, closed verdicts, rounds capped at 2 → ship: **never auto-merge to main** (human-gated; matches the approval philosophy) → post-ship workflows: daily worklog, weekly release notes, worktree prune.

### 5.3 Mobile-dev playbook (from gx-client-expo)
Score-based TDD (5-signal scorecard, ≥2 ⇒ Red-Green-Refactor, else state the skip reason) → design-before-code for non-trivial UI (HTML mockup in phone frame → variants → implement) → hook-style gates: format/lint on edit, typecheck+tests at stop, protected files (`.env`, `eas.json`, `app.config.ts`) blocked → structural contracts (design tokens, no raw px/hex, thin routes, `@/` imports) → docs are part of done → gated release lane (blocking lint+unit+E2E; explicit human go-ahead before store submit; OTA is a separate lane). Henry carries this playbook into any Expo repo via cwd-as-config; gx-client-expo already ships the rules/skills that workers will auto-load.

### 5.4 E2E — web (research verdict)
**Playwright Test as the persistent layer** (committed `.spec.ts`, zero LLM at runtime) + **Playwright Agents** (v1.56+ Planner/Generator/Healer) for authoring and self-healing + **`@playwright/cli`** for exploration (a11y snapshots to files: ~4× fewer tokens than MCP). Accessibility-tree-first, vision on demand. Role locators + `toMatchAriaSnapshot`. Headless shell, `workers:1`, trace on-first-retry. Skip browser-use/Stagehand for testing.

### 5.5 E2E — mobile (research verdict)
**Maestro + iOS Simulator locally** (Expo has effectively chosen Maestro: Detox plugin removed Jun 2025), against `expo run:ios --configuration Release` builds (never Expo Go). Author via Maestro MCP (`inspect_screen` → YAML flows), commit `.maestro/*.yml` as the regression artifact — same "AI authors, deterministic artifact runs" split as web. **Android E2E delegates to cloud**: EAS `maestro` job (free tier: 30 builds + 60 CI min/mo) or GHA ubuntu+KVM — the Android emulator (~3–4GB) does not fit next to the agent on 8GB. One platform at a time; builds run exclusively.

## 6. Capability roadmap

| Capability | Path | Cost | Notes |
|---|---|---|---|
| X DMs/tweets in Dad's style | Official X API v2 pay-per-use, `twitter-api-v2`, OAuth PKCE | $0.015/send (~$4.50/mo) | Approval-gated per send; "Automated" label; no scraping clients — account safety first |
| X style corpus | Free X archive export → parse `direct-messages.js`/`tweets.js` → style profile in memory (not fine-tuning) | $0 | Request archive early (~24h wait) |
| Image reading | Provider CLI native | $0 | Already works |
| Image generation → local PNG | FLUX schnell API (Together/fal/Replicate) default; Gemini image for premium creatives | ~$0.003/img; $0.03–0.07 premium | Local gen on 8GB = slow fallback only |
| Desktop/docs | `osascript` + Shortcuts CLI; `pandoc --pdf-engine=typst`; `markitdown`; `ocrit` OCR | $0 | **No filesystem MCP** — CLIs do files natively; saves 100–300MB RAM |
| Interview prep / career booster | Free GitHub corpora (tech-interview-handbook incl. FAANG rubrics, system-design-primer) + mock-interview state machine with separate grader + `ts-fsrs` spaced practice; optional voice via whisper.cpp ($0, faster than realtime on M1) | ~$0 | Deny-list scraping: Glassdoor/LinkedIn/Blind/levels.fyi |
| Web surfing / research | Provider-native web search (Codex `--search`, Claude WebSearch) for research; Playwright persistent-profile browser for logged-in/interactive browsing; `curl` + readability extraction for cheap page reads | $0 | Enable search flags in ProviderRunner (Phase 3); browser already built |
| Screenshot sorting | Watch the screenshots folder (fs.watch) → T0 vision call classifies each new image (receipt/design-ref/meme/work/doc…) → deterministic move into taxonomy folders; taxonomy is user-editable config; unknown → `_unsorted` for review; classification fact optionally stored in memory | ~$0 (nano vision or provider CLI native) | Screenshots module; Phase 6 |
| Proactivity | OpenClaw-style heartbeat workflow (periodic checklist turn, silent unless newsworthy) | tokens | Later phase |

### 6.1 Meeting-shadow module (cheapest efficient design)

Henry attends Dad's meetings and produces (a) general meeting notes and (b) a personalized notes doc. All local, ~$0:
1. **Capture**: BlackHole (free open-source audio loopback) as an aggregate device (system audio + mic) recorded via `ffmpeg`/AVFoundation. Works with any meeting app (Meet/Zoom/Teams) — no bot joins the call. *Dad follows local consent norms for recording.*
2. **Transcribe**: whisper.cpp `small.en` locally (Metal, ~850MB RAM, faster than realtime on M1) — run **post-meeting** by default (cheapest, no RAM contention with the meeting app); live streaming mode is a later upgrade. Optional speaker labels via whisper.cpp tinydiarize (approximate) — skip v1.
3. **Summarize** (T1, one call): transcript → structured notes (attendees, decisions, action items, open questions) + **personalized section** built with Engram context (what Dad committed to, what affects his projects, suggested follow-ups/drafts — drafts stay approval-gated).
4. **Output**: markdown → `pandoc` → `.docx` (or plain `.txt`) saved to a meetings folder; facts + commitments captured to Engram (T0 memory-agent); surfaces on dashboard.
Decomposition per doctrine: capture+transcribe = deterministic, summary = one T1 call, memory = T0. Cost per meeting ≈ one standard model call. Build in Phase 6.

### 6.2 GrowthX knowledge base — the RAG module (digital-twin foundation)

Goal: Dad's agent reasons with GrowthX's tried-and-tested founder knowledge (learning-module transcripts: GTM strategies, PM content, engineering content) and future sources. Design principle: **knowledge ≠ memory** — they are separate stores with different lifecycles.

| | Personal memory (Engram, existing) | Knowledge base (new `knowledge` module) |
|---|---|---|
| Content | Dad's life/work facts, episodic | Curated domain corpus (strategies, playbooks) |
| Lifecycle | Decays, supersedes, promotes | Versioned, source-attributed, no decay; updates = re-ingest |
| Injection | Every turn (profile + recall) | **On demand** — when the task's domain matches or a workflow requires it |

**Architecture** (module per §3.1, all `claude -p`/Codex CLI — no API credits):
1. **Source adapters**: first adapter = read-only Mongo export script run locally against the GrowthX DB (Dad's existing credentials; creds never stored in Henry). Later adapters (Notion, Slack, docs) reuse the same pipeline. Raw transcripts land in `knowledge/raw/<module>/`.
2. **Distillation** (T1, one pass per module): each transcript → (a) a summary doc, and (b) **strategy cards** — atomic, actionable knowledge units: `{claim, when-to-use, steps, evidence/example, source module, author}` as individual markdown files in `knowledge/cards/`. Cards, not raw chunks, are the primary recall unit (higher precision, provenance built in).
3. **Index**: a second Engram instance at `data/knowledge.db` (reuses hybrid retrieval, graph, entity seeding, the Phase-1 local embeddings — zero new deps). Metadata: `{domain: gtm|pm|eng, module, author, sourcePath}`.
4. **Retrieval**: cards first, raw chunks as depth fallback; entity-seeded hybrid recall; ~2k-token budget; injected as a clearly labeled block — *"GrowthX knowledge (tried & tested)"* — so the model treats it as authoritative practice, distinct from general knowledge. A T0 domain classifier (or explicit workflow declaration) decides when to attach it; it is never injected on unrelated turns.
5. **Governance — hard rule**: `knowledge/` and `data/knowledge.db` are proprietary GrowthX content → **local-only, gitignored, never in the public repo**. The open-source repo ships the empty knowledge module + adapter framework, not the data.

### 6.2b LX-RAG reference findings (studied 2026-08-06, adopted)

GX's own LX-RAG (gx-backend `learning_chunks`) validated these choices, now applied to Henry's knowledge module: (1) **reuse their LLM-chunked corpus** — `learningchunks` docs (chapter-titled, role/difficulty/concept-tagged, stereo-deduped) are the primary export, so Henry inherits their $-expensive semantic chunking free; (2) **context-prefixed embeddings** — embed `module | chapter | topic` prefix + text, display raw text (our ingest prepends module/product already); (3) **score threshold + metadata pre-filters beat pure top-K** (their 0.70 minScore killed all false positives at 93-96% precision; ours exposed as `minScore`, tune empirically for bge-small); (4) **max 2 chunks per module** for context diversity (implemented); (5) **versioned writes with atomic active-flag swap** for re-ingestion without blackout (planned with the arbitration work); (6) build a **~30-query personal eval set** before any reranking investment (their 32-query manual benchmark found content gaps, not retrieval gaps, once corpus was broad). Their next-lever list (minScore bump → per-module cap → role boosting → LLM rerank → query expansion → hybrid RRF) is our tuning roadmap — Engram already ships hybrid RRF and `rerank`.

### 6.3 Launch crew — the digital-twin workflow

Use case: "I built product X — give me the launch roadmap and GTM." One workflow (`launch.workflow.md`), decomposed per the §11 doctrine:

| # | Agent | Tier | Task |
|---|---|---|---|
| 1 | intake | T1 | Reads the product (repo, docs, dashboard), then **asks Dad the missing datapoints** — the question list is derived from what the matched strategy cards require (ICP, pricing, channels, timeline). Interactive gate; no guessing. |
| 2 | gtm-strategist | **T2** | Launch roadmap + GTM strategy grounded in knowledge-base recall; cites which founder playbooks it used |
| 3 | product-auditor | T1 + deterministic | Full product review: code audit, breaks, E2E smoke (reuses review + E2E modules) → findings in closed vocabulary |
| 4 | fixer | T1 | Fixes auditor findings; re-verified; rounds capped at 2 (Junior pattern), then escalate to Dad |
| 5 | competition-researcher | T1 + web search | Competitor landscape, feature/positioning gap analysis → research report |
| 6 | synthesizer | T2 | Consolidated launch dossier: strategy + audit status + competitive gaps + roadmap → docs artifact + dashboard |
| 7 | memory-agent | T0 | Capture decisions/outcomes to Engram |

Parallelism: 2 ∥ 3 ∥ 5 after intake (disjoint); 4 follows 3; 6 last. Token profile: two T2 calls per launch, rest T1/T0/deterministic. This crew pattern (plan / audit / fix / research / synthesize) is reusable for any "ship something" request, not just launches.

## 7. Luna as resource manager (M1 Air 8GB policy)

Budget: ~5GB total for the agent stack (macOS takes ~3GB).
- **Max 2 provider subprocesses, default 1** (if 2: at most one Claude CLI — heavier — plus Codex).
- **Chromium: max 1, on-demand, never while 2 CLIs run.** iOS Simulator and Android emulator never together; builds run exclusively.
- **Admission control before every spawn**: check `memory_pressure` — pause spawns at "warn"/<1GB free; kill lowest-priority worker at "critical".
- **Per-worker envelope** (goose pattern): 25-turn cap, 5-min default wall-clock, partial-results-on-failure.
- **RSS watchdog**: recycle any worker >1.5GB RSS or >30min (checkpoint state to file first).
- **Depth cap**: ≤8 orchestration round-trips, then hand off to a fresh session with a distilled brief.
- **Tier routing**: triage/summaries/heartbeat → nano-class API models (~1–2% of Opus-class cost); hard reasoning → subscription CLIs; **budget invocations per 5h window, not just tokens**; heavy consolidation runs in the nightly idle window.

## 8. Futuristic dashboard (design spec)

One live control room, loopback-only, zero frameworks (vanilla + SSE + canvas — M1-cheap):
- **Heartbeat**: agent pulse (animated), uptime, last activity, scheduler next-fires, provider health, workflow runs in flight.
- **Resources (realtime)**: per-process RSS meters (Henry, provider CLIs, Chromium, simulator) sampled via `ps`; macOS `memory_pressure` state; the 5GB budget as a live bar; admission-control decisions ticker; worker envelopes (turns/time remaining).
- **Spend**: provider invocations vs 5h-window cap; nano-tier calls; X/image API spend vs daily caps.
- **Activity stream**: SSE-pushed timeline (runs, tool events, memory ops, approvals) — no more 5s polling.
- **Memory observatory**: live recall traces (why each memory surfaced), graph view (canvas force layout), profile.md rendered, last dream report, tier/salience distributions.
- **Ops panels**: approval queue (approve/execute), jobs pipeline, workflows (run/enable/history), provider toggle (exists), `<ask-owner>` questions inbox.
- Aesthetic: dark glassmorphic telemetry, monospaced numerics, sparklines, subtle motion — "mission control," not admin CRUD.

Implementation: `/api/events` SSE endpoint + dashboard-state module (Friday pattern); `ps -o rss=` sampler on a 2s tick; everything degrades gracefully when idle.

## 9. Open-source plan

- **Privacy scrub before first public push**: `soul.md`, `personality.md`, `context.md` personal sections, `application-profile.md`, `resume.md`, `memory/**` content, `data/**` — all local-only (gitignore; runtime falls back to `*.example.md`).
- Ship: `soul.example.md`, `personality.example.md`, a "Design your agent's soul" guide (structure + principles, not Dad's design), `docs/architecture.md` (public canonical architecture), scrubbed `context.md` (project context for contributors), **`BOOTSTRAP.md`** — the paste-into-Claude/Codex prompt that walks someone's agent through cloning this repo, generating their own soul/personality/profile, configuring providers, and customizing capabilities.
- README overhaul, MIT license, CI (typecheck+tests on PR).
- Push target: Dad's personal repo (`Luvishgulati03/ai-agent-`) — **needs Dad's confirmation** since he also refers to that URL as "Junior's repo"; a dedicated `henry` repo may be cleaner.

## 10. Build phases (in order, commit+push per phase)

| Phase | Content | Executor |
|---|---|---|
| 0 | Unblock: move repo off iCloud, personal gh auth, run full tests+build, commit parked work in clean phases, first push | Dad (2 actions) + architect |
| 1 | Memory v1: local embeddings, extraction+debounce, arbitration/supersede, injection budget, dream-on | architect + workers |
| 2 | Memory v2: nightly sleep-time consolidation, profile.md, entity seeding, selective rerank, recall traces | workers |
| 3 | Workflow engine (Junior format) + web/mobile playbooks + E2E stacks (Playwright Agents, Maestro) + Friday spine (worktrees, cwd-dispatch, ask-owner) + resource manager | architect + workers |
| 4 | Futuristic dashboard (SSE realtime, heartbeat, resources, memory observatory) | workers, spec from §8 |
| 5 | **GrowthX knowledge module + launch crew** (§6.2–6.3) — Dad's priority; needs Phase 1 embeddings + Phase 3 dispatch | architect + workers |
| 6 | X messaging + style pipeline + image generation + screenshots + meeting shadow | workers |
| 7 | Career booster: interview prep, mock loop, spaced practice; job-search expansion | workers |
| 8 | **Friday/Junior capability parity** (Dad's directive 2026-08-06): everything those two agents can do, Henry can do — Friday: buffered sessions, per-thread worktrees+tmux dispatch, ask-owner, runbooks, voice daemon, vision-grounded UI control, dashboards/SSE, standup, brain-dumps, anti-spiral; Junior: workflow engine, bug pipeline (thinker/reproducer/lead), dev-server queue, action buttons, persistent agents, worklog/release-notes/worktree-prune workflows. Most are already planned in Phases 3-4; this phase closes the remainder (voice, standup/dumps, bug pipeline state machine, dev-server manager) | architect + workers |
| 9 | Open-source release: scrub, templates, BOOTSTRAP.md, README, CI, license | architect + workers |

## 11. Sub-agent management doctrine (the dispatch skill)

This is Henry's core orchestration policy. It ships as a repo skill (`skills/dispatch.md`, Phase 3) injected into Luna's prompt, and every workflow is decomposed according to it. Sources: Friday's orchestrate-never-inline rule, Junior's bounded-dispatch + closed-vocabulary patterns, goose envelopes, the M1 policy in §7.

### 11.1 The four knobs — set explicitly on EVERY dispatch

Each dispatched worker gets: **role** (persona + tool permissions), **model tier**, **effort level**, **envelope** (turn/time/RSS caps). The orchestrator chooses all four per task — never a global default.

| Tier | Models | Effort | Use for | Cost profile |
|---|---|---|---|---|
| **T0 nano** | GPT-5-nano / Gemini Flash / Haiku-class | low | Triage, classification, fact extraction, formatting, summaries, memory capture | ~1–2% of frontier cost |
| **T1 standard** | Codex default / Sonnet-class | medium | Routine implementation, test authoring, form-filling logic, doc updates | Subscription CLI |
| **T2 frontier** | Opus-class / Codex high-reasoning | high | Architecture, hard debugging, review verdicts, final tailored writing | Scarce — budget per 5h window |

Effort maps to provider flags (Codex `model_reasoning_effort`, Claude thinking budget); the ProviderRunner exposes both as dispatch options.

**Hard cost rule — subscription CLIs only, never the Anthropic API.** Every Claude dispatch is a `claude -p` subprocess (subscription auth, Friday's model) — zero API credits; tiering within Claude = `--model haiku|sonnet|opus` on the CLI. Codex likewise via the `codex` CLI. The T0 "nano API" options (Gemini free tier etc.) are optional cost-savers a user may configure, never a default; with nothing configured, T0 tasks run on `claude -p --model haiku` or the cheapest Codex profile. Vision/summaries/extraction all follow the same rule.

### 11.2 Dispatch rules

1. **Decompose first**: break every workflow into tasks; one agent per task (or per two tightly-coupled tasks). Merge tasks only when they share working context so tightly that a handoff costs more than co-location.
2. **Lowest tier that clears the quality bar.** Escalation ladder on failure: retry same tier once → escalate one tier with the failure attached. Never start mechanical work at T2; never give T0 judgment calls.
3. **Deterministic beats LLM**: if code can do the step (render PDF, fill a form, parse JSON, diff files), no agent is dispatched at all.
4. **Bounded prompts, always**: exact question, input paths/artifacts, expected output shape, stop condition, mutation limits. No "look around" dispatches.
5. **Closed output vocabularies**: workers return machine-readable results (`done|blocked|failed`, verdict enums, file-path lists) so the orchestrator's state machine never parses prose.
6. **Read-only vs edit separation**: investigation passes get read-only workers; edit passes get worktree isolation when parallel.
7. **Parallel only when disjoint** (files, topics, repos); shared-state work runs sequentially. Concurrency always respects §7 (max 2 CLI workers, admission control).
8. **Envelopes always on**: 25-turn / 5-min defaults, partial-results-on-failure, RSS watchdog. Blocked workers emit `<ask-owner>` — they never spin.
9. **Orchestrator never does worker tasks inline** — if Luna catches itself grepping a target repo "just to check," it stops and dispatches (Friday's rule, verbatim).
10. **Memory capture is itself a T0 task** at the end of every workflow: outcomes, decisions, and lessons go to Engram.

### 11.3 Codex parity (the doctrine runs on both engines)

The dispatch doctrine is engine-agnostic and must be first-class on Codex, not a Claude port:
- **Tier mapping**: T0/T1/T2 become named Codex profiles in `~/.codex/config.toml` (model + `model_reasoning_effort` combos, e.g. `t0` = mini model + low effort, `t2` = frontier + high). ProviderRunner selects `--profile` per dispatch, exactly as it selects Claude effort/model flags. Effort knob = `model_reasoning_effort` (Codex) ↔ thinking budget (Claude).
- **Agent definitions**: `.claude/` stays canonical; a thin `.agent/` mirror (gx-client-expo pattern) gives Codex the same roles/rules with a tool-translation table (Read/Grep→rg, Edit→apply_patch). Any `.claude/` change updates its mirror.
- **No hooks on Codex**: deterministic gates (format, typecheck, tests, protected files) that Claude gets via hooks are expressed as a mandatory post-edit checklist in the Codex agent prompt + verified by the orchestrator after the worker returns.
- **Events**: Codex `exec --json` JSONL is already mapped to the shared event shape in ProviderRunner (Friday's `mapCodexEvent` pattern) — dashboards/envelopes/watchdogs work identically for both engines.
- **Web**: `--search` flag for Codex research dispatches ↔ Claude WebSearch.

### 11.4 Worked example — job-application workflow decomposition

| # | Task | Executor | Tier/Effort | Why |
|---|---|---|---|---|
| 1 | Discover postings (scan boards/links Dad feeds) | discover-agent | T0 / low | Bulk scanning is triage |
| 2 | Match & score vs profile + Engram memories | match-agent | T0→T1 / low | Scoring rubric, cheap; escalate ambiguous calls |
| 3 | Inspect posting page, extract questions | deterministic browser code + T0 cleanup | — | Playwright snapshot is code, not judgment |
| 4 | Tailor: cover letter + answers + resume markdown | tailor-agent | **T2 / high** | The one frontier call — quality directly visible to employers |
| 5 | Render PDF, fill form, screenshot | deterministic | — | Zero tokens |
| 6 | Review gate | **Dad** | — | Approval boundary, non-negotiable |
| 7 | Submit approved application | deterministic (claimed approval) | — | Zero tokens |
| 8 | Capture outcome to memory | memory-agent | T0 / low | Facts + reusable lessons |

Token profile per application: **one frontier call, two nano calls, everything else deterministic.** Every workflow in the system (PR review, worklog, interview prep, X drafting, release notes) gets an equivalent decomposition table when built — authored in the workflow file itself so the decomposition is versioned and reviewable.

## 11.5 Response-latency optimization plan (PLANNED 2026-08-07 — not yet implemented)

Observed: REPL turns take ~40-60s. Root causes ranked, fix per cause, implement in this order:

1. **No streaming display** (biggest perceived win, zero risk): ProviderRunner already gets JSONL events via onEvent; the REPL prints nothing until completion. Fix: stream text deltas live to terminal + dashboard SSE. Effort S.
2. **Cold ephemeral session per turn** (biggest actual win): every turn spawns fresh `codex exec --ephemeral`/`claude -p` re-sending the full prompt. Fix: per-surface session reuse (codex --session / claude --resume, Friday's model); reset on :reset or 2h idle. Effort M.
3. **Prompt obesity**: soul+personality+AGENTS+capabilities+memory+knowledge ≈ 8-12k chars every turn. Fix: static blocks via --append-system-prompt-file (never re-sent on resumed sessions); trim AGENTS injection; memory k 8→5 with score floor. Effort S-M.
4. **Synchronous post-turn memory capture**: agent.run awaits remember() (embed+write) before returning. Fix: fire-and-forget after response. Effort S.
5. **No intent tiering**: greetings/acks take the full frontier pass. Fix: zero-LLM gate (length+pattern) routing trivial turns to t0 haiku/mini; anything touching tools/actions stays t1+. Effort M.
6. **Spinner honesty**: elapsed seconds + phase (recalling → thinking → acting) from the event stream. Effort S.

Target after 1-4: first visible tokens <8s; trivial turns <10s; complex turns same quality, streaming from the start.

## 12. Continuation protocol (anti-hallucination handoff)

Any agent (Codex, Claude, or other) picking up this project MUST:
1. Read `context.md` top-to-bottom, then this file (`docs/MASTER_PLAN.md`).
2. Trust only verifiable state: run `git status`, `git log --oneline -5`, `npx tsc --noEmit`, and the focused tests before believing any claim about what works. Do not assume a phase is done because it is described here — phases are marked done only in `context.md`'s latest handoff section.
3. Never invent repo names, URLs, API keys, or user decisions — every established decision is written in `context.md` ("User decisions that must remain true") or §11 of this plan. If a needed decision is absent, ask Dad; do not guess.
4. Follow the phase order in §10; within a phase, follow §11's dispatch doctrine.
5. After every working session: update `context.md`'s latest-handoff section (state, what changed, next steps) and commit. The handoff is the single source of session-to-session truth.

## 13. Decisions Dad must make

1. **Repo target**: push Henry to `ai-agent-` (currently empty, but you also call it "Junior's repo") or create a fresh `henry` repo?
2. **Personal GitHub auth**: run `! gh auth login` and pick the personal account (required before any push).
3. **iCloud**: approve moving the repo to `~/dev/henry` (kills the eviction hangs permanently).
4. **X API**: approve the pay-per-use signup (card required, ~$4.50/mo at your volume) — needed only at Phase 5.
5. **X archive**: request your data archive from X settings **today** (free, ~24h wait) so style data is ready when Phase 5 starts.
6. **Image API**: pick default provider for FLUX schnell (Together/fal/Replicate — all ~$0.003/img) — needed only at Phase 5.
