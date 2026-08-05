# Lavu end-to-end test plan

This is the executable validation plan for Lavu. Tests must run against the isolated repository at `/Users/luvishgulati/Desktop/junior's repo/luvish jr/` and must never send an external message accidentally.

## Test environments

### Local offline suite

- Node.js 20+.
- Dependencies installed with `npm install`.
- No Gmail credentials required.
- No GitHub write operation required.
- Uses temporary directories for Engram databases, activity logs, approvals, and generated schedules.
- Runs on every phase commit.

Commands:

```bash
npm run typecheck
npm test
npm run build
```

### Provider smoke environment

- Codex CLI installed and authenticated.
- Claude CLI installed and authenticated for fallback coverage.
- Run in a disposable Git repository or a dedicated test worktree.
- Use `approval_policy="never"` only inside the disposable test environment.
- Never pass production secrets to test prompts.

### Gmail sandbox environment

- Google OAuth desktop credentials stored outside Git.
- A dedicated test Gmail account or test label, not a personal inbox.
- Test messages addressed only to the test account.
- Token file stored under ignored `data/`.
- Outbound send cases require a human confirmation step and an explicit test recipient.

### GitHub fixture environment

- A private test repository with a disposable pull request.
- `gh auth status` checked before starting.
- Review comments tested first with a dry-run or fixture API response.
- Posting a comment is never part of unattended CI; it requires an explicit approval test step.

## E2E test matrix

| ID | Flow | Expected result | External side effect |
| --- | --- | --- | --- |
| E2E-01 | `lavu status` | Returns provider, dashboard, memory, and approval status | None |
| E2E-02 | `lavu ask "..."` with Codex | Recalls Engram context, returns response, captures outcome | Local memory write only |
| E2E-03 | Codex failure then Claude fallback | Claude runs, result identifies fallback provider, failure is logged | None |
| E2E-04 | Interactive REPL | Multiple turns work, `:memory`, `:status`, and `:quit` work | Local memory writes only |
| E2E-05 | `lavu memory remember/search/index/dream` | Memory survives a new process and graph stats update | Local database/files only |
| E2E-06 | Dashboard health/status/activity | Localhost endpoints return valid JSON and UI loads | None |
| E2E-07 | Dashboard ask | Request runs through Lavu and appears in activity | Local memory write only |
| E2E-08 | Dashboard dispatch | Luna dispatches a bounded specialist task and records the run | None unless `allowEdits` is explicitly enabled |
| E2E-09 | Gmail OAuth missing | CLI gives actionable credentials/auth instructions | None |
| E2E-10 | Gmail inbox read | Messages are parsed with sender, subject, thread, date, and body | Read only |
| E2E-11 | Gmail draft/reply | Local approval item is created and dashboard shows it | No message sent |
| E2E-12 | Gmail approval | Pending → approved → executed transition is enforced | One explicitly approved test message |
| E2E-13 | Gmail duplicate execution | Executed item cannot be sent a second time | No second message |
| E2E-14 | Scheduler list/run | Workflow loads, runs the selected job, and logs completion/failure | Depends on selected workflow |
| E2E-15 | Scheduler install | Cron and launchd files are generated under ignored `data/` | No scheduler installed automatically |
| E2E-16 | PR review | Full diff is reviewed through six passes and report is saved | No GitHub post |
| E2E-17 | PR review approval | Inline comments and verdict are staged in one approval item | No post until approval |
| E2E-18 | Approved PR review | GitHub review is posted once and item becomes executed | One explicitly approved test review |
| E2E-19 | PR re-review | Existing comments are read and duplicate findings are suppressed | No post unless approved |
| E2E-20 | Restart/recovery | Activity, memory, approvals, and review reports survive process restart | Local persistence only |

## Detailed scenarios

### Terminal and provider flow

1. Start from a clean disposable repository.
2. Run `lavu status` and assert `provider=codex`.
3. Run an ask that requests a deterministic short response.
4. Assert the response is non-empty and the activity log contains `run.started`, `run.completed`, `memory.recalled`, and `memory.saved`.
5. Temporarily make the Codex command unavailable through a test-only PATH and run the same ask.
6. Assert Claude is attempted and the result identifies `claude`.
7. Restore PATH and verify no credentials appear in activity, output, or memory.

### Engram persistence and recall

1. Write a unique test decision with `lavu memory remember`.
2. Search for a paraphrase in a new process.
3. Assert the result includes the decision and an explainable `why` field.
4. Run `lavu memory index --fresh` and repeat the search.
5. Run `lavu memory dream` and assert the operation completes without deleting protected test memory.
6. Verify only ignored `data/engram.db*` files change.

### Approval gate

1. Create a Gmail draft and assert status `pending`.
2. Attempt direct execution and assert it fails.
3. Approve it and assert status `approved`.
4. Execute it once with a test recipient.
5. Assert status `executed` and reject a second execution attempt.
6. Repeat the same transition with a GitHub PR review.
7. Confirm the dashboard displays the body before execution.

### Dashboard

1. Start `lavu dashboard` on a random test port.
2. Assert `/api/health`, `/api/status`, `/api/activity`, `/api/approvals`, `/api/workflows`, and `/api/memory/graph` return JSON.
3. Send a same-origin `POST /api/ask` and assert a response.
4. Send a cross-origin request with a non-local `Origin` header and assert HTTP 403.
5. Create a pending approval and assert the dashboard lists it.
6. Approve and execute through separate dashboard requests; verify the application transition rules still apply.

### Gmail

1. Run `lavu gmail auth` with missing credentials and assert the message is actionable.
2. Connect a dedicated sandbox account.
3. Run `lavu gmail inbox --limit 5` and verify headers/body parsing.
4. Generate a reply with `--thread-id` and assert the local approval payload preserves the thread.
5. Verify scheduler polling reads messages but never sends.
6. Send only after explicit approval and verify the exact test recipient, subject, body, and thread.

### Pull request review

1. Create a fixture PR containing one known bug, one safety issue, and one missing test.
2. Run `lavu review <number> --cwd <fixture-repo>`.
3. Assert the saved report contains all six pass keys, verdict, summary, severity, path, line, and provider.
4. Assert a `github.review` approval is created and no GitHub review exists yet.
5. Inspect the staged body in CLI and dashboard.
6. Approve and execute once against the fixture PR.
7. Re-run review after adding a commit and verify existing comments/reviews are supplied to the reviewer and duplicate findings are not re-posted.

## CI boundaries

The default CI job should run only the offline suite:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Provider, Gmail, and GitHub tests should be opt-in jobs guarded by explicit secrets and dedicated fixtures. They must never run against Dad’s personal Gmail or a production repository.

## Exit criteria

The implementation is considered E2E-ready when:

- E2E-01 through E2E-08 and E2E-14 through E2E-15 pass offline.
- E2E-09, E2E-11 through E2E-13 pass with mocked or sandbox Gmail.
- E2E-16 through E2E-19 pass with a disposable private GitHub fixture.
- E2E-20 passes after restarting the process.
- No test can send or post without an explicit approval transition.
- `npm run typecheck`, `npm test`, and `npm run build` pass from a clean checkout.
