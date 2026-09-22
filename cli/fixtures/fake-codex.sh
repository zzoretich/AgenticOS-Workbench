#!/bin/sh
# Stand-in for the `codex` CLI in tests and the CI rehearsal. Records every call, answers the read-only
# queries cli/codex-host.js makes, and keeps one piece of state: the MCP registration, in the file named
# by FAKE_CODEX_STATE (so `mcp get` after `mcp add` reports what was added, and `mcp remove` clears it).
# Line 1 of that file is the launcher, line 2 records whether `--env AOS_HOST=codex` was passed, so a
# registration written the 0.5.0 way (no host env) reads back as stale, exactly like the real CLI.
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
      LAUNCHER=$(sed -n 1p "$STATE"); HOSTENV=$(sed -n 2p "$STATE")
      if [ "$HOSTENV" = "AOS_HOST=codex" ]; then ENVJSON='{"AOS_CONFIG":"x","AOS_HOST":"codex"}'; else ENVJSON='{"AOS_CONFIG":"x"}'; fi
      printf '{"name":"agenticos","enabled":true,"transport":{"type":"stdio","command":"sh","args":["%s","mcp-server"],"env":%s}}\n' "$LAUNCHER" "$ENVJSON"
    else
      echo "No MCP server named 'agenticos'" >&2
      exit 1
    fi ;;
  "mcp add")
    if [ "${FAKE_CODEX_FAIL_MCP:-}" = "1" ]; then echo "fake: mcp add failed" >&2; exit 1; fi
    HOSTENV=""; for a in "$@"; do [ "$a" = "AOS_HOST=codex" ] && HOSTENV="AOS_HOST=codex"; done
    # the launcher is the argument right after `-- sh`
    while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
    [ -n "$STATE" ] && [ $# -ge 3 ] && printf '%s\n%s\n' "$3" "$HOSTENV" > "$STATE" ;;
  "mcp remove")
    [ -n "$STATE" ] && rm -f "$STATE" ;;
  "exec -")
    # A headless run (lib/headless.js codex runner): the prompt is on stdin, the final message goes to the -o file,
    # the --json event stream to stdout. FAKE_CODEX_STDIN captures the prompt, FAKE_ARGS the argv (like fake-claude),
    # FAKE_JOURNAL appends a duty journal entry so run-duty.sh sees its contract met.
    PROMPT_IN=$(cat)
    [ -n "${FAKE_CODEX_STDIN:-}" ] && printf '%s' "$PROMPT_IN" > "$FAKE_CODEX_STDIN"
    [ -n "${FAKE_ARGS:-}" ] && printf '%s\n' "$@" > "$FAKE_ARGS"
    [ -n "${FAKE_JOURNAL:-}" ] && { mkdir -p "$(dirname "$FAKE_JOURNAL")"; printf '\n## 09:00 — duty: testduty\n- status: OK\n' >> "$FAKE_JOURNAL"; }
    OUTF=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && OUTF="$2"; shift; done
    [ -n "$OUTF" ] && printf 'fake reply\n' > "$OUTF"
    printf '{"type":"thread.started","thread_id":"fake"}\n{"type":"item.completed","item":{"type":"agent_message","text":"fake reply"}}\n{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":0,"output_tokens":300}}\n' ;;
esac
exit 0
