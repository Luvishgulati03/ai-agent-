# Knowledge RAG — architecture & production-RAG lineage

Date: 2026-08-07. This is the canonical description of Henry's knowledge system and its
explicit mapping to the reference production RAG that the organization built in its backend repo (`learning_chunks` +
Atlas Vector Search). We deliberately use the **same architecture and method**, swapping
infrastructure for local-first equivalents. Read `docs/MASTER_PLAN.md` §6.2/§6.2b for the
original design decisions and `docs/modules/knowledge-base.md` for operations.

## 1. The pipeline, end to end

```
org-prod Mongo (read-only, DB_STRING from the reference backend repo's .env at runtime)
   │  export: learningchunks (LLM-chunked by the reference production RAG) + video transcripts + text modules
   ▼
knowledge/raw/            ← markdown + jsonl, gitignored (the organization's IP, never leaves machine)
   │  ingest: context-prefixed local embeddings (bge-small-en-v1.5 q8, 384d, $0)
   ▼
data/knowledge.db         ← Engram instance #2: SQLite (vectors + FTS5 + associative graph)
   │  distill (one-time full run): Codex turns each module into 3-8 STRATEGY CARDS
   ▼
knowledge/cards/*.md      ← atomic tactics: claim · when-to-use · steps · evidence · source
   │  indexed into the same DB, layer="card", importance 8
   ▼
RETRIEVAL (LLM-free, ~350ms warm)
   │  hybrid RRF (cosine + FTS5) ⊕ spreading activation ⊕ domain boost ⊕ filters
   ▼
INJECTION — only when the turn's domain matches (zero-LLM router), as a labeled block:
   "--- Curated knowledge (tried & tested playbooks) ---"
   cards first, raw chunks as depth; ≤2 chunks/module; ~6k char budget; source attribution
```

## 2. Element-by-element mapping to the backend production RAG

| Production RAG (reference backend repo) | Henry | Why the swap |
|---|---|---|
| AWS Transcribe → `awsmediajobs.transcript` | Same source, exported read-only | Identical corpus |
| LLM semantic chunking (DeepSeek, chapter titles, 500-1500 chars, content_role/difficulty/concepts) | **Inherited as-is** — we export `learningchunks`, so their most expensive processing is reused free | Never re-pay for chunking |
| Contextual retrieval: `Product \| Module \| Chapter` prefix embedded, raw text displayed | Same technique — module/product prefix in `embedding` text, raw text stored | Proven +recall on short chunks |
| Voyage `voyage-4-large`, 1024d, API | `bge-small-en-v1.5` q8 local, 384d, transformers.js | $0, offline, M1-fast (~10ms) |
| Mongo Atlas `$vectorSearch` + filter fields | Engram SQLite: hybrid RRF (vector+FTS5) + **spreading activation** over typed edges | Local; activation adds associative recall Atlas doesn't have |
| `minScore: 0.70` cosine cut (their #1 false-positive killer) | `minScore: 0.02` on the *fused* score scale (empirically calibrated — different scale, same principle: threshold beats pure top-K) | Same rule, recalibrated |
| Planned: cap results per module for diversity | **Implemented**: ≤2 chunks per module | Their Tier-1 roadmap item, done here |
| `audience` as rerank-boost, never hard filter (their decision log) | `domain` as ranking boost ×1.5, never hard filter | Their own blind-spot lesson, generalized |
| Access control: member `module_access` pre-filter | N/A — single-operator local system | Simpler by design |
| Versioned writes + atomic active-flag swap | Planned with re-ingestion work (doctrine rule; full rebuilds currently used instead) | Same crash-safety goal |
| Retrieval-only (Tutor Q&A deferred) | **Injection into the agent turn** — Henry reasons WITH the knowledge, cites module names | We're the consumer they deferred |
| 32-query manual benchmark before rerank investment | Henry eval set (~30 real queries) — planned with the metrics module (dashboard v2) | Their eval-first method |
| Their improvement ladder: minScore bump → per-module cap → role boost → LLM rerank → query expansion → hybrid RRF | Ladder positions 1-2 done; hybrid RRF native; `rerank`/query-expansion available in Engram, gated behind the eval set | Same roadmap, right order |

## 3. What Henry adds beyond the production RAG

1. **Strategy cards** — a distilled precision layer the production RAG doesn't have: atomic playbook
   units with provenance, ranked above raw chunks at recall. (Full-corpus distillation run:
   see `data/full-extraction.log`.)
2. **Associative graph recall** — spreading activation seeded by query entities (HippoRAG's
   PPR family), so "community launch" surfaces adjacent pricing/activation content.
3. **Usage reinforcement** — `markUsed`/`reinforce` on every recall: cards that keep proving
   useful rank higher; feeds salience like the production RAG's planned usage signals.
4. **Domain routing at zero cost** — a regex router decides *whether* knowledge is injected
   at all; chit-chat never pays the retrieval tax.
5. **Two-store separation** — personal memory (decays/supersedes) vs knowledge (versioned,
   never decays); the production RAG only has the corpus store.

## 4. How the agent actually uses it (surfaces)

- **Every domain-matched turn**: auto-injected labeled block; Henry cites module names.
- **Explicit**: `henry knowledge search|context "<q>" [--domain gtm]` — also exposed to
  Henry's own brain (self-capabilities) so he can re-query mid-reasoning.
- **Launch crew** (§6.3): the GTM strategist gets card-grounded context and the intake agent
  derives its question list from what the matched cards require.
- **Dashboard**: knowledge stats panel; recall lab with activation trace (dashboard v2).

## 5. Operational notes

- Corpus and DB are **local-only forever** (the organization's IP): `knowledge/`, `data/knowledge.db`
  gitignored; the public repo ships the empty module + adapters.
- Refresh: re-run `henry knowledge export` + `index` (idempotent-ish; full rebuild preferred
  until versioned swap lands). Distillation is checkpointed (`knowledge/cards/.distilled.json`)
  — safe to interrupt and resume any time; the nightly cron is disabled by Luvish's request
  (laptop sleeps) in favor of manual full runs.
