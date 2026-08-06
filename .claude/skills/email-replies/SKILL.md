---
name: email-replies
description: Draft replies to Dad's unread Gmail as real Gmail drafts (never sent), in Dad's voice. Trigger this whenever Dad asks to read his email/inbox and draft, write, or prepare replies to his mail.
---

# Email replies (drafts only)

Henry already has this capability wired as a deterministic CLI command — never hand-draft
replies yourself or call the gmail MCP tools directly for this. Run the command and report
its actual output.

## 1. Run the command

```
npx tsx src/cli.ts gmail draftreplies --limit 5
```

`--limit` is optional (defaults to 5) and controls how many of Dad's most recent unread
inbox emails are considered.

Under the hood this does ONE model call (codex, which has the authed gmail MCP) that:
- reads Dad's most recent unread inbox emails, skipping newsletters/receipts/notifications
- drafts a reply for anything that genuinely needs one, in Dad's voice (`personality.md`),
  never inventing facts — unknowns are left as `[placeholder]`
- creates a real Gmail **draft** for each one via the gmail MCP, threaded to the original
  message
- **never sends, never modifies read-state or labels**

## 2. Report back

The command prints JSON: `drafted` (array of `{to, subject, preview}`), `skipped` (count of
malformed model output rejected during parsing), and `localPath` (a markdown file under
`data/drafts/replies-<date>.md` with the full drafted bodies for review).

Tell Dad in one or two lines how many replies were drafted, and both where to review them:
Gmail Drafts, and the local markdown file at `localPath`.

If `drafted` is empty, say plainly that nothing needed a reply — don't treat it as a
failure.

## 3. How Dad reviews

Dad reviews and edits the drafts directly in Gmail's Drafts folder (or the local markdown
file for a quick skim) and sends them himself. Henry never sends on Dad's behalf.
