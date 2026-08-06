# Module: gmail

**You are Claude Code, Codex, or another coding agent, reading this inside Henry's
repo.** This module is already implemented in the kernel fork at
`src/integrations/gmail.ts` — don't rebuild it. Your job here is narrow: **configure
credentials and verify the wiring**, nothing more.

## 1. What it does

Read-only inbox access plus approval-gated outbound sending. It never sends an
email on its own trigger — every outbound message is staged as an approval item
first (`assertOutboundExecutionClaim` in `src/guardrails.ts` enforces this in code,
not just in the prompt).

Commands it adds (`src/cli.ts`, `gmail` branch):

```
henry gmail auth                                            # one-time OAuth
henry gmail inbox [--limit N]                                # read (default 10)
henry gmail draft --to <email> --subject <s> --body <b> [--thread-id <id>]
henry gmail send  --to <email> --subject <s> --body <b>       # same as draft: still queues, never sends
henry gmail reply --to <email> --subject <s> --body <b> --thread-id <id>
```

`draft`, `send`, and `reply` are aliases for the exact same call
(`GmailService.queueEmail`) — none of them send anything. All three create a
pending `gmail.send` approval and print its `approvalId`. The only path to an
actual send is through the approval gate (§4).

## 2. Configure

Env keys (`.env`, all read by `src/config.ts`):

```
GMAIL_CREDENTIALS_PATH=./data/gmail-credentials.json   # default shown
GMAIL_TOKEN_PATH=./data/gmail-token.json                # default shown
GMAIL_REDIRECT_URI=http://127.0.0.1:43821/oauth2callback # default shown
DAD_EMAIL=                                              # optional, for recognizing the owner's own address
```

One-time external setup (Google Cloud OAuth desktop credentials):

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select a
   project, enable the **Gmail API**.
2. Create OAuth 2.0 credentials of type **Desktop app**.
3. Download the JSON and save it at the path in `GMAIL_CREDENTIALS_PATH`
   (default `data/gmail-credentials.json`).
4. Run `henry gmail auth` — it prints an authorization URL, opens it on macOS
   automatically, and runs a local callback server on the port in
   `GMAIL_REDIRECT_URI` to capture the token. The token is written to
   `GMAIL_TOKEN_PATH` with `0o600` permissions.
5. Scopes requested: `gmail.readonly` and `gmail.send` (see `SCOPES` in
   `src/integrations/gmail.ts`) — nothing broader.

## 3. How it wires to the brain

- **Approval gate**: `queueEmail()` creates an approval of kind `gmail.send`
  via `ApprovalStore`. `HenryRuntime.executeApproval()` (`src/runtime.ts`)
  routes `gmail.send` approvals to `GmailService.sendApproved()`, which asserts
  the item is in `"executing"` state before it ever calls the Gmail API.
- **The free-form agent**: `HenryAgent.buildPrompt()` (`src/agent/henry.ts`)
  tells the provider CLI it can shell out to
  `npx tsx src/cli.ts gmail draft --to ... --subject ... --body ...` when Dad
  asks for an email, and spells out the three-step flow: draft → Dad approves
  (`henry approve approve <id>`) → send (`henry approve send <id>`, optionally
  scheduled via `henry remind --execute-approval`). Henry never approves on
  its own behalf.
- **Memory / provider runner**: `gmail.ts` itself makes no LLM calls and no
  memory writes — content generation, if any, happens upstream in the agent's
  free-form turn before it calls `gmail draft`.
- **Scheduler**: `workflows/defaults.json` ships a `gmail-inbox-poll` cron
  entry (`kind: "gmail.inbox"`, every 15 min) — **disabled by default**
  (`"enabled": false`).

## 4. Verify

```bash
npx tsx src/cli.ts gmail auth                    # completes OAuth, "Henry is connected to Gmail."
npx tsx src/cli.ts gmail inbox --limit 3          # prints up to 3 InboxMessage objects
npx tsx src/cli.ts gmail draft --to you@example.com --subject "test" --body "hello"
# → { message: "Saved locally and queued for Dad's approval", approvalId: "...", dashboard: "http://127.0.0.1:7337" }
npx tsx src/cli.ts approve list                   # the approval shows status "pending"
npx tsx src/cli.ts approve approve <approvalId>   # status -> "approved"
npx tsx src/cli.ts approve send <approvalId>      # actually sends; prints the Gmail message id
```

Sending before approving must fail: `henry approve send <id>` on a `pending`
item throws `"Sending is blocked: approval ... is pending"` — confirm this
before trusting the module.

## 5. Disable

`GmailService` is constructed unconditionally in `HenryRuntime` (it is not
behind a feature flag today), so the clean disable is credential-shaped, not
code-shaped: leave `GMAIL_CREDENTIALS_PATH` unset/missing. `gmail auth`,
`gmail inbox`, and `gmail draft`'s eventual `sendApproved` call will all throw
`"Gmail credentials missing at ..."` — no network calls happen. Also keep
`gmail-inbox-poll` at `"enabled": false` in `workflows/defaults.json` (the
shipped default) so the scheduler never polls the inbox.
