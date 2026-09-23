#!/bin/sh
# run-duty.sh — run one Chief of Staff duty headlessly and enforce the duty contract
# (a new journal entry this run), with runner-side FAILED handling when the duty dies
# before reporting. POSIX sh: no arrays, no pipefail, no printf %q, no sed -i.
#
# usage: run-duty.sh <duty> [--dry-run]
# env:   AOS_CONFIG        agenticos.json (default <configDir>/agenticos.json)
#        AOS_VAULT         vault dir (default: "vault" in agenticos.json)
#        AOS_NODE          node binary (default: "node" in agenticos.json, then the bin/aos probe list)
#        PERSONA_MODEL     duty model (default: claude.model in agenticos.json — the "model" key under "claude",
#                          the only "model" key there — else haiku)          # execution amendment 2026-09-15 (A27)
#        PERSONA_EFFORT    low|medium|high (default medium)
#        PERSONA_LOG_DIR   default <vault>/persona/journal/logs
#        PERSONA_TOOLS     --allowedTools value
#        PERSONA_MAX_USD   --max-budget-usd for this run (default persona.perDutyUsd from config, else 2)
#        PERSONA_CLAUDE_BIN  claude binary (default: claude.bin from agenticos.json, then `command -v claude`,
#                          then $HOME/.local/bin/claude — contract §2 addendum order)   # execution amendment 2026-09-15 (A24)
#        PERSONA_TIMEOUT   seconds, default 1800
# Helper: two duties have a runner-side helper — tick.js for `tick`, reflect.js for `reflect-daily`: `precheck` exit 3 →
# the model call is skipped ("skipped:" in the log, no journal entry, exit 0); `beat` runs once the duty met its
# contract (the tick records its beat and may start an early reflect; the daily reflect drains the queue).
# Daily cap: record-spend.js --check compares today's duty:* ledger spend with persona.perDayUsd;
# a capped day journals "SKIPPED daily-cap" and exits 0 (hook spend never blocks a duty).
# Flags: --strict-mcp-config (no MCP servers) and --no-session-persistence (no session file) are always
# passed; --setting-sources "" is deliberately NOT passed — a duty may read the vault's CLAUDE.md and
# settings, unlike the brain's own claude -p recipe (sdk/lib/claude-cli.js).   # execution amendment 2026-09-15 (A25)
# Git: this runner never commits — the vault ignores persona/journal/ and persona/STATE.md.   # (A7)
set -u
unset CLAUDECODE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CONFIG="${AOS_CONFIG:-$CONFIG_DIR/agenticos.json}"
# json_value <key>: first "key": "value" string in agenticos.json (flat scan; no jq)
json_value() {
  [ -f "$CONFIG" ] || return 0
  sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" "$CONFIG" | head -n 1
}
# claude_bin_from_config: the "bin" inside the top-level "claude" block only. Since 0.5.0 agenticos.json also carries
# hosts.claude.bin and hosts.codex.bin, so a flat scan for "bin" could name the codex binary on a Codex-only machine.
claude_bin_from_config() {
  [ -f "$CONFIG" ] || return 0
  awk '/"claude": *\{/ { f = 1 } f && /"bin": *"/ { sub(/.*"bin": *"/, ""); sub(/".*/, ""); print; exit } f && /\}/ { f = 0 }' "$CONFIG"
}

VAULT="${AOS_VAULT:-$(json_value vault)}"
[ -n "$VAULT" ] || { echo "run-duty: no vault (set AOS_VAULT or run 'aos init')" >&2; exit 1; }
NODE="${AOS_NODE:-$(json_value node)}"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
  # Same probe list as bin/aos (contract §4.1); the nvm entry is an unquoted glob on purpose.
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME"/.nvm/versions/node/*/bin/node "$HOME/.volta/bin/node" "$HOME/.local/share/fnm/aliases/default/bin/node"; do
    [ -n "$NODE" ] && break
    [ -x "$c" ] && NODE="$c"
  done
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  # execution amendment 2026-09-15 (A27): say so instead of silently skipping the cap check and the ledger below.
  echo "run-duty: node not found (set AOS_NODE or \"node\" in agenticos.json) — daily cap check and spend ledger skipped" >&2
fi

