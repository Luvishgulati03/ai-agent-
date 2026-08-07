# Henry (Luvish Junior)

Henry is a terminal-first personal engineering agent. Luna orchestrates the build and Henry orchestrates future specialist work. It uses Codex first, Claude as a fallback, and the actual Engram memory module as its canonical memory engine.

## What is implemented

- One-shot terminal commands and an interactive REPL.
- Codex-first command runner with Claude fallback.
- Engram-backed recall, capture, graph export, indexing, and dreaming.
- Local dashboard for activity, approvals, workflows, PR reviews, and memory.
- Gmail inbox reading, local drafts, and approval-gated sending.
- Cron workflows for inbox polling and nightly memory maintenance.
- Six-pass GitHub PR review with staged inline comments.
- Luna specialist-agent dispatch for architecture, runtime, memory, dashboard, Gmail, PR review, and QA tasks.
- Codebase task execution with local repository context.
- Provider toggle between Codex and Claude (CLI and dashboard).
- Job application pipeline with tailored resume PDFs and approval-gated submission.
- Cover letter generation from job descriptions with resume grounding.
- The organization's knowledge base (RAG module): curated domain content, local-only indexing, on-demand injection with source attribution.

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
henry ask "summarize the current git changes"
henry code "add unit tests for the auth module" --cwd /path/to/repo
henry provider claude
henry jobs inspect "https://boards.greenhouse.io/example/jobs/123"
henry jobs prepare "https://boards.greenhouse.io/example/jobs/123"
henry cover import /path/to/resume.docx
henry cover "https://example.com/job-posting"
henry knowledge search "GTM strategies for B2B SaaS" --domain gtm
henry knowledge stats
henry review 123 --repo /path/to/repo
henry dispatch pr-review "review the current pull request"
henry memory search "what did we decide about deploys?"
henry memory remember "Always run migrations before application deploys."
henry gmail inbox --limit 10
henry gmail draft --to someone@example.com --subject "Draft" --body "Do not send yet"
henry gmail reply --to someone@example.com --thread-id <gmail-thread-id> --subject "Re: Draft" --body "Staged reply"
henry approve list
henry approve send <approval-id>
henry schedule daemon
henry schedule install
```

## Important safety boundary

Codex is configured for full local access with no interactive approval prompts. Henry separately blocks outbound messages. Email, GitHub comments, and any other message are drafted, saved to Engram, shown on the dashboard, and sent only after Dad explicitly approves them.

## Configuration

See `.env.example`, `AGENTS.md`, `personality.md`, and `workflows/defaults.json`.
