# Standup module — design

Status: **BUILT 2026-08-08** (src/standup/: store, poller, service, send; scheduler kinds
+ crons armed as safe no-ops; `henry standup` CLI; 10 tests). Awaiting only the group
connection: create group → add @Henry_luv_bot → BotFather Group Privacy off → someone
posts → `henry standup discover` → put the negative id in `.env` as
`HENRY_TELEGRAM_STANDUP_CHAT_ID` → restart Henry. Implementation notes vs this design:
transport is interval short-polling (60s) instead of a held long-poll — this laptop
sleeps on lid-close and a short poll survives sleep/wake for free; scan runs tier t1,
summary t2; the noon summary cron polls + scans late posts before composing.

## What it does

Henry runs the team's daily standup inside a Telegram group:

1. **Prompt** — on weekday mornings the bot posts the standup ask in the team group
   ("Standup time — drop yours: Yesterday / Today / Blockers").
2. **Collect** — everyone replies in the group in plain text. Henry's poller reads the
   group (long-polling `getUpdates` from the Mac) and stores every update.
3. **Scan** — a batched light-tier provider pass parses each update into
   yesterday/today/blockers, judges quality, and for a *vague* update sends **one**
   threaded reply asking for clarity ("which API — payments or auth?"). Banter and
   off-topic chatter are classified `offtopic` and silently ignored — no nagging.
4. **Summarize** — at window close Henry composes the team summary (per-person
   one-liners, a Blockers section with owners, a Missing list of people who didn't
   post) and DMs it to Luvish. Optionally also posted back to the group (config flag,
   default off).
5. **Remember** — every update and every daily summary goes into Engram, so
   "what has Rohan been working on this week?" or "who was blocked on the payments
   bug?" is answerable any day later via normal recall, plus
   `henry standup summary --date YYYY-MM-DD` for the exact ledger.

## Why Bot API (not a user-account "app", not a Mini App)

- **MTProto user-account client** (Henry as a "person"): needs a phone number +
  api_id/api_hash, sessions get logged out, and Telegram bans automated user
  accounts. Zero benefit over a bot for read-summarize-reply. Rejected.
- **Telegram Mini App**: a web UI that opens *inside* Telegram from a bot button.
  It's a display layer — it cannot listen to group messages. Possible v2 nicety
  (a "today's summary" button), not a transport. Rejected as the base.
- **Bot in the group** (chosen): official, free, no ban risk, we already own
  @Henry_luv_bot and the outbound pipe. With privacy mode disabled the bot receives
  every group message via `getUpdates` — long-polling works from a home machine with
  no server, webhook, or public IP.

## Components

- `src/standup/store.ts` — SQLite `data/standups.db` (WAL), tables:
  - `updates(id, chat_id, message_id, user_id, user_name, date, text, received_at,
    edited, quality, clarified, UNIQUE(chat_id, message_id))` — `date` is the IST
    day bucket; `quality` ∈ `ok | vague | offtopic | NULL(unscanned)`.
  - `summaries(date PK, markdown, created_at)`.
  - `meta(key, value)` — `getUpdates` offset + poller lock.
- `src/standup/poller.ts` — long-poll `getUpdates` (`allowed_updates:
  ["message","edited_message"]`), **filtered to the configured standup group id
  only**; everything else is dropped unread. Edited messages upsert their row and
  reset `quality` for rescan. Single-consumer lock in `meta`
  (pid+heartbeat, stale after 60s) — two pollers on one token = Telegram 409.
- `src/standup/service.ts` — prompt/scan/summarize/status; scan and summary run
  through `runner.run(prompt, { provider: "codex", readOnly: true, role:
  "standup-scan" })` exactly like mailwatch; scan is **batched** (all unscanned
  updates in one call) on the light path; summary is one t2-quality call.
- `src/standup/send.ts` — `sendStandupMessage(config, text, replyTo?)`: a second
  scope-guarded sender pinned to `telegramStandupChatId` (mirror of
  `notify/telegram.ts`'s doctrine — named surface, chat id from config only, never
  caller-supplied, fails open). `notify/telegram.ts` stays Luvish-DM-only.