PERSONA="$VAULT/persona"
DUTY="${1:?usage: run-duty.sh <duty> [--dry-run]}"
DRY_RUN="${2:-}"
DUTY_FILE="$PERSONA/duties/$DUTY.md"
PERSONA_LOG_DIR="${PERSONA_LOG_DIR:-$PERSONA/journal/logs}"
LOG="$PERSONA_LOG_DIR/duty-$DUTY.log"
ERR="$PERSONA_LOG_DIR/duty-$DUTY-error.log"
MODEL="${PERSONA_MODEL:-$(json_value model)}"; MODEL="${MODEL:-haiku}"   # json_value is a flat scan: the only "model" key is claude.model
EFFORT="${PERSONA_EFFORT:-medium}"
MAX_USD="${PERSONA_MAX_USD:-}"     # empty → persona.perDutyUsd from --check below → 2
# Scoped allowlist (not bypassPermissions): node is pinned to the two persona scripts; git is limited to
# status/log/diff, so a duty can neither commit nor push (final review F3/safety-5, departs from A26 — git
# add/commit were dropped: docs/chief-of-staff.md promises a duty never commits, and nothing needed the verbs).
# Write/Edit are unscoped — guarded files rely on the proposal protocol plus git history, not on the permission layer.
PERSONA_TOOLS="${PERSONA_TOOLS:-Read,Write,Edit,Glob,Grep,Bash(git status:*),Bash(git log:*),Bash(git diff:*),Bash(date:*),Bash(ls:*),Bash(grep:*),Bash(wc:*),Bash(tail:*),Bash(head:*),Bash($NODE $VAULT/brain/scripts/persona/sitrep-state.js:*),Bash($NODE $VAULT/brain/scripts/persona/scan-arsenal.js:*),Bash($NODE $VAULT/brain/scripts/persona/ledger.js:*),Bash($NODE $VAULT/brain/scripts/persona/proposal-html.js:*),Bash($NODE $VAULT/brain/scripts/persona/reflect.js:*),Bash(node $VAULT/brain/scripts/persona/sitrep-state.js:*),Bash(node $VAULT/brain/scripts/persona/scan-arsenal.js:*),Bash(node $VAULT/brain/scripts/persona/ledger.js:*),Bash(node $VAULT/brain/scripts/persona/proposal-html.js:*),Bash(node $VAULT/brain/scripts/persona/reflect.js:*),Bash($NODE brain/scripts/persona/reflect.js:*),Bash(node brain/scripts/persona/reflect.js:*),Bash($NODE brain/scripts/persona/ledger.js:*),Bash($NODE brain/scripts/persona/proposal-html.js:*),Bash(node brain/scripts/persona/ledger.js:*),Bash(node brain/scripts/persona/proposal-html.js:*)}"
RECORD="$SCRIPT_DIR/record-spend.js"     # sibling: repo checkout in tests, <vault>/brain/scripts/persona/ when installed
TODAY="$(date +%Y-%m-%d)"
NOW="$(date +%H:%M)"
JOURNAL="$PERSONA/journal/$TODAY.md"
# The UTC day's journal, when it differs from the local one (the last hours of every local day west of UTC):
# a model that dates its entry from the UTC timestamps in tool output files it there. Counted by the contract
# check below so a misfiled entry is a log warning, not a FAILED duty.
UTC_JOURNAL="$PERSONA/journal/$(date -u +%Y-%m-%d).md"
[ "$UTC_JOURNAL" = "$JOURNAL" ] && UTC_JOURNAL=""
# duty_entries <file>: journal headers this duty wrote in <file> (0 when the file is missing).
duty_entries() {
  c=$(grep -c "duty: $DUTY" "$1" 2>/dev/null || true)
  echo "${c:-0}"
}

if [ -f "$PERSONA/DISABLED" ]; then
  echo "persona DISABLED — skipping duty '$DUTY'"
  exit 0
fi
[ -f "$DUTY_FILE" ] || { echo "unknown duty '$DUTY' (no $DUTY_FILE)" >&2; exit 1; }

# claude binary: PERSONA_CLAUDE_BIN → claude.bin recorded in agenticos.json by `aos init` (contract §2 addendum;
# "bin" occurs exactly once there, under "claude") → PATH → ~/.local/bin/claude. execution amendment 2026-09-15 (A24)
# A SET PERSONA_CLAUDE_BIN that is not executable is a misconfiguration, not a cue to fall through to the
# PATH lookup — fail loudly instead of silently launching whatever `claude` happens to resolve to. (A50)
# Deliberately BELOW the kill switch and the unknown-duty check (final review safety-9 = spec-12): a disabled
# persona must exit 0 and an unknown duty must exit 1 with its own message, whatever a stale override names.
if [ -n "${PERSONA_CLAUDE_BIN:-}" ]; then
  CLAUDE_BIN="$PERSONA_CLAUDE_BIN"
  [ -x "$CLAUDE_BIN" ] || { echo "run-duty: PERSONA_CLAUDE_BIN is not executable: $CLAUDE_BIN" >&2; exit 1; }
