# Module: screenshots

**You are Claude Code, Codex, or another coding agent, reading this inside
Henry's repo.** Already implemented at `src/screenshots/service.ts` — don't
rebuild it. Configure and verify only.

Note: `docs/architecture.md` currently lists this module as **in progress,
not yet stable**.

## 1. What it does

Vision-classifies and files screenshots into a category taxonomy, either
on-demand for a backlog, one file at a time, or continuously via an `fs.watch`
on the screenshots directory (debounced, since macOS writes screenshots in
stages). Classification is one `claude -p` vision call per image — the model
sees the local file path directly in the prompt.

Commands it adds (`src/cli.ts`, `screenshots` branch):

```
henry screenshots backlog [--limit N]     # sort existing screenshots already in the watch dir (default 20)
henry screenshots sort <image-path>       # sort exactly one image
henry screenshots watch                   # long-running: sorts new screenshots as they land, Ctrl+C to stop
```

## 2. Configure

Env keys (`.env`, read by `src/config.ts`):

```
HENRY_SCREENSHOT_CATEGORIES=work,design-reference,receipts,memes,documents,code,_unsorted   # default taxonomy (comma-separated)
HENRY_SCREENSHOTS_DIR=~/Desktop                        # default shown; watched/scanned for new screenshots
HENRY_SCREENSHOTS_SORTED_DIR=~/Pictures/sorted-screenshots  # default shown; destination root, one subfolder per category
```

`~` is expanded to the home directory (`expandHome()` in `src/config.ts`); no
external account or install is required. Only macOS-named screenshots match:
the watcher and backlog scan both filter on `/^Screenshot .*\.png$/i` (the
default macOS `Screenshot 2026-08-06 at 10.32.11 AM.png` pattern).

## 3. How it wires to the brain

- **Provider runner, pinned to Claude**: `classify()` calls
  `this.runner.run(prompt, { readOnly: true, provider: "claude" })` — the
  only module that hardcodes a provider choice, because vision classification
  needs Claude's image-reading path specifically; it does not fall back to
  Codex.
- **No memory, no approval gate**: this module only moves files on the local
  filesystem (`fs.rename`, falling back to copy+unlink across devices/`EXDEV`)
  and records activity events — there is nothing outbound to gate.
- **The free-form agent**: `HenryAgent.buildPrompt()` mentions
  `npx tsx src/cli.ts screenshots backlog` as a shell-outable action for the
  conversational agent; `sort`/`watch` are not mentioned there — invoke those
  directly via the CLI.

## 4. Verify

```bash
npx tsx src/cli.ts screenshots backlog --limit 3
# → [{ imagePath, category, destPath }, ...]   (empty array if HENRY_SCREENSHOTS_DIR has no matches)
ls ~/Pictures/sorted-screenshots/           # one subfolder per category that actually got used
npx tsx src/cli.ts screenshots sort ~/Desktop/"Screenshot 2026-08-06 at 10.32.11 AM.png"
# → { category, destPath }
npx tsx src/cli.ts screenshots watch
# → "Watching for screenshots. Ctrl+C to stop." — take a screenshot, confirm it's sorted ~2s later (DEBOUNCE_MS)
```

An unrecognized classification (or a failed provider call) always lands in
`_unsorted`, never silently dropped or left in place — verify a genuinely
ambiguous image ends up there instead of erroring.

## 5. Disable

`ScreenshotSorterService` is constructed unconditionally in `HenryRuntime`,
but it is entirely pull-based — nothing runs unless you invoke `backlog`,
`sort`, or `watch`. To keep it dormant: simply never run those commands (no
`fs.watch` handle exists until `watch()` is called). There is no
scheduler-workflow entry for this module in `workflows/defaults.json`.
