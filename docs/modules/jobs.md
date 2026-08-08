# Module: jobs (career)

**You are Claude Code, Codex, or another coding agent, reading this inside
Henry's repo.** This module is already implemented at `src/jobs/service.ts`,
`src/jobs/browser.ts`, and `src/jobs/store.ts` — don't rebuild it. Configure
and verify only.

## 1. What it does

Inspects a job posting in a real (visible, persistent-profile) browser, drafts
a truthful, resume-grounded application (cover letter, questionnaire answers,
a reordered/re-emphasized resume) via the provider CLI, renders a tailored
resume PDF, and stages the whole application as one approval item. Filling
form fields is separate from submitting; submitting is approval-gated.

Commands it adds (`src/cli.ts`, `jobs` branch):

```
henry jobs inspect <url>              # scrape title/company/description/questions, remember it
henry jobs prepare <url>              # inspect + draft cover letter/answers/resume + create approval
henry jobs list                       # summary + list of stored applications
henry jobs fill <application-id>      # fills the visible form (no submit)
```

Submission is **not** a `jobs` subcommand — it goes through the approval gate:
`henry approve approve <id>` then `henry approve send <id>`.

## 2. Configure

Env keys (`.env`, read by `src/config.ts`):

```
HENRY_JOB_PROFILE_PATH=application-profile.md   # default shown; candidate facts (never invented)
HENRY_RESUME_SOURCE_PATH=resume.md              # default shown; source of truth for tailoring
HENRY_BROWSER_PROFILE_DIR=data/browser-profile  # default shown; persistent Chromium profile
HENRY_BROWSER_HEADLESS=false                    # default shown; visible browser so Luvish can watch/intervene
```

One-time external setup:

1. Provide `resume.md` at `HENRY_RESUME_SOURCE_PATH` — either write it by hand
   or run `henry cover import <path-to-resume.docx|.txt|.md>` (uses macOS
   `textutil` for `.docx`/`.doc`/`.rtf`/`.html`; `.pdf` needs `pdftotext` from
   `brew install poppler` and isn't handled directly).
2. Provide `application-profile.md` at `HENRY_JOB_PROFILE_PATH` with any
   candidate facts not on the resume (visa status, salary expectations,
   etc). If it's missing, `prepare` still runs — missing facts are surfaced
   in `missingFacts`, never guessed.
3. Install Playwright's Chromium binary (both the job browser and the resume
   PDF renderer use `playwright`'s `chromium`):
   ```
   npx playwright install chromium
   ```

## 3. How it wires to the brain

- **Provider runner**: `prepare()` builds a strict, evidence-only prompt (no
  invented employers/dates/metrics) and calls `this.runner.run(prompt, { role:
  "job-application", readOnly: true })` — a `ProviderRunner` instance shared
  with the rest of Henry (`runtime.agent.providerRunner`).
- **Memory (Engram)**: `inspect()` remembers the posting (`tier: "semantic"`);
  `prepare()` recalls up to 12 relevant memories as context and remembers the
  drafted application (`tier: "episodic"`); a successful submission is
  remembered too.
- **Approval gate**: `prepare()` creates a `job.application` approval whose
  `payload.descriptionHash` is checked again at submit time — if the posting
  changed after approval, `submitApproved()` throws instead of submitting a
  stale application. `HenryRuntime.executeApproval()` routes `job.application`
  to `JobApplicationService.submitApproved()`.
- **The free-form agent**: `HenryAgent.buildPrompt()` tells the provider CLI
  it can shell out to `npx tsx src/cli.ts jobs inspect|prepare <url>` directly
  — `jobs fill` is not yet mentioned there, so drive it manually via the CLI.

## 4. Verify

```bash
npx tsx src/cli.ts jobs inspect "https://boards.greenhouse.io/example/jobs/123"
# → JobPosting { id, url, title, company, description, questions, ... }
npx tsx src/cli.ts jobs prepare "https://boards.greenhouse.io/example/jobs/123"
# → { applicationId, status: "ready-for-review", approvalId, resumePdf, missingFacts, next: "..." }
npx tsx src/cli.ts jobs list
# → { summary: {...}, applications: [{ id, title, company, status, approvalId }] }
npx tsx src/cli.ts approve approve <approvalId>
npx tsx src/cli.ts approve send <approvalId>
# → the real submission URL; only fires if the description hash still matches
```

## 5. Disable

`JobApplicationService` is constructed unconditionally in `HenryRuntime`
(`runtime.jobs.init()` runs on every boot to open its JSON store), so there is
no single env toggle. To keep it dormant: don't create `resume.md` or
`application-profile.md`, and never run `henry jobs inspect|prepare`. Without
a resume, `henry cover`/`henry resume` will also refuse to run (they share
`resumeSourcePath`), which is expected — those are separate modules layered on
the same file, see `docs/modules/cover-letters.md`.
