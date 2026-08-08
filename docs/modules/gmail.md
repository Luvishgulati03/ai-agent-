# Module: gmail

**You are Claude Code, Codex, or another coding agent, reading this inside Henry's
repo.** Gmail access to Henry has two layers today: an MCP-first layer that gives
the free-form agent live read/draft access straight from the provider CLI, and a
built-in API integration (`src/integrations/gmail.ts`) that is still the only path
an approved send actually executes through. Read both sections before touching
either.

## 1. What it does

Read-only inbox access plus approval-gated outbound sending. Henry never sends an
email on its own trigger — every outbound message is staged as an approval item
first (`assertOutboundExecutionClaim` in `src/guardrails.ts` enforces this in code,
not just in the prompt). That rule holds regardless of which layer below reads or
drafts the email.

## 2. Architecture: MCP-first (current)

Empirically verified (see §2.4): the user's Codex CLI has a registered and
authenticated `gmail` MCP server
(`@gongrzhe/server-gmail-autoauth-mcp`, via `codex mcp add`/`~/.codex/config.toml`).
Because `codex exec` (Henry's `codex` provider path in `src/providers/runner.ts`)
loads its own MCP config the moment it starts, Henry running on codex gets Gmail
tools **natively in the model's tool list** — no `src/integrations/gmail.ts` code
runs, no shell-out to `henry gmail ...` is needed for reading.

### 2.1 How it works

- Codex's `gmail` MCP server exposes tools (search/read messages and threads,
  list labels, create drafts, etc.) directly to the model during a normal
  `npx tsx src/cli.ts ask "..."` run, exactly like any other MCP server described
  in `docs/modules/mcp-tools.md`.
- Henry can therefore **read inbox/threads and summarize or triage them inline**,
  in the same conversational turn, with no CLI round-trip.
- Henry can also **create drafts** via the MCP tools directly — a draft alone is
  not an outbound action.
- `src/agent/henry.ts`'s self-capabilities block spells this out to the model
  explicitly (see §2.3's hard rule) — this is the enforcement surface for the MCP
  path, since (per `docs/modules/mcp-tools.md` §3) MCP tool calls happen inside the
  provider subprocess, before any of Henry's own approval-gate code runs.

### 2.2 The empirical claude -p limitation

Verified twice tonight: `claude -p` has **no** Gmail tools available, even though
a Gmail connector is enabled in the claude.ai account. The claude.ai connector
does not propagate into `claude -p` tool-use calls the way `docs/modules/mcp-tools.md`
describes for other connectors — so today, MCP-native Gmail access is a
**codex-only** capability. Do not assume `claude -p` can read or draft Gmail; if
Henry is running on the Claude provider path, it has no Gmail tools at all unless
the optional local MCP server in §2.4 is wired up.

### 2.3 The send prohibition (hard rule)

Regardless of provider: MCP gmail tools may **read** and may **create drafts**,
and nothing else. Henry must **never** send, reply, forward, or modify
labels/read-state via an MCP gmail tool. Sending goes only through the approval
queue: `npx tsx src/cli.ts gmail draft --to ... --subject ... --body ...`, then
Luvish approves (`henry approve approve <approvalId>`), then a send executes via the
built-in integration in §3. If Luvish asks Henry to send something, Henry stages it
through that flow and says so — it does not attempt a send through any MCP tool
call, and there is no code-level guardrail that would catch it if it tried (see
`docs/modules/mcp-tools.md` §3), so this is prompt-enforced and must not be
weakened.

### 2.4 Optional: Claude-side parity (untested)

To give `claude -p` the same MCP-native Gmail read/draft access Codex has, the
same server can in principle be registered with the Claude CLI:

```bash
claude mcp add gmail -- npx @gongrzhe/server-gmail-autoauth-mcp
# then complete that server's own OAuth/auth flow (run it once interactively,
# or however @gongrzhe/server-gmail-autoauth-mcp documents first-run auth)
```

This is **OPTIONAL and UNTESTED** — it has not been verified on this machine.
If wired up, the same hard rule in §2.3 applies identically: read and draft only,
never send, regardless of which provider CLI is making the MCP call.

## 3. Optional: built-in API integration (approval-gated sending + scheduled sends)

This is the pre-existing `src/integrations/gmail.ts` module. It is no longer the
primary way Henry reads Gmail day-to-day (§2 is), but it remains load-bearing:
it is still the **only** path through which an approved send actually executes,
and it's what backs scheduled/prompt-driven sends (`henry remind --execute-approval`)
where there's no live MCP-equipped conversation to draft from.

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
actual send is through the approval gate (§3.3).

### 3.1 Configure

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

### 3.2 How it wires to the brain

- **Approval gate**: `queueEmail()` creates an approval of kind `gmail.send`
  via `ApprovalStore`. `HenryRuntime.executeApproval()` (`src/runtime.ts`)
  routes `gmail.send` approvals to `GmailService.sendApproved()`, which asserts
  the item is in `"executing"` state before it ever calls the Gmail API.
- **The free-form agent**: `HenryAgent.buildPrompt()` (`src/agent/henry.ts`)
  tells the provider CLI it can shell out to
  `npx tsx src/cli.ts gmail draft --to ... --subject ... --body ...` when Luvish
  asks for an email, and spells out the three-step flow: draft → Luvish approves
  (`henry approve approve <id>`) → send (`henry approve send <id>`, optionally
  scheduled via `henry remind --execute-approval`). Henry never approves on
  its own behalf. The same block also carries the MCP hard rule from §2.3.
- **Memory / provider runner**: `gmail.ts` itself makes no LLM calls and no
  memory writes — content generation, if any, happens upstream in the agent's
  free-form turn before it calls `gmail draft`.
- **Scheduler**: `workflows/defaults.json` ships a `gmail-inbox-poll` cron
  entry (`kind: "gmail.inbox"`, every 15 min) — **disabled by default**
  (`"enabled": false`).

### 3.3 Verify

```bash
npx tsx src/cli.ts gmail auth                    # completes OAuth, "Henry is connected to Gmail."
npx tsx src/cli.ts gmail inbox --limit 3          # prints up to 3 InboxMessage objects
npx tsx src/cli.ts gmail draft --to you@example.com --subject "test" --body "hello"
# → { message: "Saved locally and queued for Luvish's approval", approvalId: "...", dashboard: "http://127.0.0.1:7337" }
npx tsx src/cli.ts approve list                   # the approval shows status "pending"
npx tsx src/cli.ts approve approve <approvalId>   # status -> "approved"
npx tsx src/cli.ts approve send <approvalId>      # actually sends; prints the Gmail message id
```

Sending before approving must fail: `henry approve send <id>` on a `pending`
item throws `"Sending is blocked: approval ... is pending"` — confirm this
before trusting the module.

### 3.4 Disable

`GmailService` is constructed unconditionally in `HenryRuntime` (it is not
behind a feature flag today), so the clean disable is credential-shaped, not
code-shaped: leave `GMAIL_CREDENTIALS_PATH` unset/missing. `gmail auth`,
`gmail inbox`, and `gmail draft`'s eventual `sendApproved` call will all throw
`"Gmail credentials missing at ..."` — no network calls happen. Also keep
`gmail-inbox-poll` at `"enabled": false` in `workflows/defaults.json` (the
shipped default) so the scheduler never polls the inbox. Note this disable
lever is independent of §2 — it does not affect the MCP-native Gmail tools
Codex has via its own `gmail` MCP server; disabling that requires
`codex mcp remove gmail` (see `docs/modules/mcp-tools.md` §5).
