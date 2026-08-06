# Bootstrap your own agent from this repo

This repo ships as a **kernel + optional modules** (see
`docs/architecture.md`). Forking it gives you the kernel — runtime,
provider routing, memory, the approval gate, the scheduler, and the
dashboard — plus whichever modules you choose to keep switched on. Your
personal data (name, resume, memory content, tokens) never has to touch
the repo; the kernel falls back to safe example templates until you
generate your own.

The fastest way to stand this up is to hand the block below to an agentic
coding assistant (Claude Code, Codex CLI, or similar) running **inside a
clone of this repo**, and let it do the cloning, installing, interviewing,
and file generation for you. Paste the whole fenced block as your first
message.

If you'd rather do it by hand: `git clone`, `npm install`, copy
`.env.example` to `.env`, copy `soul.example.md` to `soul.md` and
`personality.example.md` to `personality.md` and fill them in per
`docs/design-your-soul.md`, then `npm run typecheck && npm test`.

---

## Paste this into Claude Code / Codex CLI

```
You are bootstrapping a personal fork of this agent repo for a new user.
Work through the steps below in order. Do not skip the interview — do
not guess the user's name, capabilities, or provider preference. Stop and
ask if a step fails; do not silently continue past a failure.

STEP 1 — Clone and install
  1. If not already cloned, clone this repository to a local path the
     user chooses (default: ~/dev/<agent-name>, avoid iCloud/Dropbox/
     OneDrive-synced folders — synced folders can evict node_modules
     files mid-build and hang the compiler).
  2. Run `npm install` in the repo root.
  3. Copy `.env.example` to `.env` (do not edit yet — later steps will).

STEP 2 — Interview the user
  Ask these questions, one at a time, in plain conversation (not a form):
  1. What should the agent be called, and what should it call you?
  2. Which capabilities do you want enabled? Show the module list below
     and let them pick any combination, including "just the kernel."
  3. Which provider do you have a subscription for: Codex (OpenAI) or
     Claude (Anthropic)? This repo drives both through subscription CLIs
     only — it never calls a paid per-token API for agent reasoning.
  4. For any module they picked that needs it (Gmail, jobs/career), ask
     for the file paths or credentials it needs (see the module list) —
     or tell them it's fine to add those later and the module will stay
     dormant until configured.

  Module list (kernel is always on; everything else is opt-in):

  - KERNEL (always on, no toggle): runtime, config, provider routing
    (Codex/Claude via subscription CLI), Engram memory, the approval
    store + outbound guardrail, the scheduler, the CLI/REPL, the local
    dashboard.
  - gmail — read inbox, generate replies, save Gmail drafts. Sending is
    always approval-gated. Needs Google Cloud OAuth desktop credentials.
  - jobs / career — inspect job postings, tailor a resume + cover letter
    against a resume file, render application PDFs, fill forms in a
    visible browser, submit only after explicit approval. Needs a resume
    file and an application-profile file (never invented — missing facts
    are surfaced, not guessed).
  - cover letters — standalone cover-letter generation from a resume file
    and a job description or URL (works without the full jobs module).
  - knowledge base — a separate, on-demand RAG store for a curated
    domain corpus (playbooks, docs, transcripts you provide) distinct
    from personal memory; ships empty, you bring your own corpus.
  - pr-review — six-pass GitHub PR review (logic, safety, product
    thinking, query performance, consistency, surface); staged comments,
    posting is approval-gated.
  - scheduler workflows — cron-driven background jobs (nightly memory
    maintenance, inbox polling, etc.) defined in `workflows/*.json` or
    `*.workflow.md`.
  - IN PROGRESS, not yet part of a stable release: meetings (meeting-
    shadow transcription/notes), screenshots (auto-sorting), x-messaging
    (X/Twitter DMs and posts in the user's style). Tell the user these
    exist on the roadmap but should not be relied on yet.

STEP 3 — Generate the persona files
  1. Read `docs/design-your-soul.md` for the principles.
  2. Copy `soul.example.md` to `soul.md`. Fill in every bracketed
     placeholder from the interview answers. Keep the hard outbound
     boundary language intact — extend it with any extra outbound
     channels the chosen modules add (e.g. Gmail, PR comments), never
     soften it.
  3. Copy `personality.example.md` to `personality.md`. Fill in Identity
     to match soul.md exactly (same name, same term of address). Fill in
     Voice and Decision behavior from the interview; leave "Future
     personalization" as a placeholder — the user will refine it after
     living with the agent for a while.
  4. Confirm both files stay under roughly 2k tokens combined per
     `docs/design-your-soul.md` — trim before adding.

STEP 4 — Configure providers and modules
  1. In `.env`, set the agent name/user name env vars and the chosen
     default provider.
  2. For every module the user did NOT select, disable it via its config
     flag (see that module's section in `docs/architecture.md` and the
     relevant `.env.example` keys) rather than deleting its code — this
     keeps the fork mergeable with upstream.
  3. For every module they DID select, fill in the config paths/
     credentials they gave you in Step 2, or leave the safe defaults and
     note what's still needed before that module will actually run.

STEP 5 — Verify
  1. Run the typecheck command and the test command from `package.json`.
     Fix any failure before continuing; do not proceed on a red build.
  2. Report a short summary: agent name, enabled modules, provider,
     anything still needed from the user (credentials, resume file,
     etc.).

STEP 6 — First run
  1. Start the REPL (the `dev` or equivalent script in `package.json`)
     and have the user say hello — confirm the persona in soul.md/
     personality.md is reflected in the reply.
  2. Start the dashboard (the `dashboard` script) and confirm it serves
     on loopback only, then tell the user the local URL.

Stop after Step 6 and hand control back to the user.
```
