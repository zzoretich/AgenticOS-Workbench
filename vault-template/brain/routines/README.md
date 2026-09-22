# Routines

One file per recurring action. Frontmatter holds the schedule (five-field cron, local time), the kind, and whether it is enabled; the body is the prompt for a `prompt` routine and a note for the others.

```yaml
---
schema: 1
name: Morning brief
kind: prompt            # duty | prompt | command
schedule: "30 7 * * 1-5"
enabled: true
model: haiku            # prompt only; default claude.model
effort: low             # prompt only; low | medium | high
budgetUsd: 0.5          # prompt only; default routines.perRunUsd
timeoutSec: 600
tags: [brief]
---
The prompt for a prompt routine goes here.
```

- `duty` runs `persona/duties/<slug>.md` through the persona runner (its caps, journal and contract apply).
- `prompt` sends the body to headless Claude with the tools in `routines.tools`, capped by `routines.perDayUsd` (needs the `claude` CLI; on a Codex-only machine a prompt routine records a failed run).
- `command` runs `argv: [program, arg, …]` directly (no shell) with the vault as the working directory. `{{NODE}}` in an entry expands to the node running the routine and `{{VAULT}}` to the vault path, so a file like `heartbeat.md` (the persona watchdog) works unchanged on every machine.

Apply changes with `aos routines sync` (the HUD's Routines tab has an Apply button). `aos routines list` shows the next fire time and the last result; `brain/_index/routines.json` keeps the run state.
