# Architecture

This is the public, canonical description of how this agent is built:
the kernel, the module contract that lets you add or remove capabilities,
the memory pipeline, and the orchestration doctrine that governs how work
gets dispatched. If you are forking this repo, start here, then
`BOOTSTRAP.md` to stand up your own instance, then `docs/design-your-soul.md`
to write your persona files.

## 1. Kernel and modules

The governing design idea is **a minimal kernel plus optional modules**.
The kernel is always present and never depends on any module; every
capability beyond it is opt-in, and removing a module never breaks
another one.

```text
                   terminal / REPL / local dashboard (SSE realtime)
                                      |
                                   CLI entry
                                      |
                                  the Runtime
        ┌──────────┬──────────┬───────┼────────┬───────────┬──────────┐
     Memory     Workflows  Orchestrator Approvals  Modules    Modules
    (Engram)   (scheduler)  (dispatch)  (store+gate) (gmail,   (jobs/career,
        |            |          |           |         pr-review) knowledge, ...)
        └── ProviderRunner: subscription CLI (Codex / Claude), tier routing
        └── optional: Playwright browser, whisper.cpp, local embeddings
```

### Kernel components

- **Runtime** — the composition root. It reads config, wires up memory,
  approvals, the provider runner, the scheduler, and every enabled
  module, and exposes one interface to the CLI, REPL, and dashboard.
  Nothing outside the runtime talks to a module directly.
- **Config** — a single typed config object loaded from environment
  variables, with safe defaults so an unconfigured module stays dormant
  instead of crashing the process.
- **ProviderRunner — subscription CLI only.** Every model call runs as a
  local subprocess of a provider's own CLI (subscription auth), never a
  paid per-token API. Tiering happens via CLI flags (model, effort/
  reasoning-level). Provider output, including a JSON-lines event stream,
  is mapped to one internal event shape, so the rest of the system is
  provider-agnostic.
- **Memory (Engram)** — the canonical memory engine. Markdown on disk is
  the durable source of truth; a SQLite index is the rebuildable
  retrieval layer on top of it. See §3 for the pipeline.
- **Approval store + guardrails** — every outbound action (send an
  email, post a comment, submit a form, message someone) is staged as an
  approval item, never executed directly. The **approve-vs-execute
  invariant**: approving and executing are two separate operations,
  gated by an explicit claim step, so a scheduled job, a model
  instruction, or an ambiguous "go ahead" can never count as approval.
  This is enforced in code, not just prompt text — execution requires a
  claimed, approved approval record to already exist.
- **Scheduler** — a cron-driven runner for background workflows (memory
  maintenance, inbox polling, distillation, etc.), each independently
  enabled/disabled and producing the same activity-log events as
  interactive work.
- **Dashboard** — a local, loopback-only control surface (activity
  stream, approval queue, module panels, provider toggle) served over
  server-sent events. Exposing it beyond localhost requires an explicit
  token-protected remote mode — the approval queue and full-access
  provider control must never sit behind an unauthenticated interface.

## 2. The module contract

A module is anything that isn't in the kernel: email, job applications,
PR review, a knowledge base, scheduled workflows with side effects, and
so on. Each module lives in its own directory and registers through one
interface, roughly:

```text
{
  name,
  init(runtime),
  cliCommands?,
  approvalKinds + executor?,   // if it produces outbound actions
  activityKinds?,
  dashboardPanel?,
  workflows?,
  configKeys                   // all with safe defaults
}
```

Rules that keep the contract honest:

- A disabled module is never constructed — not initialized with empty
  config, simply never instantiated.
- The kernel iterates registered modules; no kernel file imports a
  specific module directly except the registry itself.
- Any module that can take an outbound action must route execution
  through the approval store's claim step — a module never sends,
  posts, or submits on its own trigger.
- A module you don't want costs nothing: no code loaded, no config
  required, no behavior change elsewhere.