else
  CLAUDE_BIN="$(claude_bin_from_config)"
  [ -x "$CLAUDE_BIN" ] || CLAUDE_BIN="$(command -v claude 2>/dev/null || echo "$HOME/.local/bin/claude")"
fi

# Runner (codex-parity D4): lib/headless.js picks claude when the Claude host is enabled and a binary resolves, else
# codex (persona.runner / AOS_RUNNER override; PERSONA_CLAUDE_BIN still pins claude). Under codex there is no
# --max-budget-usd: the daily cap below still gates the start and the spend is estimated from the usage block
# afterwards (D5); the tools allowlist has no Codex form, the workspace-write sandbox is the guard. No node → claude.
RUNNER="claude"; CODEX_BIN=""; CODEX_MODEL=""
if [ -n "$NODE" ] && [ -x "$NODE" ] && [ -f "$SCRIPT_DIR/../lib/headless.js" ]; then
  RES="$(AOS_VAULT="$VAULT" AOS_CONFIG="$CONFIG" "$NODE" "$SCRIPT_DIR/../lib/headless.js" --resolve --kind persona 2>/dev/null)" || RES=""
  case "$RES" in
    claude*) [ -n "${PERSONA_CLAUDE_BIN:-}" ] || CLAUDE_BIN="$(printf '%s' "$RES" | cut -f2)" ;;
    codex*) RUNNER="codex"; CODEX_BIN="$(printf '%s' "$RES" | cut -f2)"; CODEX_MODEL="$(printf '%s' "$RES" | cut -f3)" ;;
  esac
fi

# Hooks do not run under AOS_HEADLESS=1, so the persona is injected here instead.
# The date line pins "today": a duty running just after midnight otherwise infers the date from STATE.md and the
# journal (both still yesterday's), appends its entry to yesterday's file, and the contract check below reads FAILED.
SYSTEM="$( { echo "Today is $TODAY (local time $NOW). This run's journal file is $JOURNAL. Use this date and time for every date you write; timestamps in tool output are UTC."; echo; cat "$PERSONA/IDENTITY.md" 2>/dev/null; echo; echo '---'; cat "$PERSONA/STATE.md" 2>/dev/null; } )"
# The date line alone is not enough: a duty file says "append to journal/<today YYYY-MM-DD>.md" and "## <HH:MM>", and
# a small model fills those from the UTC ISO timestamps its scripts print — after 20:00 EDT that is tomorrow's file.
# So the placeholders arrive already filled with the local day and time. Literal index() replace, not gsub: no regex.
PROMPT="$(awk -v today="$TODAY" -v now="$NOW" '
  function fill(s, from, to,   out, i) { out = ""; while ((i = index(s, from)) > 0) { out = out substr(s, 1, i - 1) to; s = substr(s, i + length(from)) } return out s }
  { s = fill($0, "<today YYYY-MM-DD>", today); s = fill(s, "<today>", today); s = fill(s, "<YYYY-MM-DD>", today); print fill(s, "<HH:MM>", now) }
' "$DUTY_FILE")"

if [ "$DRY_RUN" = "--dry-run" ]; then
  if [ "$RUNNER" = "codex" ]; then
    printf '%s\n' "$CODEX_BIN" "exec" "-" "--skip-git-repo-check" "--ephemeral" "-s" "workspace-write" "-c" "features.hooks=false" \
      "--json" "-o" "<last message file>" ${CODEX_MODEL:+-m "$CODEX_MODEL"} "-c" "model_reasoning_effort=\"$EFFORT\"" \
      "<duty $DUTY on stdin, after persona IDENTITY.md + STATE.md>"
    exit 0
  fi
  printf '%s\n' "$CLAUDE_BIN" "-p" "<duty $DUTY>" "--model" "$MODEL" "--effort" "$EFFORT" \
    "--allowedTools" "$PERSONA_TOOLS" "--max-budget-usd" "${MAX_USD:-2}" "--output-format" "json" \
    "--strict-mcp-config" "--no-session-persistence" \
    "--append-system-prompt" "<persona IDENTITY.md + STATE.md>"
  exit 0
fi

mkdir -p "$PERSONA_LOG_DIR" "$PERSONA/journal"