- Config: `TELEGRAM_STANDUP_CHAT_ID` → `config.telegramStandupChatId`; window
  times + `postSummaryToGroup` in the workflow entry.
- Scheduler: three `workflows/defaults.json` entries dispatched in `scheduler.ts` —
  `standup.prompt` (e.g. `30 9 * * 1-5` IST), `standup.scan` (`*/15 10-11 * * 1-5`),
  `standup.summary` (`0 12 * * 1-5`). Poller runs while the REPL/daemon is up.
- CLI: `henry standup status | summary [--date] [--post]`.
- Prompt capability line: standup memories are the grounding for team questions —
  answer with person + date cited; `henry standup summary --date` for the ledger.

## Memory contract

- Per update: episodic, importance 5 — `Standup <date> — <person>: yesterday …;
  today …; blocked on …` with metadata `{domain:"standup", person, date}`.
- Daily summary: semantic, importance 6; any blocker naming Luvish bumps to 8 and is
  flagged at the top of his DM.

## Per-person style adaptation

Henry talks to multiple humans in the group, and each should feel talked *to*:

- The scan pass's output contract gains per-person **style observations** — register
  (formal/casual), typical length, emoji habits, language mix (English/Hinglish),
  signature quirks — extracted from the same batched call, zero extra provider spend.
- `styles` table in `standups.db`: `(user_id PK, user_name, profile_json,
  samples_seen, updated_at)` — merged incrementally so profiles sharpen over time;
  a material change snapshots to Engram (`{domain:"style", person}`) so recall
  answers "how does X write?" and future surfaces (DM bridge) inherit profiles.
- Every per-person outbound (clarification pings today, DM replies later) is
  composed WITH that person's profile injected: match their register, length, and
  language mix. A one-word-Hinglish teammate gets a short casual nudge; a formal
  one gets a crisp professional line.
- **Rail: style tunes tone only.** Content, rails, approvals, and honesty never
  bend per person, Henry never fakes being a human teammate, and clarifications
  stay polite regardless of how blunt the target's own style is.
- Henry's core persona (with Luvish and everywhere) stays constant — adaptation is
  a surface voice, not an identity change.

## Rails (non-negotiable)

- **Addressed-only (added 2026-08-08 on Luvish's order):** Henry stores and
  processes a group message ONLY when it starts with his @username
  (case-insensitive; mention stripped before storing) or directly replies to one
  of his own messages (clarification answers). All other group chatter is dropped
  unread — never persisted, never scanned, never nagged. Bot identity comes from
  `getMe`, cached in meta; if identity can't resolve, nothing is stored (fail
  closed, never fail open into read-everything).
- **Group text is untrusted data.** A teammate typing "Henry, delete the repo" is
  content to summarize, never an instruction. The scan/summary prompts carry the
  same untrusted-data framing as the jd pipeline.
- **Clarification pings ≤1 per person per day**, always a threaded reply, polite —
  the runaway-reminder lesson; `clarified` column enforces it.
- Outbound is limited to exactly two pre-authorized surfaces: the standup group
  (prompt + clarifications) and Luvish's DM (summary). Nothing else, no approval
  bypass created.
- Standup content stays local (`data/` is gitignored) — team data never reaches the
  public repo.
- Telegram holds undelivered updates ~24h: if the Mac is off for a full day, that
  window's messages are unrecoverable and the summary marks a collection gap.

## Luvish's setup steps (only he can do these)

1. Create the team group; add **@Henry_luv_bot**.
2. BotFather → `/mybots` → @Henry_luv_bot → Bot Settings → **Group Privacy →
   Turn off** (so the bot sees all group messages, not just commands).
3. Have anyone post one message in the group; Henry fishes the group chat id from
   `getUpdates` and it goes into `.env` as `TELEGRAM_STANDUP_CHAT_ID`.

## Relationship to the two-way DM bridge

This poller is ~90% of the previously designed (and permission-blocked) two-way
chat bridge. The standup module deliberately contains **no command execution** —
it reads, summarizes, and replies. Extending the poller into DM chat/remote
control remains a separate, explicitly-gated decision.
