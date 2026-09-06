#!/bin/sh
# ollama-serve.sh — keep a local Ollama HTTP API alive on 127.0.0.1:11434.
#
# Every ollama-provider pipeline (auto-wrap, session-summary, scan insights, embeddings)
# POSTs to this port. When the listener is gone they fail with ECONNREFUSED and the
# provider layer falls back to claude/none. Run this script from a supervisor that
# restarts it on exit (launchd KeepAlive on macOS, a systemd user unit with
# Restart=always on Linux): every exit below is a restart — that buys crash recovery,
# not just start-at-login.
#
# POSIX sh, macOS + Linux. Env: OLLAMA_HOST, OLLAMA_PORT, AOS_OLLAMA_LOG (log path),
# and the usual OLLAMA_* tuning variables (defaults below only apply when unset).
set -u

HOST="${OLLAMA_HOST:-127.0.0.1}"
PORT="${OLLAMA_PORT:-11434}"
PROBE="http://$HOST:$PORT/api/tags"
LOG="${AOS_OLLAMA_LOG:-$HOME/.local/state/agenticos/ollama-serve.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

# Truncate an unbounded log on (re)start (server chatter can reach tens of MB a week).
size=$(wc -c < "$LOG" 2>/dev/null || echo 0)
if [ "${size:-0}" -gt 10485760 ]; then : > "$LOG"; fi

OLLAMA="$(command -v ollama 2>/dev/null || true)"
if [ -z "$OLLAMA" ]; then
  for c in /usr/local/bin/ollama /opt/homebrew/bin/ollama /usr/bin/ollama /Applications/Ollama.app/Contents/Resources/ollama; do
    if [ -x "$c" ]; then OLLAMA="$c"; break; fi
  done
fi
if [ -z "$OLLAMA" ]; then
  echo "$(date -u +%FT%TZ) [ollama-serve] no ollama binary found — install Ollama first" >&2
  sleep 300 # long pause so a restart-on-exit supervisor cannot spin on a missing install
  exit 1
fi

# If another server (the menu-bar app, a hand-run `ollama serve`) already holds the
# port, park and poll instead of fighting for it, then take over when it goes away.
if curl -sfm 2 "$PROBE" >/dev/null 2>&1; then
  echo "$(date -u +%FT%TZ) [ollama-serve] $HOST:$PORT already served elsewhere — standing by" >&2
  while curl -sfm 2 "$PROBE" >/dev/null 2>&1; do sleep 30; done
  echo "$(date -u +%FT%TZ) [ollama-serve] previous owner gone — taking over" >&2
fi

export OLLAMA_HOST="$HOST:$PORT"
export OLLAMA_FLASH_ATTENTION="${OLLAMA_FLASH_ATTENTION:-1}"
export OLLAMA_KV_CACHE_TYPE="${OLLAMA_KV_CACHE_TYPE:-q8_0}"
export OLLAMA_MAX_LOADED_MODELS="${OLLAMA_MAX_LOADED_MODELS:-3}"   # workhorse + embedder + reasoner
export OLLAMA_NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-1}"

echo "$(date -u +%FT%TZ) [ollama-serve] starting $OLLAMA serve" >&2
exec "$OLLAMA" serve >>"$LOG" 2>&1