# Daily duty cap from the provider spend ledger (exit 3 = capped; any other failure → proceed).
# --check prints {"allowed":…,"spentToday":…,"perDayUsd":…,"perDutyUsd":…}; perDutyUsd is the
# per-run budget unless PERSONA_MAX_USD was set.
if [ -n "$NODE" ] && [ -x "$NODE" ] && [ -f "$RECORD" ]; then
  CAPS="$(AOS_VAULT="$VAULT" AOS_CONFIG="$CONFIG" "$NODE" "$RECORD" --check 2>>"$ERR")"
  RC=$?
  if [ "$RC" -eq 3 ]; then
    echo "[$(date)] duty=$DUTY skipped: daily spend cap reached $CAPS" >> "$LOG"
    {
      echo ""
      echo "## $(date +%H:%M) — duty: $DUTY"
      echo "- status: SKIPPED daily-cap"
      echo "- did: nothing — today's duty spend is at persona.perDayUsd $CAPS"
    } >> "$JOURNAL"
    exit 0
  elif [ "$RC" -ne 0 ]; then
    # Neither allowed (0) nor capped (3) — the check itself failed. Proceed uncapped rather than block
    # every duty on a broken --check; --max-budget-usd still bounds what this one run can spend. (A50)
    echo "[$(date)] duty=$DUTY cap check failed (exit $RC) — proceeding uncapped; --max-budget-usd still bounds this run" >> "$LOG"
  fi
  [ -n "$MAX_USD" ] || MAX_USD="$(printf '%s' "$CAPS" | sed -n 's/.*"perDutyUsd":\([0-9][0-9.]*\).*/\1/p')"
fi
MAX_USD="${MAX_USD:-2}"

# Duty helper (spec 2026-09-22-persona-tick-design D3): a sibling script whose `precheck` verb exits 3 when nothing
# changed since the duty's last beat — the model call is skipped (one log line, no journal entry, exit 0, and
# run-routine.js still records the run, so the watchdog never mistakes an idle hour for a miss) — and whose `beat`
# verb runs after the duty met its contract. The daily reflect (spec 2026-09-22-persona-reflect-daily-design D2) uses the
# same seam: reflect.js `precheck` exits 3 when the queue is empty and today already drained; `beat` drains the queue.
# Named per duty on purpose: only these two have one, and a user duty that happens to share a script's name must never
# pick that script up.
case "$DUTY" in
  tick) HELPER="$SCRIPT_DIR/tick.js"; SKIP_WHY="unchanged since the last beat" ;;
  reflect-daily) HELPER="$SCRIPT_DIR/reflect.js"; SKIP_WHY="queue empty and already drained today" ;;
  *) HELPER=""; SKIP_WHY="" ;;
esac
if [ -n "$HELPER" ] && [ -f "$HELPER" ] && [ -n "$NODE" ] && [ -x "$NODE" ]; then
  PRE="$(AOS_VAULT="$VAULT" AOS_CONFIG="$CONFIG" "$NODE" "$HELPER" precheck --root "$VAULT" 2>>"$ERR")"
  if [ $? -eq 3 ]; then
    echo "[$(date)] duty=$DUTY skipped: $SKIP_WHY $PRE" >> "$LOG"
    exit 0
  fi
fi

echo "[$(date)] duty=$DUTY runner=$RUNNER model=$MODEL effort=$EFFORT budget=$MAX_USD start" >> "$LOG"
BEFORE_COUNT=$(duty_entries "$JOURNAL")
UTC_BEFORE=0; [ -n "$UTC_JOURNAL" ] && UTC_BEFORE=$(duty_entries "$UTC_JOURNAL")
OUT="$(mktemp "${TMPDIR:-/tmp}/duty-$DUTY.XXXXXX")"

IN=""
if [ "$RUNNER" = "codex" ]; then
  # The prompt goes on stdin from a file (not a pipe: `exec` must replace this subshell so the watchdog can kill
  # the codex process itself, and a pipeline element cannot do that). --json events land in $OUT for the ledger.
  IN="$(mktemp "${TMPDIR:-/tmp}/duty-$DUTY-in.XXXXXX")"
  { printf '%s\n\n---\n\n' "$SYSTEM"; printf '%s' "$PROMPT"; } > "$IN"
  ( cd "$VAULT" && AOS_HEADLESS=1 exec "$CODEX_BIN" exec - --skip-git-repo-check --ephemeral -s workspace-write \
      -c features.hooks=false --json -o "$OUT.msg" ${CODEX_MODEL:+-m "$CODEX_MODEL"} -c "model_reasoning_effort=\"$EFFORT\"" \
      < "$IN" > "$OUT" 2>> "$ERR" ) &
