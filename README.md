# Lavu (Luvish Junior)

Lavu is a terminal-first personal engineering agent. Luna orchestrates the build and Lavu orchestrates future specialist work. It uses Codex first, Claude as a fallback, and the actual [Engram memory module](https://github.com/anmolm-growthx/engram-memory) as its canonical memory engine.

## What is implemented

- One-shot terminal commands and an interactive REPL.
- Codex-first command runner with Claude fallback.
- Engram-backed recall, capture, graph export, indexing, and dreaming.
- Local dashboard for activity, approvals, workflows, PR reviews, and memory.
- Gmail inbox reading, local drafts, and approval-gated sending.
- Cron workflows for inbox polling and nightly memory maintenance.
- Six-pass GitHub PR review with staged inline comments.
- Luna specialist-agent dispatch for architecture, runtime, memory, dashboard, Gmail, PR review, and QA tasks.

## Quick start

```bash
npm install
cp .env.example .env
npm run typecheck
npx tsx src/cli.ts ask "inspect this repository and tell me what needs attention"
npx tsx src/cli.ts repl
npx tsx src/cli.ts dashboard
```

Open the dashboard at http://127.0.0.1:7337.

## Common commands

```bash
lavu ask "summarize the current git changes"
lavu review 123 --repo /path/to/repo
lavu dispatch pr-review "review the current pull request"
lavu memory search "what did we decide about deploys?"
lavu memory remember "Always run migrations before application deploys."
lavu gmail inbox --limit 10
lavu gmail draft --to someone@example.com --subject "Draft" --body "Do not send yet"
lavu gmail reply --to someone@example.com --thread-id <gmail-thread-id> --subject "Re: Draft" --body "Staged reply"
lavu approve list
lavu approve send <approval-id>
lavu schedule daemon
lavu schedule install
```

## Important safety boundary

Codex is configured for full local access with no interactive approval prompts. Lavu separately blocks outbound messages. Email, GitHub comments, and any other message are drafted, saved to Engram, shown on the dashboard, and sent only after Dad explicitly approves them.

## Configuration

See `.env.example`, `AGENTS.md`, `personality.md`, and `workflows/defaults.json`.
