# Lavu development context

This file is the durable handoff for any other agentic IDE, model, or engineer working on Lavu. Read the whole file before changing code.

## Identity and user decisions

- Agent name: **Lavu** (Luvish Junior).
- Lavu calls the user **Dad**.
- Luna is the top-level orchestrator for this build and dispatches bounded specialist agents.
- This is a **terminal agent**, not a Slack bot.
- Terminal UX must support both one-shot commands and an interactive REPL.
- Codex is the primary model/runtime. Claude is the fallback.
- Codex execution preference: `danger-full-access` with no interactive approval prompts.
- Gmail is the first email provider.
- Gmail can be read. Responses can be generated and saved, but sending or replying requires explicit Dad approval. This is a non-negotiable hard guardrail.
- Every outbound message requires the same approval gate: email, GitHub review comments, Slack, or any other external message.
- Local file work, investigation, code execution, memory writes, and drafts do not require approval.
- When uncertain: investigate briefly, then ask Dad.
- Voice defaults: kind, sarcastic, appealing; a mix of terse updates, bullets, and conversational explanations; emojis, slang, humor, and Hinglish are allowed.
- Detailed personality training examples will be added later. Do not invent Dad’s writing style.

## Repository boundaries

- Local project: `/Users/luvishgulati/Desktop/junior's repo/luvish jr/`.
- GitHub repository: https://github.com/luvishg-growthx/luvish-jr
- GitHub account currently authenticated: `luvishg-growthx`.
- Local commit identity: `Luvish Gulati <Gulatiluvish@gmail.com>`.
- The sibling `Junior` directory is a reference and must not be extended for Lavu.
- The earlier exploratory draft inside `Junior` is user-owned, uncommitted, and must not be reset, deleted, or modified unless Dad explicitly asks.
- Engram and Friday-clone were inspected as references. Engram is also a real runtime dependency here, not merely a reference.

## Current implementation

The latest pushed phases are:

1. `25c2a31` — scaffold, project config, docs, memory/workflow directories.
2. `27f12d3` — provider runtime, Luna dispatch, Engram, dashboard, Gmail adapter, scheduler, PR review, approval queue, CLI, initial agent definitions.
3. `1ac12d9` — installable cron and launchd scheduler artifacts.
4. `8acb13e` — delegated QA coverage for Engram, scheduler, and approval transitions.

The end-to-end Codex smoke test passed with:

```text
Lavu runtime is connected.
```

Engram native SQLite initialization, memory indexing, recall, and dashboard health/status endpoints have also passed locally.

## Architecture

```text
terminal / dashboard
        |
        v
    src/cli.ts
        |
        v
    src/runtime.ts
      /   |    \
     /    |     \
  Lavu  Luna  workflows
   |      |       |
   |      |       +-- Gmail polling / Engram dream
   |      +---------- specialist dispatch
   +----------------- memory recall -> provider -> memory capture
        |
        +-- ProviderRunner: Codex first, Claude fallback
        +-- ApprovalStore: outbound actions stay pending
        +-- Dashboard: localhost JSON APIs + operator UI
        +-- PullRequestReviewer: six-pass review -> staged GitHub comments
        +-- LavuMemory: actual `engram-memory` package
```

Important source locations:

- `src/runtime.ts` — dependency composition and approval execution.
- `src/cli.ts` — one-shot commands and REPL.
- `src/providers/runner.ts` — Codex/Claude subprocess contract and fallback.
- `src/agent/lavu.ts` — persona, recall-before-turn, provider call, capture-after-turn.
- `src/orchestration/luna.ts` — specialist roles and dispatch.
- `src/memory/engram.ts` — canonical Engram integration.
- `src/approval/store.ts` — persistent approval queue and transition rules.
- `src/integrations/gmail.ts` — OAuth, inbox reading, local outbound queue, approved send.
- `src/pr/review.ts` — full diff, six passes, report, staged inline comments.
- `src/scheduler/scheduler.ts` — Croner-backed workflows.
- `src/dashboard/` — local dashboard server and page.
- `personality.md` — initial technical personality profile; personalize last.
- `AGENTS.md` — durable operating instructions.
- `agents/` — specialist role descriptions.
- `workflows/defaults.json` — scheduled workflow definitions.
- `docs/e2e-test-plan.md` — the complete offline, provider, Gmail, dashboard, scheduler, and PR-review E2E plan.