else
  ( cd "$VAULT" && AOS_HEADLESS=1 exec "$CLAUDE_BIN" -p "$PROMPT" --model "$MODEL" --effort "$EFFORT" \
      --allowedTools "$PERSONA_TOOLS" --max-budget-usd "$MAX_USD" --output-format json \
      --strict-mcp-config --no-session-persistence \
      --append-system-prompt "$SYSTEM" > "$OUT" 2>> "$ERR" ) &
fi
CLAUDE_PID=$!
# `exec` replaces the backgrounded subshell with $CLAUDE_BIN itself, so $! above is the claude process,
# not a wrapper shell around it — without exec, killing $! only kills the subshell and claude is
# reparented to init, orphaned and still spending (A49). Watchdog: the killer owns and reaps its own
# sleep. A plain `( sleep N; kill … ) &` leaves the sleep orphaned when the killer is killed, and that
# sleep holds the inherited stdout/stderr open — spawnSync in run-duty.test.js then blocks for the full
# PERSONA_TIMEOUT, and under launchd/cron every duty leaves a 30-minute sleep behind. With the trap,
# `kill "$KILLER_PID"` ends the sleep too.
( sleep "${PERSONA_TIMEOUT:-1800}" & S=$!; trap 'kill "$S" 2>/dev/null; exit 0' TERM; wait "$S"; kill "$CLAUDE_PID" 2>/dev/null ) &
KILLER_PID=$!
wait "$CLAUDE_PID"; STATUS=$?
kill "$KILLER_PID" 2>/dev/null; wait "$KILLER_PID" 2>/dev/null

cat "$OUT" >> "$LOG"
if [ -n "$NODE" ] && [ -x "$NODE" ] && [ -f "$RECORD" ] && [ -s "$OUT" ]; then
  SPEND_MODEL="$MODEL"; [ "$RUNNER" = "codex" ] && SPEND_MODEL="${CODEX_MODEL:-codex-default}"
  AOS_VAULT="$VAULT" AOS_CONFIG="$CONFIG" "$NODE" "$RECORD" --file "$OUT" --feature "duty:$DUTY" --model "$SPEND_MODEL" >> "$LOG" 2>> "$ERR" || true
fi
rm -f "$OUT" "$OUT.msg"; [ -n "$IN" ] && rm -f "$IN"

# Duty contract check: the duty must have added a NEW journal entry this run
# (a plain grep would match a prior run's watchdog entry and self-satisfy). An entry filed under the UTC day
# still counts — the duty did its work — but it is logged so the misfiling is visible.
AFTER_COUNT=$(duty_entries "$JOURNAL")
if [ "$AFTER_COUNT" -le "$BEFORE_COUNT" ] && [ -n "$UTC_JOURNAL" ] && [ "$(duty_entries "$UTC_JOURNAL")" -gt "$UTC_BEFORE" ]; then
  echo "[$(date)] duty=$DUTY journal entry landed in $UTC_JOURNAL (the UTC day), not $JOURNAL — counted" >> "$LOG"
  AFTER_COUNT=$((BEFORE_COUNT + 1))
fi
if [ "$AFTER_COUNT" -le "$BEFORE_COUNT" ]; then
  {
    echo ""
    echo "## $(date +%H:%M) — duty: $DUTY"
    echo "- status: FAILED"
    echo "- did: runner-detected failure (exit $STATUS, no journal entry) — see $ERR"
  } >> "$JOURNAL"
  # Flag it in STATE.md right under '## Flags' — portable insert (no sed -i).
  if [ -f "$PERSONA/STATE.md" ]; then
    TMP="$PERSONA/STATE.md.tmp.$$"
    awk -v line="- [ ] $TODAY duty '$DUTY' FAILED — check $ERR" \
      '{ print } /^## Flags[[:space:]]*$/ { print line }' "$PERSONA/STATE.md" > "$TMP" && mv "$TMP" "$PERSONA/STATE.md"
  fi
  # No commit here: the vault template ignores persona/journal/ and persona/STATE.md, and a background job must
  # never run a pathspec-less `git commit` over whatever the user had staged. execution amendment 2026-09-15 (A7)
  echo "[$(date)] duty=$DUTY FAILED (contract unmet)" >> "$LOG"
  exit 1
fi

if [ -n "$HELPER" ] && [ -f "$HELPER" ] && [ -n "$NODE" ] && [ -x "$NODE" ]; then
  AOS_VAULT="$VAULT" AOS_CONFIG="$CONFIG" "$NODE" "$HELPER" beat --root "$VAULT" >> "$LOG" 2>>"$ERR" || true
fi
echo "[$(date)] duty=$DUTY done (exit $STATUS)" >> "$LOG"
