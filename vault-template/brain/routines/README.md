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
budgetUsd: 0.5          # prompt: default routines.perRunUsd · duty: PERSONA_MAX_USD for that duty (default persona.perDutyUsd)
tools: "Read,Glob,Grep" # duty only; the PERSONA_TOOLS allowlist for that duty ({{NODE}} and {{VAULT}} expand)
writes: [notes/inbox/]  # duty only; vault-relative paths it may write on top of the default scope
timeoutSec: 600
tags: [brief]
---
The prompt for a prompt routine goes here.
```

- `duty` runs `persona/duties/<slug>.md` through the persona runner (its caps, journal and contract apply); `budgetUsd` and `tools` in the file override the runner's defaults for that duty (the hourly `tick.md` and the nightly `reflect-daily.md` use both). A duty writes only inside its write scope — the journal, `STATE.md`, proposals, the playbook, reflections, the sitrep and today's daily note — plus its `writes:` entries; write tools in `tools` are ignored, this folder's routine files cannot be written at all, and a change to the persona's own files (`IDENTITY.md`, duties, `autoapply.json`) is undone after the run. The same limits hold under Claude Code and Codex (see `docs/chief-of-staff.md` in the AgenticOS repository).
- `prompt` sends the body to a headless agent, capped by `routines.perDayUsd`: `claude -p` with the tools in `routines.tools` when Claude Code is wired and installed, else `codex exec` in a workspace-write sandbox (no tools allowlist there; the spend is estimated from token counts). `routines.runner` in `brain/config.json` pins `claude` or `codex`.
- `command` runs `argv: [program, arg, …]` directly (no shell) with the vault as the working directory. `{{NODE}}` in an entry expands to the node running the routine and `{{VAULT}}` to the vault path, so a file like `heartbeat.md` (the persona watchdog) works unchanged on every machine.

Apply changes with `aos routines sync` (the HUD's Routines tab has an Apply button). `aos routines list` shows the next fire time and the last result; `brain/_index/routines.json` keeps the run state.
