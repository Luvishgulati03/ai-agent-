# Module: telegram

**You are Claude Code, Codex, or another coding agent, reading this inside
Henry's repo.** Already implemented at `src/notify/telegram.ts` — don't
rebuild it. Configure and verify only.

## 1. What it does

`sendTelegram(config, text)` posts `text` to Luvish's own Telegram chat via the
Bot API (`sendMessage`). It is a **fire-and-forget, fail-open** notification
channel layered on top of the existing console + macOS-notification path
(`notifyReminder` in `src/reminders/service.ts`) — it never replaces it and
never throws. Any failure (unconfigured, network error, timeout, non-2xx
response) returns `false` silently.

**SCOPE-GUARD**: this is an operator-notification channel only. `chat_id`
always comes from config — Luvish's own chat — and is never accepted as a
caller-supplied parameter. It is never a general send-to-anyone surface;
outbound messages to other people still stage through the `ApprovalStore`
exactly as before.

Where it's wired in (composed once, in `src/runtime.ts`, as
`HenryRuntime.notifyOperator`):

- `henry schedule daemon` — the scheduler's reminder ticker and the
  `mail.watch` workflow both notify through it.
- `henry dashboard` — its reminder ticker notifies through it.
- `henry telegram test` — a direct one-off send for setup verification.

`henry repl`'s reminder ticker intentionally keeps its own terminal-echo
notifier (the message prints above the prompt Luvish is already watching) and
does not also fire Telegram.

## 2. Configure

1. **Create the bot** — message [@BotFather](https://t.me/BotFather) on
   Telegram:
   ```
   /newbot
   ```
   Follow the prompts (choose a name, then a username ending in `bot`).
   BotFather replies with an HTTP API token that looks like
   `123456789:AAExampleTokenTextGoesHere`. That's `HENRY_TELEGRAM_BOT_TOKEN`.

2. **Get your chat id** — open a DM with your new bot and send it any
   message (e.g. "hi"), then run:
   ```bash
   curl -s "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates"
   ```
   Find `"chat":{"id":<NUMBER>, ...}` in the response — that number
   (may be negative for group chats) is `HENRY_TELEGRAM_CHAT_ID`. If the
   response has an empty `"result":[]`, you haven't messaged the bot yet —
   send it a message and re-run the curl command.

3. **Add to `.env`**:
   ```
   HENRY_TELEGRAM_BOT_TOKEN=123456789:AAExampleTokenTextGoesHere
   HENRY_TELEGRAM_CHAT_ID=987654321
   ```

No other setup. `HenryConfig.telegramBotToken` / `telegramChatId` are read
via the same `HENRY_<name>` (falling back to `LAVU_<name>`) convention as
every other env-backed config field (`src/config.ts`).

## 3. Verify

```bash
npx tsx src/cli.ts telegram test
# → "ok — check your Telegram chat" and a "Henry → Telegram is live 🎉"
#   message arrives in the configured chat within a few seconds
```

If it prints `fail — check HENRY_TELEGRAM_BOT_TOKEN / HENRY_TELEGRAM_CHAT_ID
in .env, then see docs/modules/telegram.md`, re-check step 2/3 above — most
commonly the chat id wasn't captured because the bot was never messaged
first.

## 4. Disable

Remove (or blank out) `HENRY_TELEGRAM_BOT_TOKEN` and
`HENRY_TELEGRAM_CHAT_ID` from `.env` and restart any running Henry process.
`sendTelegram` no-ops (returns `false` immediately) whenever either key is
missing — every notification path still delivers via console + macOS
notification exactly as before; only the Telegram leg is skipped.
