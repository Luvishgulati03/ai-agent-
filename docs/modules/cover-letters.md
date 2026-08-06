# Module: cover letters

**You are Claude Code, Codex, or another coding agent, reading this inside
Henry's repo.** Already implemented at `src/jobs/cover.ts` (and
`src/jobs/resume-editor.ts` for standalone resume edits) — don't rebuild it.
Configure and verify only.

## 1. What it does

Standalone, resume-grounded cover-letter generation from a job URL, a local
JD file, or raw JD text — works without the full `jobs` module (it only
depends on `jobs.inspect()` when given a URL). It also ships a resume-import
helper and a separate resume-editing flow that never overwrites the canonical
resume without an explicit promote step.

Commands it adds (`src/cli.ts`, `cover` and `resume` branches):

```
henry cover import <path-to-resume.docx|.md|.txt>   # one-time: writes resume.md
henry cover <job-url | jd-file-path | jd-text>       # generate a tailored cover letter (.md + .pdf)
henry resume edit <instructions...>                  # rewrite resume.md into a NEW draft, never overwrites
henry resume promote <markdown-path>                 # Dad's acceptance step: draft -> canonical resume.md
henry resume show                                    # preview the current resume.md
```

This is entirely outbound-free — nothing here touches the approval gate; the
output is a file on disk for Dad to read and use manually.

## 2. Configure

Env keys (`.env`, read by `src/config.ts`):

```
HENRY_RESUME_SOURCE_PATH=resume.md   # default shown; REQUIRED, re-read on every generate/edit call
```

No other config keys. There is no external account or API key to set up.

One-time setup: get a `resume.md` in place, either by hand or via
`henry cover import <path>`:
- `.md` / `.txt` are read as-is.
- `.docx` / `.doc` / `.rtf` / `.html` are converted with macOS's built-in
  `textutil` (no install needed on macOS; this will fail on non-macOS hosts).
- `.pdf` is not supported by `cover import` — convert it to `.docx` first, or
  install `pdftotext` (`brew install poppler`) and convert manually.

`cover generate` and `resume edit` both call
`renderResumePdf()` (`src/jobs/resume.ts`), which launches headless
`playwright` Chromium to print the markdown to PDF — same one-time
requirement as the `jobs` module:

```
npx playwright install chromium
```

## 3. How it wires to the brain

- **Provider runner**: `CoverLetterService.generate()` and
  `ResumeEditorService.edit()` both call `this.runner.run(prompt, { role:
  "cover-letter" | "resume-editor", readOnly: true })` on the shared
  `ProviderRunner`. Both prompts are explicit about never inventing
  employers/dates/metrics/skills not already in the resume.
- **Memory (Engram)**: `generate()` recalls up to 10 memories (voice, career
  goals, past cover-letter feedback) as context, then remembers the generated
  letter (`tier: "episodic"`); `edit()`/`promote()` remember each draft/promotion
  the same way.
- **The free-form agent**: `HenryAgent.buildPrompt()` tells the provider CLI
  it can shell out to `npx tsx src/cli.ts cover <job-url-or-jd>` and
  `npx tsx src/cli.ts resume edit "<instructions>"` directly when Dad asks.
- No approval gate involvement — files are written to disk under
  `data/cover-letters/` and `data/resumes/` for manual review/use.

## 4. Verify

```bash
npx tsx src/cli.ts cover import /path/to/resume.docx
# → { resumePath: "<repo>/resume.md" }
npx tsx src/cli.ts cover "https://example.com/some-job-posting"
# → { markdownPath, pdfPath, company, title }  — open the .pdf to confirm layout
npx tsx src/cli.ts resume edit "tighten the summary, emphasize B2B SaaS growth"
# → { markdownPath, pdfPath }  — a NEW draft, resume.md is unchanged
npx tsx src/cli.ts resume show
# → still shows the ORIGINAL resume.md preview
npx tsx src/cli.ts resume promote data/resumes/edited-....md
# → { resumePath: "<repo>/resume.md" }  — now resume.md matches the draft
```

## 5. Disable

Both services are constructed unconditionally in `HenryRuntime`, so disabling
is again file-shaped: without a `resume.md` present, `resume()` (the private
guard both services call first) throws `"Resume not found at ...; Run: henry
cover import <path-to-resume.docx>"` before any provider call or file write —
no cost is incurred. Simply never run `henry cover`/`henry resume` commands
and leave `resume.md` absent.