## Commands

Run from this repository:

```bash
npm install
npm run typecheck
npm test
npx tsx src/cli.ts ask "inspect the current project"
npx tsx src/cli.ts repl
npx tsx src/cli.ts dashboard
npx tsx src/cli.ts status
npx tsx src/cli.ts memory search "deployment decision"
npx tsx src/cli.ts memory remember "durable decision"
npx tsx src/cli.ts memory index
npx tsx src/cli.ts memory dream
npx tsx src/cli.ts dispatch architect "propose the next safe phase"
npx tsx src/cli.ts gmail auth
npx tsx src/cli.ts gmail inbox --limit 10
npx tsx src/cli.ts gmail draft --to someone@example.com --subject "Draft" --body "Do not send yet"
npx tsx src/cli.ts gmail reply --to someone@example.com --thread-id <gmail-thread-id> --subject "Re: Draft" --body "Staged reply"
npx tsx src/cli.ts review 123 --cwd /path/to/target/repository
npx tsx src/cli.ts approve list
npx tsx src/cli.ts approve approve <approval-id>
npx tsx src/cli.ts approve approve <approval-id>  # explicit Dad approval
npx tsx src/cli.ts approve send <approval-id>     # execution only; never approves implicitly
npx tsx src/cli.ts schedule list
npx tsx src/cli.ts schedule daemon
npx tsx src/cli.ts schedule install
```

Dashboard default: http://127.0.0.1:7337.

## Provider rules

Codex uses the installed CLI in JSONL mode, ephemeral sessions, `danger-full-access`, and `approval_policy="never"`. It is intentionally configured for local engineering execution. The application-level outbound gate is separate and must remain enforced even if a provider has unrestricted local access.

Read-only specialist work never falls back to Claude's full-permission mode. Provider subprocesses receive an explicit environment allowlist, not the complete parent environment.

Claude is invoked only when Codex fails or the user explicitly selects it. Keep provider-specific flags inside `src/providers/runner.ts`.

## Memory rules

Engram is the canonical memory module. Markdown under `memory/` is durable source material; `data/engram.db` is a rebuildable derived index. Do not replace Engram with a new local retrieval implementation.

The normal loop is:

1. Recall relevant memories before a meaningful turn.
2. Inject the explainable context into the provider prompt.
3. Capture useful outcomes and decisions after the turn.
4. Reindex when Markdown changes.
5. Run Engram dreaming on a schedule.

## PR-review rules

The workflow is intentionally adapted from Junior’s review agent:

1. Logic.
2. Safety.
3. Product thinking.
4. Query performance.
5. Consistency.
6. Surface/readability.

Read the full diff. On re-review, inspect existing GitHub comments/reviews and avoid duplicate findings. Findings need severity, title, body, file path, and positive changed-line number. The reviewer creates an approval item; it must not post to GitHub until Dad approves and executes it.

The approval preview contains the complete rendered review and a content hash. Execution claims `approved -> executing` before calling Gmail/GitHub, revalidates the PR head SHA, and rejects stale or duplicate actions. The dashboard is loopback-only by default; remote mode requires an explicit token.

## Safe development workflow

- Work in phases and commit after each coherent phase.
- Run `npm run typecheck` and `npm test` before every phase commit.
- Use `git status --short` before adding files.
- Never commit `.env`, OAuth tokens, Engram databases, activity logs, or approval data.
- Do not reset or revert user changes destructively.
- Do not send external messages during tests.
- If a task touches the same files as another dispatched specialist, dispatch sequentially or use a separate worktree.

## Next recommended phases

1. Add focused provider, memory, scheduler, dashboard, Gmail, and PR-review tests.
2. Improve Gmail reply threading, attachment handling, and OAuth diagnostics.
3. Add richer dashboard timelines and memory recall traces/graph visualization.
4. Harden GitHub re-review comment de-duplication and API fixtures.
5. Add launchd/cron installation helpers for unattended workflows.
6. Gather Dad’s anonymized writing examples and finish the personalized `personality.md`.
