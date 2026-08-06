---
name: memory-consolidation
enabled: true
description: Run the offline Engram consolidation pass and summarize memory promotions, archives, and draft rules.
triggers:
  - type: schedule
    cron: "38 6 * * *"
    timezone: Asia/Kolkata
  - type: command
    command: memory-consolidation
outputs:
  - type: docs
    path: data/workflow-runs/memory-consolidation
runner:
  tier: t1
  timeoutMs: 900000
concurrency: skip
---

Run the associative-memory consolidation workflow for Henry's Engram memory module.

Use the memory code path as the source of truth: raw source records in `memory/` and
`memory/captured/` remain authoritative, derived memories are rebuildable, and any
promotion/archive/rule proposal must preserve provenance.

Access memory through the supported CLI surface, not by editing the SQLite index directly:

- `henry memory search "<query>"` — recall relevant memories
- `henry memory remember "<content>"` — write a new memory
- `henry memory graph` — inspect the memory graph
- `henry memory dream` — run Engram's consolidation pass
- `henry memory index [--fresh]` — rebuild the SQLite index from the markdown source under `memory/`

Expected work:

1. Run `henry memory dream` to trigger Engram's own consolidation pass and capture its result.
2. Inspect recent memory source records (`memory/captured/`), derived events, ingestion
   classifications, and corrections via `henry memory search`.
3. Promote repeated corrections into routing memories only when the evidence is explicit.
4. Promote repeated high-importance patterns into lessons/facts only when source records
   support a reusable behavioral rule, user preference, domain fact, or operating
   procedure.
5. Do not promote tag-count clusters into lessons. A lesson must say what to do
   differently, when to apply it, and why the evidence supports it.
6. Flag low-importance stale events and low-value derived memories that should be
   archived out of active recall, without deleting source records.
7. Propose draft ingestion rules from repeated corrections; do not mark them accepted
   without review.
8. Record a compact summary of decisions: promoted memories, flagged-for-archive event
   ids, draft rule ideas, and any blockers.

Quality bar:

- Tag-based promotion is allowed only for semantic tags that describe reusable work
  patterns, domains, products, features, user preferences, or procedures.
- Tags may help find candidate evidence, but a promoted lesson must be backed by source
  bodies that explain why the pattern matters.
- Reject or flag promotions from operational/indexing tags (e.g. `agent:*`,
  `runner_tool_error`, `runner_output`, `error`, `command:*`, or similarly broad
  metadata tags) — these are retrieval labels, not lessons.
- Before proposing any promotion, check via `henry memory search` whether an equivalent
  lesson/fact/summary already exists. Prefer updating or merging over creating
  timestamped near-duplicates.
- Flag generated lessons whose body is only a count, a tag name, or a source-list —
  these are indexes, not memories.
- Treat clusters of tool errors, runner failures, or agent activity as health/telemetry
  findings, not associative-memory lessons.

Do not run this on every message. This is an offline/operator-triggered pass, not the
hot capture path.
