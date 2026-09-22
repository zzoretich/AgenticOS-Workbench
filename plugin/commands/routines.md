---
description: Manage the vault's recurring actions (brain/routines/*.md) — list, sync the OS schedules, run one now, enable or disable, next fire times; see the routines each session host owns (Codex Automations, Claude Code cloud routines)
allowed-tools: Bash, Read, Write, ToolSearch, RemoteTrigger
argument-hint: [list [--json] | sync | run <slug> [--dry-run] | enable <slug> | disable <slug> | next [<slug>] | hosts [--refresh] | cloud]
---

Run `aos routines $ARGUMENTS` via Bash (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" routines $ARGUMENTS`); with no arguments run `aos routines list`. The one verb that is not a passthrough is `cloud` (below).

- `list`: relay the table. A `health` of `failed`, `missed`, `stale` or `invalid` deserves one line of explanation: `failed` = the last run exited non-zero (see `persona/journal/logs/routine-<slug>.log`), `missed` = a fire time passed with no run recorded (is the schedule loaded? `aos routines sync`), `stale` = the file changed since the schedules were last applied (`aos routines sync`), `invalid` = the file's frontmatter does not validate (the error is printed under the table). A `HOSTS` table follows when host routines are known; its `as-of` column is the age of that host's snapshot.
- `sync`: relay the `routines: scheduled …` line and any `warning:` lines verbatim.
- `run <slug>`: streams the runner's output; relay the exit code. `--dry-run` prints the invocation and executes nothing.
- `enable <slug>` / `disable <slug>`: rewrites the file and syncs; relay both lines.
- `next [<slug>]`: relay the fire times.
- `hosts [--refresh]`: the recurring actions each session host owns, read-only. `--refresh` re-reads the Codex app's Automations (its local database, through `sqlite3`); the Claude Code cloud section only changes through `cloud`. Relay the table and any `warning:` line.
- `cloud`: refresh the Claude Code cloud routines snapshot. Load the tool with `ToolSearch select:RemoteTrigger`, call it with `{"action": "list"}`, write the raw JSON response to a temp file under `$TMPDIR` (Write), then run `aos routines import-cloud <that file>` and relay its `HOSTS` table. Delete the temp file afterwards. If `RemoteTrigger` is not available (a Codex session, a headless run), say that the cloud snapshot can only be refreshed from an interactive Claude Code session and run `aos routines hosts` instead. Never paste the payload into the vault by hand: the import validates and normalizes it.

Host rows are read-only here: a Codex Automation is edited in the Codex app, a cloud routine at claude.ai/code/routines.

To create or edit a routine, write `brain/routines/<slug>.md` (see `brain/routines/README.md` for the frontmatter) and then run `sync`. A routine with `guarded: true` is covered by the persona contract: say so and ask before changing its schedule or body.
