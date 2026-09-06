#!/bin/sh
# model-pull.sh — pull the three Ollama tags the brain's defaults expect.
# Usage: model-pull.sh          pull each tag in order; stop at the first failure
#        model-pull.sh --list   print the three tags, one per line, and exit (no Ollama needed)
# Env: BRAIN_MODEL (workhorse, default qwen3.5:4b) · BRAIN_REASONER (default gpt-oss:20b)
#      BRAIN_EMBEDDER (default qwen3-embedding:0.6b) — the same variables sdk/lib/models.js reads.
# Exit: 0 all pulled (or listed) · 1 a pull failed · 3 no ollama binary
set -u

WORKHORSE="${BRAIN_MODEL:-qwen3.5:4b}"
REASONER="${BRAIN_REASONER:-gpt-oss:20b}"
EMBEDDER="${BRAIN_EMBEDDER:-qwen3-embedding:0.6b}"

if [ "${1:-}" = "--list" ]; then
  printf '%s\n' "$WORKHORSE" "$REASONER" "$EMBEDDER"
  exit 0
fi

command -v ollama >/dev/null 2>&1 || { echo "[model-pull] no ollama binary on PATH — install Ollama first" >&2; exit 3; }

for m in "$WORKHORSE" "$REASONER" "$EMBEDDER"; do
  echo "[model-pull] ollama pull $m" >&2
  ollama pull "$m" || { echo "[model-pull] pull failed: $m" >&2; exit 1; }
done
echo "[model-pull] done: $WORKHORSE $REASONER $EMBEDDER" >&2
