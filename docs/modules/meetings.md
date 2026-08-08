# Module: meetings (meeting shadow)

**You are Claude Code, Codex, or another coding agent, reading this inside
Henry's repo.** Already implemented at `src/meetings/service.ts` — don't
rebuild it. Configure and verify only.

Note: `docs/architecture.md` currently lists this module as **in progress,
not yet stable** — treat it accordingly; it works end-to-end but hasn't had
the same mileage as gmail/jobs/knowledge.

## 1. What it does

Local, offline meeting transcription and note-taking: audio file → local
Whisper transcript → one provider CLI call that produces structured notes
(decisions, action items, open questions) plus a **personalized-for-Luvish**
section (his commitments, which of his projects it affects, suggested
follow-ups — drafting any outbound message from those is explicitly left to
the approval-gated modules, never auto-sent). Output is written as markdown,
optionally converted to `.docx` via `pandoc`, and key facts are written to
memory.

Command it adds (`src/cli.ts`, `meetings` branch):

```
henry meetings shadow <audio-file> [--title "t"]
```

## 2. Configure

Env keys (`.env`, read by `src/config.ts`):

```
HENRY_WHISPER_MODEL=   # optional path to a whisper.cpp ggml model; unset uses the binary's own default
```

`meetingsDir` (output location) is fixed at `data/meetings/`, not
independently configurable.

One-time external setup:

1. Install a local Whisper binary — `MeetingShadowService.findWhisperBinary()`
   looks on `PATH` for `whisper-cli`, `whisper-cpp`, or `main`, in that order:
   ```
   brew install whisper-cpp
   ```
2. Download a model and point `HENRY_WHISPER_MODEL` at it, e.g.:
   ```
   curl -L -o ~/models/ggml-small.en.bin \
     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
   ```
   (This exact command is the one `service.ts` itself prints when no binary is
   found — `WHISPER_MISSING_MESSAGE`.)
3. Optional: install `pandoc` (`brew install pandoc`) to get a `.docx` output
   instead of a `.txt` fallback — `defaultRender()` checks for `pandoc` on
   `PATH` and degrades gracefully (writes a `.txt` alongside the `.md`) if
   it's missing. Neither the markdown nor the transcript step depends on
   pandoc.

## 3. How it wires to the brain

- **Provider runner**: `summarize()` calls `this.runner.run(prompt, { role:
  "meeting-shadow", readOnly: true })` on the shared `ProviderRunner` — one
  call per meeting, not per line of transcript.
- **Memory (Engram)**: pulls up to 10 memories of Luvish's active
  projects/commitments/priorities as context before summarizing, then writes
  back an overview memory (`tier: "episodic"`, importance 6) plus one memory
  per extracted commitment (importance 7) so future turns can recall "what
  did I commit to in that meeting."
- **The free-form agent**: `meetings shadow` is **not** currently mentioned in
  `HenryAgent.buildPrompt()`'s list of shell-outable actions
  (`src/agent/henry.ts`) — invoke it directly via the CLI rather than
  expecting the conversational agent to trigger it on its own.
- No approval-gate involvement — output is a file plus memory writes, nothing
  outbound.

## 4. Verify

```bash
which whisper-cli || which whisper-cpp || which main   # confirm a binary is on PATH first
npx tsx src/cli.ts meetings shadow /path/to/meeting.m4a --title "Weekly sync"
# → { notes: {...}, markdownPath, outputPath, memoryIds: [...] }
cat data/meetings/<date>-weekly-sync.md   # or the .docx/.txt outputPath from the result
```

If no Whisper binary is found, the command fails fast with the exact install
instructions above (`WHISPER_MISSING_MESSAGE`) rather than a generic error —
that failure message itself is a valid verification that the guard works.

## 5. Disable

`MeetingShadowService` is constructed unconditionally in `HenryRuntime`, but
it does nothing until invoked — there is no daemon or polling loop for this
module. To keep it dormant: don't install a Whisper binary (the command then
fails immediately, before any transcription or provider call) and never run
`henry meetings shadow`.
