---
description: Manage the vault's recurring actions (brain/routines/*.md) — list, sync the OS schedules, run one now, enable or disable, next fire times
allowed-tools: Bash, Read
argument-hint: [list [--json] | sync | run <slug> [--dry-run] | enable <slug> | disable <slug> | next [<slug>]]
---

Run `aos routines $ARGUMENTS` via Bash (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" routines $ARGUMENTS`); with no arguments run `aos routines list`.

- `list`: relay the table. A `health` of `failed`, `missed`, `stale` or `invalid` deserves one line of explanation: `failed` = the last run exited non-zero (see `persona/journal/logs/routine-<slug>.log`), `missed` = a fire time passed with no run recorded (is the schedule loaded? `aos routines sync`), `stale` = the file changed since the schedules were last applied (`aos routines sync`), `invalid` = the file's frontmatter does not validate (the error is printed under the table).
- `sync`: relay the `routines: scheduled …` line and any `warning:` lines verbatim.
- `run <slug>`: streams the runner's output; relay the exit code. `--dry-run` prints the invocation and executes nothing.
- `enable <slug>` / `disable <slug>`: rewrites the file and syncs; relay both lines.
- `next [<slug>]`: relay the fire times.

To create or edit a routine, write `brain/routines/<slug>.md` (see `brain/routines/README.md` for the frontmatter) and then run `sync`. A routine with `guarded: true` is covered by the persona contract: say so and ask before changing its schedule or body.
