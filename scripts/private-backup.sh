#!/usr/bin/env bash
# Refresh the PRIVATE full mirror (~/henry-private → github.com/<you>/henry-private).
# The mirror carries everything the public framework repo excludes (soul, memory,
# data, knowledge corpus). Secrets and the >100MB knowledge.db stay out — see
# PRIVATE-README.md in the mirror. Safe to run any time; no-ops when clean.
set -euo pipefail

SRC="${HENRY_DIR:-$HOME/Downloads/henry}"
DEST="${HENRY_PRIVATE_DIR:-$HOME/henry-private}"

if [ ! -d "$DEST/.git" ]; then
  echo "Private mirror not initialized at $DEST — see PRIVATE-README.md" >&2
  exit 1
fi

rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .git --exclude .env \
  --exclude .DS_Store --exclude "data/browser-profile" \
  --exclude "data/knowledge.db" --exclude "data/knowledge.db-shm" --exclude "data/knowledge.db-wal" \
  --exclude .gitignore --exclude PRIVATE-README.md \
  "$SRC/" "$DEST/"

cd "$DEST"
git add -A
if git diff --cached --quiet; then
  echo "Private mirror already up to date."
else
  git commit -q -m "backup: $(date '+%Y-%m-%d %H:%M') sync from working repo"
  git push -q private main
  echo "Private mirror updated and pushed."
fi