Shipped modules today (each independently toggleable): **gmail** (read
inbox, generate replies, save drafts — sending is approval-gated),
**jobs/career** (inspect postings, tailor a resume-grounded application,
approval-gated submission), **cover letters** (standalone tailored
cover-letter generation), **knowledge base** (a second, on-demand RAG
store for a curated domain corpus you provide — kept separate from
personal memory because it has a different lifecycle: versioned and
source-attributed instead of decaying), **pr-review** (six-pass GitHub
review, staged comments), and **scheduler workflows** (cron-driven
background jobs). Meeting transcription, screenshot sorting, and
X/social messaging are in progress and not yet stable — see
`BOOTSTRAP.md`'s module list for current status.

To add your own module: implement the interface above, register it, add
its config keys (with defaults), and — if it introduces a new outbound
channel — name that channel explicitly in your fork's `soul.md`.

## 3. Memory architecture

Personal memory and any knowledge-base module are deliberately separate
stores with different lifecycles: memory decays, supersedes, and
promotes; a knowledge base is versioned and never decays. Personal memory
follows a **capture → extract → arbitrate → store → consolidate →
retrieve → inject** pipeline:

1. **Capture (hot path)** — a raw transcript is written per exchange;
   no inline extraction happens on the hot path, only a debounce timer.
2. **Extraction (background, debounced)** — once a conversation settles,
   an extraction pass pulls atomic, dated, entity-tagged facts; a
   novelty gate drops non-news before any model call is spent on it.
3. **Arbitration (write time)** — each new fact is compared against its
   nearest existing memories and classified add / update / no-op. An
   update supersedes the old memory rather than deleting it, so
   corrected information can't resurface later.
4. **Storage** — memory lives in a local SQLite index with local
   embeddings (no external embedding API); memories are tiered episodic
   → semantic (promoted, protected) → procedural.
5. **Consolidation (nightly, idle hours)** — a "dream" pass promotes and
   consolidates memory, builds retrieval edges, and rewrites a small
   profile summary (identity, active projects, preferences, current
   commitments) capped to a low token budget.
6. **Retrieval (hot path)** — hybrid search plus entity-seeded spreading
   activation, with a recency half-life so older, unused memories fade
   from ranking without being deleted.
7. **Injection (budgeted)** — the profile summary plus score-thresholded
   recall results are injected per turn under a fixed token budget;
   weak matches are dropped rather than padded in to fill a quota.

## 4. Dispatch doctrine (orchestration)

When work is broken into sub-agents, every dispatch sets four knobs
explicitly — there is no global default:

| Tier | Use for | Cost profile |
|---|---|---|
| **T0 — nano/low-effort** | Triage, classification, extraction, formatting, summaries | Cheapest tier available |
| **T1 — standard** | Routine implementation, test authoring, doc updates | Subscription CLI, default effort |
| **T2 — frontier/high-effort** | Architecture, hard debugging, review verdicts, final tailored writing | Scarce — budget it, don't default to it |

The rules, compressed to their essence:

1. Decompose every workflow into bounded tasks before dispatching.
2. Use the lowest tier that clears the quality bar; escalate one tier on
   failure rather than starting over at the top.
3. If deterministic code can do the step, don't dispatch an agent for it.
4. Every dispatch is bounded: exact question, inputs, expected output
   shape, stop condition — never an open-ended "look around."
5. Workers return closed, machine-readable results, not prose to parse.
6. Separate read-only investigation passes from editing passes; isolate
   concurrent edits (e.g. via worktrees) so they can't collide.
7. Parallelize only genuinely disjoint work; shared-state work runs
   sequentially.
8. Every worker has an envelope — turn cap, wall-clock cap, and a
   resource watchdog — and reports partial results on failure instead of
   spinning.
9. The orchestrator dispatches instead of doing worker-shaped tasks
   inline, even "just to check something."
10. Capturing outcomes to memory is itself a dispatched task at the end
    of a workflow, not an afterthought.

## 5. What runs where — cost note

- **Local embeddings** run on-device via a small local model — $0 per
  call, no external embedding API required.
- **All model reasoning** runs through subscription CLIs (provider
  authentication, not pay-per-token API keys) — this repo requires **no
  API keys** to operate the core agent loop.
- **Optional paid paths** (e.g. a social-messaging send API, image
  generation) are opt-in, isolated to their own module, and never
  required for the kernel or the modules above to function.
- The result: a fork can run entirely on a consumer laptop, bounded by
  the provider CLI's subscription limits and local compute, with no
  recurring per-token bill for the agent itself.
