#!/bin/sh
# Stand-in for the `codex` CLI in tests and the CI rehearsal. Records every call, answers the read-only
# queries cli/codex-host.js makes, and keeps one piece of state: the MCP registration, in the file named
# by FAKE_CODEX_STATE (so `mcp get` after `mcp add` reports what was added, and `mcp remove` clears it).
# Knobs: FAKE_CODEX_LOGGED_OUT=1 makes `login status` report no login; FAKE_CODEX_FAIL_MCP=1 makes
# `mcp add` fail, to exercise the allowFail path without touching the network.
echo "$*" >> "${FAKE_CODEX_LOG:-/dev/null}"
STATE="${FAKE_CODEX_STATE:-}"
case "$1 $2" in
  "--version ") echo "codex-cli 0.0.0-fake" ;;
  "login status")
    if [ "${FAKE_CODEX_LOGGED_OUT:-}" = "1" ]; then echo "Not logged in"; exit 1; fi
    echo "Logged in using ChatGPT" ;;
  "mcp get")
    if [ -n "$STATE" ] && [ -f "$STATE" ]; then
      LAUNCHER=$(cat "$STATE")
      printf '{"name":"agenticos","enabled":true,"transport":{"type":"stdio","command":"sh","args":["%s","mcp-server"]}}\n' "$LAUNCHER"
    else
      echo "No MCP server named 'agenticos'" >&2
      exit 1
    fi ;;
  "mcp add")
    if [ "${FAKE_CODEX_FAIL_MCP:-}" = "1" ]; then echo "fake: mcp add failed" >&2; exit 1; fi
    # the launcher is the argument right after `-- sh`
    while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
    [ -n "$STATE" ] && [ $# -ge 3 ] && printf '%s' "$3" > "$STATE" ;;
  "mcp remove")
    [ -n "$STATE" ] && rm -f "$STATE" ;;
esac
exit 0
