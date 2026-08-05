# Lavu memory

Markdown files in this directory are the durable source material for Engram. The generated SQLite index lives under `data/` and can be rebuilt with:

```bash
lavu memory index
```

Conversation outcomes and approved preferences are written to `memory/captured/` at runtime.
